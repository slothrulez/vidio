import { z } from "zod";
import { schemas, executeTool, type ToolName } from "./service";
import { compositionOptionsSchema, StudioError, type ToolOutput } from "./types";
import { studioMode } from "./config";
import { consentOperations, consumeCostConsent, issueCostConsent } from "./consent";

export { consentOperations };

const modelJob = z.object({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(100).optional(),
  confirmed: z.boolean().default(false),
}).strict();
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
  const issued = await issueCostConsent(owner, consent);
  return {
    structuredContent: {
      mode: studioMode(),
      message: `Approval recorded for ${consent.operation}; it can be used once within 10 minutes.`,
      consent: issued,
    },
  };
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
    if (name === "start_video_job" || name === "regenerate_segment" || name === "compose_final_video") {
    if (!consentToken)
      throw new StudioError("CONSENT", "Approve this paid step in the vidio studio first; a model-declared confirmation is not sufficient", 409);
    await consumeCostConsent(owner, consentToken, name, input as unknown as { projectId: string; revision: number; idempotencyKey?: string });
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
