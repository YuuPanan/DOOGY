CREATE TABLE contact_alerts (
  id TEXT PRIMARY KEY NOT NULL, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  message TEXT NOT NULL, captured_mode TEXT NOT NULL CHECK(captured_mode IN ('offline','api')), attempt INTEGER NOT NULL CHECK(attempt>0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX contact_alert_pending ON contact_alerts(expires_at,created_at,id);
CREATE TABLE contact_alert_recipients (
  id TEXT PRIMARY KEY NOT NULL, alert_id TEXT NOT NULL REFERENCES contact_alerts(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES household_contacts(id) ON DELETE SET NULL, contact_version INTEGER NOT NULL CHECK(contact_version>0),
  method TEXT NOT NULL CHECK(method IN ('email','phone')), attempt INTEGER NOT NULL CHECK(attempt>0),
  status TEXT NOT NULL CHECK(status IN ('pending','simulated','failed','cancelled')),
  error_code TEXT, execution_source TEXT, queued_at TEXT NOT NULL, processed_at TEXT,
  UNIQUE(alert_id,contact_id)
);
CREATE INDEX contact_alert_contact ON contact_alert_recipients(contact_id);
CREATE INDEX contact_alert_queue ON contact_alert_recipients(status,alert_id);
