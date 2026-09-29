# B2 MCP Webinar — Event Notification Demo

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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

## The three secrets — what each one actually is

Three names get referenced below. Here's exactly what each one is and where it comes from —
none of them are things this repo already has; you create or fetch all three yourself.

| Secret | What it is | Where the value comes from |
|---|---|---|
| `GITHUB_REPO` | Not a secret at all — just this repo's name, as a literal string | `backblaze-labs/b2-mcp-webinar` — copy it as-is, no account or dashboard involved |
| `GITHUB_TOKEN` | A **Personal Access Token** *you* create, so the edge function is allowed to call GitHub's API (`repository_dispatch`) on your behalf | See **Getting `GITHUB_TOKEN`** below — read it before generating one, there are two token types and only one of them reliably works against an org repo without extra approval steps |
| `DISCORD_WEBHOOK_URL` | A URL Discord generates for one specific channel; anything POSTed to it appears as a message in that channel | In the target Discord server: pick the channel → gear icon (**Edit Channel**) → **Integrations** → **Webhooks** → **New Webhook** → name it (e.g. "B2 Demo") → **Copy Webhook URL** |

None of these three are things that can be created on your behalf — the PAT needs your GitHub
login, the webhook needs your ownership of the Discord server. Once you have all three values in
hand, the setup below is just pasting them in when each CLI prompts for them (`wrangler secret
put` / `vercel env add` never echo the value back, so it's safe to paste a real secret there).

### Getting `GITHUB_TOKEN` — classic PAT, not fine-grained

Use a **classic** Personal Access Token:
[github.com/settings/tokens/new](https://github.com/settings/tokens/new) → check the `repo`
scope → Generate → copy it (starts `ghp_…`).

**Why classic and not fine-grained:** a fine-grained PAT scoped to an *organization*-owned repo
(this one lives under `backblaze-labs`) can require the org admin to separately approve it
before it becomes active — until approved, every API call using it fails with `403 Resource not
accessible by personal access token`, even when every permission checkbox looks correct. This
is exactly the failure this repo hit while building the demo (see **Troubleshooting** below). A
classic PAT with `repo` scope skips that approval step entirely for any repo you already have
write access to.

If you'd rather use a fine-grained PAT anyway (tighter scope, single-repo only): create it at
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
with Resource owner `backblaze-labs`, Repository access → only `b2-mcp-webinar`, Permissions →
Contents: **Read and write** — then check **Organization Settings → Personal access tokens** for
a pending-approval request before assuming it's broken.

## Setup — Cloudflare Workers (fastest: one CLI command)

```bash
npx wrangler login    # one-time browser login to your Cloudflare account (free tier is fine)
npx wrangler deploy
```

Deploy prints a URL like `https://<worker-name>.<your-subdomain>.workers.dev` — that's the
webhook target for B2 (last step below). **First-time accounts:** if deploy warns "you need to
register a workers.dev subdomain," do that once at the printed dashboard link before continuing
— see **Troubleshooting** for what happens if you skip or change it later.

Then set the three secrets:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_REPO
```

Each command prompts you to paste the corresponding value — see the tables above for exactly
what each one is and how to get it. `GITHUB_REPO`'s value is just `backblaze-labs/b2-mcp-webinar`.

Uses [`relay/relay.js`](relay/relay.js) + [`wrangler.toml`](wrangler.toml).

## Setup — Vercel Edge Functions (alternative, same logic)

```bash
npx vercel login
npx vercel deploy --prod
```

Deploy prints your project's URL; the function is reachable at `<url>/api/relay`. Set the same
three env vars via the CLI or the Vercel dashboard (Project Settings → Environment Variables):

```bash
npx vercel env add DISCORD_WEBHOOK_URL production
npx vercel env add GITHUB_TOKEN production
npx vercel env add GITHUB_REPO production
```

Same three values as the tables above.

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
good for rehearsing the GitHub half live without deploying anything first, and for confirming
the workflow itself is healthy independent of the edge function's own credentials.

## Testing just the edge function directly

Once deployed, fire a synthetic B2-shaped event straight at it (no real B2 upload required):

```bash
curl -X POST "https://<worker-or-vercel-url>/" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"eventType":"b2:ObjectCreated:Upload","eventData":{"bucketName":"webinar-demo-media-0928","objectName":"test.txt"}}]}'
```

A `200` means both Discord and GitHub succeeded. A `207` means one of the two failed — the
response body names which one and why (the Worker/function surfaces the real upstream error
text, not just a status code), so read the body before assuming it's broken.

## Troubleshooting — failure modes this repo actually hit

Real problems encountered wiring this up, in the order they tend to bite:

- **Wrong argument form for `wrangler secret put`.** It reads the secret value from **stdin**,
  it does not take it as a trailing CLI argument. `wrangler secret put NAME value` fails with
  `Unknown argument`. Correct form: `echo "value" | wrangler secret put NAME` (or just run
  `wrangler secret put NAME` with no value and paste when prompted).

- **`workers.dev` subdomain not registered yet.** A brand-new Cloudflare account has no
  `workers.dev` subdomain until you register one (deploy prints a warning + a dashboard link the
  first time). Until registered, the printed Worker URL resolves to nothing — TLS handshake
  fails outright (`SSL_VERSION_OR_CIPHER_MISMATCH` in a browser, `SSL routines … handshake
  failure` in curl/openssl) because there's no edge route for that hostname at all yet.

- **Changing the subdomain name later triggers real DNS propagation delay.** If you rename the
  account's `workers.dev` subdomain after already registering one, the *new* hostname can take
  several minutes to resolve — this is genuine Cloudflare-edge DNS propagation, not something a
  redeploy or any CLI flag can force faster. If it's been more than ~15 minutes, doing one more
  `wrangler deploy` (no changes needed) has been observed to nudge it into resolving.

- **Local DNS cache can lag behind the real record.** If `dig <worker-url>` returns nothing from
  your normal resolver but `dig @1.1.1.1 <worker-url>` (or `@8.8.8.8`) *does* return an IP, the
  record has already propagated — only your local resolver/router is holding a stale negative
  cache. Bypass it directly with `curl --resolve <host>:443:<ip-from-1.1.1.1> https://<host>/...`
  instead of waiting on your own DNS to catch up.

