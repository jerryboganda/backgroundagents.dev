CREATE TABLE bot_webhook_deliveries (
  service TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed')),
  claimed_at_ms INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  PRIMARY KEY (service, delivery_id)
);
