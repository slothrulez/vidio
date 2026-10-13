CREATE UNIQUE INDEX IF NOT EXISTS vidio_assets_owned_id ON vidio_assets(id,project_id,owner_id);
ALTER TABLE vidio_jobs ADD COLUMN IF NOT EXISTS result_asset_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vidio_job_result_owned') THEN
    ALTER TABLE vidio_jobs ADD CONSTRAINT vidio_job_result_owned
      FOREIGN KEY(result_asset_id,project_id,owner_id) REFERENCES vidio_assets(id,project_id,owner_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vidio_segment_asset_owned') THEN
    ALTER TABLE vidio_job_segments ADD CONSTRAINT vidio_segment_asset_owned
      FOREIGN KEY(asset_id,project_id,owner_id) REFERENCES vidio_assets(id,project_id,owner_id);
  END IF;
END $$;
