ALTER TABLE vidio_assets DROP CONSTRAINT IF EXISTS vidio_assets_mime_check;
ALTER TABLE vidio_assets ADD CONSTRAINT vidio_assets_mime_check
  CHECK (mime IN ('image/png','image/jpeg','video/mp4','audio/mpeg','text/vtt'));
CREATE TABLE IF NOT EXISTS vidio_image_uploads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  owner_id text NOT NULL,
  revision integer NOT NULL,
  mime text NOT NULL CHECK (mime IN ('image/png','image/jpeg')),
  expected_size integer NOT NULL CHECK (expected_size BETWEEN 24 AND 5000000),
  data bytea NOT NULL DEFAULT ''::bytea,
  asset_id uuid,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  FOREIGN KEY(project_id,owner_id) REFERENCES vidio_projects(id,owner_id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id,project_id,owner_id) REFERENCES vidio_assets(id,project_id,owner_id),
  CHECK(octet_length(data)<=expected_size)
);
CREATE INDEX IF NOT EXISTS vidio_upload_owner_expiry ON vidio_image_uploads(owner_id,expires_at);
ALTER TABLE vidio_jobs ADD COLUMN IF NOT EXISTS result_caption_asset_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vidio_job_caption_owned') THEN
    ALTER TABLE vidio_jobs ADD CONSTRAINT vidio_job_caption_owned
    FOREIGN KEY(result_caption_asset_id,project_id,owner_id) REFERENCES vidio_assets(id,project_id,owner_id);
  END IF;
END $$;
