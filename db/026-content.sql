CREATE TABLE content_items (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('plan','tip','guidance','lesson')),
  current_version INTEGER NOT NULL CHECK(current_version > 0), status TEXT NOT NULL CHECK(status IN ('draft','published','withdrawn')),
  revision INTEGER NOT NULL CHECK(revision > 0), updated_at TEXT NOT NULL
);
CREATE TABLE content_versions (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0),
  title TEXT NOT NULL, category TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  publication_status TEXT NOT NULL CHECK(publication_status IN ('draft','published','withdrawn')),
  PRIMARY KEY(content_id,version)
);
CREATE TABLE learning_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content_id TEXT NOT NULL, content_version INTEGER NOT NULL,
  completed_step_ids_json TEXT NOT NULL, learned INTEGER NOT NULL CHECK(learned IN (0,1)), learned_at TEXT,
  version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,content_id,content_version),
  FOREIGN KEY(content_id,content_version) REFERENCES content_versions(content_id,version)
);
