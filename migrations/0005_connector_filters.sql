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
