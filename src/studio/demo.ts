import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { database } from "./db";
import { registerAsset, readAsset } from "./assets";
import { requireDemoMode } from "./config";
import { composeOwnedSegments } from "./composition";
import {
  StudioError,
  type StudioProject,
  type JobInput,
  type Operation,
} from "./types";

const run = promisify(execFile);
export type ExecutionContext = {
  signal: AbortSignal;
  checkpoint: (progress: number) => Promise<void>;
  segment: (ordinal: number, produce: () => Promise<StudioProject["segments"][number]>) => Promise<StudioProject["segments"][number]>;
};
export async function executeDemo(
  owner: string,
  jobId: string,
  operation: Operation,
  input: JobInput,
  project: StudioProject,
  context?: ExecutionContext,
) {
  requireDemoMode();
  const workspace = path.join(process.cwd(), ".vidio", "jobs", jobId, crypto.randomUUID());
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  async function checkpoint(progress: number) {
    if (context) return context.checkpoint(progress);
    const result = await database().query(
      "SELECT cancel_requested FROM vidio_jobs WHERE id=$1 AND owner_id=$2",
      [jobId, owner],
    );
    if (result.rows[0]?.cancel_requested)
      throw new StudioError("CANCELLED", "Job cancelled");
    await database().query(
      "UPDATE vidio_jobs SET progress=greatest(progress,$2) WHERE id=$1 AND status IN ('running','partially_completed')",
      [jobId, progress],
    );
  }
  async function ffmpeg(args: string[]) {
    await checkpoint(10);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      timeout: 45000,
      maxBuffer: 100_000,
      signal: context?.signal,
    });
  }
  async function clip(id: number) {
    const script = project.scripts.find((script) => script.id === id);
    if (!script) throw new StudioError("SCRIPT", "Script not found");
    const image = project.imageAssetId
      ? path.join(workspace, "image")
      : path.join(process.cwd(), "src/app/opengraph-image.png");
    if (project.imageAssetId)
      await writeFile(
        image,
        (await readAsset(owner, project.imageAssetId)).buffer,
      );
    const label = path.join(workspace, "label.txt");
    await writeFile(
      label,
      `DEMO • SAMPLE MEDIA\n${project.name.replace(/[\r\n\0]/g, " ")} • Scene ${id}`,
    );
    const [width, height] =
      project.ratio === "9:16"
        ? [360, 640]
        : project.ratio === "1:1"
          ? [480, 480]
          : [640, 360];
    const output = path.join(workspace, `segment-${id}.mp4`);
    await ffmpeg([
      "-loop",
      "1",
      "-i",
      image,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${320 + id * 80}:sample_rate=44100`,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0xeee7ff,drawtext=textfile=${label}:fontcolor=white:fontsize=16:box=1:boxcolor=0x6c3bd1@0.85:boxborderw=10:x=(w-tw)/2:y=h-th-32`,
      "-t",
      "2",
      "-r",
      "24",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-af",
      "volume=0.08",
      "-movflags",
      "+faststart",
      output,
    ]);
    return {
      id,
      assetId: await registerAsset(
        owner,
        project.id,
        "video/mp4",
        await readFile(output),
      ),
      duration: 2,
      script: script.script,
    };
  }
  try {
    await checkpoint(5);
    if (operation === "identify_product") {
      project.features = [
        "Sample product presentation",
        "Show the details that matter",
        "An everyday essential",
      ];
      project.stage = "identified";
      project.scripts = [];
      project.segments = [];
      delete project.finalAssetId;
      delete project.voiceAssetId;
    } else if (operation === "draft_scripts") {
      const english = [
        `Meet ${project.name}. A fresh perspective on your everyday.`,
        `Make room for the details. Here is ${project.name}, up close.`,
        `Built for your day. See how ${project.name} fits into your routine.`,
        `Your next everyday essential. Discover ${project.name} today.`,
      ];
      const mandarin = [
        `认识${project.name}，发现日常生活的新灵感。`,
        `细节值得一看，近距离了解${project.name}。`,
        `让${project.name}融入你的日常。`,
        `发现你的下一件日常好物：${project.name}。`,
      ];
      project.scripts = (
        project.language === "english" ? english : mandarin
      ).map((script, id) => ({
        id: id + 1,
        script,
        prompt: `Studio product close-up, soft purple lighting, scene ${id + 1}`,
      }));
      project.segments = [];
      project.stage = "scripted";
      delete project.finalAssetId;
      delete project.voiceAssetId;
    } else if (operation === "preview_voice") {
      const output = path.join(workspace, "sample.mp3");
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "2",
        "-af",
        "volume=0.08",
        output,
      ]);
      project.voiceAssetId = await registerAsset(
        owner,
        project.id,
        "audio/mpeg",
        await readFile(output),
      );
    } else if (operation === "generate_segments") {
      project.segments = [];
      for (const script of project.scripts) {
        project.segments.push(context ? await context.segment(script.id, () => clip(script.id)) : await clip(script.id));
        await checkpoint(20 + script.id * 15);
      }
      project.stage = "generated";
      delete project.finalAssetId;
    } else if (operation === "regenerate_segment") {
      const segment = context ? await context.segment(input.segmentId!, () => clip(input.segmentId!)) : await clip(input.segmentId!);
      project.segments = [...project.segments.filter(item=>item.id!==segment.id),segment].sort((a,b)=>a.id-b.id);
      project.stage = "generated";
      delete project.finalAssetId;
    } else if (operation === "compose_video") {
      await composeOwnedSegments(owner,project,input.segmentIds!,context?.signal,checkpoint);
    }
    await checkpoint(95);
    return project;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
