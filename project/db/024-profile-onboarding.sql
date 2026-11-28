CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT, version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL
);
CREATE TABLE user_consents (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL, privacy_version TEXT NOT NULL, accepted_at TEXT NOT NULL, source TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), UNIQUE(user_id,version)
);
CREATE INDEX user_consent_history ON user_consents(user_id,accepted_at,id);
CREATE TABLE user_onboarding (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id TEXT REFERENCES pets(id) ON DELETE SET NULL,
  collar_choice TEXT CHECK(collar_choice IN ('skipped','completed')),
  completed_at TEXT, version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL
);
CREATE TABLE pet_avatars (
  pet_id TEXT PRIMARY KEY NOT NULL REFERENCES pets(id) ON DELETE CASCADE, id TEXT UNIQUE NOT NULL,
  content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL, content_base64 TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0), created_by TEXT REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL
);
