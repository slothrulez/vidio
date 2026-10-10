import { config } from "dotenv";
import { PgBoss } from "pg-boss";
import { database } from "./studio/db";
import { getProject } from "./studio/store";
import { executeDemo, type ExecutionContext } from "./studio/demo";
import { requireDemoMode, workerLimits } from "./studio/config";
import { claimJob, heartbeat, completeJob, failJob, recoverJobs, completedSegment, persistSegment, type ClaimedJob } from "./studio/lifecycle";
import { StudioError, type StudioProject } from "./studio/types";

config({ path: ".env.local", quiet: true });
export const queueName = "vidio-preview";
export type JobExecutor = (job: ClaimedJob, project: StudioProject, context: ExecutionContext) => Promise<StudioProject>;
const demoExecutor: JobExecutor = (job, project, context) => executeDemo(job.owner,job.id,job.operation,job.input,project,context);
export async function runJob(id: string, execute: JobExecutor = demoExecutor) {
  const job = await claimJob(id);
  if (!job) return;
  const controller = new AbortController();
  let heartbeatFailure: unknown;
  let refreshing = false;
  const timer = setInterval(() => {
    if (refreshing) return;
    refreshing = true;
    void heartbeat(job).catch((error: unknown) => {
      heartbeatFailure = error;
      controller.abort();
    }).finally(() => { refreshing = false; });
  }, Math.floor(workerLimits().leaseSeconds * 1000 / 3));
  try {
    await heartbeat(job, 1);
    const project = await getProject(job.owner, job.projectId);
    if (project.revision !== job.input.revision) throw new StudioError("REVISION", "Project changed");
    const context = {
      signal: controller.signal,
      checkpoint: (progress: number) => heartbeat(job, progress),
      segment: async (ordinal: number, produce: () => Promise<typeof project.segments[number]>) => {
        const existing = await completedSegment(job,ordinal);
        if (existing) return existing;
        const segment = await produce();
        await persistSegment(job,segment);
        return segment;
      },
    };
    const updated = await execute(job,project,context);
    await completeJob(job,updated);
  } catch (error) {
    await failJob(job,heartbeatFailure ?? error);
    console.error("Job attempt ended:", job.id, error instanceof StudioError ? error.code : "WORKER_ERROR");
  } finally {
    clearInterval(timer);
    controller.abort();
  }
}
export async function startWorker(execute: JobExecutor = demoExecutor) {
  requireDemoMode();
  const limits = workerLimits();
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, max: limits.concurrency + 2 });
  boss.on("error", () => console.error("Queue connection error; check PostgreSQL."));
  await boss.start();
  await boss.createQueue(queueName, { retryLimit: 0, expireInSeconds: limits.timeoutSeconds + limits.leaseSeconds });
  await boss.work<{jobId: string}>(queueName, { batchSize: 1, localConcurrency: limits.concurrency, pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const task of jobs) await runJob(task.data.jobId,execute);
  });
  let dispatching = false;
  async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      await recoverJobs();
      await database().query("UPDATE vidio_jobs SET queue_id=NULL WHERE status='queued' AND dispatched_at<now()-$1*interval '1 second'", [limits.timeoutSeconds + limits.leaseSeconds]);
      const pending = await database().query("SELECT id FROM vidio_jobs WHERE status='queued' AND queue_id IS NULL AND next_attempt_at<=now() ORDER BY created_at LIMIT 20");
      for (const row of pending.rows) {
        const id = await boss.send(queueName, { jobId: row.id }, { retryLimit: 0, expireInSeconds: limits.timeoutSeconds + limits.leaseSeconds });
        if (id) await database().query("UPDATE vidio_jobs SET queue_id=$2,dispatched_at=now() WHERE id=$1 AND status='queued' AND queue_id IS NULL", [row.id,id]);
      }
    } catch {
      console.error("Outbox dispatch failed; durable state retained for retry.");
    } finally { dispatching = false; }
  }
  await dispatch();
  const timer = setInterval(() => { void dispatch(); },2000);
  console.log("vidio durable worker ready; provider calls disabled");
  return async () => {
    clearInterval(timer);
    await boss.stop({graceful: true, timeout: 50000});
  };
}
async function main() {
  const stop = await startWorker();
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => { void stop().then(() => database().end()).then(() => process.exit(0)); });
}
if (process.argv[1]?.endsWith("/worker.ts")) main().catch(() => {
  console.error("Worker startup failed; check mode, migrations and database.");
  process.exit(1);
});
