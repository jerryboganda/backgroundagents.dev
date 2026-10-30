-- Preserve the original DO init request in the same transaction as the session index.
ALTER TABLE sessions ADD COLUMN creation_init_payload TEXT;
