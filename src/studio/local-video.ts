import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StudioProject } from "./types";

const run = promisify(execFile);
const dimensions = (ratio: StudioProject["ratio"]) => ratio === "9:16" ? [360, 640] : ratio === "1:1" ? [480, 480] : [640, 360];

/** Render a genuine, locally encoded H.264/AAC scene from the uploaded still. */
export async function renderProductScene(image: Buffer, mime: string, ratio: StudioProject["ratio"], headline: string, narration?: Buffer) {
  const workspace = await mkdtemp(path.join(tmpdir(), "vidio-local-video-"));
  try {
    const extension = mime === "image/png" ? "png" : "jpg";
    await writeFile(path.join(workspace, `product.${extension}`), image, { mode: 0o600 });
    await writeFile(path.join(workspace, "caption.txt"), headline.replace(/[\r\n\0]/g, " ").slice(0, 240), { mode: 0o600 });
    const [width, height] = dimensions(ratio);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "24", "-i", `product.${extension}`];
    if (narration) {
      await writeFile(path.join(workspace, "narration.wav"), narration, { mode: 0o600 });
      args.push("-i", "narration.wav");
    } else args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    args.push("-t", "5", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(zoom+0.0008,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=24,drawtext=textfile=caption.txt:fontcolor=white:fontsize=${Math.max(18, Math.floor(width / 24))}:box=1:boxcolor=black@0.58:boxborderw=16:x=(w-text_w)/2:y=h-text_h-30`, "-r", "24", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "scene.mp4");
    await run("ffmpeg", args, { cwd: workspace, timeout: 90_000, maxBuffer: 100_000 });
    return await readFile(path.join(workspace, "scene.mp4"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
