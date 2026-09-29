// B2 event relay — Cloudflare Worker.
//
// Receives B2's raw event-notification webhook and does two things directly, at the edge:
//   1. Posts a formatted message to a Discord channel — including an inline image preview
//      when the uploaded object looks like an image, via a short-lived presigned GetObject
//      URL (Discord fetches the bytes itself; they never pass through this Worker).
//   2. Triggers a GitHub Actions workflow via `repository_dispatch` (GitHub's only inbound
//      trigger surface for a system outside GitHub — it requires an Authorization header and
//      a fixed { event_type, client_payload } body, which is why this translation step has to
//      exist at all; B2 can't send that shape itself).
//
// Deploy: `npx wrangler deploy` from the repo root (see ../wrangler.toml).
// One-time secrets:
//   npx wrangler secret put DISCORD_WEBHOOK_URL
//   npx wrangler secret put GITHUB_TOKEN            (classic PAT, `repo` scope — see README)
//   npx wrangler secret put GITHUB_REPO             (value: "backblaze-labs/b2-mcp-webinar")
//   npx wrangler secret put B2_APPLICATION_KEY_ID    (a READ-ONLY key scoped to the demo bucket)
//   npx wrangler secret put B2_APPLICATION_KEY
//   npx wrangler secret put B2_S3_ENDPOINT          (e.g. "s3.us-east-005.backblazeb2.com")
//   npx wrangler secret put B2_REGION               (e.g. "us-east-005")
//
// The B2_APPLICATION_KEY_ID/KEY here should be least-privilege: readFiles + listFiles, scoped
// to only the demo bucket. This Worker never needs write/delete capability on B2.
//
// B2's webhook body shape (subset used here — fields are flat on each event object, verified
// against a live B2-fired webhook, not merely inferred from docs):
//   { events: [ { eventType, bucketName, objectName, objectSize, objectVersionId, ... } ] }
// See: https://www.backblaze.com/apidocs/b2-event-notification-rules
//
// A Vercel Edge Function port of this exact logic lives at ../api/relay.js.

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);

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

    console.log("relay: raw B2 webhook body", JSON.stringify(body));

    // B2's real event-notification payload is flat on each event object — bucketName,
    // objectName, and eventType are top-level fields, NOT nested under an eventData wrapper.
    // Confirmed against a live B2-fired webhook (see the "raw payload (debug)" capture used
    // to fix this); do not reintroduce a nested-field guess here.
    const event = body.events?.[0];
    const info = {
      eventType: event?.eventType ?? "unknown",
      bucketName: event?.bucketName ?? "unknown-bucket",
      objectName: event?.objectName ?? "unknown-object",
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

function isImageKey(objectName) {
  const ext = objectName.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

async function postToDiscord(env, { eventType, bucketName, objectName }) {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("missing DISCORD_WEBHOOK_URL");

  const payload = {
    content: `📦 **B2 event** \`${eventType}\`\nBucket: \`${bucketName}\`\nObject: \`${objectName}\``,
  };

  // Best-effort thumbnail: only attempted for image-shaped keys, and only when the B2 read
  // credentials are configured. A presigning failure here must never block the Discord post
  // itself — fall back to the plain text message.
  if (isImageKey(objectName) && env.B2_APPLICATION_KEY_ID && env.B2_APPLICATION_KEY) {
    try {
      const imageUrl = await presignS3GetObject(env, bucketName, objectName, 3600);
      payload.embeds = [
        {
          title: objectName,
          image: { url: imageUrl },
          color: 0xd0021b, // Backblaze red
        },
      ];
    } catch (err) {
      console.error("relay: thumbnail presign failed (posting without it)", err.message);
    }
  }

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
    const bodyText = await res.text().catch(() => "");
    throw new Error(`GitHub dispatch failed: ${res.status} ${bodyText}`.trim());
  }
}

// --- Minimal AWS SigV4 query-string presigning (GET), using Web Crypto only. --------------
// No AWS SDK dependency — Workers ship Web Crypto natively, and this is the entire surface
// area needed to mint a read-only, time-limited GetObject URL against B2's S3-compatible API.

async function presignS3GetObject(env, bucket, key, expiresSeconds) {
  const host = env.B2_S3_ENDPOINT;
  const region = env.B2_REGION;
  const accessKeyId = env.B2_APPLICATION_KEY_ID;
  const secretKey = env.B2_APPLICATION_KEY;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const canonicalUri = `/${encodeURIComponent(bucket)}/${encodeS3Path(key)}`;
  const queryParams = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(queryParams[k])}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(secretKey, dateStamp, region, "s3");
  const signature = toHex(await hmacRaw(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

async function deriveSigningKey(secretKey, dateStamp, region, service) {
  const enc = new TextEncoder();
  const kDate = await hmacRaw(enc.encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  return hmacRaw(kService, "aws4_request");
}

async function hmacRaw(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return toHex(digest);
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// AWS's flavor of URI encoding: RFC 3986 unreserved chars stay literal, everything else
// (including "!" "*" "'" "(" ")") is percent-encoded, and space must be %20 not "+".
function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// S3 path encoding: encode each path segment with encodeRFC3986, but keep "/" as a literal
// segment separator rather than percent-encoding it.
function encodeS3Path(key) {
  return key.split("/").map(encodeRFC3986).join("/");
}
