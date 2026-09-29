// B2 event relay — Cloudflare Worker.
//
// Receives B2's raw event-notification webhook and does two things directly, at the edge:
//   1. Posts a formatted message to a Discord channel.
//   2. Triggers a GitHub Actions workflow via `repository_dispatch` (GitHub's only inbound
//      trigger surface for a system outside GitHub — it requires an Authorization header and
//      a fixed { event_type, client_payload } body, which is why this translation step has to
//      exist at all; B2 can't send that shape itself).
//
// Deploy: `npx wrangler deploy` from the repo root (see ../wrangler.toml).
// One-time secrets:
//   npx wrangler secret put DISCORD_WEBHOOK_URL
//   npx wrangler secret put GITHUB_TOKEN
//   npx wrangler secret put GITHUB_REPO      (value: "backblaze-labs/b2-mcp-webinar")
//
// B2's webhook body shape (subset used here):
//   { events: [ { eventType, eventData: { bucketName, objectName, ... } } ] }
// See: https://www.backblaze.com/apidocs/b2-event-notification-rules
//
// A Vercel Edge Function port of this exact logic lives at ../api/relay.js.

export default {
  async fetch(request, env) {
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
      postToDiscord(env, info),
      triggerWorkflow(env, info),
    ]);

    const failures = [discordResult, dispatchResult].filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      const reasons = failures.map((f) => String(f.reason?.message ?? f.reason));
      console.error("relay: partial failure", reasons);
      return new Response(`ok, with ${failures.length} downstream failure(s): ${reasons.join("; ")}`, {
        status: 207,
      });
    }

    return new Response("ok");
  },
};

async function postToDiscord(env, { eventType, bucketName, objectName }) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("missing DISCORD_WEBHOOK_URL");

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `📦 **B2 event** \`${eventType}\`\nBucket: \`${bucketName}\`\nObject: \`${objectName}\``,
    }),
  });
  if (!res.ok) throw new Error(`Discord post failed: ${res.status}`);
}

async function triggerWorkflow(env, { eventType, bucketName, objectName }) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    throw new Error("missing GITHUB_TOKEN or GITHUB_REPO");
  }

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "b2-mcp-webinar-relay",
    },
    body: JSON.stringify({
      event_type: "b2_object_created",
      client_payload: { eventType, bucketName, objectName },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub dispatch failed: ${res.status} ${body}`.trim());
  }
}
