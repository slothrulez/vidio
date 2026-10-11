import { startWorker } from "../../src/worker";
import { registerAsset } from "../../src/studio/assets";
import { database } from "../../src/studio/db";

async function main() {
  const worker=await startWorker(async(job,project,context)=>{
    for (const script of project.scripts) {
      const segment=await context.segment(script.id,async()=>{
        if (job.id===process.env.TEST_JOB_ID && script.id===2 && (await database().query("SELECT attempts FROM vidio_jobs WHERE id=$1",[job.id])).rows[0].attempts===1) {
          process.send?.({phase:"partial",jobId:job.id});
          await new Promise<void>(()=>{});
        }
        return {id:script.id,assetId:await registerAsset(job.owner,project.id,"video/mp4",Buffer.from("mock-process-video")),duration:2,script:script.script};
      });
      project.segments=[...project.segments.filter(item=>item.id!==script.id),segment];
    }
    project.stage="generated";
    return project;
  });
  process.send?.({phase:"ready"});
  process.on("SIGTERM",()=>void worker().then(()=>database().end()).then(()=>process.exit(0)));
}
main().catch(()=>process.exit(1));
