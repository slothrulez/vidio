import { z } from "zod";
import {
  createProject,
  getProject,
  listProjects,
  getJob,
  startJob,
  updateScript,
  cancelJob,
  replaceScripts,
} from "./store";
import { projectMedia } from "./assets";
import {
  jobInputSchema,
  operations,
  type ToolResponse,
  StudioError,
  scriptsSchema,
} from "./types";
import { studioMode } from "./config";
import { uploadSchemas, executeUpload, type UploadTool } from "./uploads";
import { retryJob } from "./lifecycle";
import { database } from "./db";

export const schemas = {
  ...uploadSchemas,
  create_project: z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .default("Your everyday essential"),
      language: z.literal("english").default("english"),
      ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
    })
    .strict(),
  list_projects: z.object({}).strict(),
  get_project: z.object({ projectId: z.uuid() }).strict(),
  render_project: z.object({ projectId: z.uuid().optional() }).strict(),
  get_job: z.object({ jobId: z.uuid() }).strict(),
  cancel_job: z.object({ jobId: z.uuid() }).strict(),
  retry_job: z.object({ jobId: z.uuid() }).strict(),
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
  save_scripts: z.object({projectId:z.uuid(),revision:z.number().int().nonnegative(),scripts:scriptsSchema.min(1).refine(scripts=>scripts.every(script=>script.prompt.trim().length>0),"Visual directions are required")}).strict(),
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
  const mode=studioMode();
  let project, job, projects, upload;
  let message = mode === "demo" ?
    "Local preview: recognition/scripts are fixtures and voice preview is a tone. Wan footage requires explicit selection and available free GPU quota; static fallback is not AI footage." : "Production studio: owned projects, durable jobs and private media.";
  if (Object.hasOwn(uploadSchemas,name)) {
    const result=await executeUpload(owner,name as UploadTool,args);
    project=result.project;
    upload=result.upload;
    message=project ? "Product image saved privately." : name==="abort_image_upload" ? "Unfinished upload cancelled." : "Private image upload in progress.";
  } else if (operations.some((operation) => operation === name)) {
    const input = jobInputSchema.parse(args);
    job = await startJob(owner, name as (typeof operations)[number], input);
    project = await getProject(owner, input.projectId);
    message = `Job queued${input.generationMode === "wan" ? ": anonymous Wan AI inference, subject to free GPU quota" : input.generationMode === "static" ? ": static image fallback, NOT AI footage" : ""}. Poll get_job and get_project for durable progress.`;
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
  else if (name === "retry_job") {
    const input=schemas.retry_job.parse(args);
    await retryJob(owner,input.jobId);
    job=await getJob(owner,input.jobId);
  }
  else if (name === "save_scripts") {
    const input=schemas.save_scripts.parse(args);
    project=await replaceScripts(owner,input.projectId,input.revision,input.scripts);
  } else if (name === "update_script")
    project = await updateScript(owner, schemas.update_script.parse(args));
  if (project && !job && ["get_project", "render_project"].includes(name)) {
    const latest=await database().query("SELECT id FROM vidio_jobs WHERE project_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[project.id,owner]);
    if (latest.rows.length) job=await getJob(owner,latest.rows[0].id);
  }
  return {
    structuredContent: { mode, project, job, projects, message },
    _meta: { ...(project ? { media: await projectMedia(owner, project),mediaExpiresAt:new Date(Date.now()+600_000).toISOString() } : {}), ...(upload ? {upload} : {}) },
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
