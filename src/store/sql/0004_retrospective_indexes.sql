CREATE INDEX IF NOT EXISTS idx_stream_events_task_reference_seq
  ON stream_events (task_reference, seq);
