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
