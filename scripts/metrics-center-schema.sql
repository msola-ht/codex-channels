CREATE TABLE IF NOT EXISTS request_metrics (
  device_id TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT,
  operation TEXT,
  thread_id TEXT,
  turn_id TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  total_tokens INTEGER,
  cache_hit_rate REAL,
  pricing_currency TEXT,
  total_cost_nanos INTEGER,
  payload TEXT NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_request_metrics_recorded
  ON request_metrics (recorded_at_ms);

CREATE INDEX IF NOT EXISTS idx_request_metrics_provider_model
  ON request_metrics (provider, model, recorded_at_ms);

CREATE TABLE IF NOT EXISTS provider_identities (
  device_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_provider_identities_provider
  ON provider_identities (provider);

CREATE TABLE IF NOT EXISTS subagent_threads (
  device_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  parent_thread_id TEXT,
  parent_turn_id TEXT,
  agent_path TEXT,
  recorded_at_ms INTEGER NOT NULL,
  ingested_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_subagent_threads_recorded
  ON subagent_threads (recorded_at_ms);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_ingested_at_ms INTEGER,
  display_name TEXT
);
