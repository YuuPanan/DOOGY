CREATE TABLE pet_goals (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  targets_json TEXT NOT NULL, plan_json TEXT, source TEXT NOT NULL,
  created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(pet_id,effective_date,version)
);
CREATE INDEX goals_pet_date ON pet_goals(pet_id,effective_date DESC,version DESC);
CREATE TABLE body_check_ins (
  id TEXT PRIMARY KEY, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL, timezone TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  observed_at TEXT NOT NULL, values_json TEXT NOT NULL, notes TEXT NOT NULL,
  toileting_record_id TEXT REFERENCES care_records(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(pet_id,local_date,timezone,version)
);
