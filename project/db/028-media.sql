CREATE TABLE pet_media (
  id TEXT PRIMARY KEY NOT NULL, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  sha256 TEXT NOT NULL, content_base64 TEXT NOT NULL, duration_seconds REAL NOT NULL CHECK(duration_seconds > 0),
  captured_at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('owner_upload','synthetic')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL, validation_json TEXT NOT NULL
);
CREATE INDEX pet_media_history ON pet_media(pet_id,created_at,id);
