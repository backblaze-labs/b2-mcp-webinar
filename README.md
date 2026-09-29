# B2 MCP Webinar — Event Notification Demo

Minimal example: a **Backblaze B2 event notification** (a real webhook, fired on every object
upload) reaches an edge function that does two things **directly, right there**: posts a
message to a **Discord channel**, and triggers a **GitHub Actions workflow** that opens an
Issue. Built for a live 30-minute webinar demo; optimized for speed to set up, not production
hardening. Deployable to either **Cloudflare Workers** or **Vercel Edge Functions** — same
logic, pick whichever platform you already have an account on.

```
B2 bucket upload
      │
      ▼
B2 event notification (real webhook, B2's fixed JSON shape)
      │
      ▼
edge function  ──┬──► posts a message to Discord           (done, right there)
 (relay/relay.js  │
  or api/relay.js)└──► triggers repository_dispatch ──► .github/workflows/b2-event.yml
                                                                    │
                                                                    ▼
                                                          opens a GitHub Issue
```

## Why an edge function sits in the middle at all

GitHub Actions has exactly one trigger surface for a system outside GitHub:
`repository_dispatch`. It requires a POST with an `Authorization: Bearer <token>` header and a
fixed body shape — `{ event_type, client_payload }`. B2 sends its own fixed JSON event shape and
can't template the body or set a bearer token as a header value — so something has to sit
between B2 and GitHub to reshape the payload and add that header. The same function does the
Discord post directly, since Discord's webhook needs no such translation — just a normal POST.

## Setup — Cloudflare Workers (fastest: one CLI command)

```bash
npx wrangler deploy
```

First run prompts a browser login to your Cloudflare account (free tier is enough). Deploy
prints a URL like `https://b2-mcp-webinar-relay.<your-subdomain>.workers.dev` — that's the
webhook target for B2 (last step below). Then set the three secrets:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL   # Discord: channel > Settings > Integrations > Webhooks > New Webhook > Copy URL
npx wrangler secret put GITHUB_TOKEN          # fine-grained PAT, this repo only, repository_dispatch permission
npx wrangler secret put GITHUB_REPO           # value: backblaze-labs/b2-mcp-webinar
```

Uses [`relay/relay.js`](relay/relay.js) + [`wrangler.toml`](wrangler.toml).

## Setup — Vercel Edge Functions (alternative, same logic)

```bash
npx vercel deploy --prod
```

Deploy prints your project's URL; the function is reachable at `<url>/api/relay`. Set the same
three env vars via the CLI or the Vercel dashboard (Project Settings → Environment Variables):

```bash
npx vercel env add DISCORD_WEBHOOK_URL production
npx vercel env add GITHUB_TOKEN production
npx vercel env add GITHUB_REPO production
```

Uses [`api/relay.js`](api/relay.js) — Vercel auto-detects any file under `api/` as a serverless
function, no extra config needed.

## Either way, finish with:

1. **Point the B2 bucket's event notification at whichever URL you deployed** (see the B2 MCP
   server's `b2_set_bucket_notification_rules` tool, or the B2 web console → bucket → Event
   Notifications). Use event type `b2:ObjectCreated:*`.
2. **Upload a file to the bucket.** Within a few seconds: a message lands in Discord, and a new
   Issue appears on this repo — both fired from the same edge function call, itself fired by a
   real B2 webhook.

## Manual test (no B2, no deploy required)

Skip the whole pipeline and fire the GitHub side directly:

```bash
gh api repos/backblaze-labs/b2-mcp-webinar/dispatches \
  -f event_type='b2_object_created' \
  -f 'client_payload[objectName]=demo/hello.txt' \
  -f 'client_payload[bucketName]=webinar-demo-media-0928'
```

That triggers [`.github/workflows/b2-event.yml`](.github/workflows/b2-event.yml) directly —
good for rehearsing the GitHub half live without deploying anything first.

## Files

| Path | Purpose |
|---|---|
| `relay/relay.js` | Cloudflare Worker: posts to Discord + triggers the GitHub workflow. |
| `wrangler.toml` | Cloudflare Worker deploy config. |
| `api/relay.js` | Vercel Edge Function port of the exact same logic. |
| `.github/workflows/b2-event.yml` | Reacts to the trigger by opening a GitHub Issue. |
| `README.md` | This file |

## Not covered here

Production concerns — retries, dead-lettering, webhook signature verification (B2 supports an
HMAC-SHA256 signing secret on the notification rule; the edge function should verify it before
trusting the payload), and secret rotation — are intentionally out of scope for a 15-minute
demo repo.
