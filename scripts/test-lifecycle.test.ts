import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { database } from "../src/studio/db";
import { createProject,getProject,getJob,startJob,saveProject } from "../src/studio/store";
import { claimJob,heartbeat,completeJob,failJob,recoverJobs,completedSegment,persistSegment,providerCheckpoint,retryJob,persistComposition } from "../src/studio/lifecycle";
import { runJob } from "../src/worker";
import { fork,type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { registerAsset,readAsset } from "../src/studio/assets";
import { StudioError } from "../src/studio/types";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Use a disposable TEST_DATABASE_URL ending in _test");
process.env.DATABASE_URL=url;
process.env.VIDIO_MODE="demo";
const owner=`test-lifecycle-${randomUUID()}`;
before(async()=>{
  await database().query(await readFile("migrations/0001_studio.sql","utf8"));
  await database().query(await readFile("migrations/0002_job_lifecycle.sql","utf8"));
  await database().query(await readFile("migrations/0003_result_ownership.sql","utf8"));
  await database().query(await readFile("migrations/0004_widget_uploads.sql","utf8"));
  await database().query(await readFile("migrations/0005_release_safety.sql","utf8"));
  await database().query(await readFile("migrations/0006_cost_consent.sql","utf8"));
});
after(async()=>{
  await database().query("DELETE FROM vidio_projects WHERE owner_id=$1",[owner]);
  await database().end();
});
async function fixture() {
  const project=await createProject(owner,{name:"Lifecycle test",language:"english",ratio:"16:9"});
  project.stage="scripted";
  project.scripts=[1,2].map(id=>({id,script:`Scene ${id}`,prompt:"Mock only"}));
  await saveProject(owner,project);
  const input={projectId:project.id,revision:project.revision,confirmed:true,idempotencyKey:randomUUID()};
  const job=await startJob(owner,"generate_segments",input);
  return {project,input,job};
}
test("jobs immediately expose persistent owned segments and idempotency",async()=>{
  const {job,input}=await fixture();
  const repeat=await startJob(owner,"generate_segments",input);
  assert.equal(repeat.id,job.id);
  const status=await getJob(owner,job.id);
  assert.equal(status.lifecycleStatus,"queued");
  assert.equal(status.segments?.length,2);
  assert.ok(status.updatedAt);
  await assert.rejects(()=>getJob("other-owner",job.id));
  await assert.rejects(()=>startJob(owner,"generate_segments",{...input,revision:1}));
});
test("partial completion survives a worker restart and fences the previous worker",async()=>{
  const {job,project}=await fixture();
  const first=(await claimJob(job.id))!;
  await completedSegment(first,1);
  const assetId=await registerAsset(owner,project.id,"video/mp4",Buffer.from("fixture-video"));
  await persistSegment(first,{id:1,assetId,duration:2,script:"Scene 1"});
  assert.equal((await getJob(owner,job.id)).lifecycleStatus,"partially_completed");
  await database().query("UPDATE vidio_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  await recoverJobs();
  const second=(await claimJob(job.id))!;
  assert.notEqual(first.token,second.token);
  await assert.rejects(()=>heartbeat(first),{code:"LEASE_LOST"});
  assert.equal((await completedSegment(second,1))?.assetId,assetId);
  const latest=await getProject(owner,project.id);
  assert.equal(latest.segments[0].assetId,assetId);
  await assert.rejects(()=>completeJob(second,latest));
  await completedSegment(second,2);
  const asset2=await registerAsset(owner,project.id,"video/mp4",Buffer.from("fixture-video-2"));
  await persistSegment(second,{id:2,assetId:asset2,duration:2,script:"Scene 2"});
  latest.segments=(await getProject(owner,project.id)).segments;
  await completeJob(second,latest);
  assert.equal((await getJob(owner,job.id)).lifecycleStatus,"completed");
  assert.equal((await readAsset(owner,assetId)).buffer.toString(),"fixture-video");
  await assert.rejects(()=>readAsset("other-owner",assetId));
});
test("retryable failures use bounded attempts and retained progress",async()=>{
  const {job,project}=await fixture();
  for(let attempt=1;attempt<=3;attempt++){
    const claim=(await claimJob(job.id))!;
    assert.ok(claim);
    await failJob(claim,new StudioError("POLL","private provider detail"));
    const state=await getJob(owner,job.id);
    assert.equal(state.attempts,attempt);
    assert.equal(state.lifecycleStatus,attempt<3?"queued":"failed");
    assert.equal(state.error?.includes("private provider"),false);
    await database().query("UPDATE vidio_jobs SET next_attempt_at=now() WHERE id=$1",[job.id]);
  }
  assert.equal((await getProject(owner,project.id)).activeJobId,undefined);
  await assert.rejects(()=>retryJob(owner,job.id));
});
test("unknown paid submissions fail closed after recovery rather than submit twice",async()=>{
  const {job}=await fixture();
  const claim=(await claimJob(job.id))!;
  await completedSegment(claim,1);
  await providerCheckpoint(claim,1);
  await database().query("UPDATE vidio_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  await recoverJobs();
  const state=await getJob(owner,job.id);
  assert.equal(state.lifecycleStatus,"failed");
  assert.equal(state.errorCode,"SUBMISSION_UNKNOWN");
  assert.equal(state.retryable,false);
  await assert.rejects(()=>retryJob(owner,job.id));
  assert.equal(await claimJob(job.id),null);
});
test("known provider tasks are retained for retry and cancellation does not expose media",async()=>{
  const {job}=await fixture();
  const claim=(await claimJob(job.id))!;
  await completedSegment(claim,1);
  await providerCheckpoint(claim,1);
  await providerCheckpoint(claim,1,"provider-task-123");
  await failJob(claim,new StudioError("POLL","network"));
  await database().query("UPDATE vidio_jobs SET next_attempt_at=now() WHERE id=$1",[job.id]);
  const next=(await claimJob(job.id))!;
  await completedSegment(next,1);
  const task=await database().query("SELECT provider_task_id FROM vidio_job_segments WHERE job_id=$1 AND ordinal=1",[job.id]);
  assert.equal(task.rows[0].provider_task_id,"provider-task-123");
  await database().query("UPDATE vidio_jobs SET cancel_requested=true WHERE id=$1",[job.id]);
  await assert.rejects(()=>heartbeat(next),{code:"CANCELLED"});
  await failJob(next,new StudioError("CANCELLED","cancelled"));
  assert.equal((await getJob(owner,job.id)).status,"cancelled");
});
test("deadlines and cross-owner segment writes are rejected",async()=>{
  const {job}=await fixture();
  const claim=(await claimJob(job.id))!;
  await assert.rejects(()=>persistSegment(claim,{id:1,assetId:randomUUID(),duration:2,script:"Scene 1"}));
  await database().query("UPDATE vidio_jobs SET deadline_at=now()-interval '1 second' WHERE id=$1",[job.id]);
  await assert.rejects(()=>heartbeat(claim),{code:"TIMEOUT"});
  await failJob(claim,new StudioError("TIMEOUT","private detail"));
  assert.equal((await getJob(owner,job.id)).lifecycleStatus,"failed");
});
test("composition checkpoint resumes without producing another final asset",async()=>{
  const {job,project}=await fixture();
  await database().query("UPDATE vidio_jobs SET status='cancelled' WHERE id=$1",[job.id]);
  delete project.activeJobId;
  const assetId=await registerAsset(owner,project.id,"video/mp4",Buffer.from("owned-composition-fixture"));
  project.segments=[{id:1,assetId,duration:2,script:"Scene 1"}];
  await saveProject(owner,project);
  const compose=await startJob(owner,"compose_video",{projectId:project.id,revision:project.revision,confirmed:true,segmentIds:[1],idempotencyKey:randomUUID()});
  const first=(await claimJob(compose.id))!;
  await persistComposition(first,assetId);
  await database().query("UPDATE vidio_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[compose.id]);
  await recoverJobs();
  await runJob(compose.id,async()=>{throw new Error("Composition must not run twice");});
  assert.equal((await getJob(owner,compose.id)).lifecycleStatus,"completed");
  assert.equal((await getProject(owner,project.id)).finalAssetId,assetId);
  assert.equal((await retryJob(owner,compose.id)).id,compose.id);
});
test("pg-boss survives a killed worker process and reuses its completed segment",{timeout:30_000},async()=>{
  const {job}=await fixture();
  let child:ChildProcess|undefined;
  const launch=()=>fork(fileURLToPath(new URL("./fixtures/lifecycle-worker.ts",import.meta.url)),[],{execArgv:["--import","tsx"],env:{...process.env,DATABASE_URL:url,TEST_JOB_ID:job.id},stdio:["ignore","ignore","pipe","ipc"]});
  try {
    child=launch();
    let stderr="";
    child.stderr?.on("data",chunk=>{stderr+=String(chunk).slice(0,500);});
    const partial=new Promise<void>((resolve,reject)=>{
      child!.on("message",message=>{if (typeof message==="object" && message!==null && "phase" in message && message.phase==="partial") resolve();});
      child!.once("exit",()=>reject(new Error(`Worker stopped before checkpoint: ${stderr}`)));
    });
    await Promise.race([partial,delay(12_000,undefined,{ref:false}).then(()=>{throw new Error("Worker checkpoint timed out");})]);
    const before=await getJob(owner,job.id);
    assert.equal(before.lifecycleStatus,"partially_completed");
    const assetId=before.segments?.[0].assetId;
    assert.ok(assetId);
    const exit=once(child,"exit");
    child.kill("SIGKILL");
    await exit;
    await database().query("UPDATE vidio_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
    child=launch();
    let state=await getJob(owner,job.id);
    const deadline=Date.now()+12_000;
    while (state.lifecycleStatus!=="completed" && Date.now()<deadline) {
      await delay(100);
      state=await getJob(owner,job.id);
    }
    assert.equal(state.lifecycleStatus,"completed");
    assert.equal(state.segments?.[0].assetId,assetId);
    assert.equal(state.attempts,2);
  } finally {
    if (child?.exitCode===null && child.signalCode===null) {
      const exit=once(child,"exit");
      child.kill("SIGTERM");
      await Promise.race([exit,delay(5000,undefined,{ref:false}).then(()=>child?.kill("SIGKILL"))]);
    }
  }
});
