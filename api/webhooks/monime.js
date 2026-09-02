import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "../_lib/db.js";
import { json, methodNotAllowed, logError } from "../_lib/http.js";

const MONIME_BASE = "https://api.monime.io/v1";
const VERSION = process.env.MONIME_VERSION || "caph.2025-08-23";
const MAX_BODY_BYTES = 1024 * 1024;

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a).trim());
  const right = Buffer.from(String(b).trim());
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(request) {
  const expected = process.env.MONIME_WEBHOOK_TOKEN || process.env.MONIME_WEBHOOK_SECRET;
  if (!expected || expected.length < 32) return false;

  const candidates = [
    request.headers.get("x-maseray-webhook-token"),
    request.headers.get("x-maseray-webhook-secret"),
    request.headers.get("x-webhook-secret"),
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
  ];

  return candidates.some((value) => safeEqual(value, expected));
}

function eventId(payload, rawBody) {
  return typeof payload?.event?.id === "string" && payload.event.id.trim()
    ? payload.event.id.trim()
    : "sha256:" + createHash("sha256").update(rawBody, "utf8").digest("hex");
}

function eventName(payload) {
  return typeof payload?.event?.name === "string" ? payload.event.name : null;
}

function objectId(payload) {
  return typeof payload?.object?.id === "string" ? payload.object.id : null;
}

function objectType(payload) {
  return typeof payload?.object?.type === "string" ? payload.object.type : null;
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function monimeGet(path) {
  const token = process.env.MONIME_ACCESS_TOKEN;
  const spaceId = process.env.MONIME_SPACE_ID;
  if (!token || !spaceId) throw new Error("Monime API configuration is missing.");

  const response = await fetch(MONIME_BASE + path, {
    headers: {
      Authorization: "Bearer " + token,
      "Monime-Space-Id": spaceId,
      "Monime-Version": VERSION,
    },
    cache: "no-store",
  });

  const data = await response.json().catch(() => null);
  return { response, data };
}

async function verifyPaymentCode(contribution, payload) {
  const id = objectId(payload);
  if (!id || objectType(payload) !== "payment_code") return false;
  if (payload?.data?.id && payload.data.id !== id) return false;

  const remote = await monimeGet("/payment-codes/" + encodeURIComponent(id));
  if (!remote.response.ok || !remote.data?.success || !remote.data?.result) return false;

  const result = remote.data.result;
  if (String(result.status || "").toLowerCase() !== "completed") return false;
  if (result.progress?.isCompleted !== true) return false;

  const amount = numberValue(result.amount?.value);
  const currency = String(result.amount?.currency || "").toUpperCase();
  if (amount === null || amount !== Number(contribution.amount_minor)) return false;
  if (currency !== "SLE") return false;

  const reference = typeof result.reference === "string" ? result.reference : null;
  if (reference && reference !== contribution.reference) return false;

  return true;
}

async function verifyCheckoutSession(contribution, payload) {
  const id = objectId(payload);
  if (!id || objectType(payload) !== "checkout_session") return false;

  const remote = await monimeGet("/checkout-sessions/" + encodeURIComponent(id));
  if (!remote.response.ok || !remote.data?.success || !remote.data?.result) return false;

  const result = remote.data.result;
  if (String(result.status || "").toLowerCase() !== "completed") return false;

  const amount = numberValue(
    result.amount?.value ?? result.lineItems?.data?.[0]?.price?.value
  );
  const currency = String(
    result.amount?.currency ?? result.lineItems?.data?.[0]?.price?.currency ?? ""
  ).toUpperCase();

  if (amount === null || amount !== Number(contribution.amount_minor)) return false;
  if (currency !== "SLE") return false;

  const reference = typeof result.reference === "string" ? result.reference : null;
  if (reference && reference !== contribution.reference) return false;

  return true;
}

export default async function handler(request) {
  if (request.method !== "POST") return methodNotAllowed();

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return json({ error: "Webhook payload is too large." }, 413);
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "Webhook payload is too large." }, 413);
  }

  if (!authenticate(request)) {
    return json({ error: "Unauthorized webhook." }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const name = eventName(payload);
  const supported = new Set([
    "payment_code.created",
    "payment_code.processed",
    "payment_code.completed",
    "payment_code.expired",
    "checkout_session.completed",
  ]);

  if (!name || !supported.has(name)) {
    return json({ received: true, ignored: true, event: name }, 200);
  }

  const id = eventId(payload, rawBody);

  try {
    const db = sql();

    const inserted = await db.query(
      "INSERT INTO webhook_events (event_id, event_type, payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
      [id, name, rawBody]
    );

    if (inserted.length === 0) {
      return json({ received: true, duplicate: true }, 200);
    }

    const resourceId = objectId(payload);

    const rows = resourceId
      ? await db.query(
          "SELECT id, reference, amount_minor, status, monime_payment_code_id, client_request_id FROM contributions WHERE monime_payment_code_id = $1 OR client_request_id = $1 LIMIT 1",
          [resourceId]
        )
      : [];

    const contribution = rows[0];

    if (!contribution) {
      console.warn("Monime webhook has no matching local contribution", {
        eventId: id,
        event: name,
        resourceId,
      });
      return json({ received: true, matched: false }, 200);
    }

    if (contribution.status === "PAID") {
      return json({ received: true, alreadyPaid: true }, 200);
    }

    if (name === "payment_code.created") {
      return json({ received: true, matched: true, status: contribution.status }, 200);
    }

    if (name === "payment_code.processed") {
      await db.query(
        "UPDATE contributions SET monime_status = 'processed', webhook_event_id = $1, webhook_payload = $2::jsonb WHERE id = $3 AND status <> 'PAID'",
        [id, rawBody, contribution.id]
      );
      return json({ received: true, matched: true, status: "PENDING" }, 200);
    }

    if (name === "payment_code.expired") {
      await db.query(
        "UPDATE contributions SET status = 'EXPIRED', monime_status = 'expired', webhook_event_id = $1, webhook_payload = $2::jsonb WHERE id = $3 AND status = 'PENDING'",
        [id, rawBody, contribution.id]
      );
      return json({ received: true, matched: true, status: "EXPIRED" }, 200);
    }

    const verified = name === "payment_code.completed"
      ? await verifyPaymentCode(contribution, payload)
      : await verifyCheckoutSession(contribution, payload);

    if (!verified) {
      console.error("Monime webhook payment verification failed", {
        eventId: id,
        event: name,
        contributionId: contribution.id,
      });
      return json({ received: true, matched: true, verified: false }, 200);
    }

    const updated = await db.query(
      "UPDATE contributions SET status = 'PAID', paid_at = COALESCE(paid_at, NOW()), monime_status = 'completed', webhook_event_id = $1, webhook_payload = $2::jsonb WHERE id = $3 AND status <> 'PAID' RETURNING id, reference, status",
      [id, rawBody, contribution.id]
    );

    return json({
      received: true,
      matched: updated.length > 0,
      status: updated[0]?.status || "PAID",
      verified: true,
    }, 200);
  } catch (error) {
    logError("Monime webhook processing failed", error, { eventId: id, event: name });
    return json({ error: "Webhook processing failed." }, 500);
  }
}

export async function GET() {
  return json({ ok: true, endpoint: "monime-webhook" }, 200);
}
