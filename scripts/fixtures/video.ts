import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run=promisify(execFile);
export async function videoFixture(ratio:"16:9"|"9:16"="16:9",audio=true) {
  const workspace=await mkdtemp(path.join(tmpdir(),"vidio-test-"));
  try {
    const file=path.join(workspace,"fixture.mp4");
    await run("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i",`color=c=purple:s=${ratio==="16:9" ? "640x360" : "360x640"}:r=10`,...(audio ? ["-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-c:a","aac"] : []),"-t","2","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p",file],{timeout:15_000,maxBuffer:10_000});
    return await readFile(file);
  } finally {await rm(workspace,{recursive:true,force:true});}
}
