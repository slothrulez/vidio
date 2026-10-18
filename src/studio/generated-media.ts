import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { StudioError, type StudioProject } from "./types";
import { MAX_ASSET_BYTES } from "./object-store";
import { probeVideo } from "./video-provider";

const run = promisify(execFile);
export async function normalizeGeneratedVideo(buffer: Buffer, ratio: StudioProject["ratio"], signal: AbortSignal) {
  if (!buffer.length || buffer.length > MAX_ASSET_BYTES) throw new StudioError("PROVIDER_MEDIA", "Generated clip exceeds the media byte limit", 503);
  const workspace = await mkdtemp(path.join(tmpdir(), "vidio-generated-"));
  try {
    const input = path.join(workspace, "raw.mp4"), output = path.join(workspace, "scene.mp4");
    await writeFile(input, buffer, { mode: 0o600 });
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration,nb_frames", "-of", "json", input], { signal, timeout: 10_000, maxBuffer: 10_000 });
    const { streams } = z.object({ streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional(), duration: z.coerce.number().optional(), nb_frames: z.coerce.number().optional() })).max(4) }).parse(JSON.parse(probe.stdout));
    const video = streams.filter(stream => stream.codec_type === "video");
    const audio = streams.filter(stream => stream.codec_type === "audio");
    const v = video[0];
    if (video.length !== 1 || audio.length > 1 || !v.width || !v.height || v.width < 64 || v.height < 64 || v.width > 1920 || v.height > 1920 || !v.duration || v.duration < 1 || v.duration > 30 || !v.nb_frames || v.nb_frames < 16)
      throw new StudioError("PROVIDER_MEDIA", "Generated clip failed frame, duration or resolution validation", 503);
    // Decode the entire source before any normalization can conceal a damaged tail.
    await run("ffmpeg", ["-v", "error", "-xerror", "-i", input, "-map", "0:v:0", "-f", "null", "-"], { signal, timeout: 30_000, maxBuffer: 10_000 });
    const [width, height] = ratio === "16:9" ? [640, 360] : ratio === "9:16" ? [360, 640] : [480, 480];
    await run("ffmpeg", ["-v", "error", "-xerror", "-y", "-i", input,
      ...(audio.length ? [] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
      "-map", "0:v:0", "-map", audio.length ? "0:a:0" : "1:a:0",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`,
      "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-af", "apad",
      "-t", String(v.duration), "-movflags", "+faststart", "-fs", String(MAX_ASSET_BYTES), output], { signal, timeout: 120_000, maxBuffer: 10_000 });
    if ((await stat(output)).size > MAX_ASSET_BYTES) throw new StudioError("PROVIDER_MEDIA", "Normalized clip exceeds the media byte limit", 503);
    const duration = await probeVideo(output, ratio, signal);
    if (Math.abs(duration - v.duration) > 0.15) throw new StudioError("PROVIDER_MEDIA", "Normalization truncated the generated clip", 503);
    return { buffer: await readFile(output), duration };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof StudioError) throw error;
    throw new StudioError("PROVIDER_MEDIA", "Generated clip could not be decoded and normalized", 503);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
