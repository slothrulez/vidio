import { test, after, before, mock } from "node:test";
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
import { videoFixture } from "./fixtures/video";
import { WAN_SPACE_REVISION } from "../src/studio/wan-provider";
import { executeMcpTool } from "../src/studio/mcp-contracts";

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
async function aiFixture() {
  const project=await createProject(owner,{name:"Wan lifecycle test",language:"english",ratio:"16:9"});
  project.stage="scripted";
  project.scripts=[{id:1,script:"Mock scene one",prompt:"Mock moving product"}];
  await saveProject(owner,project);
  return project;
}
test("Wan is operator opt-in, separate from paid admission, and static fallback is explicit",async()=>{
  const project=await aiFixture();
  const input={projectId:project.id,revision:0,confirmed:true,idempotencyKey:randomUUID(),generationMode:"wan" as const};
  delete process.env.VIDIO_WAN_ENABLED;
  await assert.rejects(()=>startJob(owner,"generate_segments",input),{code:"PROVIDER_CONFIGURATION"});
  await assert.rejects(()=>startJob(owner,"generate_segments",{...input,generationMode:"ark"}),{code:"BUDGET"});
  const job=await startJob(owner,"generate_segments",{...input,generationMode:"static"});
  const spy=mock.method(globalThis,"fetch",async()=>{throw new Error("Static fallback must not contact a provider");});
  try {
    await runJob(job.id);
    assert.equal((await getJob(owner,job.id)).lifecycleStatus,"completed");
    assert.equal((await getProject(owner,project.id)).segments[0].generationMode,"static");
    assert.equal(spy.mock.callCount(),0);
  } finally { spy.mock.restore(); }
});
test("Wan worker checkpoints actual task IDs, validates silent generated media and stores owned provenance",async()=>{
  const project=await aiFixture();
  const signalEvent="b".repeat(32),base="https://naxyiudu228-wan22-ti2v-5b.hf.space";
  const clip=await videoFixture("16:9",false);
  let submissions=0;
  process.env.VIDIO_WAN_ENABLED="true";
  const spy=mock.method(globalThis,"fetch",async(url:unknown)=>{
    if(String(url).includes("/api/spaces/")) return Response.json({runtime:{stage:"RUNNING",sha:WAN_SPACE_REVISION,hardware:{current:"zero-a10g"}}});
    if(String(url).endsWith("/call/generate_video")) { submissions++; return Response.json({event_id:signalEvent}); }
    if(String(url).endsWith(signalEvent)) return new Response(`event: generating\ndata: null\n\nevent: complete\ndata: [{"url":"${base}/gradio_api/file=/tmp/gradio/generated.mp4"}]\n\n`);
    return new Response(clip,{headers:{"Content-Type":"video/mp4"}});
  });
  try {
    const job=await startJob(owner,"generate_segments",{projectId:project.id,revision:0,confirmed:true,idempotencyKey:randomUUID(),generationMode:"wan"});
    await runJob(job.id);
    const state=await getJob(owner,job.id),next=await getProject(owner,project.id);
    assert.equal(state.lifecycleStatus,"completed"); assert.equal(submissions,1);
    assert.equal(state.segments?.[0].status,"completed"); assert.equal(next.segments[0].generationMode,"wan");
    assert.match(next.segments[0].model!,/FastWan/);
    assert.equal((await readAsset(owner,next.segments[0].assetId)).mime,"video/mp4");
    const checkpoint=await database().query("SELECT provider_task_id FROM vidio_job_segments WHERE job_id=$1",[job.id]);
    assert.equal(checkpoint.rows[0].provider_task_id,signalEvent);
  } finally { spy.mock.restore(); delete process.env.VIDIO_WAN_ENABLED; }
});
test("free GPU quota failure remains visible, never switches modes, and permits explicit fallback",async()=>{
  const project=await aiFixture();
  let submissions=0;
  process.env.VIDIO_WAN_ENABLED="true";
  const spy=mock.method(globalThis,"fetch",async(url:unknown)=>{
    if(String(url).includes("/api/spaces/")) return Response.json({runtime:{stage:"RUNNING",sha:WAN_SPACE_REVISION,hardware:{current:"zero-a10g"}}});
    if(String(url).endsWith("/call/generate_video")) { submissions++; return Response.json({event_id:"c".repeat(32)}); }
    return new Response('event: error\ndata: "GPU quota exceeded. Retry tomorrow."\n\n');
  });
  try {
    const input={projectId:project.id,revision:0,confirmed:true,idempotencyKey:randomUUID(),generationMode:"wan" as const};
    const job=await startJob(owner,"generate_segments",input);
    await runJob(job.id);
    const failed=await getJob(owner,job.id);
    assert.equal(failed.lifecycleStatus,"failed"); assert.match(failed.error!,/GPU quota exceeded/);
    assert.equal(failed.segments?.[0].status,"failed"); assert.equal(submissions,1);
    assert.equal((await getProject(owner,project.id)).segments.length,0);
    const fallback=await startJob(owner,"generate_segments",{...input,idempotencyKey:randomUUID(),generationMode:"static"});
    await runJob(fallback.id);
    assert.equal((await getProject(owner,project.id)).segments[0].generationMode,"static");
    assert.equal(submissions,1);
  } finally { spy.mock.restore(); delete process.env.VIDIO_WAN_ENABLED; }
});
test("a static approval cannot be reused to authorize AI image sharing",async()=>{
  const project=await aiFixture(),key=randomUUID();
  const grant=await executeMcpTool(owner,"grant_cost_consent",{projectId:project.id,revision:0,operation:"start_video_job",idempotencyKey:key,generationMode:"static"});
  await assert.rejects(()=>executeMcpTool(owner,"start_video_job",{projectId:project.id,revision:0,idempotencyKey:key,confirmed:true,generationMode:"wan",consentToken:grant.structuredContent.consent!.token}),{code:"CONSENT"});
});
test("fade composition keeps the full timeline, captions and audio of owned scenes",async()=>{
  const {project,job}=await fixture();
  await runJob(job.id);
  const next=await getProject(owner,project.id);
  const compose=await startJob(owner,"compose_video",{projectId:next.id,revision:next.revision,confirmed:true,idempotencyKey:randomUUID(),segmentIds:[2,1],composition:{subtitles:true,backgroundMusic:"soft",transition:"fade"}});
  await runJob(compose.id);
  const result=await getProject(owner,next.id);
  assert.equal((await getJob(owner,compose.id)).lifecycleStatus,"completed");
  assert.ok(result.finalAssetId); assert.ok(result.captionAssetId);
  assert.equal((await readAsset(owner,result.finalAssetId)).mime,"video/mp4");
  const captions=(await readAsset(owner,result.captionAssetId)).buffer.toString();
  assert.ok(captions.indexOf("Scene 2")<captions.indexOf("Scene 1"));
  assert.match(captions,/00:00:04.000/);
});
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
