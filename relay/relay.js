// B2 -> GitHub webhook translator, as a Cloudflare Worker.
//
// GitHub Actions has exactly one trigger surface for a system outside GitHub:
// `repository_dispatch`. It requires a POST with an `Authorization: Bearer <token>` header
// and a fixed JSON body: { event_type, client_payload }. B2's event-notification webhook
// sends its own fixed JSON shape and cannot template the body or set an Authorization header
// value that isn't a static custom header — so this translator is the minimal bridge that
// makes "a real B2 webhook triggers a GitHub Actions workflow" possible at all.
//
// Everything the demo actually DOES (open an issue, post to Discord) lives in
// .github/workflows/b2-event.yml, not here. This file only reshapes and re-authenticates.
//
// Deploy: `npx wrangler deploy` from this directory (see ../wrangler.toml).
// Configure secrets once: `npx wrangler secret put GITHUB_TOKEN`
//                         `npx wrangler secret put GITHUB_REPO`
// (GITHUB_REPO value: "backblaze-labs/b2-mcp-webinar")
//
// B2's webhook body shape (subset used here):
//   { events: [ { eventType, eventData: { bucketName, objectName, ... } } ] }
// See: https://www.backblaze.com/apidocs/b2-event-notification-rules

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
    const eventType = event?.eventType ?? "unknown";
    const bucketName = event?.eventData?.bucketName ?? event?.bucketName ?? "unknown-bucket";
    const objectName = event?.eventData?.objectName ?? event?.fileName ?? "unknown-object";

    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return new Response("relay misconfigured: missing GITHUB_TOKEN or GITHUB_REPO", {
        status: 500,
      });
    }

    const dispatch = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
      {
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
      },
    );

    if (!dispatch.ok) {
      return new Response(`GitHub dispatch failed: ${dispatch.status}`, { status: 502 });
    }

    return new Response("ok");
  },
};
