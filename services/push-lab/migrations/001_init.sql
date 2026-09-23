CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  baseline_at INTEGER NOT NULL,
  eta_at INTEGER,
  expires_at INTEGER NOT NULL,
  deliverable INTEGER NOT NULL DEFAULT 1 CHECK (deliverable IN (0, 1)),
  CHECK (eta_at IS NULL OR eta_at >= baseline_at)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  csrf_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_deliveries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, delivery_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  exchange_key_hash TEXT,
  session_id TEXT REFERENCES sessions(id),
  retry_cipher TEXT,
  retry_until INTEGER
);

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  proof_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider = 'fcm'),
  project_id TEXT NOT NULL,
  fcm_fid TEXT NOT NULL,
  fid_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  installation_id TEXT NOT NULL REFERENCES installations(id),
  consent_version TEXT NOT NULL,
  subscribed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (delivery_id, installation_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  revision INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS self_test_requests (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, delivery_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  notification_type TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  deliverable INTEGER NOT NULL DEFAULT 1 CHECK (deliverable IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('queued','sending','retrying','accepted','unknown','expired','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  selected_fid TEXT,
  selected_fid_version INTEGER,
  retry_at INTEGER,
  last_error_class TEXT,
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_id, subscription_id, notification_type)
);

CREATE INDEX IF NOT EXISTS outbox_claim_idx
  ON outbox(status, available_at, retry_at, expires_at);

CREATE TABLE IF NOT EXISTS send_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(id),
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  provider_message_id TEXT,
  error_class TEXT
);

CREATE TABLE IF NOT EXISTS worker_state (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_meta(version, applied_at)
VALUES (1, unixepoch());
