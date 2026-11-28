CREATE TABLE password_recovery_requests (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL CHECK(length(email_hash)=64), captured_mode TEXT NOT NULL CHECK(captured_mode IN ('offline','api')),
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('pending_local_delivery','offline_demo','skipped','not_configured')),
  token_hash TEXT UNIQUE CHECK(token_hash IS NULL OR length(token_hash)=64), failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, delivered_at TEXT, verified_at TEXT, consumed_at TEXT, invalidated_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX password_recovery_user ON password_recovery_requests(user_id,created_at,id);
CREATE INDEX password_recovery_expiry ON password_recovery_requests(expires_at);
