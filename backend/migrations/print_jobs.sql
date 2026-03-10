-- Run this in Supabase SQL Editor to create the print_jobs table for the shared print relay.
-- Required for Order Collector + Delivery labels to work across multiple Cloud Run instances.

CREATE TABLE IF NOT EXISTS print_jobs (
  id SERIAL PRIMARY KEY,
  job_id VARCHAR(64) NOT NULL UNIQUE,
  pc_id VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  leased_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  dedup_key VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_print_jobs_job_id ON print_jobs (job_id);
CREATE INDEX IF NOT EXISTS ix_print_jobs_pc_id ON print_jobs (pc_id);
CREATE INDEX IF NOT EXISTS ix_print_jobs_status ON print_jobs (status);
CREATE INDEX IF NOT EXISTS ix_print_jobs_dedup_key ON print_jobs (dedup_key);
CREATE INDEX IF NOT EXISTS ix_print_jobs_created_at ON print_jobs (created_at);
