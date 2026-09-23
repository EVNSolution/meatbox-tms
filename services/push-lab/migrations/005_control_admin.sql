CREATE TABLE admin_login_challenges (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE admin_login_failures (
  source TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);
INSERT INTO schema_meta(version, applied_at) VALUES (5, unixepoch());
