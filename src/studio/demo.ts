import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { database } from "./db";
import { registerAsset, readAsset } from "./assets";
import { requireDemoMode } from "./config";
import { composeOwnedSegments } from "./composition";
import { renderProductScene } from "./local-video";
import { generateMarketing } from "./marketing-ai";
import { StudioError, type StudioProject, type JobInput, type Operation } from "./types";

export type ExecutionContext = {
  signal: AbortSignal;
  checkpoint: (progress: number) => Promise<void>;
  segment: (ordinal: number, produce: () => Promise<StudioProject["segments"][number]>) => Promise<StudioProject["segments"][number]>;
};

export async function executeDemo(owner: string, jobId: string, operation: Operation, input: JobInput, project: StudioProject, context?: ExecutionContext) {
  requireDemoMode();
  const workspace = path.join(process.cwd(), ".vidio", "jobs", jobId, crypto.randomUUID());
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  async function checkpoint(progress: number) {
    if (context) return context.checkpoint(progress);
    const result = await database().query("SELECT cancel_requested FROM vidio_jobs WHERE id=$1 AND owner_id=$2", [jobId, owner]);
    if (result.rows[0]?.cancel_requested) throw new StudioError("CANCELLED", "Job cancelled");
    await database().query("UPDATE vidio_jobs SET progress=greatest(progress,$2) WHERE id=$1 AND status IN ('running','partially_completed')", [jobId, progress]);
  }
  async function clip(id: number) {
    const script = project.scripts.find((item) => item.id === id);
    if (!script) throw new StudioError("SCRIPT", "Script not found");
    if (!project.imageAssetId) throw new StudioError("IMAGE_REQUIRED", "Upload a product image before generating video");
    const image = await readAsset(owner, project.imageAssetId);
    const buffer = await renderProductScene(image.buffer, image.mime, project.ratio, script.script);
    const output = path.join(workspace, `segment-${id}.mp4`);
    await writeFile(output, buffer, { mode: 0o600 });
    return { id, assetId: await registerAsset(owner, project.id, "video/mp4", buffer), duration: 5, script: script.script };
  }
  try {
    await checkpoint(5);
    if (operation === "identify_product") {
      delete project.notice;
      let marketing: Awaited<ReturnType<typeof generateMarketing>>;
      try { marketing = await generateMarketing(project, owner); }
      catch (error) {
        if (!(error instanceof StudioError) || !error.code.startsWith("GEMINI_")) throw error;
        project.notice = `${error.message} Generic local copy will be used; verify all product details.`;
      }
      project.marketingSource = marketing ? "gemini" : "local";
      if (!marketing && !project.notice) project.notice = "Gemini is disabled. Generic local copy will be used; verify all product details.";
      project.features = marketing?.features ?? ["Product appearance shown in the uploaded photo", "Visible product details for a concise product story"];
      if (marketing) project.name = marketing.productName;
      project.stage = "identified"; project.scripts = []; project.segments = [];
      delete project.finalAssetId; delete project.captionAssetId; delete project.voiceAssetId;
    } else if (operation === "draft_scripts") {
      let marketing: Awaited<ReturnType<typeof generateMarketing>>;
      if (project.marketingSource !== "local") {
        try { marketing = await generateMarketing(project, owner, true); }
        catch (error) {
          if (!(error instanceof StudioError) || !error.code.startsWith("GEMINI_")) throw error;
          project.marketingSource = "local";
          project.notice = `${error.message} Generic local scripts will be used; verify all product details.`;
        }
      }
      if (marketing) project.marketingSource = "gemini";
      else {
        project.marketingSource = "local";
        if (!project.notice) project.notice = "Gemini is disabled. Generic local scripts will be used; verify all product details.";
      }
      const defaults = [
        `Meet ${project.name}. A fresh perspective on your everyday.`,
        `Make room for the details. Here is ${project.name}, up close.`,
        `Built for your day. See how ${project.name} fits into your routine.`,
        `Your next everyday essential. Discover ${project.name} today.`,
      ];
      project.scripts = (marketing?.scripts?.map((item) => item.script) ?? defaults).map((script, index) => ({
        id: index + 1, script,
        prompt: marketing?.scripts?.[index]?.prompt ?? `Product close-up, clean studio lighting, scene ${index + 1}`,
      }));
      project.segments = []; project.stage = "scripted";
      delete project.finalAssetId; delete project.captionAssetId; delete project.voiceAssetId;
    } else if (operation === "preview_voice") {
      throw new StudioError("TTS_UNAVAILABLE", "Text-to-speech is not configured. Video export works without narration.", 503);
    } else if (operation === "generate_segments") {
      project.segments = [];
      for (const script of project.scripts) {
        project.segments.push(context ? await context.segment(script.id, () => clip(script.id)) : await clip(script.id));
        await checkpoint(20 + script.id * 15);
      }
      project.stage = "generated"; delete project.finalAssetId; delete project.captionAssetId;
    } else if (operation === "regenerate_segment") {
      const id = input.segmentId!;
      const segment = context ? await context.segment(id, () => clip(id)) : await clip(id);
      project.segments = [...project.segments.filter((item) => item.id !== segment.id), segment].sort((a, b) => a.id - b.id);
      project.stage = "generated"; delete project.finalAssetId; delete project.captionAssetId;
    } else if (operation === "compose_video") {
      await composeOwnedSegments(owner, project, input.segmentIds!, context?.signal, checkpoint, input.composition);
    }
    await checkpoint(95);
    return project;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
