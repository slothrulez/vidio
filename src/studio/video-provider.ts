import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { signedAssetUrl, registerAsset, readAsset } from "./assets";
import { providerTask,providerCheckpoint,providerRunning,rejectedSubmission,type ClaimedJob } from "./lifecycle";
import { StudioError,type StudioProject,type scriptSchema } from "./types";
import type { ExecutionContext } from "./demo";
import { MAX_ASSET_BYTES } from "./object-store";
import { boundedBody } from "./request";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run=promisify(execFile);
export async function probeVideo(file:string,ratio:StudioProject["ratio"],signal?:AbortSignal,maxDuration=30) {
  try {
    const result=await run("ffprobe",["-v","error","-show_entries","stream=codec_type,codec_name,width,height,duration,channels","-of","json",file],{signal,timeout:10_000,maxBuffer:10_000});
    const {streams}=z.object({streams:z.array(z.object({codec_type:z.string(),codec_name:z.string(),width:z.number().optional(),height:z.number().optional(),duration:z.coerce.number().optional(),channels:z.number().optional()})).max(8)}).parse(JSON.parse(result.stdout));
    const video=streams.filter(stream=>stream.codec_type==="video"),audio=streams.filter(stream=>stream.codec_type==="audio");
    const expected=ratio==="16:9" ? 16/9 : ratio==="9:16" ? 9/16 : 1;
    const v=video[0],a=audio[0];
    if (video.length!==1 || audio.length!==1 || v.codec_name!=="h264" || a.codec_name!=="aac" || !v.width || !v.height || v.width<64 || v.height<64 || v.width>1920 || v.height>1920 || Math.abs(v.width/v.height-expected)>0.03 || !v.duration || !a.duration || v.duration<1 || v.duration>maxDuration || Math.abs(v.duration-a.duration)>0.5 || !a.channels || a.channels>2) throw new Error("Unsupported video");
    await run("ffmpeg",["-hide_banner","-loglevel","error","-xerror","-i",file,"-map","0:v:0","-map","0:a:0","-f","null","-"],{signal,timeout:30_000,maxBuffer:10_000});
    return v.duration;
  } catch {throw new StudioError("PROVIDER_MEDIA","Video failed bounded format, timeline or audio validation",503);}
}

export async function validateProviderVideo(buffer:Buffer,ratio:StudioProject["ratio"],signal?:AbortSignal) {
  if (!buffer.length || buffer.length>MAX_ASSET_BYTES) throw new StudioError("ASSET_LIMIT","Provider video exceeds the media byte limit",413);
  const workspace=await mkdtemp(path.join(tmpdir(),"vidio-probe-"));
  try {
    const file=path.join(workspace,"segment.mp4");
    await writeFile(file,buffer,{mode:0o600});
    return await probeVideo(file,ratio,signal);
  } finally {await rm(workspace,{recursive:true,force:true});}
}

type Script = z.infer<typeof scriptSchema>;
const taskSchema=z.object({id:z.string().min(1).max(200),status:z.enum(["queued","running","succeeded","failed","cancelled","expired"]),content:z.object({video_url:z.string().url().optional()}).optional(),duration:z.number().positive().max(30).optional(),error:z.string().max(500).optional()});
export type VideoTask=z.infer<typeof taskSchema>;
export interface VideoProvider {
  readonly generationMode?: "wan" | "ark";
  readonly modelName?: string;
  uploadImage?(buffer:Buffer,mime:string,signal:AbortSignal):Promise<string>;
  submit(project:StudioProject,script:Script,imageUrl:string|undefined,signal:AbortSignal):Promise<string>;
  poll(id:string,signal:AbortSignal,onRunning?:()=>Promise<void>):Promise<VideoTask>;
  download(url:string,signal:AbortSignal):Promise<Buffer>;
  prepare?(buffer:Buffer,ratio:StudioProject["ratio"],signal:AbortSignal):Promise<{buffer:Buffer;duration:number}>;
}
export class ArkVideoProvider implements VideoProvider {
  readonly generationMode = "ark";
  get modelName() { return this.model; }
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
    const content: Array<{type:"text";text:string}|{type:"image_url";image_url:{url:string};role:"first_frame"}>=[{type:"text",text:`${script.prompt}\nSpoken voiceover language: English. Read this approved narration: ${script.script}`}];
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
        let imageUrl:string|undefined;
        if (project.imageAssetId) {
          if (provider.uploadImage) {
            const image=await readAsset(job.owner,project.imageAssetId);
            imageUrl=await provider.uploadImage(image.buffer,image.mime,context.signal);
          } else imageUrl=await signedAssetUrl(job.owner,project.imageAssetId);
        }
        await providerCheckpoint(job,script.id);
        try { taskId=await provider.submit(project,script,imageUrl,context.signal); }
        catch(error) {
          if (error instanceof StudioError && ["PROVIDER_UNAVAILABLE","PROVIDER_REJECTED","PROVIDER_UPLOAD","PROMPT"].includes(error.code)) await rejectedSubmission(job,script.id);
          throw error;
        }
        await providerCheckpoint(job,script.id,taskId);
      }
      while (true) {
        await context.checkpoint(Math.floor(completed/scripts.length*85));
        const task=await provider.poll(taskId,context.signal,()=>providerRunning(job,script.id));
        if (task.status==="failed" || task.status==="cancelled" || task.status==="expired") throw new StudioError("PROVIDER_FAILED",task.error ?? "Provider task failed; resubmission requires a new approval");
        if (task.status==="succeeded") {
          if (!task.content?.video_url) throw new StudioError("PROVIDER_FAILED","Completed provider task has no video");
          const downloaded=await provider.download(task.content.video_url,context.signal);
          const {buffer,duration}=provider.prepare ? await provider.prepare(downloaded,project.ratio,context.signal) : {buffer:downloaded,duration:await validateProviderVideo(downloaded,project.ratio,context.signal)};
          return {id:script.id,assetId:await registerAsset(job.owner,project.id,"video/mp4",buffer),duration,script:script.script,generationMode:provider.generationMode,model:provider.modelName};
        }
        await delay(5000,undefined,{signal:context.signal});
      }
    });
    project.segments=[...project.segments.filter(item=>item.id!==script.id),segment].sort((a,b)=>a.id-b.id);
    completed++;
  }
  project.stage="generated";
  delete project.finalAssetId;
  delete project.captionAssetId;
  return project;
}
