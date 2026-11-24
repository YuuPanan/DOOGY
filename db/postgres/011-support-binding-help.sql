ALTER TABLE support_tickets
  ALTER COLUMN device_id DROP NOT NULL,
  ALTER COLUMN pet_id DROP NOT NULL,
  ALTER COLUMN binding_id DROP NOT NULL,
  ADD CONSTRAINT support_ticket_binding_context CHECK (
    (device_id IS NOT NULL AND pet_id IS NOT NULL AND binding_id IS NOT NULL)
    OR (device_id IS NULL AND pet_id IS NULL AND binding_id IS NULL AND category='binding'
        AND diagnostics_consented_at IS NULL AND diagnostics_expires_at IS NULL
        AND diagnostics_revoked_at IS NULL AND diagnostics_json IS NULL)
  );
