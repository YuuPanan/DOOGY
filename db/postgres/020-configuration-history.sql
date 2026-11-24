CREATE TABLE pet_configuration_history (
  id TEXT PRIMARY KEY NOT NULL, pet_id TEXT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0), kind TEXT NOT NULL CHECK(kind IN ('geofence','reporting_policy')),
  resource_id TEXT NOT NULL, binding_id TEXT, command_id TEXT,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user','system')), actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL, before_version INTEGER, after_version INTEGER,
  before_json TEXT, after_json TEXT, changed_fields_json TEXT NOT NULL, changed_at TEXT NOT NULL,
  UNIQUE(pet_id,version)
);
CREATE INDEX configuration_history_time ON pet_configuration_history(pet_id,changed_at);
