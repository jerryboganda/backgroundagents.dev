-- Atomic with the session index insert, so a lost response cannot create a second session.
ALTER TABLE sessions ADD COLUMN creation_idempotency_key TEXT;
CREATE UNIQUE INDEX idx_sessions_creation_idempotency_key
  ON sessions(creation_idempotency_key)
  WHERE creation_idempotency_key IS NOT NULL;
