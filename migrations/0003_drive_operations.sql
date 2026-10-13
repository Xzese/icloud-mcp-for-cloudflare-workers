-- Additive. Apply after the service-settings migration. Preserves Apple sessions.
CREATE TABLE IF NOT EXISTS drive_operations (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  permission_revision INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  envelope TEXT,
  PRIMARY KEY (owner_id, operation_id)
);
CREATE TABLE IF NOT EXISTS drive_handles (
  owner_id TEXT NOT NULL,
  handle_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  permission_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  PRIMARY KEY (owner_id, handle_id)
);
