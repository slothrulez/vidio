import { open } from "node:fs/promises";
import { database } from "./db";
import { assetPath } from "./assets";
import { objectKey, productionObjectStore, MAX_ASSET_BYTES } from "./object-store";
import { StudioError } from "./types";

let active = 0;
const owners = new Map<string, number>();

export function byteRange(value:string|null,size:number) {
  if (!value) return {start:0,end:size-1};
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return undefined;
  const first=Number(match[1]),last=Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return undefined;
  const start=match[1] ? first : Math.max(0,size-last);
  const end=match[1] && match[2] ? Math.min(last,size-1) : size-1;
  if ((!match[1] && !last) || start>end || start>=size) return undefined;
  return {start,end};
}

export async function mediaMetadata(owner:string,id:string) {
  const result=await database().query("SELECT mime,size,storage_backend,project_id FROM vidio_assets WHERE id=$1 AND owner_id=$2",[id,owner]);
  if (!result.rows.length) throw new StudioError("NOT_FOUND","Media not found",404);
  const row=result.rows[0],size=Number(row.size);
  if (!Number.isSafeInteger(size) || size<1 || size>MAX_ASSET_BYTES) throw new StudioError("STORAGE","Invalid asset metadata",503);
  return {mime:String(row.mime),size,backend:String(row.storage_backend),projectId:String(row.project_id)};
}

async function* localBytes(id:string,start:number,end:number,size:number) {
  const file=await open(assetPath(id),"r");
  try {
    if ((await file.stat()).size!==size) throw new StudioError("STORAGE","Asset size verification failed",503);
    for (let offset=start;offset<=end;) {
      const buffer=Buffer.alloc(Math.min(65_536,end-offset+1));
      const {bytesRead}=await file.read(buffer,0,buffer.length,offset);
      if (!bytesRead) throw new StudioError("STORAGE","Incomplete media",503);
      offset+=bytesRead;
      yield buffer.subarray(0,bytesRead);
    }
  } finally { await file.close(); }
}

export async function mediaStream(owner:string,id:string,metadata:Awaited<ReturnType<typeof mediaMetadata>>,range:{start:number;end:number},signal:AbortSignal) {
  if (active>=8 || (owners.get(owner) ?? 0)>=4) throw new StudioError("RATE_LIMIT","Too many active media reads",429);
  active++;
  owners.set(owner,(owners.get(owner) ?? 0)+1);
  let released=false;
  const release=()=>{
    if (released) return;
    released=true;
    active--;
    const count=(owners.get(owner) ?? 1)-1;
    if (count) owners.set(owner,count); else owners.delete(owner);
  };
  try {
    const source=metadata.backend==="s3"
      ? await productionObjectStore().range(objectKey(metadata.projectId,id),range.start,range.end,metadata.size,signal)
      : localBytes(id,range.start,range.end,metadata.size);
    const iterator=source[Symbol.asyncIterator]();
    let received=0;
    let stopped=false;
    let stopping:Promise<void>|undefined;
    let controller:ReadableStreamDefaultController<Uint8Array>;
    const stop=()=>{
      if (stopping) return stopping;
      stopped=true;
      signal.removeEventListener("abort",abort);
      stopping=Promise.resolve().then(()=>iterator.return?.()).then(()=>{},()=>{}).finally(release);
      return stopping;
    };
    const abort=()=>{if (!stopped) {controller.error(new StudioError("STORAGE","Media request cancelled"));void stop();}};
    return new ReadableStream<Uint8Array>({
      start(value) {controller=value;signal.addEventListener("abort",abort,{once:true});if (signal.aborted) abort();},
      async pull(value) {
        if (stopped) return;
        try {
          const chunk=await iterator.next();
          if (stopped) return;
          if (chunk.done) {
            if (received!==range.end-range.start+1) throw new Error("Incomplete media");
            await stop();value.close();return;
          }
          received+=chunk.value.length;
          if (received>range.end-range.start+1) throw new Error("Oversized media");
          value.enqueue(new Uint8Array(chunk.value));
        } catch {if (!stopped) {value.error(new StudioError("STORAGE","Media stream interrupted; refresh the link"));await stop();}}
      },
      cancel() {return stop();},
    });
  } catch(error) {release();throw error;}
}
