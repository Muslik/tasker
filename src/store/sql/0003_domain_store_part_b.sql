CREATE TABLE IF NOT EXISTS documents (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id, revision)
);

CREATE INDEX IF NOT EXISTS idx_documents_kind_id_revision_desc
  ON documents (kind, id, revision DESC);

DROP TABLE IF EXISTS projections;
DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS aggregate_heads;
