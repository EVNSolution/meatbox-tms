ALTER TABLE installations
  ADD COLUMN bootstrap_session_id TEXT REFERENCES sessions(id);

CREATE UNIQUE INDEX installations_bootstrap_session_idx
  ON installations(bootstrap_session_id)
  WHERE bootstrap_session_id IS NOT NULL;

INSERT INTO schema_meta(version, applied_at)
VALUES (3, unixepoch());
