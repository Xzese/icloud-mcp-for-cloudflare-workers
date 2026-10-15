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
