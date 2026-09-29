# B2 MCP Webinar — Event Notification Demo

Minimal example: a **Backblaze B2 event notification** (fired on every object upload) triggers
a **GitHub Actions workflow** that does everything — opens an Issue and posts to a **Discord
channel**. Built for a live 30-minute webinar demo; optimized for speed to set up, not
production hardening.

## The one hard constraint

GitHub Actions has exactly one trigger surface for a system outside GitHub:
`repository_dispatch`. It requires a POST with an `Authorization: Bearer <token>` header and a
fixed body shape — `{ event_type, client_payload }`. B2 sends its own fixed JSON event shape
and can't template the body or set a bearer token as a header value, so **something has to
translate one shape into the other.** [`relay/relay.js`](relay/relay.js) is that translator —
nothing more. It does not talk to Discord and does not decide what happens next; it only
reshapes the payload and adds the auth header GitHub requires. It runs as a **Cloudflare
Worker** (fastest real deploy for this: one CLI command, no project scaffolding).

Everything the demo actually **does** — opening an Issue, posting to Discord — lives in one
place: [`.github/workflows/b2-event.yml`](.github/workflows/b2-event.yml). One real B2 webhook,
one workflow, does all of it.

```
B2 bucket upload
      │
      ▼
B2 event notification (real webhook, B2's fixed JSON shape)
      │
      ▼
relay/relay.js (Cloudflare Worker) ── translates + adds GitHub auth header ──► repository_dispatch
                                                                                      │
                                                                                      ▼
                                                                  .github/workflows/b2-event.yml
                                                                        ├──► opens a GitHub Issue
                                                                        └──► posts a message to Discord
```

## Setup (fast path)

1. **Add one repo secret** for Discord: Settings → Secrets and variables → Actions →
   `DISCORD_WEBHOOK_URL` (Discord: channel → Settings → Integrations → Webhooks → New Webhook →
   Copy URL). That's the only Discord-specific config — the workflow handles the rest.

2. **Deploy the relay to Cloudflare Workers** (no wrangler install needed, `npx` runs it):
   ```bash
   npx wrangler deploy
   ```
   First run prompts a browser login to your Cloudflare account (free tier is enough). Deploy
   prints a URL like `https://b2-mcp-webinar-relay.<your-subdomain>.workers.dev` — that's the
   webhook target for step 4.

3. **Set the Worker's two secrets** (separate from the repo secret above — the relay only needs
   to reach the GitHub dispatch API, never Discord):
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put GITHUB_REPO
   ```
   - `GITHUB_TOKEN` — paste a fine-grained PAT scoped to **this repo only**, with
     **contents: read** and **repository_dispatch** permission (a classic PAT with `repo` scope
     also works).
   - `GITHUB_REPO` — paste `backblaze-labs/b2-mcp-webinar`.

4. **Point the B2 bucket's event notification at the Worker's URL** (see the B2 MCP server's
   `b2_set_bucket_notification_rules` tool, or the B2 web console → bucket → Event
   Notifications). Use event type `b2:ObjectCreated:*`.

5. **Upload a file to the bucket.** Within a few seconds: a new Issue appears on this repo, and
   a message lands in Discord — both fired from the same workflow run, itself fired by a real
   B2 webhook hitting the Worker.

## Manual test (no B2, no Worker deploy required)

Skip the whole pipeline and fire the real trigger directly:

```bash
gh api repos/backblaze-labs/b2-mcp-webinar/dispatches \
  -f event_type='b2_object_created' \
  -f 'client_payload[objectName]=demo/hello.txt' \
  -f 'client_payload[bucketName]=webinar-demo-media-0928'
```

That's exactly what the relay sends — good for rehearsing the whole workflow live without
waiting on a real upload or standing up the Worker first.

## Why Cloudflare Workers (and not Vercel)

Both work; Workers is faster to stand up for a single-function relay with no framework —
`npx wrangler deploy` from a single `.js` file and a four-line `wrangler.toml`, versus Vercel's
project-shaped deploy (an `api/` function plus a `vercel deploy`, roughly the same result with
more scaffolding). If you already have a Vercel project you'd rather reuse, `relay/relay.js`'s
logic ports directly into an Edge Function — swap the `export default { fetch(request, env) }`
Worker shape for `export default async function handler(request)` and read
`process.env.GITHUB_TOKEN` / `process.env.GITHUB_REPO` instead of `env.*`.

## Files

| Path | Purpose |
|---|---|
| `relay/relay.js` | Cloudflare Worker: translates B2's webhook into a GitHub `repository_dispatch` call. Nothing else. |
| `wrangler.toml` | Cloudflare Worker deploy config. |
| `.github/workflows/b2-event.yml` | The one workflow that does everything: opens an Issue, posts to Discord. |
| `README.md` | This file |

## Not covered here

Production concerns — retries, dead-lettering, webhook signature verification (B2 supports an
HMAC-SHA256 signing secret on the notification rule; the Worker should verify it before
trusting the payload), and Worker observability — are intentionally out of scope for a
15-minute demo repo.
