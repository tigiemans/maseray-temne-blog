import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "../_lib/db.js";
import { json, methodNotAllowed, logError } from "../_lib/http.js";

function stableEventId(rawBody, headerEventId) {
  if (headerEventId) return String(headerEventId);
  return `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
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
  if (depth > 6 || value == null) return null;
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

export default async function handler(request) {
  if (request.method !== "POST") return methodNotAllowed();

  const secret = process.env.MONIME_WEBHOOK_SECRET;
  if (!secret) return json({ error: "Webhook is not configured." }, 503);

  const rawBody = await request.text();
  const suppliedSecret = request.headers.get("x-maseray-webhook-secret");

  // Monime supports custom outbound headers on webhooks. This header is an
  // additional shared-secret gate. The Monime-Signature header is also sent
  // by Monime; its exact signing construction should be implemented only
  // from Monime's current signature-verification guide, not guessed here.
  if (!suppliedSecret || !constantTimeStringEqual(suppliedSecret, secret)) {
    return json({ error: "Unauthorized webhook." }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const eventType = getString(event, ["type", "event", "eventType", "name"]);
  if (eventType !== "payment.completed") {
    return json({ received: true, ignored: true }, 200);
  }

  const reference = findNestedValue(event, ["reference"]);
  const paymentCodeId = findNestedValue(event, ["paymentCodeId", "payment_code_id"]);
  const paymentId = findNestedValue(event, ["paymentId", "payment_id"]);
  const eventId = stableEventId(rawBody, getString(event, ["id", "eventId", "event_id"]));

  if (!reference && !paymentCodeId) {
    return json({ error: "Missing payment reference/payment code identifier." }, 400);
  }

  try {
    const db = sql();

    const inserted = await db`
      INSERT INTO webhook_events (event_id, event_type, payload)
      VALUES (${eventId}, ${eventType}, ${rawBody}::jsonb)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;

    if (inserted.length === 0) {
      return json({ received: true, duplicate: true }, 200);
    }

    const updated = reference
      ? await db`
          UPDATE contributions
          SET status = 'PAID',
              paid_at = COALESCE(paid_at, NOW()),
              monime_status = 'completed',
              webhook_event_id = ${eventId},
              webhook_payload = ${rawBody}::jsonb
          WHERE reference = ${reference}
            AND status <> 'PAID'
          RETURNING id, reference, status
        `
      : await db`
          UPDATE contributions
          SET status = 'PAID',
              paid_at = COALESCE(paid_at, NOW()),
              monime_status = 'completed',
              webhook_event_id = ${eventId},
              webhook_payload = ${rawBody}::jsonb
          WHERE monime_payment_code_id = ${paymentCodeId}
            AND status <> 'PAID'
          RETURNING id, reference, status
        `;

    if (updated.length === 0) {
      console.warn("Payment completed webhook did not match a pending contribution", {
        reference,
        paymentCodeId,
        paymentId,
        eventId,
      });
      return json({ received: true, matched: false }, 200);
    }

    return json({ received: true, matched: true, status: "PAID" }, 200);
  } catch (error) {
    logError("Monime webhook processing failed", error, { eventId });
    return json({ error: "Webhook processing failed." }, 500);
  }
}
