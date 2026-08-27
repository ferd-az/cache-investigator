CREATE TABLE telemetry_corpora (
  id TEXT PRIMARY KEY,
  scenario_version INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  window_from_ms INTEGER NOT NULL,
  window_to_ms INTEGER NOT NULL,
  expected_request_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('seeding', 'ready')),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  seeded_at TEXT
);

CREATE UNIQUE INDEX idx_telemetry_corpora_active
  ON telemetry_corpora(active)
  WHERE active = 1;

CREATE TABLE request_telemetry (
  corpus_id TEXT NOT NULL,
  id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  service TEXT NOT NULL,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  query_json TEXT NOT NULL,
  has_session_id INTEGER NOT NULL CHECK (has_session_id IN (0, 1)),
  session_id TEXT,
  traffic_source TEXT NOT NULL,
  deployment TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  cache_status TEXT NOT NULL CHECK (cache_status IN ('HIT', 'MISS')),
  origin_request INTEGER NOT NULL CHECK (origin_request IN (0, 1)),
  origin_queue_depth INTEGER NOT NULL,
  response_status INTEGER NOT NULL,
  response_latency_ms INTEGER NOT NULL,
  PRIMARY KEY (corpus_id, id),
  FOREIGN KEY (corpus_id) REFERENCES telemetry_corpora(id)
);

CREATE INDEX idx_request_telemetry_time
  ON request_telemetry(corpus_id, timestamp_ms, id);
CREATE INDEX idx_request_telemetry_service_time
  ON request_telemetry(corpus_id, service, timestamp_ms, id);
CREATE INDEX idx_request_telemetry_route_time
  ON request_telemetry(corpus_id, route, timestamp_ms, id);
CREATE INDEX idx_request_telemetry_status_time
  ON request_telemetry(corpus_id, response_status, timestamp_ms, id);

CREATE TABLE deployment_telemetry (
  corpus_id TEXT NOT NULL,
  id TEXT NOT NULL,
  service TEXT NOT NULL,
  environment TEXT NOT NULL,
  version TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  deployed_at_ms INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  PRIMARY KEY (corpus_id, id),
  FOREIGN KEY (corpus_id) REFERENCES telemetry_corpora(id)
);

CREATE INDEX idx_deployment_telemetry_time
  ON deployment_telemetry(corpus_id, deployed_at_ms, id);
CREATE INDEX idx_deployment_telemetry_service_time
  ON deployment_telemetry(corpus_id, service, deployed_at_ms, id);

CREATE TABLE dependency_telemetry (
  corpus_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  service TEXT NOT NULL,
  dependency TEXT NOT NULL,
  latency_p99_ms INTEGER NOT NULL,
  error_rate REAL NOT NULL,
  healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
  PRIMARY KEY (corpus_id, timestamp_ms, dependency),
  FOREIGN KEY (corpus_id) REFERENCES telemetry_corpora(id)
);

CREATE INDEX idx_dependency_telemetry_service_time
  ON dependency_telemetry(corpus_id, service, timestamp_ms, dependency);
