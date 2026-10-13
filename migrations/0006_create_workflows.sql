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
