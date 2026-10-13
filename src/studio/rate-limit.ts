import { database } from "./db";
import { StudioError } from "./types";

export async function rateLimit(owner: string) {
  const result = await database().query(
    `INSERT INTO vidio_request_limits(owner_id,window_at,requests)
     VALUES($1,date_trunc('minute',now()),1)
     ON CONFLICT(owner_id) DO UPDATE SET
       requests=CASE WHEN vidio_request_limits.window_at>=EXCLUDED.window_at THEN vidio_request_limits.requests+1 ELSE 1 END,
       window_at=greatest(vidio_request_limits.window_at,EXCLUDED.window_at) RETURNING requests`,
    [owner],
  );
  if (result.rows[0].requests > 240)
    throw new StudioError("RATE_LIMIT", "Too many requests; try again next minute", 429);
}
