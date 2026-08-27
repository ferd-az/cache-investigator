CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'no_findings', 'failed')
  ),
  trigger_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  plan_json TEXT NOT NULL,
  finding_json TEXT,
  checkpoint_json TEXT
);

CREATE INDEX idx_investigations_status_created
  ON investigations(status, created_at);

CREATE TABLE investigation_events (
  investigation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (investigation_id, id),
  UNIQUE (investigation_id, operation_key),
  UNIQUE (investigation_id, sequence),
  FOREIGN KEY (investigation_id) REFERENCES investigations(id)
);

CREATE INDEX idx_investigation_events_sequence
  ON investigation_events(investigation_id, sequence);
