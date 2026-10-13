-- Owner-scoped, revisioned service preferences. Apple credentials remain separate.
CREATE TABLE IF NOT EXISTS owner_service_settings (
  owner_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
