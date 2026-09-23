DROP INDEX IF EXISTS installations_bootstrap_session_idx;

ALTER TABLE installations
  ADD COLUMN bootstrap_key_hash TEXT;

ALTER TABLE installations
  ADD COLUMN proof_recovery_cipher TEXT;

ALTER TABLE installations
  ADD COLUMN proof_retry_until INTEGER;

CREATE UNIQUE INDEX installations_bootstrap_key_idx
  ON installations(bootstrap_key_hash)
  WHERE bootstrap_key_hash IS NOT NULL;

INSERT INTO schema_meta(version, applied_at)
VALUES (4, unixepoch());
