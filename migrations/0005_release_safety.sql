CREATE TABLE IF NOT EXISTS vidio_request_limits (
  owner_id text PRIMARY KEY,
  window_at timestamptz NOT NULL,
  requests integer NOT NULL CHECK (requests > 0)
);

-- Intents are independent of caller transactions so rolled-back storage writes remain accounted for.
CREATE TABLE IF NOT EXISTS vidio_asset_intents (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  size bigint NOT NULL CHECK (size > 0),
  storage_backend text NOT NULL CHECK (storage_backend IN ('local','s3')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vidio_asset_intents_age ON vidio_asset_intents(created_at);
