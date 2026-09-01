CREATE TABLE test_fixture_submissions (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  post_count INTEGER NOT NULL DEFAULT 1,
  first_submitted_at TEXT NOT NULL,
  last_submitted_at TEXT NOT NULL
);
