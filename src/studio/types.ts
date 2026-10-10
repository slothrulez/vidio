import { z } from "zod";

export const scriptSchema = z.object({
  id: z.number().int().positive(),
  script: z.string().min(1).max(1000),
  prompt: z.string().max(1500),
});
export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  revision: z.number().int(),
  language: z.enum(["english", "mandarin"]),
  ratio: z.enum(["16:9", "9:16", "1:1"]),
  stage: z.enum(["new", "identified", "scripted", "generated", "done"]),
  features: z.array(z.string()),
  scripts: z.array(scriptSchema),
  segments: z.array(
    z.object({
      id: z.number().int(),
      assetId: z.uuid(),
      duration: z.number(),
      script: z.string(),
    }),
  ),
  imageAssetId: z.uuid().optional(),
  voiceAssetId: z.uuid().optional(),
  finalAssetId: z.uuid().optional(),
  activeJobId: z.uuid().optional(),
  createdAt: z.string(),
  mode: z.literal("demo"),
});
export type StudioProject = z.infer<typeof projectSchema>;
export const jobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  operation: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type StudioJob = z.infer<typeof jobSchema>;
export const jobInputSchema = z
  .object({
    projectId: z.uuid(),
    revision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(100).optional(),
    confirmed: z.boolean().default(false),
    segmentId: z.number().int().min(1).max(4).optional(),
    segmentIds: z.array(z.number().int().min(1).max(4)).max(4).optional(),
  })
  .strict();
export type JobInput = z.infer<typeof jobInputSchema>;
export const operations = [
  "identify_product",
  "draft_scripts",
  "preview_voice",
  "generate_segments",
  "regenerate_segment",
  "compose_video",
] as const;
export type Operation = (typeof operations)[number];
export const toolOutputSchema = z.object({
  mode: z.literal("demo"),
  project: projectSchema.optional(),
  job: jobSchema.optional(),
  projects: z.array(projectSchema).optional(),
  message: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  finalVideo: z.object({ assetId: z.uuid(), mimeType: z.literal("video/mp4") }).optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;
export type ToolResponse = {
  structuredContent: ToolOutput;
  _meta?: { media?: Record<string, string> };
};

export class StudioError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
