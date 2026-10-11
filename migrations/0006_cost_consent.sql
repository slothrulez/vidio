-- Single-use, server-issued human approvals for paid MCP steps.
CREATE TABLE IF NOT EXISTS vidio_cost_consents (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  operation text NOT NULL CHECK (operation IN ('start_video_job','regenerate_segment','compose_final_video')),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS vidio_cost_consents_owner ON vidio_cost_consents(owner_id, used_at, expires_at);