- **`403 Resource not accessible by personal access token` on the GitHub dispatch call.** This is
  a fine-grained-PAT-specific failure against an *organization*-owned repo: the org may require
  admin approval for fine-grained tokens before they're active, independent of whether every
  permission checkbox was set correctly. Switch to a **classic** PAT with `repo` scope (see
  **Getting `GITHUB_TOKEN`** above) to skip that approval step, or check **Organization Settings
  → Personal access tokens** for a pending request.

- **How to tell "the workflow is broken" apart from "the edge function's token is broken."**
  Fire the manual test dispatch (above) using your *own* `gh` auth. If that opens an Issue but
  the edge function's own calls still fail, the workflow and its trigger config are proven fine
  — the problem is isolated to the edge function's `GITHUB_TOKEN` secret specifically.

## Files

| Path | Purpose |
|---|---|
| `relay/relay.js` | Cloudflare Worker: posts to Discord + triggers the GitHub workflow. |
| `wrangler.toml` | Cloudflare Worker deploy config. |
| `api/relay.js` | Vercel Edge Function port of the exact same logic. |
| `.github/workflows/b2-event.yml` | Reacts to the trigger by opening a GitHub Issue. |
| `package.json` | npm scripts for deploy/secrets/manual-test; no runtime dependencies. |
| `LICENSE` | MIT, matching the rest of the `backblaze-labs` org. |
| `README.md` | This file |

## Not covered here

Production concerns — retries, dead-lettering, webhook signature verification (B2 supports an
HMAC-SHA256 signing secret on the notification rule; the edge function should verify it before
trusting the payload), and secret rotation — are intentionally out of scope for a 15-minute
demo repo.
