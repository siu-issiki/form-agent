ALTER TABLE jobs
ADD COLUMN allowed_hosts_json TEXT NOT NULL DEFAULT '[]';
