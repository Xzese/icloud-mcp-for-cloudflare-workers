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
  kind TEXT NOT NULL CHECK (kind IN ('bulk_create', 'bulk_delete')),
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
