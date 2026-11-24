ALTER TABLE safety_events ADD COLUMN closed_reason TEXT CHECK (
  closed_reason IS NULL OR (
    status='closed' AND closed_at IS NOT NULL AND closed_reason IN (
      'geofence_returned','geofence_entry_recorded','fence_disabled','fence_rule_changed',
      'device_unbound','device_reconnected','battery_recovered','location_recovered'
    )
  )
);
