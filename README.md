# B2 MCP Webinar — Event Notification Demo

Minimal example: a **Backblaze B2 event notification** (fired on every object upload) reaches
a tiny relay, which fans the event out to two destinations — a **Discord channel** and a
**GitHub Actions workflow** (which opens an issue). Built for a live 30-minute webinar demo;
optimized for speed to set up, not production hardening.

## Why a relay exists

B2 delivers its own JSON event shape to a webhook URL. Neither Discord nor GitHub's
`repository_dispatch` API accepts that shape directly — Discord expects `{"content": "..."}`
/ `{"embeds": [...]}`, and GitHub's dispatch endpoint expects
`{"event_type": "...", "client_payload": {...}}` plus a Bearer token. The relay in
[`relay/relay.js`](relay/relay.js) is the ~30 lines of glue that translates one B2 event into
both destination shapes.

```
B2 bucket upload
      │
      ▼
B2 event notification (webhook)  ──────►  relay/relay.js  ──┬──►  Discord channel message
                                                              └──►  GitHub repository_dispatch
                                                                        │
                                                                        ▼
                                                          .github/workflows/b2-event.yml
                                                                        │
                                                                        ▼
                                                              opens a GitHub Issue
```

## Setup (fast path)

1. **Deploy the relay.** Paste [`relay/relay.js`](relay/relay.js) into any HTTPS function host
   — [Val Town](https://www.val.town) is fastest (paste, get a URL back immediately). Cloudflare
   Workers or any Node serverless function work too.
2. **Set the relay's environment/config:**
   - `DISCORD_WEBHOOK_URL` — Discord channel → Settings → Integrations → Webhooks → New Webhook.
   - `GITHUB_TOKEN` — a fine-grained PAT scoped to **this repo only**, with **Contents: read**
     and **repository_dispatch** permission (classic PAT with `repo` scope also works).
   - `GITHUB_REPO` — `backblaze-labs/b2-mcp-webinar`.
3. **Point the B2 bucket's event notification at the relay's URL** (see the B2 MCP server's
   `b2_set_bucket_notification_rules` tool, or the B2 web console → bucket → Event Notifications).
   Use event type `b2:ObjectCreated:*`.
4. **Upload a file to the bucket.** Within a few seconds: a message lands in Discord, and a new
   issue appears on this repo.

## Manual test (no B2 required)

Skip the whole pipeline and fire the GitHub side directly:

```bash
gh api repos/backblaze-labs/b2-mcp-webinar/dispatches \
  -f event_type='b2_object_created' \
  -f 'client_payload[objectName]=demo/hello.txt' \
  -f 'client_payload[bucketName]=webinar-demo-media-0928'
```

That triggers [`.github/workflows/b2-event.yml`](.github/workflows/b2-event.yml) directly,
which opens an issue — good for rehearsing the GitHub half live without waiting on a real
upload.

## What "doing something" means here

- **Discord**: a formatted message naming the bucket, object key, and event type.
- **GitHub**: a new Issue opened by the Actions workflow, titled with the object key, body
  containing the full event payload. No email/SMTP credentials required — issues need only the
  workflow's own `GITHUB_TOKEN`.

Swap the workflow's final step for anything else GitHub Actions can do (send an email via an
SMTP action, post a Slack message, trigger a deploy) — the `repository_dispatch` trigger and
payload shape stay the same.

## Files

| Path | Purpose |
|---|---|
| `relay/relay.js` | Receives the raw B2 webhook POST, forwards to Discord + GitHub |
| `.github/workflows/b2-event.yml` | Reacts to the relayed event by opening an issue |
| `README.md` | This file |

## Not covered here

Production concerns — retries, dead-lettering, webhook signature verification (B2 supports an
HMAC-SHA256 signing secret on the notification rule; the relay should verify it before trusting
the payload), and secret management for the relay's own env vars — are intentionally out of
scope for a 15-minute demo repo.
