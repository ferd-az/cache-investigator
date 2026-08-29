CREATE TABLE investigation_interrupt_deliveries (
  investigation_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('slack')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempted_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  PRIMARY KEY (investigation_id, transport),
  FOREIGN KEY (investigation_id) REFERENCES investigations(id)
);

CREATE INDEX idx_investigation_interrupt_deliveries_status
  ON investigation_interrupt_deliveries(status, attempted_at);
