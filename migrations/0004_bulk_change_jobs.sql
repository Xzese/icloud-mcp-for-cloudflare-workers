-- Rebuild the immutable job-kind constraint while preserving rows and dependent ledgers.
-- D1 applies migrations transactionally and defers child foreign keys until the same parent name is restored.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE reminder_jobs_expanded (
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

INSERT INTO reminder_jobs_expanded SELECT owner_id, account_scope, job_id, job_key, kind, generation, state, revision, manifest_hash, item_count, input_bytes, expires_at, cancel_requested, next_eligible_at, lease_id, lease_until, mutation_id, created_at, updated_at FROM reminder_jobs;

CREATE TABLE reminder_job_items_expanded (
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
  FOREIGN KEY (owner_id, job_id) REFERENCES reminder_jobs_expanded(owner_id, job_id)
);
INSERT INTO reminder_job_items_expanded SELECT owner_id, job_id, ordinal, item_key_hash, input_hash, input_envelope, result_envelope, mutation_envelope, state, attempts, dispatch_phase, next_attempt_at, reconciliation_status FROM reminder_job_items;

CREATE TABLE reminder_job_chunks_expanded (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  chunk_key TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  accepted_revision INTEGER NOT NULL,
  PRIMARY KEY (owner_id, job_id, chunk_key),
  FOREIGN KEY (owner_id, job_id) REFERENCES reminder_jobs_expanded(owner_id, job_id)
);
INSERT INTO reminder_job_chunks_expanded SELECT owner_id, job_id, chunk_key, chunk_hash, accepted_revision FROM reminder_job_chunks;

CREATE TABLE reminder_job_outbox_expanded (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, job_id),
  FOREIGN KEY (owner_id, job_id) REFERENCES reminder_jobs_expanded(owner_id, job_id)
);
INSERT INTO reminder_job_outbox_expanded SELECT owner_id, job_id, revision, next_eligible_at FROM reminder_job_outbox;

DROP TABLE reminder_job_outbox;
DROP TABLE reminder_job_chunks;
DROP TABLE reminder_job_items;
DROP TABLE reminder_jobs;
ALTER TABLE reminder_jobs_expanded RENAME TO reminder_jobs;
ALTER TABLE reminder_job_items_expanded RENAME TO reminder_job_items;
ALTER TABLE reminder_job_chunks_expanded RENAME TO reminder_job_chunks;
ALTER TABLE reminder_job_outbox_expanded RENAME TO reminder_job_outbox;
CREATE INDEX IF NOT EXISTS reminder_job_selection ON reminder_job_items(owner_id, job_id, state, ordinal);
CREATE INDEX IF NOT EXISTS reminder_job_owners ON reminder_jobs(owner_id, state);

