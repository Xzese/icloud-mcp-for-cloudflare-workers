-- Tombstones remain non-reusable without repeated cleanup writes or quota scans.
CREATE INDEX IF NOT EXISTS drive_operations_active
  ON drive_operations(owner_id, generation, expires_at) WHERE envelope IS NOT NULL;
