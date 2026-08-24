import { randomUUID } from "node:crypto";
import { sql } from "./_lib/db.js";
import { json, methodNotAllowed, logError } from "./_lib/http.js";
import { validateContributionInput, formatMajorAmount, SUPPORTED_PROVIDERS } from "./_lib/contributions.js";

const MONIME_URL = "https://api.monime.io/v1/payment-codes";

function buildInstructions(ussdCode, provider, amountMinor) {
  if (!ussdCode) {
    return "Follow the payment instructions provided by Monime to complete your contribution.";
  }
  const providerName = SUPPORTED_PROVIDERS[provider] || "Mobile Money";
  return `Dial ${ussdCode} from your ${providerName} line to complete your SLE ${formatMajorAmount(amountMinor)} contribution.`;
}

export default async function handler(request) {
  if (request.method !== "POST") return methodNotAllowed();

  const token = process.env.MONIME_ACCESS_TOKEN;
  const spaceId = process.env.MONIME_SPACE_ID;
  if (!token || !spaceId) {
    return json({ error: "Payment service is not configured." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  let input;
  try {
    input = validateContributionInput(body);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const clientRequestId = typeof body.clientRequestId === "string"
    ? body.clientRequestId.trim()
    : null;

  if (clientRequestId && !/^[A-Za-z0-9._:-]{8,100}$/.test(clientRequestId)) {
    return json({ error: "clientRequestId must be 8-100 safe characters." }, 400);
  }

  try {
    const db = sql();

    // Idempotency check for existing client request
    if (clientRequestId) {
      const existing = await db`
        SELECT reference, idempotency_key, contribution_type, customer_name,
               amount_minor, payment_provider, monime_payment_code_id,
               ussd_payment_code, monime_status, expires_at, status
        FROM contributions
        WHERE client_request_id = ${clientRequestId}
        LIMIT 1;
      `;
      if (existing.length > 0) {
        const item = existing[0];
        return json({
          success: true,
          replayed: true,
          contribution: {
            type: item.contribution_type,
            name: input.name,
            customerName: item.customer_name,
            amount: Number(item.amount_minor) / 100,
            amountMinor: Number(item.amount_minor),
            currency: "SLE",
            provider: item.payment_provider,
            reference: item.reference,
            status: item.status,
          },
          payment: {
            id: item.monime_payment_code_id,
            ussdCode: item.ussd_payment_code,
            status: item.monime_status,
            amount: { currency: "SLE", value: Number(item.amount_minor) },
            currency: "SLE",
            reference: item.reference,
            expiresAt: item.expires_at,
          },
          instructions: buildInstructions(item.ussd_payment_code, item.payment_provider, item.amount_minor),
        }, 200);
      }
    }

    const reference = `MTB-${randomUUID()}`;
    const idempotencyKey = randomUUID();

    // 1. Insert initial PENDING contribution record
    await db`
      INSERT INTO contributions (
        id, contribution_type, customer_name, amount_minor, currency,
        payment_provider, reference, idempotency_key, client_request_id, status
      ) VALUES (
        ${randomUUID()}, ${input.contributionType}, ${input.customerName},
        ${input.amountMinor.toString()}, 'SLE', ${input.paymentProvider},
        ${reference}, ${idempotencyKey}, ${clientRequestId}, 'PENDING'
      );
    `;

    // 2. Build Monime API Payload
    const payload = {
      name: input.name,
      mode: "one_time",
      enable: true,
      amount: {
        currency: "SLE",
        value: Number(input.amountMinor),
      },
      duration: "10m",
      customer: {
        name: input.customerName,
      },
      reference,
      authorizedProviders: [input.paymentProvider],
      metadata: {
        project: "Maseray Temne Blogger",
        contribution_type: input.contributionType,
        customer_name: input.customerName,
      },
    };

    // 3. Call Monime Create Payment Code API
    const response = await fetch(MONIME_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "Monime-Space-Id": spaceId,
        "Monime-Version": process.env.MONIME_VERSION || "caph.2025-08-23",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success || !data?.result) {
      await db`
        UPDATE contributions
        SET status = 'FAILED', monime_response = ${JSON.stringify(data ?? {})}::jsonb
        WHERE reference = ${reference};
      `;
      console.error("Monime Payment Code creation failed", {
        status: response.status,
        reference,
        monimeRequestId: response.headers.get("Monime-Request-Id"),
      });
      return json({ error: "Unable to create payment request.", reference }, 502);
    }

    const result = data.result;

    // 4. Update contribution with Monime details
    await db`
      UPDATE contributions
      SET
        monime_payment_code_id = ${result.id ?? null},
        ussd_payment_code = ${result.ussdCode ?? null},
        monime_status = ${result.status ?? "pending"},
        expires_at = ${result.expireTime ? new Date(result.expireTime) : null},
        monime_response = ${JSON.stringify(data)}::jsonb
      WHERE reference = ${reference};
    `;

    return json({
      success: true,
      contribution: {
        type: input.contributionType,
        name: input.name,
        customerName: input.customerName,
        amount: Number(input.amountMinor) / 100,
        amountMinor: Number(input.amountMinor),
        currency: "SLE",
        provider: input.paymentProvider,
        reference,
        status: "PENDING",
      },
      payment: {
        id: result.id,
        ussdCode: result.ussdCode,
        status: result.status,
        amount: result.amount,
        currency: result.amount?.currency,
        reference: result.reference,
        expiresAt: result.expireTime,
      },
      instructions: buildInstructions(result.ussdCode, input.paymentProvider, input.amountMinor),
    }, 201);
  } catch (error) {
    logError("Payment Code endpoint failed", error, { contributionType: input.contributionType });
    return json({ error: "Internal payment service error." }, 500);
  }
}
