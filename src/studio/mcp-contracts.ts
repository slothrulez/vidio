import { z } from "zod";
import { schemas, executeTool, type ToolName } from "./service";
import { compositionOptionsSchema, operations, StudioError } from "./types";
import { getProject, getJob } from "./store";

const modelJob = z.object({
  projectId: z.uuid(),
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(100).optional(),
  confirmed: z.boolean().default(false),
}).strict();
const confirmedJob = modelJob.extend({ confirmed: z.literal(true) });
const statusSchema = z.object({ jobId: z.uuid() }).strict();
const finalSchema = z.object({ projectId: z.uuid() }).strict();
const segment = z.number().int().min(1).max(4);

export const mcpSchemas = {
  ...schemas,
  create_project: schemas.create_project.extend({ language: z.literal("english").default("english") }),
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

async function requireEnglishProject(owner: string, projectId: string) {
  const project = await getProject(owner, projectId);
  if (project.language !== "english")
    throw new StudioError("LANGUAGE", "Create a new English project to use the MCP studio. Your existing project is unchanged.");
}

export async function executeMcpTool(owner: string, name: McpToolName, args: unknown) {
  const input = mcpSchemas[name].parse(args);
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
  if (operations.some((operation) => operation === target) && "projectId" in input && typeof input.projectId === "string")
    await requireEnglishProject(owner, input.projectId);
  if (target === "retry_job" && "jobId" in input)
    await requireEnglishProject(owner, (await getJob(owner, input.jobId)).projectId);
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
