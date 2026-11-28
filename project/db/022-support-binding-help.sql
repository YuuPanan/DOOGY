DROP TRIGGER revoke_grants_after_member_removal;
DROP TRIGGER revoke_grants_after_device_unbind;

CREATE TEMP TABLE support_ticket_history_backup AS
SELECT rowid AS history_rowid,id,ticket_id,actor_id,status,reply,created_at FROM support_ticket_history;
DROP TABLE support_ticket_history;

CREATE TABLE support_tickets_new (
  id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id), pet_id TEXT REFERENCES pets(id),
  binding_id TEXT REFERENCES device_bindings(id), created_by TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  diagnostics_consented_at TEXT, diagnostics_expires_at TEXT, diagnostics_revoked_at TEXT, diagnostics_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CONSTRAINT support_ticket_binding_context CHECK (
    (device_id IS NOT NULL AND pet_id IS NOT NULL AND binding_id IS NOT NULL)
    OR (device_id IS NULL AND pet_id IS NULL AND binding_id IS NULL AND category='binding'
        AND diagnostics_consented_at IS NULL AND diagnostics_expires_at IS NULL
        AND diagnostics_revoked_at IS NULL AND diagnostics_json IS NULL)
  )
);
INSERT INTO support_tickets_new(rowid,id,device_id,pet_id,binding_id,created_by,category,description,status,
  diagnostics_consented_at,diagnostics_expires_at,diagnostics_revoked_at,diagnostics_json,created_at,updated_at)
SELECT rowid,id,device_id,pet_id,binding_id,created_by,category,description,status,
  diagnostics_consented_at,diagnostics_expires_at,diagnostics_revoked_at,diagnostics_json,created_at,updated_at FROM support_tickets;
DROP TABLE support_tickets;
ALTER TABLE support_tickets_new RENAME TO support_tickets;
CREATE INDEX support_ticket_creator ON support_tickets(created_by,created_at DESC,id DESC);
CREATE INDEX support_ticket_status ON support_tickets(status,created_at DESC,id DESC);

CREATE TABLE support_ticket_history (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id), actor_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL, reply TEXT NOT NULL, created_at TEXT NOT NULL
);
INSERT INTO support_ticket_history(rowid,id,ticket_id,actor_id,status,reply,created_at)
SELECT history_rowid,id,ticket_id,actor_id,status,reply,created_at FROM temp.support_ticket_history_backup;
DROP TABLE temp.support_ticket_history_backup;
CREATE INDEX support_history_ticket ON support_ticket_history(ticket_id,created_at,id);

CREATE TRIGGER revoke_grants_after_member_removal
AFTER DELETE ON household_members
BEGIN
  UPDATE location_shares
  SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE created_by=OLD.user_id AND revoked_at IS NULL
    AND pet_id IN (SELECT id FROM pets WHERE household_id=OLD.household_id);
  UPDATE support_tickets
  SET diagnostics_revoked_at=COALESCE(diagnostics_revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      diagnostics_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE created_by=OLD.user_id AND diagnostics_consented_at IS NOT NULL
    AND (diagnostics_json IS NOT NULL OR diagnostics_revoked_at IS NULL)
    AND pet_id IN (SELECT id FROM pets WHERE household_id=OLD.household_id);
END;

CREATE TRIGGER revoke_grants_after_device_unbind
AFTER UPDATE OF unbound_at ON device_bindings
WHEN OLD.unbound_at IS NULL AND NEW.unbound_at IS NOT NULL
BEGIN
  UPDATE location_shares
  SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE binding_id=OLD.id AND revoked_at IS NULL;
  UPDATE support_tickets
  SET diagnostics_revoked_at=COALESCE(diagnostics_revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      diagnostics_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE binding_id=OLD.id AND diagnostics_consented_at IS NOT NULL
    AND (diagnostics_json IS NOT NULL OR diagnostics_revoked_at IS NULL);
END;
