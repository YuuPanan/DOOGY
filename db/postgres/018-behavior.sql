CREATE TABLE behavior_records (
  id TEXT PRIMARY KEY NOT NULL, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  media_id TEXT REFERENCES pet_media(id) ON DELETE SET NULL, media_deleted_at TEXT,
  labels_json TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, notes TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source='owner_annotation'), created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX behavior_pet_time ON behavior_records(pet_id,start_at DESC,id DESC);
CREATE TABLE interpretations (
  id TEXT PRIMARY KEY NOT NULL, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  media_id TEXT REFERENCES pet_media(id) ON DELETE SET NULL,
  behavior_record_id TEXT REFERENCES behavior_records(id) ON DELETE SET NULL,
  from_at TEXT NOT NULL, to_at TEXT NOT NULL, background_json TEXT NOT NULL, notes TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','succeeded','failed','cancelled')),
  captured_mode TEXT NOT NULL CHECK(captured_mode IN ('offline','api')), attempt INTEGER NOT NULL CHECK(attempt>0),
  result_json TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', execution_source TEXT, model_version TEXT, error_code TEXT,
  created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);
CREATE INDEX interpretation_queue ON interpretations(status,created_at,id);
CREATE INDEX interpretation_pet ON interpretations(pet_id,created_at DESC,id DESC);
CREATE INDEX interpretation_media ON interpretations(media_id);
