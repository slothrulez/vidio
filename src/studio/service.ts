import { z } from "zod";
import {
  createProject,
  getProject,
  listProjects,
  getJob,
  startJob,
  updateScript,
  cancelJob,
} from "./store";
import { projectMedia } from "./assets";
import {
  jobInputSchema,
  operations,
  type ToolResponse,
  StudioError,
} from "./types";
import { requireDemoMode } from "./config";

export const schemas = {
  create_project: z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .default("Your everyday essential"),
      language: z.enum(["english", "mandarin"]).default("english"),
      ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
    })
    .strict(),
  list_projects: z.object({}).strict(),
  get_project: z.object({ projectId: z.uuid() }).strict(),
  render_project: z.object({ projectId: z.uuid().optional() }).strict(),
  get_job: z.object({ jobId: z.uuid() }).strict(),
  cancel_job: z.object({ jobId: z.uuid() }).strict(),
  get_download: z.object({ projectId: z.uuid() }).strict(),
  update_script: z
    .object({
      projectId: z.uuid(),
      revision: z.number().int().nonnegative(),
      id: z.number().int().min(1).max(4),
      script: z.string().trim().min(1).max(1000),
      prompt: z.string().trim().min(1).max(1500),
    })
    .strict(),
  identify_product: jobInputSchema,
  draft_scripts: jobInputSchema,
  preview_voice: jobInputSchema,
  generate_segments: jobInputSchema,
  regenerate_segment: jobInputSchema,
  compose_video: jobInputSchema,
};
export type ToolName = keyof typeof schemas;
export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}

export async function executeTool(
  owner: string,
  name: ToolName,
  args: unknown,
): Promise<ToolResponse> {
  requireDemoMode();
  let project, job, projects;
  let message =
    "Demo only: recognition and scripts are fixtures; voice is a sample tone and videos are local sample media. No AI provider was called.";
  if (operations.some((operation) => operation === name)) {
    const input = jobInputSchema.parse(args);
    job = await startJob(owner, name as (typeof operations)[number], input);
    project = await getProject(owner, input.projectId);
    message =
      "Demo job queued. Poll get_job and get_project for durable progress. No paid generation.";
  } else if (name === "create_project")
    project = await createProject(owner, schemas.create_project.parse(args));
  else if (name === "list_projects") {
    schemas.list_projects.parse(args);
    projects = await listProjects(owner);
  } else if (name === "get_project" || name === "get_download") {
    project = await getProject(
      owner,
      schemas.get_project.parse(args).projectId,
    );
    if (name === "get_download" && !project.finalAssetId)
      throw new StudioError("NOT_READY", "Compose a video first");
  } else if (name === "render_project") {
    const input = schemas.render_project.parse(args);
    if (input.projectId) project = await getProject(owner, input.projectId);
    else projects = await listProjects(owner);
  } else if (name === "get_job")
    job = await getJob(owner, schemas.get_job.parse(args).jobId);
  else if (name === "cancel_job")
    job = await cancelJob(owner, schemas.cancel_job.parse(args).jobId);
  else if (name === "update_script")
    project = await updateScript(owner, schemas.update_script.parse(args));
  return {
    structuredContent: { mode: "demo", project, job, projects, message },
    _meta: project ? { media: await projectMedia(owner, project) } : undefined,
  };
}

export function safeError(error: unknown) {
  if (error instanceof StudioError)
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return {
      status: 400,
      body: {
        error: { code: "VALIDATION", message: "Invalid or unsupported input" },
      },
    };
  return {
    status: 503,
    body: {
      error: {
        code: "UNAVAILABLE",
        message: "Studio unavailable; check the database and worker.",
      },
    },
  };
}
