-- Keep processed webhook dedupe markers for seven days; preserve active claims.
ALTER TABLE bot_webhook_deliveries ADD COLUMN processed_at_ms INTEGER;
UPDATE bot_webhook_deliveries SET processed_at_ms = claimed_at_ms WHERE status = 'processed';
CREATE INDEX bot_webhook_deliveries_retention_idx
  ON bot_webhook_deliveries(service, status, processed_at_ms);
