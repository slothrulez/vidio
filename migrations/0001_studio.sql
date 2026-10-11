CREATE TABLE IF NOT EXISTS vidio_projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vidio_projects_owner ON vidio_projects(owner_id);
CREATE TABLE IF NOT EXISTS vidio_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vidio_projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  operation text NOT NULL,
  input jsonb NOT NULL,
  input_hash text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  progress integer NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  queue_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS vidio_jobs_dispatch ON vidio_jobs(status,queue_id);
CREATE TABLE IF NOT EXISTS vidio_assets (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES vidio_projects(id) ON DELETE CASCADE,
  mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','video/mp4','audio/mpeg')),
  size integer NOT NULL CHECK(size>0 AND size<=6000000)
);
