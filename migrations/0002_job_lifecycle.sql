ALTER TABLE vidio_jobs DROP CONSTRAINT IF EXISTS vidio_jobs_status_check;
ALTER TABLE vidio_jobs ADD CONSTRAINT vidio_jobs_status_check
  CHECK(status IN ('queued','running','partially_completed','succeeded','failed','cancelled'));
ALTER TABLE vidio_jobs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5);
CREATE UNIQUE INDEX IF NOT EXISTS vidio_projects_owner_id ON vidio_projects(id,owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS vidio_jobs_owned_id ON vidio_jobs(id,project_id,owner_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vidio_jobs_owned_project') THEN
    ALTER TABLE vidio_jobs ADD CONSTRAINT vidio_jobs_owned_project
      FOREIGN KEY(project_id,owner_id) REFERENCES vidio_projects(id,owner_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vidio_assets_owned_project') THEN
    ALTER TABLE vidio_assets ADD CONSTRAINT vidio_assets_owned_project
      FOREIGN KEY(project_id,owner_id) REFERENCES vidio_projects(id,owner_id) ON DELETE CASCADE;
  END IF;
END $$;
ALTER TABLE vidio_assets DROP CONSTRAINT IF EXISTS vidio_assets_size_check;
ALTER TABLE vidio_assets ALTER COLUMN size TYPE bigint;
ALTER TABLE vidio_assets ADD CONSTRAINT vidio_assets_size_check CHECK(size>0 AND size<=100000000);
ALTER TABLE vidio_assets
  ADD COLUMN IF NOT EXISTS storage_backend text NOT NULL DEFAULT 'local' CHECK(storage_backend IN ('local','s3')),
  ADD COLUMN IF NOT EXISTS storage_key text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS vidio_job_segments (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 4),
  script jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','submitting','submitted','completed','failed')),
  provider_task_id text,
  asset_id uuid REFERENCES vidio_assets(id),
  duration real,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(job_id,ordinal),
  FOREIGN KEY(job_id,project_id,owner_id) REFERENCES vidio_jobs(id,project_id,owner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS vidio_segments_owned ON vidio_job_segments(owner_id,job_id);
CREATE INDEX IF NOT EXISTS vidio_jobs_recovery ON vidio_jobs(status,lease_until,next_attempt_at);
