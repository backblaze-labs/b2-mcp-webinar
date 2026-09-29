# B2 MCP Webinar — Event Notification Demo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A B2 event notification fires on upload → an edge function posts to **Discord** (with an image
thumbnail) and triggers a **GitHub Actions** workflow that opens an Issue. Deployable to
**Cloudflare Workers** or **Vercel Edge Functions** — same logic.

```
B2 upload → webhook → edge function ──┬──► Discord (+ thumbnail)
      (relay/relay.js or api/relay.js) └──► repository_dispatch → b2-event.yml → GitHub Issue
```

**Why an edge function at all:** GitHub's only external trigger, `repository_dispatch`, needs a
Bearer token header and a fixed `{event_type, client_payload}` body. B2 sends its own fixed
shape and can't do either — something has to translate. The same function posts to Discord
directly (no translation needed there).

## Secrets

| Secret | Value |
|---|---|
| `GITHUB_REPO` | `backblaze-labs/b2-mcp-webinar` (literal string) |
| `GITHUB_TOKEN` | **Classic PAT**, `repo` scope: [github.com/settings/tokens/new](https://github.com/settings/tokens/new). *Not* fine-grained — org-owned repos can require separate admin approval for those, causing `403 Resource not accessible by personal access token` even with correct permissions. |
| `DISCORD_WEBHOOK_URL` | Discord channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL |

Optional, enables the image thumbnail (omit to skip it, everything else still works):

| Secret | Value |
|---|---|
| `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` | A **read-only** key scoped to the demo bucket (`listFiles`+`readFiles` only) — mint via `b2_create_key` or the B2 console |
| `B2_S3_ENDPOINT` | e.g. `s3.us-east-005.backblazeb2.com` |
| `B2_REGION` | e.g. `us-east-005` |

The relay uses the B2 key only to sign a presigned GetObject URL locally (AWS SigV4, no SDK) —
Discord fetches the image directly from B2; bytes never pass through the relay.

## Setup — Cloudflare Workers (fastest)

```bash
npx wrangler login
npx wrangler deploy
```

Prints your webhook URL (`https://<name>.<subdomain>.workers.dev`). First-time accounts: if it
warns about registering a `workers.dev` subdomain, do that at the printed link first.

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_REPO
# optional, for the thumbnail:
npx wrangler secret put B2_APPLICATION_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_S3_ENDPOINT
npx wrangler secret put B2_REGION
```

Each prompts for the value on stdin (no trailing-argument form). Uses `relay/relay.js` +
`wrangler.toml`.

## Setup — Vercel (alternative)

```bash
npx vercel login
npx vercel deploy --prod
```

Function is reachable at `<url>/api/relay`. Set the same env vars with
`npx vercel env add NAME production`. Uses `api/relay.js`.

## Finish

1. Point the bucket's event notification (`b2_set_bucket_notification_rules`, or B2 console) at
   your deployed URL, event type `b2:ObjectCreated:*`.
2. Upload a file. Discord message + GitHub Issue both fire within seconds.

## Testing without a real upload

```bash
# Fire the GitHub side directly, no deploy needed:
gh api repos/backblaze-labs/b2-mcp-webinar/dispatches \
  -f event_type='b2_object_created' \
  -f 'client_payload[objectName]=demo/hello.txt' \
  -f 'client_payload[bucketName]=webinar-demo-media-0928'

# Fire the deployed edge function with B2's real payload shape:
curl -X POST "https://<worker-or-vercel-url>/" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"eventType":"b2:ObjectCreated:Upload","bucketName":"webinar-demo-media-0928","objectName":"test.txt"}]}'
```

`bucketName`/`objectName`/`eventType` are flat fields on each event object — verified against a
live B2 webhook, not a doc guess. A `200` means both downstream actions succeeded; `207` names
which one failed and why in the response body.

## Troubleshooting

- **`wrangler secret put NAME value` fails with `Unknown argument`.** It reads from stdin, not
  a trailing arg — omit the value and paste when prompted (or `echo value | wrangler secret put NAME`).
- **Fresh Worker URL won't resolve / TLS errors.** `workers.dev` subdomain not registered yet
  (`wrangler deploy` prints the one-time dashboard link) — or, if you just renamed the
  subdomain, genuine DNS propagation lag (a few minutes; `dig @1.1.1.1 <host>` shows the real
  state if your local resolver is stale).
- **`403 Resource not accessible by personal access token`** on the GitHub call → you're using a
  fine-grained PAT against an org repo; switch to classic (see Secrets above).
- **Isolate "workflow broken" vs "relay's token broken":** run the manual `gh api dispatches`
  test with your own auth. If that opens an Issue but the relay's own calls still fail, only the
  relay's `GITHUB_TOKEN` is bad.
- **Discord/GitHub Issue says `unknown-object`.** Your test payload doesn't match B2's real flat
  shape — see the curl example above, not a nested `eventData` wrapper.

## Observability

`wrangler.toml` enables Cloudflare Workers invocation logging, so `console.log` output
(including the raw incoming payload) is visible under **Workers & Pages → Logs** in the
dashboard without needing a live `wrangler tail` session.

## Files

| Path | Purpose |
|---|---|
| `relay/relay.js` | Cloudflare Worker — Discord + thumbnail + GitHub trigger. |
| `api/relay.js` | Vercel Edge Function port of the same logic. |
| `wrangler.toml` | Cloudflare deploy config. |
| `.github/workflows/b2-event.yml` | Opens the GitHub Issue on trigger. |
| `package.json` | Deploy/secrets/test npm scripts; no runtime deps. |
| `LICENSE` | MIT. |

## Out of scope

Retries, dead-lettering, webhook signature verification (B2 supports an HMAC secret on the
rule), and secret rotation — not needed for a 15-minute demo.
