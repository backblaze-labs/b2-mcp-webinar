// B2 event relay — Vercel Edge Function. Identical logic to ../relay/relay.js (the Cloudflare
// Worker version); only the env-var access and export shape differ per platform. Use this
// file instead of the Worker if you already have a Vercel project you'd rather deploy into.
//
// Receives B2's raw event-notification webhook and does two things directly, at the edge:
//   1. Posts a formatted message to a Discord channel.
//   2. Triggers a GitHub Actions workflow via `repository_dispatch` (GitHub's only inbound
//      trigger surface for a system outside GitHub — it requires an Authorization header and
//      a fixed { event_type, client_payload } body, which is why this translation step has to
//      exist at all; B2 can't send that shape itself).
//
// Deploy: `npx vercel deploy --prod` from the repo root.
// Set env vars once (Project Settings -> Environment Variables, or via CLI):
//   npx vercel env add DISCORD_WEBHOOK_URL
//   npx vercel env add GITHUB_TOKEN
//   npx vercel env add GITHUB_REPO      (value: "backblaze-labs/b2-mcp-webinar")
//
// B2's webhook body shape (subset used here):
//   { events: [ { eventType, eventData: { bucketName, objectName, ... } } ] }
// See: https://www.backblaze.com/apidocs/b2-event-notification-rules

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("expected POST", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  // TODO before production use: verify the HMAC-SHA256 signature B2 sends when a signing
  // secret is configured on the notification rule, before trusting this payload.

  const event = body.events?.[0];
  const info = {
    eventType: event?.eventType ?? "unknown",
    bucketName: event?.eventData?.bucketName ?? event?.bucketName ?? "unknown-bucket",
    objectName: event?.eventData?.objectName ?? event?.fileName ?? "unknown-object",
  };

  const [discordResult, dispatchResult] = await Promise.allSettled([
    postToDiscord(info),
    triggerWorkflow(info),
  ]);

  const failures = [discordResult, dispatchResult].filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    console.error("relay: partial failure", failures.map((f) => f.reason));
    return new Response(`ok, with ${failures.length} downstream failure(s) (see logs)`, {
      status: 207,
    });
  }

  return new Response("ok");
}

async function postToDiscord({ eventType, bucketName, objectName }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("missing DISCORD_WEBHOOK_URL");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `📦 **B2 event** \`${eventType}\`\nBucket: \`${bucketName}\`\nObject: \`${objectName}\``,
    }),
  });
  if (!res.ok) throw new Error(`Discord post failed: ${res.status}`);
}

async function triggerWorkflow({ eventType, bucketName, objectName }) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) throw new Error("missing GITHUB_TOKEN or GITHUB_REPO");

  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "b2-mcp-webinar-relay",
    },
    body: JSON.stringify({
      event_type: "b2_object_created",
      client_payload: { eventType, bucketName, objectName },
    }),
  });
  if (!res.ok) throw new Error(`GitHub dispatch failed: ${res.status}`);
}
