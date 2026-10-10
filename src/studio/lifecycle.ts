import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { database, transaction } from "./db";
import { getProject, saveProject, jobFromRow } from "./store";
import { jobInputSchema, scriptSchema, StudioError, type Operation, type StudioProject } from "./types";
import { workerLimits } from "./config";

export type ClaimedJob = {
  id: string;
  owner: string;
  projectId: string;
  operation: Operation;
  input: ReturnType<typeof jobInputSchema.parse>;
  token: string;
  deadlineAt: string;
};
export async function claimJob(id: string): Promise<ClaimedJob | null> {
  const limits = workerLimits();
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(4112029)");
    const result = await client.query("SELECT * FROM vidio_jobs WHERE id=$1 AND status='queued' AND next_attempt_at<=now() FOR UPDATE", [id]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    if (row.cancel_requested || row.attempts>=row.max_attempts || (row.deadline_at && new Date(row.deadline_at).getTime()<=Date.now())) {
      await client.query("UPDATE vidio_jobs SET status=$2,error_code=$3,error=$4,completed_at=now(),updated_at=now(),retryable=false WHERE id=$1",[id,row.cancel_requested ? "cancelled" : "failed",row.cancel_requested ? null : "TIMEOUT",row.cancel_requested ? null : "Job deadline or attempt limit reached"]);
      await client.query("UPDATE vidio_projects SET data=data-'activeJobId' WHERE id=$1 AND owner_id=$2 AND data->>'activeJobId'=$3",[row.project_id,row.owner_id,id]);
      return null;
    }
    const active = await client.query("SELECT count(*)::int AS n FROM vidio_jobs WHERE status IN ('running','partially_completed') AND lease_until>now()", []);
    if (active.rows[0].n >= limits.concurrency) {
      await client.query("UPDATE vidio_jobs SET queue_id=NULL WHERE id=$1", [id]);
      return null;
    }
    const token = randomUUID();
    const updated=await client.query("UPDATE vidio_jobs SET status='running',lease_token=$2,lease_until=now()+$3*interval '1 second',started_at=coalesce(started_at,now()),deadline_at=coalesce(deadline_at,now()+$4*interval '1 second'),updated_at=now(),attempts=attempts+1 WHERE id=$1 RETURNING deadline_at", [id, token, limits.leaseSeconds, limits.timeoutSeconds]);
    return { id, owner: row.owner_id, projectId: row.project_id, operation: row.operation, input: jobInputSchema.parse(row.input), token, deadlineAt:new Date(updated.rows[0].deadline_at).toISOString() };
  });
}
async function locked<T>(job: ClaimedJob, work: (client: PoolClient) => Promise<T>) {
  return transaction(async (client) => {
    const state = await client.query("SELECT cancel_requested,deadline_at FROM vidio_jobs WHERE id=$1 AND owner_id=$2 AND lease_token=$3 AND lease_until>now() AND status IN ('running','partially_completed') FOR UPDATE", [job.id, job.owner, job.token]);
    if (!state.rows.length) throw new StudioError("LEASE_LOST", "Worker lease was replaced", 409);
    if (state.rows[0].cancel_requested) throw new StudioError("CANCELLED", "Job cancelled");
    if (new Date(state.rows[0].deadline_at).getTime() <= Date.now()) throw new StudioError("TIMEOUT", "Job deadline reached");
    return work(client);
  });
}
export async function heartbeat(job: ClaimedJob, progress?: number) {
  await locked(job, async (client) => {
    await client.query("UPDATE vidio_jobs SET lease_until=now()+$3*interval '1 second',progress=greatest(progress,coalesce($4,progress)),updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, job.token, workerLimits().leaseSeconds, progress === undefined ? null : Math.min(95, Math.max(0, progress))]);
  });
}
export async function completedSegment(job: ClaimedJob, ordinal: number) {
  return locked(job, async (client) => {
    const rows = await client.query("SELECT * FROM vidio_job_segments WHERE job_id=$1 AND owner_id=$2 AND ordinal=$3 FOR UPDATE", [job.id, job.owner, ordinal]);
    const row = rows.rows[0];
    if (!row) throw new StudioError("SEGMENT", "Segment record not found");
    if (row.status === "completed") return { id: ordinal, assetId: String(row.asset_id), duration: Number(row.duration), script: scriptSchema.parse(row.script).script };
    if ((row.status === "submitting" || row.error_code==="SUBMISSION_UNKNOWN") && !row.provider_task_id)
      throw new StudioError("SUBMISSION_UNKNOWN", "Provider submission needs reconciliation; automatic resubmission is disabled");
    await client.query("UPDATE vidio_job_segments SET status=CASE WHEN provider_task_id IS NULL THEN 'running' ELSE 'submitted' END,attempts=attempts+1,error=NULL,error_code=NULL,updated_at=now() WHERE id=$1", [row.id]);
    return null;
  });
}
export async function persistSegment(job: ClaimedJob, segment: StudioProject["segments"][number]) {
  await locked(job, async (client) => {
    const asset = await client.query("SELECT id FROM vidio_assets WHERE id=$1 AND owner_id=$2 AND project_id=$3 AND mime='video/mp4'", [segment.assetId, job.owner, job.projectId]);
    if (!asset.rows.length) throw new StudioError("NOT_FOUND", "Owned segment asset not found", 404);
    await client.query("UPDATE vidio_job_segments SET status='completed',asset_id=$3,duration=$4,error=NULL,error_code=NULL,updated_at=now(),completed_at=now() WHERE job_id=$1 AND ordinal=$2 AND owner_id=$5", [job.id, segment.id, segment.assetId, segment.duration, job.owner]);
    const project = await getProject(job.owner, job.projectId, client);
    project.segments = [...project.segments.filter((item) => item.id !== segment.id), segment].sort((a,b) => a.id-b.id);
    delete project.finalAssetId;
    delete project.captionAssetId;
    await saveProject(job.owner, project, client);
    const counts = await client.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='completed')::int AS done FROM vidio_job_segments WHERE job_id=$1", [job.id]);
    const { total, done } = counts.rows[0];
    await client.query("UPDATE vidio_jobs SET status='partially_completed',progress=greatest(progress,$2),updated_at=now() WHERE id=$1", [job.id, Math.floor(done/total*90)]);
  });
}
export async function providerCheckpoint(job: ClaimedJob, ordinal: number, taskId?: string) {
  await locked(job, async (client) => {
    const updated = await client.query("UPDATE vidio_job_segments SET status=$4,provider_task_id=coalesce($3,provider_task_id),updated_at=now() WHERE job_id=$1 AND ordinal=$2 AND owner_id=$5 AND status=$6 RETURNING id", [job.id, ordinal, taskId ?? null, taskId ? "submitted" : "submitting", job.owner, taskId ? "submitting" : "running"]);
    if (!updated.rows.length) throw new StudioError("SUBMISSION_STATE", "Provider submission state changed", 409);
  });
}
export async function providerTask(job: ClaimedJob, ordinal: number) {
  const result = await database().query("SELECT provider_task_id FROM vidio_job_segments WHERE job_id=$1 AND ordinal=$2 AND owner_id=$3", [job.id, ordinal, job.owner]);
  return result.rows[0]?.provider_task_id as string | null;
}
export async function composedAsset(job:ClaimedJob) {
  return locked(job,async(client)=>{
    const result=await client.query("SELECT result_asset_id FROM vidio_jobs WHERE id=$1",[job.id]);
    return result.rows[0].result_asset_id as string|null;
  });
}
export async function composedCaption(job:ClaimedJob) {
  return locked(job,async client=>{
    const result=await client.query("SELECT result_caption_asset_id FROM vidio_jobs WHERE id=$1",[job.id]);
    return result.rows[0].result_caption_asset_id as string|null;
  });
}
export async function persistComposition(job:ClaimedJob,assetId:string,captionAssetId?:string) {
  await locked(job,async(client)=>{
    await client.query("UPDATE vidio_jobs SET result_asset_id=$2,result_caption_asset_id=$3,progress=95,updated_at=now() WHERE id=$1",[job.id,assetId,captionAssetId ?? null]);
  });
}
export async function completeJob(job: ClaimedJob, updated: StudioProject) {
  await locked(job, async (client) => {
    if (job.operation === "generate_segments" || job.operation === "regenerate_segment") {
      const pending = await client.query("SELECT id FROM vidio_job_segments WHERE job_id=$1 AND status<>'completed'", [job.id]);
      if (pending.rows.length) throw new StudioError("SEGMENT", "Not all segments are completed");
    }
    const current = await getProject(job.owner, job.projectId, client);
    if (current.activeJobId !== job.id || current.revision !== job.input.revision) throw new StudioError("REVISION", "Project changed", 409);
    delete updated.activeJobId;
    updated.revision++;
    await saveProject(job.owner, updated, client);
    await client.query("UPDATE vidio_jobs SET status='succeeded',progress=100,retryable=false,error=NULL,error_code=NULL,lease_until=NULL,lease_token=NULL,completed_at=now(),updated_at=now() WHERE id=$1", [job.id]);
  });
}
const messages: Record<string, string> = {
  TIMEOUT: "Job deadline reached; completed segments remain available.",
  SUBMISSION_UNKNOWN: "Provider submission outcome is unknown. Reconcile it before approving another paid request.",
  PROVIDER_FAILED: "The provider task failed. No automatic paid resubmission was made.",
  WORKER_ERROR: "Worker failed; completed segments remain available.",
  POLL: "Provider status temporarily unavailable.",
  STORAGE: "Private asset storage temporarily unavailable.",
};
export async function failJob(job: ClaimedJob, error: unknown) {
  const code = error instanceof StudioError ? error.code : "WORKER_ERROR";
  if (code === "LEASE_LOST") return;
  await transaction(async (client) => {
    const result = await client.query("SELECT * FROM vidio_jobs WHERE id=$1 AND lease_token=$2 AND status IN ('running','partially_completed') FOR UPDATE", [job.id, job.token]);
    if (!result.rows.length) return;
    const row = result.rows[0];
    const unknown = (await client.query("SELECT id FROM vidio_job_segments WHERE job_id=$1 AND status='submitting' AND provider_task_id IS NULL", [job.id])).rows.length > 0;
    const failureCode = unknown ? "SUBMISSION_UNKNOWN" : code;
    const cancelled = Boolean(row.cancel_requested) || code === "CANCELLED";
    const retryable = !cancelled && !unknown && row.attempts<row.max_attempts && ["POLL", "STORAGE", "WORKER_ERROR","TIMEOUT"].includes(code);
    const retry = retryable && row.attempts < row.max_attempts && new Date(row.deadline_at).getTime() > Date.now();
    await client.query("UPDATE vidio_jobs SET status=$2,error=$3,error_code=$4,retryable=$5,queue_id=NULL,lease_until=NULL,lease_token=NULL,updated_at=now(),completed_at=CASE WHEN $6 THEN NULL ELSE now() END,next_attempt_at=now()+$7*interval '1 second' WHERE id=$1", [job.id, cancelled ? "cancelled" : retry ? "queued" : "failed", cancelled ? null : messages[failureCode] ?? messages.WORKER_ERROR, cancelled ? null : failureCode, retryable, retry, Math.min(30, 2 ** Number(row.attempts))]);
    await client.query("UPDATE vidio_job_segments SET status='failed',error_code=$2,error=$3,updated_at=now() WHERE job_id=$1 AND status NOT IN ('completed','queued')", [job.id, failureCode, messages[failureCode] ?? messages.WORKER_ERROR]);
    if (!retry) await client.query("UPDATE vidio_projects SET data=data-'activeJobId' WHERE id=$1 AND owner_id=$2 AND data->>'activeJobId'=$3", [job.projectId, job.owner, job.id]);
  });
}
export async function recoverJobs() {
  const expired = await database().query("SELECT * FROM vidio_jobs WHERE status IN ('running','partially_completed') AND lease_until<now() ORDER BY lease_until LIMIT 30");
  for (const row of expired.rows) {
    await transaction(async (client) => {
      const lockedRow = await client.query("SELECT * FROM vidio_jobs WHERE id=$1 AND lease_until<now() AND status IN ('running','partially_completed') FOR UPDATE", [row.id]);
      if (!lockedRow.rows.length) return;
      const state = lockedRow.rows[0];
      const unknown = (await client.query("SELECT id FROM vidio_job_segments WHERE job_id=$1 AND status='submitting' AND provider_task_id IS NULL", [row.id])).rows.length > 0;
      const cancelled = state.cancel_requested;
      const retry = !unknown && !cancelled && state.attempts < state.max_attempts && new Date(state.deadline_at).getTime() > Date.now();
      const code = unknown ? "SUBMISSION_UNKNOWN" : "TIMEOUT";
      await client.query("UPDATE vidio_jobs SET status=$2,queue_id=NULL,lease_until=NULL,lease_token=NULL,updated_at=now(),retryable=$3,error_code=$4,error=$5,completed_at=CASE WHEN $3 THEN NULL ELSE now() END WHERE id=$1", [row.id, cancelled ? "cancelled" : retry ? "queued" : "failed", retry, retry ? null : code, retry || cancelled ? null : messages[code]]);
      if (!retry) await client.query("UPDATE vidio_job_segments SET status='failed',error_code=$2,error=$3,updated_at=now() WHERE job_id=$1 AND status NOT IN ('queued','completed')", [row.id,code,messages[code]]);
      if (!retry) await client.query("UPDATE vidio_projects SET data=data-'activeJobId' WHERE id=$1 AND owner_id=$2 AND data->>'activeJobId'=$3", [state.project_id,state.owner_id,state.id]);
    });
  }
}
export async function retryJob(owner: string, id: string) {
  return transaction(async (client) => {
    const found = await client.query("SELECT * FROM vidio_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, owner]);
    if (!found.rows.length) throw new StudioError("NOT_FOUND", "Job not found", 404);
    const row = found.rows[0];
    if (["queued","running","partially_completed","succeeded"].includes(row.status)) return jobFromRow(row);
    if (row.status !== "failed" || !row.retryable || row.attempts >= row.max_attempts) throw new StudioError("RETRY", "This job cannot be retried safely; completed segments remain available", 409);
    await client.query("SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE", [row.project_id,owner]);
    const project = await getProject(owner,row.project_id,client);
    if (project.activeJobId || project.revision !== row.input.revision) throw new StudioError("REVISION", "Project changed or another job is active",409);
    project.activeJobId=id;
    await saveProject(owner,project,client);
    const updated = await client.query("UPDATE vidio_jobs SET status='queued',queue_id=NULL,completed_at=NULL,error=NULL,error_code=NULL,deadline_at=NULL,next_attempt_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id]);
    return jobFromRow(updated.rows[0]);
  });
}
