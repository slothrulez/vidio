import { z } from "zod";
import { schemas, executeTool, type ToolName } from "./service";
import { compositionOptionsSchema, StudioError, type ToolOutput } from "./types";
import { getProject } from "./store";
import { database } from "./db";
import { studioMode } from "./config";
import { randomUUID } from "node:crypto";

const modelJob = z.object({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(100).optional(),
  confirmed: z.boolean().default(false),
}).strict();
export const consentOperations = ["start_video_job", "regenerate_segment", "compose_final_video"] as const;
const confirmedJob = modelJob.extend({ confirmed: z.literal(true), consentToken: z.uuid().optional() });
const consentSchema = z.object({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  operation: z.enum(consentOperations),
  idempotencyKey: z.string().min(8).max(100),
}).strict();
const statusSchema = z.object({ jobId: z.uuid() }).strict();
const finalSchema = z.object({ projectId: z.uuid() }).strict();
const segment = z.number().int().min(1).max(4);

export const mcpSchemas = {
  ...schemas,
  create_project: schemas.create_project.extend({ language: z.literal("english").default("english") }),
  grant_cost_consent: consentSchema,
  identify_product: modelJob,
  generate_scripts: modelJob,
  start_video_job: confirmedJob,
  get_video_job_status: statusSchema,
  regenerate_segment: confirmedJob.extend({ segmentId: segment }),
  compose_final_video: confirmedJob.extend({
    composition: compositionOptionsSchema.optional(),
    segmentIds: z.array(segment).min(1).max(4).refine((ids) => new Set(ids).size === ids.length),
  }),
  get_final_video: finalSchema,
};
export type McpToolName = keyof typeof mcpSchemas;

async function grantConsent(owner: string, args: unknown): Promise<{ structuredContent: ToolOutput }> {
  const consent = consentSchema.parse(args);
  const project = await getProject(owner, consent.projectId);
  if (project.revision !== consent.revision)
    throw new StudioError("REVISION", "The project changed; review the latest revision before approving", 409);
  await database().query(
    "DELETE FROM vidio_cost_consents WHERE owner_id=$1 AND (expires_at<now() OR used_at<now()-interval '1 day')",
    [owner],
  );
  const pending = await database().query(
    "SELECT count(*)::int AS n FROM vidio_cost_consents WHERE owner_id=$1 AND used_at IS NULL",
    [owner],
  );
  if (pending.rows[0].n >= 20)
    throw new StudioError("RATE_LIMIT", "Too many pending approvals; wait for them to expire", 429);
  const token = randomUUID();
  const row = await database().query(
    "INSERT INTO vidio_cost_consents(id,owner_id,project_id,revision,operation,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes') RETURNING expires_at",
    [token, owner, consent.projectId, consent.revision, consent.operation, consent.idempotencyKey],
  );
  return {
    structuredContent: {
      mode: studioMode(),
      message: `Approval recorded for ${consent.operation}; it can be used once within 10 minutes.`,
      consent: { token, operation: consent.operation, expiresAt: new Date(row.rows[0].expires_at).toISOString() },
    },
  };
}

async function consumeConsent(
  owner: string,
  token: string,
  operation: string,
  input: { projectId: string; revision: number; idempotencyKey?: string },
) {
  if (!input.idempotencyKey)
    throw new StudioError("CONSENT", "Paid steps require the idempotencyKey that was approved", 409);
  const result = await database().query(
    `UPDATE vidio_cost_consents
     SET used_at=coalesce(used_at,now())
     WHERE id=$1 AND owner_id=$2 AND project_id=$3 AND revision=$4 AND operation=$5 AND expires_at>now()
       AND idempotency_key=$6::text
     RETURNING id`,
    [token, owner, input.projectId, input.revision, operation, input.idempotencyKey],
  );
  if (!result.rows.length)
    throw new StudioError("CONSENT", "This approval is invalid, expired or already used; approve again in the vidio studio", 409);
}

export async function executeMcpTool(owner: string, name: McpToolName, args: unknown) {
  if (name === "grant_cost_consent") return grantConsent(owner, args);
  const input = mcpSchemas[name].parse(args);
  const consentToken = "consentToken" in input ? input.consentToken : undefined;
  if ("consentToken" in input) delete (input as { consentToken?: string }).consentToken;
  const aliases = {
    generate_scripts: "draft_scripts",
    start_video_job: "generate_segments",
    get_video_job_status: "get_job",
    compose_final_video: "compose_video",
    get_final_video: "get_download",
  } as const satisfies Partial<Record<McpToolName, ToolName>>;
  const target: ToolName = name in aliases
    ? aliases[name as keyof typeof aliases]
    : name as ToolName;
  if (consentOperations.some((operation) => operation === name)) {
    if (!consentToken)
      throw new StudioError("CONSENT", "Approve this paid step in the vidio studio first; a model-declared confirmation is not sufficient", 409);
    await consumeConsent(owner, consentToken, name, input as unknown as { projectId: string; revision: number; idempotencyKey?: string });
  }
  const result = await executeTool(owner, target, input);
  const job = result.structuredContent.job;
  if (job && name in aliases && name !== "get_final_video") {
    const publicOperation = {
      draft_scripts: "generate_scripts",
      generate_segments: "start_video_job",
      compose_video: "compose_final_video",
    } as const;
    job.operation = job.operation in publicOperation
      ? publicOperation[job.operation as keyof typeof publicOperation]
      : job.operation;
  }
  if (name === "get_final_video" && result.structuredContent.project?.finalAssetId)
    result.structuredContent.finalVideo = {
      assetId: result.structuredContent.project.finalAssetId,
      mimeType: "video/mp4",
    };
  return result;
}
