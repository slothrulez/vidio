CREATE TABLE IF NOT EXISTS vidio_worker_health (
  worker_id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('demo', 'production')),
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vidio_worker_health_fresh_idx
  ON vidio_worker_health (mode, heartbeat_at DESC);
