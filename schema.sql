-- Current schema for a new iCloud Reminders deployment.
-- Reapplying this file preserves existing tables and session data.
CREATE TABLE IF NOT EXISTS apple_session_state (
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'DISCONNECTED',
  action TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  envelope TEXT,
  transaction_id TEXT,
  transaction_expires_at INTEGER,
  resume_id TEXT,
  resume_expires_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, account_id)
);

-- Job infrastructure is additive; the existing Apple session envelope is unchanged.
CREATE TABLE IF NOT EXISTS reminder_jobs (
  owner_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bulk_create', 'bulk_delete', 'bulk_update', 'bulk_complete')),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, job_id),
  UNIQUE (owner_id, account_scope, job_key)
);
CREATE TABLE IF NOT EXISTS reminder_job_items (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  item_key_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_envelope TEXT,
  result_envelope TEXT,
  mutation_envelope TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  dispatch_phase TEXT NOT NULL DEFAULT 'not_submitted',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  reconciliation_status TEXT NOT NULL DEFAULT 'not_needed',
  PRIMARY KEY (owner_id, job_id, ordinal),
  UNIQUE (owner_id, job_id, item_key_hash),
  FOREIGN KEY (owner_id, job_id) REFERENCES reminder_jobs(owner_id, job_id)
);
CREATE TABLE IF NOT EXISTS reminder_job_receipts (
  owner_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, account_scope, key_hash)
);
CREATE TABLE IF NOT EXISTS reminder_job_chunks (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  chunk_key TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  accepted_revision INTEGER NOT NULL,
  PRIMARY KEY (owner_id, job_id, chunk_key),
  FOREIGN KEY (owner_id, job_id) REFERENCES reminder_jobs(owner_id, job_id)
);
CREATE TABLE IF NOT EXISTS reminder_job_outbox (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, job_id),
  FOREIGN KEY (owner_id, job_id) REFERENCES reminder_jobs(owner_id, job_id)
);
CREATE TABLE IF NOT EXISTS reminder_job_accounts (
  owner_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, account_scope)
);
CREATE INDEX IF NOT EXISTS reminder_job_selection ON reminder_job_items(owner_id, job_id, state, ordinal);
CREATE INDEX IF NOT EXISTS reminder_job_owners ON reminder_jobs(owner_id, state);
-- Connector filters are independent of the Apple session and store only authenticated ciphertext.
CREATE TABLE IF NOT EXISTS connector_filters (
  owner_id TEXT NOT NULL,
  filter_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, filter_id)
);

CREATE INDEX IF NOT EXISTS connector_filters_owner_order
ON connector_filters(owner_id, created_at, filter_id);
-- Content and exact Apple versions live only in the authenticated envelope.
CREATE TABLE IF NOT EXISTS reminder_create_workflows (
  owner_scope TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'paused', 'completed', 'blocked', 'recovery_required')),
  envelope TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_scope, workflow_id)
);
-- Exact source snapshots and all operation stages are stored only in the encrypted envelope.
CREATE TABLE IF NOT EXISTS reminder_list_duplications (
  owner_scope TEXT NOT NULL,
  duplication_id TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('preparing', 'active', 'uncertain', 'completed')),
  envelope TEXT NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_scope, duplication_id)
);

-- Owner-scoped, revisioned service preferences. Apple credentials remain separate.
CREATE TABLE IF NOT EXISTS owner_service_settings (
  owner_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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

-- Encrypted, bounded, temporary MCP upload staging. No Apple session changes.
CREATE TABLE IF NOT EXISTS drive_upload_chunks (
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  PRIMARY KEY (owner_id, operation_id, byte_offset),
  FOREIGN KEY (owner_id, operation_id) REFERENCES drive_operations(owner_id, operation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_upload_chunks_expiry ON drive_upload_chunks(owner_id, expires_at);
