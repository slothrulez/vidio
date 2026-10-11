import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { database, transaction } from "./db";
import {
  projectSchema,
  StudioError,
  type StudioProject,
  type StudioJob,
  type JobInput,
  type Operation,
  type SegmentRecord,
} from "./types";
import { studioMode } from "./config";
import { workerLimits } from "./config";

export function segmentFromRow(row: Record<string, unknown>): SegmentRecord {
  return {
    id: String(row.id), ordinal: Number(row.ordinal), status: row.status as SegmentRecord["status"],
    assetId: row.asset_id ? String(row.asset_id) : null,
    duration: row.duration === null ? null : Number(row.duration),
    errorCode: row.error_code ? String(row.error_code) : null, error: row.error ? String(row.error) : null,
    createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString(),
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
  };
}
export async function getSegments(owner: string, jobId: string) {
  const result = await database().query("SELECT * FROM vidio_job_segments WHERE job_id=$1 AND owner_id=$2 ORDER BY ordinal", [jobId, owner]);
  return result.rows.map(segmentFromRow);
}

export async function getProject(
  owner: string,
  id: string,
  client: Pick<PoolClient, "query"> = database(),
): Promise<StudioProject> {
  const result = await client.query(
    "SELECT data FROM vidio_projects WHERE id=$1 AND owner_id=$2",
    [id, owner],
  );
  if (!result.rows.length)
    throw new StudioError("NOT_FOUND", "Project not found", 404);
  return projectSchema.parse(result.rows[0].data);
}

export async function saveProject(
  owner: string,
  project: StudioProject,
  client: Pick<PoolClient, "query"> = database(),
) {
  projectSchema.parse(project);
  await client.query(
    "UPDATE vidio_projects SET data=$3 WHERE id=$1 AND owner_id=$2",
    [project.id, owner, JSON.stringify(project)],
  );
}

export async function createProject(
  owner: string,
  input: {
    name: string;
    language: "english" | "mandarin" | "cantonese";
    ratio: "16:9" | "9:16" | "1:1";
  },
) {
  const mode=studioMode();
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(4112026)");
    const count = await client.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE owner_id=$1)::int AS owned FROM vidio_projects",
      [owner],
    );
    if (count.rows[0].total >= 200 || count.rows[0].owned >= 20)
      throw new StudioError("LIMIT", "Preview project limit reached", 429);
    const project: StudioProject = {
      id: randomUUID(),
      revision: 0,
      ...input,
      stage: "new",
      features: [],
      scripts: [],
      segments: [],
      createdAt: new Date().toISOString(),
      mode,
    };
    await client.query(
      "INSERT INTO vidio_projects(id,owner_id,data) VALUES($1,$2,$3)",
      [project.id, owner, JSON.stringify(project)],
    );
    return project;
  });
}

export async function listProjects(owner: string) {
  const result = await database().query(
    "SELECT data FROM vidio_projects WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20",
    [owner],
  );
  return result.rows.map((row) => projectSchema.parse(row.data));
}
export async function replaceScripts(owner:string,id:string,revision:number,scripts:StudioProject["scripts"]) {
  return transaction(async(client)=>{
    await client.query("SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",[id,owner]);
    const project=await getProject(owner,id,client);
    if (project.activeJobId || project.revision!==revision) throw new StudioError("REVISION","Project changed or a job is active",409);
    project.scripts=scripts;
    project.segments=[];
    project.stage="scripted";
    project.revision++;
    delete project.finalAssetId;
    delete project.captionAssetId;
    delete project.voiceAssetId;
    await saveProject(owner,project,client);
    return project;
  });
}

export async function updateScript(
  owner: string,
  input: {
    projectId: string;
    revision: number;
    id: number;
    script: string;
    prompt: string;
  },
) {
  return transaction(async (client) => {
    await client.query(
      "SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [input.projectId, owner],
    );
    const project = await getProject(owner, input.projectId, client);
    if (project.activeJobId)
      throw new StudioError(
        "BUSY",
        "Wait for the active job before editing",
        409,
      );
    if (project.revision !== input.revision)
      throw new StudioError(
        "REVISION",
        "Project changed; refresh before editing",
        409,
      );
    const script = project.scripts.find((item) => item.id === input.id);
    if (!script) throw new StudioError("NOT_FOUND", "Script not found", 404);
    script.script = input.script;
    script.prompt = input.prompt;
    project.revision++;
    project.stage = "scripted";
    project.segments = [];
    delete project.finalAssetId;
    delete project.captionAssetId;
    delete project.voiceAssetId;
    await saveProject(owner, project, client);
    return project;
  });
}

export function validateOperation(
  operation: Operation,
  project: StudioProject,
  input: JobInput,
) {
  if (
    operation !== "identify_product" &&
    operation !== "draft_scripts" &&
    !input.confirmed
  )
    throw new StudioError("CONFIRMATION", "Explicit confirmation is required");
  if (operation === "draft_scripts" && !project.features.length)
    throw new StudioError("STAGE", "Identify the product first");
  if (
    ["preview_voice", "generate_segments", "regenerate_segment"].includes(
      operation,
    ) &&
    !project.scripts.length
  )
    throw new StudioError("STAGE", "Draft scripts first");
  if (
    operation === "regenerate_segment" &&
    !project.scripts.some((item) => item.id === input.segmentId)
  )
    throw new StudioError("SEGMENT", "Choose an existing scene script");
  if (
    operation === "compose_video" &&
    (!input.segmentIds?.length ||
      new Set(input.segmentIds).size !== input.segmentIds.length ||
      input.segmentIds.some(
        (id) => !project.segments.some((item) => item.id === id),
      ))
  )
    throw new StudioError(
      "SEGMENTS",
      "Select unique generated segments to compose",
    );
}

