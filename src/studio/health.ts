import { database } from "./db";

export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_MAX_AGE_SECONDS = 30;

export async function writeWorkerHeartbeat(workerId: string, mode: "demo" | "production") {
  await database().query(
    `INSERT INTO vidio_worker_health (worker_id, mode)
     VALUES ($1, $2)
     ON CONFLICT (worker_id) DO UPDATE SET mode = EXCLUDED.mode, heartbeat_at = now()`,
    [workerId, mode],
  );
}

export async function removeWorkerHeartbeat(workerId: string) {
  await database().query("DELETE FROM vidio_worker_health WHERE worker_id = $1", [workerId]);
}

export async function pruneStaleWorkerHeartbeats() {
  await database().query("DELETE FROM vidio_worker_health WHERE heartbeat_at < now() - interval '1 day'");
}

export async function checkReadiness(
  mode: "demo" | "production",
  probe: (mode: "demo" | "production") => Promise<void> = async (expectedMode) => {
    await database().query("SELECT 1");
    const result = await database().query(
      `SELECT 1 FROM vidio_worker_health
       WHERE mode = $1 AND heartbeat_at > now() - ($2 * interval '1 second')
       LIMIT 1`,
      [expectedMode, WORKER_HEARTBEAT_MAX_AGE_SECONDS],
    );
    if (result.rowCount !== 1) throw new Error("worker_not_ready");
  },
) {
  try {
    await probe(mode);
    return true;
  } catch {
    return false;
  }
}
