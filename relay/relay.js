// B2 event-notification relay — receives B2's webhook, fans out to Discord + GitHub.
//
// Deploy anywhere that runs a `fetch`-style HTTP handler (Val Town, Cloudflare Workers,
// a Node serverless function). Set three env vars before use:
//   DISCORD_WEBHOOK_URL  - Discord channel webhook (Settings > Integrations > Webhooks)
//   GITHUB_TOKEN         - PAT with repository_dispatch permission on GITHUB_REPO
//   GITHUB_REPO          - "owner/repo", e.g. "backblaze-labs/b2-mcp-webinar"
//
// B2's webhook body shape (subset used here):
//   { events: [ { eventType, eventData: { bucketName, objectName, ... } } ] }
// See: https://www.backblaze.com/apidocs/b2-event-notification-rules

export default async function handleRequest(req) {
  if (req.method !== "POST") {
    return new Response("expected POST", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  // TODO before production use: verify the HMAC-SHA256 signature B2 sends when a signing
  // secret is configured on the notification rule, before trusting this payload.

  const event = body.events?.[0];
  const eventType = event?.eventType ?? "unknown";
  const bucketName = event?.eventData?.bucketName ?? event?.bucketName ?? "unknown-bucket";
  const objectName = event?.eventData?.objectName ?? event?.fileName ?? "unknown-object";

  await Promise.allSettled([
    forwardToDiscord({ eventType, bucketName, objectName }),
    forwardToGitHub({ eventType, bucketName, objectName }),
  ]);

  return new Response("ok");
}

async function forwardToDiscord({ eventType, bucketName, objectName }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `📦 **B2 event** \`${eventType}\`\nBucket: \`${bucketName}\`\nObject: \`${objectName}\``,
    }),
  });
}

async function forwardToGitHub({ eventType, bucketName, objectName }) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return;

  await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "b2_object_created",
      client_payload: { eventType, bucketName, objectName },
    }),
  });
}
