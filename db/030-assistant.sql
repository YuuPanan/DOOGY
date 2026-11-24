CREATE TABLE assistant_conversations (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX assistant_user_pet ON assistant_conversations(user_id,pet_id,created_at DESC,id DESC);
CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  question TEXT NOT NULL, context_json TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}',
  media_id TEXT REFERENCES pet_media(id) ON DELETE SET NULL,
  behavior_record_id TEXT REFERENCES behavior_records(id) ON DELETE SET NULL,
  interpretation_id TEXT REFERENCES interpretations(id) ON DELETE SET NULL,
  lesson_id TEXT REFERENCES content_items(id) ON DELETE SET NULL, lesson_version INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','succeeded','failed','cancelled')),
  captured_mode TEXT NOT NULL CHECK(captured_mode IN ('offline','api')), attempt INTEGER NOT NULL CHECK(attempt>0),
  result_json TEXT, execution_source TEXT, model_version TEXT, error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);
CREATE INDEX assistant_message_order ON assistant_messages(conversation_id,created_at DESC,id DESC);
CREATE INDEX assistant_pending ON assistant_messages(status,created_at,id);
