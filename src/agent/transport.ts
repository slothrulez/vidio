import { z } from "zod";

const media = z.object({
  url: z.string(),
  localPath: z.string().optional(),
  duration: z.number().optional(),
});
const completed = z.object({
  type: z.literal("done"),
  data: z.object({ video: media, audio: media.optional() }),
});
const legacy = z.object({
  videoUrl: z.string(),
  videoPath: z.string().optional(),
  audioPath: z.string().optional(),
});

export function parseRegenerationResult(
  body: unknown,
  id: number,
  script: string,
) {
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("{"))
      return { id, script, ...legacy.parse(JSON.parse(trimmed)) };
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const value: unknown = JSON.parse(line.slice(5).trim());
      const result = completed.safeParse(value);
      if (result.success) {
        return {
          id,
          script,
          videoUrl: result.data.data.video.url,
          videoPath: result.data.data.video.localPath,
          audioPath: result.data.data.audio?.localPath,
          audioUrl: result.data.data.audio?.url,
          duration: result.data.data.video.duration,
        };
      }
      const failure = z
        .object({
          type: z.literal("error"),
          data: z.object({ message: z.string() }),
        })
        .safeParse(value);
      if (failure.success) throw new Error(failure.data.data.message);
    }
    throw new Error("Regeneration stream ended without a completed segment");
  }
  return { id, script, ...legacy.parse(body) };
}
