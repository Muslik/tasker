CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  task_reference TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  stream TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  recorded_at TEXT NOT NULL,
  UNIQUE (operation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_transcripts_operation_seq
  ON transcripts (operation_id, seq);

CREATE INDEX IF NOT EXISTS idx_transcripts_task_reference
  ON transcripts (task_reference);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  task_reference TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  block_run INTEGER NOT NULL CHECK (block_run > 0),
  block_reference TEXT NOT NULL,
  verdict TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_workflow_run
  ON receipts (workflow_id, run_id);

CREATE INDEX IF NOT EXISTS idx_receipts_task_reference
  ON receipts (task_reference);

ALTER TABLE artifacts ADD COLUMN task_reference TEXT;

CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_kind
  ON artifacts (artifact_kind);

CREATE INDEX IF NOT EXISTS idx_artifacts_task_reference
  ON artifacts (task_reference);

CREATE TABLE IF NOT EXISTS agent_invocations (
  invocation_id TEXT PRIMARY KEY,
  task_reference TEXT NOT NULL,
  node_id TEXT,
  block_run INTEGER NOT NULL CHECK (block_run > 0),
  episode_id TEXT,
  status TEXT NOT NULL,
  model TEXT,
  profile TEXT,
  prompt_bytes INTEGER CHECK (prompt_bytes IS NULL OR prompt_bytes >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  usage_json TEXT,
  cost_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  payload_artifact_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_invocations_task_reference
  ON agent_invocations (task_reference);

CREATE INDEX IF NOT EXISTS idx_agent_invocations_episode_run
  ON agent_invocations (episode_id, block_run);

CREATE TABLE IF NOT EXISTS stream_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_reference TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stream_events_seq
  ON stream_events (seq);
