import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { signedAssetUrl, registerAsset } from "./assets";
import { providerTask,providerCheckpoint,type ClaimedJob } from "./lifecycle";
import { StudioError,type StudioProject,type scriptSchema } from "./types";
import type { ExecutionContext } from "./demo";
import { MAX_ASSET_BYTES } from "./object-store";
import { boundedBody } from "./request";

type Script = z.infer<typeof scriptSchema>;
const taskSchema=z.object({id:z.string().min(1).max(200),status:z.enum(["queued","running","succeeded","failed","cancelled","expired"]),content:z.object({video_url:z.string().url().optional()}).optional(),duration:z.number().positive().max(30).optional()});
export type VideoTask=z.infer<typeof taskSchema>;
export interface VideoProvider {
  submit(project:StudioProject,script:Script,imageUrl:string|undefined,signal:AbortSignal):Promise<string>;
  poll(id:string,signal:AbortSignal):Promise<VideoTask>;
  download(url:string,signal:AbortSignal):Promise<Buffer>;
}
export class ArkVideoProvider implements VideoProvider {
  private base:string;
  private key:string;
  private model:string;
  constructor() {
    this.key=process.env.ARK_API_KEY ?? "";
    this.model=process.env.VIDEO_MODEL_EP ?? "";
    this.base=process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com";
    const url=new URL(this.base);
    if (!this.key || !this.model || url.protocol!=="https:" || url.username || url.password || !["/",""].includes(url.pathname) || url.search || url.hash)
      throw new StudioError("PROVIDER_CONFIGURATION","Configure ARK_API_KEY, VIDEO_MODEL_EP and an HTTPS ARK_BASE_URL origin",503);
    this.base=url.origin;
    if (!(process.env.VIDIO_PROVIDER_MEDIA_HOSTS ?? "").trim())
      throw new StudioError("PROVIDER_CONFIGURATION","Configure the provider CDN hostname allowlist",503);
  }
  async submit(project:StudioProject,script:Script,imageUrl:string|undefined,signal:AbortSignal) {
    const voice=project.language==="cantonese" ? "Cantonese (粤语), not Mandarin" : project.language==="mandarin" ? "Mandarin Chinese (普通话)" : "English";
    const content: Array<{type:"text";text:string}|{type:"image_url";image_url:{url:string};role:"first_frame"}>=[{type:"text",text:`${script.prompt}\nSpoken voiceover language: ${voice}. Read this approved narration: ${script.script}`}];
    if (imageUrl) content.push({type:"image_url",image_url:{url:imageUrl},role:"first_frame"});
    try {
      const response=await fetch(`${this.base}/api/v3/contents/generations/tasks`,{method:"POST",redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),headers:{Authorization:`Bearer ${this.key}`,"Content-Type":"application/json"},body:JSON.stringify({model:this.model,content,ratio:project.ratio,resolution:"720p",duration:5,generate_audio:true,watermark:true})});
      if (!response.ok) throw new Error("Submission rejected");
      return z.object({id:z.string().min(1).max(200)}).parse(JSON.parse(new TextDecoder().decode(await boundedBody(response,64_000)))).id;
    } catch { throw new StudioError("SUBMISSION_UNKNOWN","Provider submission outcome unknown; do not resubmit automatically",503); }
  }
  async poll(id:string,signal:AbortSignal) {
    try {
      const response=await fetch(`${this.base}/api/v3/contents/generations/tasks/${encodeURIComponent(id)}`,{redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(15_000)]),headers:{Authorization:`Bearer ${this.key}`}});
      if (!response.ok) throw new Error("Poll failed");
      const task=taskSchema.parse(JSON.parse(new TextDecoder().decode(await boundedBody(response,64_000))));
      if (task.id!==id) throw new Error("Task mismatch");
      return task;
    } catch { throw new StudioError("POLL","Provider status temporarily unavailable",503); }
  }
  async download(value:string,signal:AbortSignal) {
    const url=new URL(value);
    const allowed=(process.env.VIDIO_PROVIDER_MEDIA_HOSTS ?? "").split(",").map(host=>host.trim());
    if (url.protocol!=="https:" || (url.port && url.port!=="443") || url.username || url.password || !allowed.includes(url.hostname) || url.hostname==="localhost" || /^[\d.:\[\]]+$/.test(url.hostname))
      throw new StudioError("PROVIDER_MEDIA","Provider returned a media URL outside the approved CDN hosts");
    try {
      const response=await fetch(url,{redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])});
      if (!response.ok || !["video/mp4","application/octet-stream"].includes(response.headers.get("content-type")?.split(";")[0] ?? "") || Number(response.headers.get("content-length"))>MAX_ASSET_BYTES)
        throw new Error("Invalid media response");
      const buffer=Buffer.from(await boundedBody(response,MAX_ASSET_BYTES));
      if (buffer.toString("ascii",4,8)!=="ftyp") throw new Error("Invalid MP4 signature");
      return buffer;
    } catch { throw new StudioError("POLL","Provider video download failed",503); }
  }
}
export async function executeVideoJob(job:ClaimedJob,project:StudioProject,context:ExecutionContext,provider:VideoProvider) {
  if (!["generate_segments","regenerate_segment"].includes(job.operation)) throw new StudioError("OPERATION","Unsupported live operation");
  const scripts=project.scripts.filter(script=>job.operation==="generate_segments" || script.id===job.input.segmentId);
  let completed=0;
  for (const script of scripts) {
    const segment=await context.segment(script.id,async()=>{
      let taskId=await providerTask(job,script.id);
      if (!taskId) {
        const imageUrl=project.imageAssetId ? await signedAssetUrl(job.owner,project.imageAssetId) : undefined;
        await providerCheckpoint(job,script.id);
        taskId=await provider.submit(project,script,imageUrl,context.signal);
        await providerCheckpoint(job,script.id,taskId);
      }
      while (true) {
        await context.checkpoint(Math.floor(completed/scripts.length*85));
        const task=await provider.poll(taskId,context.signal);
        if (task.status==="failed" || task.status==="cancelled" || task.status==="expired") throw new StudioError("PROVIDER_FAILED","Provider task failed; resubmission requires a new approval");
        if (task.status==="succeeded") {
          if (!task.content?.video_url) throw new StudioError("PROVIDER_FAILED","Completed provider task has no video");
          const buffer=await provider.download(task.content.video_url,context.signal);
          return {id:script.id,assetId:await registerAsset(job.owner,project.id,"video/mp4",buffer),duration:task.duration ?? 5,script:script.script};
        }
        await delay(5000,undefined,{signal:context.signal});
      }
    });
    project.segments=[...project.segments.filter(item=>item.id!==script.id),segment].sort((a,b)=>a.id-b.id);
    completed++;
  }
  project.stage="generated";
  delete project.finalAssetId;
  return project;
}
