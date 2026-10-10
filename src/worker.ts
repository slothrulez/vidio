import { config } from "dotenv";
import { PgBoss } from "pg-boss";
import { database, transaction } from "./studio/db";
import { getProject, saveProject } from "./studio/store";
import { executeDemo } from "./studio/demo";
import { requireDemoMode } from "./studio/config";
import { jobInputSchema, StudioError, type Operation } from "./studio/types";

config({ path: ".env.local", quiet: true });
const queue = "vidio-preview";
async function main() {
  requireDemoMode();
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,
    max: 4,
  });
  boss.on("error", () =>
    console.error("Queue connection error; check PostgreSQL."),
  );
  await boss.start();
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 120 });
  await boss.work<{ jobId: string }>(
    queue,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const task of jobs) {
        const claimed = await database().query(
          "UPDATE vidio_jobs SET status='running',lease_until=now()+interval '120 seconds',attempts=attempts+1 WHERE id=$1 AND status='queued' RETURNING *",
          [task.data.jobId],
        );
        if (!claimed.rows.length) continue;
        const row = claimed.rows[0];
        try {
          const input = jobInputSchema.parse(row.input);
          const project = await getProject(row.owner_id, row.project_id);
          if (project.revision !== input.revision)
            throw new StudioError("REVISION", "Project revision changed");
          const updated = await executeDemo(
            row.owner_id,
            row.id,
            row.operation as Operation,
            input,
            project,
          );
          await transaction(async (client) => {
            const state = await client.query(
              "SELECT cancel_requested FROM vidio_jobs WHERE id=$1 FOR UPDATE",
              [row.id],
            );
            if (state.rows[0].cancel_requested)
              throw new StudioError("CANCELLED", "Job cancelled");
            delete updated.activeJobId;
            updated.revision++;
            await saveProject(row.owner_id, updated, client);
            await client.query(
              "UPDATE vidio_jobs SET status='succeeded',progress=100,lease_until=NULL WHERE id=$1",
              [row.id],
            );
          });
        } catch (error) {
          await transaction(async (client) => {
            const cancelled =
              error instanceof StudioError && error.code === "CANCELLED";
            await client.query(
              "UPDATE vidio_jobs SET status=$2,error=$3,lease_until=NULL WHERE id=$1",
              [
                row.id,
                cancelled ? "cancelled" : "failed",
                cancelled
                  ? null
                  : "Demo job failed. Retry after checking the local worker.",
              ],
            );
            await client.query(
              "UPDATE vidio_projects SET data=data-'activeJobId' WHERE id=$1 AND data->>'activeJobId'=$2",
              [row.project_id, row.id],
            );
          });
          console.error(
            "Demo job ended:",
            row.id,
            error instanceof StudioError ? error.code : "WORKER_ERROR",
          );
        }
      }
    },
  );
  let dispatching = false;
  async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      await database().query(
        "UPDATE vidio_jobs SET status='queued',queue_id=NULL,lease_until=NULL WHERE status='running' AND lease_until<now() AND attempts<3",
      );
      const expired = await database().query(
        "UPDATE vidio_jobs SET status='failed',error='Worker recovery limit reached' WHERE status='running' AND lease_until<now() AND attempts>=3 RETURNING project_id,id",
      );
      for (const row of expired.rows)
        await database().query(
          "UPDATE vidio_projects SET data=data-'activeJobId' WHERE id=$1 AND data->>'activeJobId'=$2",
          [row.project_id, row.id],
        );
      const pending = await database().query(
        "SELECT id FROM vidio_jobs WHERE status='queued' AND queue_id IS NULL ORDER BY created_at LIMIT 20",
      );
      for (const row of pending.rows) {
        const id = await boss.send(
          queue,
          { jobId: row.id },
          { singletonKey: row.id, retryLimit: 0, expireInSeconds: 120 },
        );
        if (id)
          await database().query(
            "UPDATE vidio_jobs SET queue_id=$2 WHERE id=$1",
            [row.id, id],
          );
      }
    } catch {
      console.error(
        "Outbox dispatch failed; retrying with durable state intact.",
      );
    } finally {
      dispatching = false;
    }
  }
  await dispatch();
  const timer = setInterval(() => {
    void dispatch();
  }, 2000);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      clearInterval(timer);
      void boss
        .stop({ graceful: true, timeout: 50000 })
        .then(() => database().end())
        .then(() => process.exit(0));
    });
  console.log("vidio demo worker ready; provider calls disabled");
}
main().catch(() => {
  console.error(
    "Worker startup failed; check demo mode, migration and database.",
  );
  process.exit(1);
});
