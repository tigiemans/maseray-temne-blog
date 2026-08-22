CREATE TABLE IF NOT EXISTS contributions (
  id UUID PRIMARY KEY,
  contribution_type VARCHAR(40) NOT NULL,
  customer_name VARCHAR(100) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL DEFAULT 'SLE',
  payment_provider VARCHAR(20) NOT NULL,
  monime_payment_code_id VARCHAR(100),
  ussd_payment_code VARCHAR(100),
  reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,
  client_request_id VARCHAR(100) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  monime_status VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  monime_response JSONB,
  webhook_event_id VARCHAR(255),
  webhook_payload JSONB,
  CONSTRAINT contributions_status_check
    CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED'))
);

CREATE INDEX IF NOT EXISTS contributions_status_idx
  ON contributions(status);

CREATE INDEX IF NOT EXISTS contributions_payment_code_idx
  ON contributions(monime_payment_code_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
