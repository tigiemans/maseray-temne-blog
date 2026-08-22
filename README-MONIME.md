# Maseray Temne Blogger — Monime Payment Code backend

This is a drop-in Vercel Functions backend for the existing static Maseray Temne Blogger site.

## Current architecture

Browser/USSD flow -> `POST /api/payment-codes` -> Monime Payment Codes API
Monime `payment.completed` webhook -> `POST /api/webhooks/monime` -> Postgres -> contribution `PAID`

The frontend/USSD flow remains separate. Do not put Monime credentials in it.

## Required Vercel environment variables

- `MONIME_ACCESS_TOKEN` — Monime test token for testing; live token for production.
- `MONIME_SPACE_ID` — Monime Space ID (`spc-...`).
- `MONIME_WEBHOOK_SECRET` — a new random 32+ character secret used as a custom webhook header.
- `DATABASE_URL` — Postgres connection string from the Vercel Marketplace/Neon integration.
- `MAX_CONTRIBUTION_SLE` — optional, default `1000000`.
- `MONIME_VERSION` — optional, default `caph.2025-08-23`.

Never put any of the first four values in HTML, USSD JSON, or browser JavaScript.

## Database

Install a Postgres integration in Vercel (Neon is a good fit) and run `sql/001_contributions.sql` in the database SQL editor.

## API

`POST /api/payment-codes`

Example request:

```json
{
  "contributionType": "birthday",
  "customerName": "Musa Kamara",
  "amount": "500",
  "paymentProvider": "m17",
  "clientRequestId": "ussd-session-unique-id"
}
```

The backend maps `birthday` to `Birthday Contribution`, converts SLE 500 to 50000 minor units, creates a unique reference and idempotency key, stores a PENDING contribution, and calls Monime server-side. If the USSD system can provide a stable request/session ID, pass it as `clientRequestId`; retries of the same logical request will return the existing payment instead of creating a second one.

Response includes the Monime payment code ID, USSD code, status, amount, reference, and expiry.

## Webhook

Exact production URL:

`https://maseray-temne-blog.vercel.app/api/webhooks/monime`

Configure a Monime webhook for `payment.completed` and add an outbound custom header:

`X-Maseray-Webhook-Secret: <same value as MONIME_WEBHOOK_SECRET>`

The backend also receives Monime's `Monime-Signature` header. Do not invent or alter its verification algorithm; use Monime's current webhook signature-verification guide when implementing built-in signature verification.

## Existing USSD flow

Keep the existing contribution selection, name, amount, provider and confirmation screens.

At the final confirmation step, send the selected values to:

`POST https://maseray-temne-blog.vercel.app/api/payment-codes`

Then show the returned `payment.ussdCode` and `instructions`.

Do not mark the contribution as paid from this response. Only the verified `payment.completed` webhook changes the database status to `PAID`.

## Test

Use a Monime test/sandbox token first. Never use a real live token for the first integration test.

Health check:

`GET /api/health`

Payment-code request:

```bash
curl -X POST "https://maseray-temne-blog.vercel.app/api/payment-codes" \
  -H "Content-Type: application/json" \
  -d '{"contributionType":"birthday","customerName":"Musa Kamara","amount":"500","paymentProvider":"m17"}'
```

For a real end-to-end test, use Monime's test environment and a supported test payment method. Do not call a contribution `PAID` just because the Payment Code was created.
