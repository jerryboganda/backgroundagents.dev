-- Atomic delivery claims for the GitHub bot. Processing claims expire so a
-- manually redelivered webhook can recover after a crashed worker.
CREATE TABLE github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  claim_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed')),
  expires_at_ms INTEGER NOT NULL
);

CREATE INDEX github_webhook_deliveries_expiry_idx ON github_webhook_deliveries(expires_at_ms);
