import { config } from "dotenv";
import { PgBoss } from "pg-boss";
import { database } from "./studio/db";
import { getProject } from "./studio/store";
import { executeDemo, type ExecutionContext } from "./studio/demo";
import { studioMode, workerLimits } from "./studio/config";
import { composeOwnedSegments } from "./studio/composition";
import { ArkVideoProvider,executeVideoJob } from "./studio/video-provider";
import { composedAsset,composedCaption,persistComposition } from "./studio/lifecycle";
import { claimJob, heartbeat, completeJob, failJob, recoverJobs, completedSegment, persistSegment, type ClaimedJob } from "./studio/lifecycle";
import { StudioError, type StudioProject } from "./studio/types";
import { cleanupAssets } from "./studio/assets";

config({ path: ".env.local", quiet: true });
export const queueName = "vidio-preview";
export type JobExecutor = (job: ClaimedJob, project: StudioProject, context: ExecutionContext) => Promise<StudioProject>;
const demoExecutor: JobExecutor = (job, project, context) => executeDemo(job.owner,job.id,job.operation,job.input,project,context);
const managedExecutor: JobExecutor = async (job,project,context) => {
  if (project.mode!==studioMode()) throw new StudioError("MODE","Project mode does not match the worker");
  if (project.mode==="demo") return demoExecutor(job,project,context);
  if (job.operation==="compose_video") return composeOwnedSegments(job.owner,project,job.input.segmentIds!,context.signal,context.checkpoint,job.input.composition);
  if (process.env.VIDIO_PAID_GENERATION_ENABLED!=="true") throw new StudioError("BUDGET","Paid generation is disabled");
  return executeVideoJob(job,project,context,new ArkVideoProvider());
};
export async function runJob(id: string, execute: JobExecutor = managedExecutor) {
  const job = await claimJob(id);
  if (!job) return;
  const controller = new AbortController();
  const deadline=setTimeout(()=>controller.abort(new StudioError("TIMEOUT","Job deadline reached")),Math.max(0,new Date(job.deadlineAt).getTime()-Date.now()));
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
    const previous=job.operation==="compose_video" ? await composedAsset(job) : null;
    let updated:StudioProject;
    if (previous) { project.finalAssetId=previous; project.captionAssetId=await composedCaption(job) ?? undefined; project.stage="done"; updated=project; }
    else {
      updated=await execute(job,project,context);
      if (job.operation==="compose_video" && updated.finalAssetId) await persistComposition(job,updated.finalAssetId,updated.captionAssetId);
    }
    await completeJob(job,updated);
  } catch (error) {
    await failJob(job,heartbeatFailure ?? controller.signal.reason ?? error);
    console.error("Job attempt ended:", job.id, error instanceof StudioError ? error.code : "WORKER_ERROR");
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    controller.abort();
  }
}
export async function startWorker(execute: JobExecutor = managedExecutor) {
  const mode=studioMode();
  const queue=mode==="demo" ? queueName : "vidio-jobs";
  const limits = workerLimits();
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, max: limits.concurrency + 2 });
  boss.on("error", () => console.error("Queue connection error; check PostgreSQL."));
  await boss.start();
  await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: limits.timeoutSeconds + limits.leaseSeconds });
  await boss.work<{jobId: string}>(queue, { batchSize: 1, localConcurrency: limits.concurrency, pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const task of jobs) await runJob(task.data.jobId,execute);
  });
  let dispatching = false;
  let cleanedAt = 0;
  async function dispatch() {
    if (dispatching) return;
    dispatching = true;
    try {
      await recoverJobs();
      if (Date.now()-cleanedAt>60_000) {
        try {await cleanupAssets();cleanedAt=Date.now();}
        catch {console.error("Media cleanup deferred; quota reservations retained.");}
      }
      await database().query("UPDATE vidio_jobs SET queue_id=NULL WHERE status='queued' AND dispatched_at<now()-$1*interval '1 second'", [limits.timeoutSeconds + limits.leaseSeconds]);
      const pending = await database().query("SELECT j.id FROM vidio_jobs j JOIN vidio_projects p ON p.id=j.project_id WHERE j.status='queued' AND j.queue_id IS NULL AND j.next_attempt_at<=now() AND p.data->>'mode'=$1 ORDER BY j.created_at LIMIT 20",[mode]);
      for (const row of pending.rows) {
        const id = await boss.send(queue, { jobId: row.id }, { retryLimit: 0, expireInSeconds: limits.timeoutSeconds + limits.leaseSeconds });
        if (id) await database().query("UPDATE vidio_jobs SET queue_id=$2,dispatched_at=now() WHERE id=$1 AND status='queued' AND queue_id IS NULL", [row.id,id]);
      }
    } catch {
      console.error("Outbox dispatch failed; durable state retained for retry.");
    } finally { dispatching = false; }
  }
  await dispatch();
  const timer = setInterval(() => { void dispatch(); },2000);
  console.log(`vidio durable worker ready (${mode})`);
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
