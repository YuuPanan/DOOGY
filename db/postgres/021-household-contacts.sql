CREATE TABLE household_contacts (
  id TEXT PRIMARY KEY NOT NULL, household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL, role_description TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '',
  phone TEXT, email TEXT, is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
  consent_status TEXT NOT NULL CHECK(consent_status IN ('unknown','reported_granted','reported_revoked')),
  consent_reported_by TEXT REFERENCES users(id) ON DELETE SET NULL, consent_reported_at TEXT, consent_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK(version > 0), created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(phone IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX household_primary_contact ON household_contacts(household_id) WHERE is_primary=1;
CREATE INDEX household_contact_history ON household_contacts(household_id,created_at DESC,id DESC);
