CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'running',
      'submitting',
      'sent',
      'prohibited',
      'uncertain',
      'failed',
      'dead_lettered'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  run_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE results (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('sent', 'prohibited', 'uncertain', 'failed')
  ),
  form_url TEXT,
  reason_code TEXT,
  reason TEXT,
  completed_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX events_job_id_created_at
  ON events(job_id, created_at);
