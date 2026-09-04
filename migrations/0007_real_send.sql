ALTER TABLE jobs
ADD COLUMN real_send INTEGER NOT NULL DEFAULT 0;

CREATE INDEX jobs_real_send_created_at
  ON jobs(real_send, created_at);
