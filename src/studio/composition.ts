import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAsset, registerAsset } from "./assets";
import { mediaMetadata } from "./media";
import { MAX_ASSET_BYTES } from "./object-store";
import { probeVideo } from "./video-provider";
import {
  StudioError,
  type StudioProject,
  type CompositionOptions,
} from "./types";

const run = promisify(execFile);
export function subtitleFiles(segments: StudioProject["segments"]) {
  let offset = 0;
  const cues = segments.map((segment, index) => {
    const start = offset;
    offset += segment.duration;
    const stamp = (seconds: number) => {
      const ms = Math.round(seconds * 1000);
      return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
    };
    const text = segment.script
      .replace(/[<>\u0000]/g, "")
      .replace(/\s+/gu, " ");
    return {
      index: index + 1,
      time: `${stamp(start)} --> ${stamp(offset)}`,
      text,
    };
  });
  return {
    vtt: `WEBVTT\n\n${cues.map((cue) => `${cue.time}\n${cue.text}\n`).join("\n")}`,
    srt: cues
      .map(
        (cue) =>
          `${cue.index}\n${cue.time.replaceAll(".", ",")}\n${cue.text}\n`,
      )
      .join("\n"),
  };
}
export async function composeOwnedSegments(
  owner: string,
  project: StudioProject,
  ids: number[],
  signal?: AbortSignal,
  checkpoint: (progress: number) => Promise<void> = async () => {},
  options?: CompositionOptions,
) {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new StudioError("SEGMENTS", "Select unique completed segments");
  const selected = ids.map((id) => {
    const source=project.segments.find(segment=>segment.id===id);
    if (!source) throw new StudioError("SEGMENTS","Selected segment is not completed");
    return source;
  });
  const metadata=await Promise.all(selected.map(source=>mediaMetadata(owner,source.assetId)));
  if (metadata.some(asset=>asset.mime!=="video/mp4") || metadata.reduce((size,asset)=>size+asset.size,0)>80_000_000)
    throw new StudioError("ASSET_LIMIT","Composition inputs must be MP4 and total no more than 80 MB",413);
  const workspace = await mkdtemp(path.join(tmpdir(), "vidio-compose-"));
  try {
    for (const id of ids) {
      await checkpoint(10);
      const source = project.segments.find((segment) => segment.id === id);
      if (!source)
        throw new StudioError("SEGMENTS", "Selected segment is not completed");
      const asset = await readAsset(owner, source.assetId);
      if (asset.mime !== "video/mp4")
        throw new StudioError("SEGMENTS", "Selected segment is not a video");
      await writeFile(path.join(workspace, `${id}.mp4`), asset.buffer, {
        mode: 0o600,
      });
    }
    await writeFile(
      path.join(workspace, "concat.txt"),
      ids.map((id) => `file '${id}.mp4'`).join("\n"),
      { mode: 0o600 },
    );
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      "concat.txt",
    ];
    let inputIndex = 1;
    let captions: ReturnType<typeof subtitleFiles> | undefined;
    if (options?.subtitles) {
      captions = subtitleFiles(selected);
      await writeFile(path.join(workspace, "captions.srt"), captions.srt, {
        mode: 0o600,
      });
      args.push("-i", "captions.srt");
      inputIndex++;
    }
    const outputArgs = ["-map", "0:v:0"];
    if (options?.backgroundMusic === "soft") {
      const probe = await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "a",
          "-show_entries",
          "stream=index",
          "-of",
          "csv=p=0",
          selected[0].id + ".mp4",
        ],
        { cwd: workspace, signal, timeout: 10_000, maxBuffer: 1000 },
      );
      args.push(
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.025*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t))*pow(sin(PI*mod(t\\,2)/2)\\,2):s=44100",
      );
      if (probe.stdout.trim())
        outputArgs.push(
          "-filter_complex",
          `[0:a:0][${inputIndex}:a:0]amix=inputs=2:duration=first:normalize=0[a]`,
          "-map",
          "[a]",
        );
      else outputArgs.push("-map", `${inputIndex}:a:0`);
      // Bound synthetic audio by the full timeline, not sparse subtitle packets.
      outputArgs.push(
        "-c:a", "aac", "-t",
        String(selected.reduce((duration, segment) => duration + segment.duration, 0)),
      );
    } else outputArgs.push("-map", "0:a:0?", "-c:a", "copy");
    args.push(...outputArgs);
    if (captions)
      args.push(
        "-map",
        "1:s:0",
        "-c:s",
        "mov_text",
        "-metadata:s:s:0",
        "language=eng",
      );
    args.push(
      "-c:v",
      "copy",
      "-movflags",
      "+faststart",
      "-fs",
      String(MAX_ASSET_BYTES),
      "final.mp4",
    );
    await run("ffmpeg", args, {
      cwd: workspace,
      signal,
      timeout: 120_000,
      maxBuffer: 100_000,
    });
    await checkpoint(90);
    const output=path.join(workspace,"final.mp4");
    if ((await stat(output)).size>MAX_ASSET_BYTES) throw new StudioError("ASSET_LIMIT","Composed video exceeds 100 MB",413);
    const duration=await probeVideo(output,project.ratio,signal,120);
    if (Math.abs(duration-selected.reduce((total,segment)=>total+segment.duration,0))>0.25)
      throw new StudioError("COMPOSITION","Composed video did not preserve the complete scene timeline");
    project.finalAssetId = await registerAsset(
      owner,
      project.id,
      "video/mp4",
      await readFile(output),
    );
    if (captions)
      project.captionAssetId = await registerAsset(
        owner,
        project.id,
        "text/vtt",
        Buffer.from(captions.vtt),
      );
    else delete project.captionAssetId;
    project.stage = "done";
    return project;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
