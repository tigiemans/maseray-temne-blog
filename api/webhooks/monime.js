import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "../_lib/db.js";
import { json, methodNotAllowed, logError } from "../_lib/http.js";

const SUCCESS_EVENT_TYPES = new Set([
  "payment.completed",
  "payment_code.completed",
  "payment_code.processed",
  "checkout_session.completed",
]);

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SIGNATURE_AGE_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 30;

function stableEventId(rawBody, headerEventId) {
  if (headerEventId) return String(headerEventId);
  return "sha256:" + createHash("sha256").update(rawBody).digest("hex");
}

function getString(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function findNestedValue(value, keys, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedValue(item, keys, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const direct = getString(value, keys);
  if (direct) return direct;
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, keys, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function constantTimeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function digestEqual(expectedHex, supplied) {
  const value = String(supplied).trim().toLowerCase();
  const expected = Buffer.from(expectedHex, "hex");
  let actual;
  if (/^[0-9a-f]{64}$/.test(value)) actual = Buffer.from(value, "hex");
  else {
    try { actual = Buffer.from(value, "base64"); } catch { return false; }
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function verifyMonimeSignature(request, rawBody, secret) {
  const header = request.headers.get("monime-signature");
  if (!header) return false;

  const parts = new Map();
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) parts.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }

  const timestamp = parts.get("t");
  const headerNames = parts.get("h");
  const supplied = parts.get("v1");
  const timestampSeconds = Number(timestamp);
  if (!timestamp || !headerNames || !supplied || !Number.isSafeInteger(timestampSeconds)) return false;

  const now = Math.floor(Date.now() / 1000);
  const age = now - timestampSeconds;
  if (age > MAX_SIGNATURE_AGE_SECONDS || age < -MAX_FUTURE_SKEW_SECONDS) return false;

  const names = headerNames.split(/\s+/).filter(Boolean);
  const headerValues = names.map((name) => request.headers.get(name) ?? "").join(".");
  const signedPayload = timestampSeconds + "." + headerNames + "." + headerValues + "." + rawBody;
  const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  return supplied.split(/\s+/).some((signature) => digestEqual(expected, signature));
}

function authenticate(request, rawBody, secret) {
  const custom = request.headers.get("x-maseray-webhook-secret");
  if (custom && constantTimeStringEqual(custom, secret)) return "custom-header";
  if (verifyMonimeSignature(request, rawBody, secret)) return "monime-signature";
  return null;
}

export default async function handler(request) {
  if (request.method !== "POST") return methodNotAllowed();

  const secret = process.env.MONIME_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) {
    return json({ error: "Webhook is not configured correctly." }, 503);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return json({ error: "Webhook payload is too large." }, 413);
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "Webhook payload is too large." }, 413);
  }

  const authMethod = authenticate(request, rawBody, secret);
  if (!authMethod) {
    console.error("Monime webhook authentication failed", {
      hasSignature: Boolean(request.headers.get("monime-signature")),
      hasCustomHeader: Boolean(request.headers.get("x-maseray-webhook-secret")),
    });
    return json({ error: "Unauthorized webhook." }, 401);
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON body." }, 400); }

  const eventType = findNestedValue(event, ["type", "event", "eventType", "name"]);
  if (!eventType || !SUCCESS_EVENT_TYPES.has(eventType)) {
    return json({ received: true, ignored: true, eventType }, 200);
  }

  const reference = findNestedValue(event, ["reference", "contributionReference", "orderReference"]);
  const paymentCodeId = findNestedValue(event, [
    "paymentCodeId", "payment_code_id", "checkoutSessionId", "checkout_session_id", "paymentId", "payment_id"
  ]);
  const eventId = stableEventId(rawBody, getString(event, ["id", "eventId", "event_id"]));

  if (!reference && !paymentCodeId) {
    return json({ error: "Missing payment reference/payment identifier." }, 400);
  }

  try {
    const db = sql();

    const insertResult = await db.query(
      "INSERT INTO webhook_events (event_id, event_type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [eventId, eventType, rawBody]
    );

    if (insertResult.length === 0) {
      return json({ received: true, duplicate: true }, 200);
    }

    const updated = reference
      ? await db.query(
          "UPDATE contributions SET status = 'PAID', paid_at = COALESCE(paid_at, NOW()), monime_status = 'completed', webhook_event_id = $1, webhook_payload = $2::jsonb WHERE reference = $3 AND status <> 'PAID' RETURNING id, reference, status",
          [eventId, rawBody, reference]
        )
      : await db.query(
          "UPDATE contributions SET status = 'PAID', paid_at = COALESCE(paid_at, NOW()), monime_status = 'completed', webhook_event_id = $1, webhook_payload = $2::jsonb WHERE monime_payment_code_id = $3 AND status <> 'PAID' RETURNING id, reference, status",
          [eventId, rawBody, paymentCodeId]
        );

    if (updated.length === 0) {
      return json({ received: true, matched: false }, 200);
    }

    return json({ received: true, matched: true, status: "PAID" }, 200);
  } catch (error) {
    logError("Monime webhook processing failed", error, { eventId });
    return json({ error: "Webhook processing failed." }, 500);
  }
}
