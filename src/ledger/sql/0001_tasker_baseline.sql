INSERT INTO schema_metadata (key, value) VALUES
  ('schema_family', 'tasker'),
  ('schema_baseline', 'product-store-v1')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS aggregate_heads (
  aggregate_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  event_type TEXT NOT NULL,
  event_schema_version INTEGER NOT NULL CHECK (event_schema_version > 0),
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  actor TEXT,
  UNIQUE (aggregate_id, aggregate_version)
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
  snapshot_schema_version INTEGER NOT NULL CHECK (snapshot_schema_version > 0),
  taken_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  UNIQUE (aggregate_id, aggregate_version)
);

CREATE TABLE IF NOT EXISTS projections (
  projection_type TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_sequence INTEGER,
  PRIMARY KEY (projection_type, projection_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  artifact_kind TEXT NOT NULL,
  storage_uri TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parent_artifact_id TEXT REFERENCES artifacts(artifact_id)
);
