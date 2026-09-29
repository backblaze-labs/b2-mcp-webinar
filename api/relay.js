// B2 event relay — Vercel Edge Function. Identical logic to ../relay/relay.js (the Cloudflare
// Worker version); only the env-var access and export shape differ per platform. Use this
// file instead of the Worker if you already have a Vercel project you'd rather deploy into.
//
// Receives B2's raw event-notification webhook and does two things directly, at the edge:
//   1. Posts a formatted message to a Discord channel — including an inline image preview
//      when the uploaded object looks like an image, via a short-lived presigned GetObject
//      URL (Discord fetches the bytes itself; they never pass through this function).
//   2. Triggers a GitHub Actions workflow via `repository_dispatch` (GitHub's only inbound
//      trigger surface for a system outside GitHub — it requires an Authorization header and
//      a fixed { event_type, client_payload } body, which is why this translation step has to
//      exist at all; B2 can't send that shape itself).
//
// Deploy: `npx vercel deploy --prod` from the repo root.
// Set env vars once (Project Settings -> Environment Variables, or via CLI):
//   npx vercel env add DISCORD_WEBHOOK_URL
//   npx vercel env add GITHUB_TOKEN            (classic PAT, `repo` scope — see README)
//   npx vercel env add GITHUB_REPO             (value: "backblaze-labs/b2-mcp-webinar")
//   npx vercel env add B2_APPLICATION_KEY_ID    (a READ-ONLY key scoped to the demo bucket)
//   npx vercel env add B2_APPLICATION_KEY
//   npx vercel env add B2_S3_ENDPOINT          (e.g. "s3.us-east-005.backblazeb2.com")
//   npx vercel env add B2_REGION               (e.g. "us-east-005")
//
// B2's webhook body shape (subset used here):
//   { events: [ { eventType, eventData: { bucketName, objectName, ... } } ] }
// See: https://www.backblaze.com/apidocs/b2-event-notification-rules

export const config = { runtime: "edge" };

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);

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
    const reasons = failures.map((f) => String(f.reason?.message ?? f.reason));
    console.error("relay: partial failure", reasons);
    return new Response(`ok, with ${failures.length} downstream failure(s): ${reasons.join("; ")}`, {
      status: 207,
    });
  }

  return new Response("ok");
}

function isImageKey(objectName) {
  const ext = objectName.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

async function postToDiscord({ eventType, bucketName, objectName }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("missing DISCORD_WEBHOOK_URL");

  const payload = {
    content: `📦 **B2 event** \`${eventType}\`\nBucket: \`${bucketName}\`\nObject: \`${objectName}\``,
  };

  if (isImageKey(objectName) && process.env.B2_APPLICATION_KEY_ID && process.env.B2_APPLICATION_KEY) {
    try {
      const imageUrl = await presignS3GetObject(bucketName, objectName, 3600);
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

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`GitHub dispatch failed: ${res.status} ${bodyText}`.trim());
  }
}

// --- Minimal AWS SigV4 query-string presigning (GET), using Web Crypto only. --------------
// No AWS SDK dependency — Vercel's Edge runtime ships Web Crypto natively, and this is the
// entire surface area needed to mint a read-only, time-limited GetObject URL against B2's
// S3-compatible API. Identical algorithm to relay/relay.js's Cloudflare Worker version.

async function presignS3GetObject(bucket, key, expiresSeconds) {
  const host = process.env.B2_S3_ENDPOINT;
  const region = process.env.B2_REGION;
  const accessKeyId = process.env.B2_APPLICATION_KEY_ID;
  const secretKey = process.env.B2_APPLICATION_KEY;

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

function encodeRFC3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(key) {
  return key.split("/").map(encodeRFC3986).join("/");
}