export function jobFromRow(row: Record<string, unknown>): StudioJob {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    operation: String(row.operation),
    status: (row.status === "partially_completed" ? "running" : row.status) as StudioJob["status"],
    progress: Number(row.progress),
    error: row.error ? String(row.error) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    lifecycleStatus: (row.status === "succeeded" ? "completed" : row.status) as StudioJob["lifecycleStatus"],
    updatedAt: new Date(String(row.updated_at ?? row.created_at)).toISOString(),
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    attempts: Number(row.attempts),
    retryable: Boolean(row.retryable),
    errorCode: row.error_code ? String(row.error_code) : null,
  };
}

export async function getJob(owner: string, id: string) {
  const result = await database().query(
    "SELECT * FROM vidio_jobs WHERE id=$1 AND owner_id=$2",
    [id, owner],
  );
  if (!result.rows.length)
    throw new StudioError("NOT_FOUND", "Job not found", 404);
  return { ...jobFromRow(result.rows[0]), segments: await getSegments(owner,id) };
}

export async function startJob(
  owner: string,
  operation: Operation,
  input: JobInput,
) {
  const mode=studioMode();
  if (mode === "production" && !["generate_segments","regenerate_segment","compose_video"].includes(operation))
    throw new StudioError("NOT_CONFIGURED","Recognition, scripts and voice previews are not connected to live providers",503);
  if (mode === "production" && !input.idempotencyKey)
    throw new StudioError("IDEMPOTENCY","Production jobs require an idempotencyKey");
  const hash = createHash("sha256")
    .update(JSON.stringify({ operation, ...input, idempotencyKey: undefined }))
    .digest("hex");
  const key = input.idempotencyKey ?? hash;
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [owner]);
    const existing = await client.query(
      "SELECT * FROM vidio_jobs WHERE owner_id=$1 AND idempotency_key=$2",
      [owner, key],
    );
    if (existing.rows.length) {
      if (existing.rows[0].input_hash !== hash)
        throw new StudioError(
          "IDEMPOTENCY",
          "Idempotency key was used for different inputs",
          409,
        );
      return jobFromRow(existing.rows[0]);
    }
    await client.query(
      "SELECT id FROM vidio_projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [input.projectId, owner],
    );
    const project = await getProject(owner, input.projectId, client);
    if (project.mode !== mode) throw new StudioError("MODE","Project execution mode does not match the server",409);
    if (project.revision !== input.revision)
      throw new StudioError(
        "REVISION",
        "Project changed; refresh before starting",
        409,
      );
    if (project.activeJobId)
      throw new StudioError("BUSY", "A project job is already active", 409);
    validateOperation(operation, project, input);
    if (mode === "production" && operation !== "compose_video") {
      const ordinals=operation==="regenerate_segment" ? [input.segmentId!] : project.scripts.map(script=>script.id);
      const unresolved=await client.query("SELECT id FROM vidio_job_segments WHERE project_id=$1 AND owner_id=$2 AND ordinal=ANY($3::int[]) AND (error_code='SUBMISSION_UNKNOWN' OR status='submitting' OR (provider_task_id IS NOT NULL AND asset_id IS NULL AND NOT (status='failed' AND error_code='PROVIDER_FAILED'))) LIMIT 1",[project.id,owner,ordinals]);
      if (unresolved.rows.length) throw new StudioError("RECONCILIATION","Reconcile the previous provider submission before approving another paid request for this scene",409);
      const dailyLimit=Number(process.env.VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY);
      if (process.env.VIDIO_PAID_GENERATION_ENABLED !== "true" || !Number.isInteger(dailyLimit) || dailyLimit<1 || dailyLimit>100)
        throw new StudioError("BUDGET","Paid generation requires explicit operator opt-in and a daily segment budget",503);
      const reserved=await client.query("SELECT count(*)::int AS n FROM vidio_job_segments WHERE owner_id=$1 AND created_at>=date_trunc('day',now())",[owner]);
      const requested=operation === "regenerate_segment" ? 1 : project.scripts.length;
      if (reserved.rows[0].n+requested>dailyLimit) throw new StudioError("BUDGET","Daily approved segment budget exhausted",429);
    }
    const count = await client.query(
      "SELECT count(*)::int AS n FROM vidio_jobs WHERE owner_id=$1",
      [owner],
    );
    if (count.rows[0].n >= 100)
      throw new StudioError("LIMIT", "Job history limit reached", 429);
    const id = randomUUID();
    const result = await client.query(
      "INSERT INTO vidio_jobs(id,project_id,owner_id,operation,input,input_hash,idempotency_key,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [id, project.id, owner, operation, JSON.stringify(input), hash, key, workerLimits().maxAttempts],
    );
    if (operation === "generate_segments" || operation === "regenerate_segment") {
      for (const script of project.scripts.filter((script) => operation === "generate_segments" || script.id === input.segmentId))
        await client.query("INSERT INTO vidio_job_segments(id,job_id,project_id,owner_id,ordinal,script) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(),id,project.id,owner,script.id,JSON.stringify(script)]);
    }
    project.activeJobId = id;
    await saveProject(owner, project, client);
    return jobFromRow(result.rows[0]);
  });
}

export async function cancelJob(owner: string, id: string) {
  await database().query(
    "UPDATE vidio_jobs SET cancel_requested=true,updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('queued','running','partially_completed')",
    [id, owner],
  );
  return getJob(owner, id);
}
