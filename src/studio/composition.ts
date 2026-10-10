import { mkdtemp,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAsset,registerAsset } from "./assets";
import { StudioError,type StudioProject } from "./types";

const run=promisify(execFile);
export async function composeOwnedSegments(owner:string,project:StudioProject,ids:number[],signal?:AbortSignal,checkpoint: (progress:number)=>Promise<void>=async()=>{}) {
  if (!ids.length || new Set(ids).size!==ids.length) throw new StudioError("SEGMENTS","Select unique completed segments");
  const workspace=await mkdtemp(path.join(tmpdir(),"vidio-compose-"));
  try {
    for (const id of ids) {
      await checkpoint(10);
      const source=project.segments.find(segment=>segment.id===id);
      if (!source) throw new StudioError("SEGMENTS","Selected segment is not completed");
      const asset=await readAsset(owner,source.assetId);
      if (asset.mime!=="video/mp4") throw new StudioError("SEGMENTS","Selected segment is not a video");
      await writeFile(path.join(workspace,`${id}.mp4`),asset.buffer,{mode:0o600});
    }
    await writeFile(path.join(workspace,"concat.txt"),ids.map(id=>`file '${id}.mp4'`).join("\n"),{mode:0o600});
    await run("ffmpeg",["-hide_banner","-loglevel","error","-y","-f","concat","-safe","1","-i","concat.txt","-c","copy","-movflags","+faststart","final.mp4"],{cwd:workspace,signal,timeout:120_000,maxBuffer:100_000});
    await checkpoint(90);
    project.finalAssetId=await registerAsset(owner,project.id,"video/mp4",await readFile(path.join(workspace,"final.mp4")));
    project.stage="done";
    return project;
  } finally { await rm(workspace,{recursive:true,force:true}); }
}
