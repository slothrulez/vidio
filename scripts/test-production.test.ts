import { test,before,after,mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { SignJWT,generateKeyPair,exportJWK,type JWTPayload } from "jose";
import { S3Client,PutObjectCommand,GetObjectCommand,GetPublicAccessBlockCommand,DeleteObjectCommand } from "@aws-sdk/client-s3";
import { database,transaction } from "../src/studio/db";
import { createProject,getProject,getJob,startJob } from "../src/studio/store";
import { runJob } from "../src/worker";
import { executeVideoJob,type VideoProvider } from "../src/studio/video-provider";
import { mediaToken,readAsset,signedAssetUrl,registerAsset,cleanupAssets } from "../src/studio/assets";
import { rateLimit } from "../src/studio/rate-limit";
import { signingKey } from "../src/studio/config";
import { claimJob,providerCheckpoint,recoverJobs,completedSegment } from "../src/studio/lifecycle";
import { executeTool } from "../src/studio/service";
import { executeMcpTool } from "../src/studio/mcp-contracts";
import { videoFixture } from "./fixtures/video";
import { validateProviderVideo } from "../src/studio/video-provider";
import { composeOwnedSegments } from "../src/studio/composition";
import { PrivateObjectStore,objectKey } from "../src/studio/object-store";
import { StudioError } from "../src/studio/types";
import { POST as start } from "../src/app/api/studio/jobs/route";
import { POST as createConsent } from "../src/app/api/studio/consent/route";
import { GET as status } from "../src/app/api/studio/jobs/[jobId]/route";
import { POST as retry } from "../src/app/api/studio/jobs/[jobId]/retry/route";
import { PUT as scripts } from "../src/app/api/studio/projects/[projectId]/scripts/route";
import { POST as upload } from "../src/app/api/studio/upload/route";
import { GET as media } from "../src/app/api/media/[assetId]/route";
import { POST as session } from "../src/app/api/studio/session/route";
import { POST as tools } from "../src/app/api/studio/tools/route";
import { POST as mcp } from "../src/app/mcp/route";

const url=process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Use a disposable TEST_DATABASE_URL ending in _test");
process.env.DATABASE_URL=url;
Object.assign(process.env,{VIDIO_MODE:"production",VIDIO_MCP_LOCAL_AUTH:"false",VIDIO_PUBLIC_ORIGIN:"https://vidio.example.test",OAUTH_ISSUER:"https://issuer.example.test",OAUTH_JWKS_URL:"https://issuer.example.test/jwks",OAUTH_AUDIENCE:"vidio-test",VIDIO_MEDIA_SECRET:"test-only-media-secret-not-a-real-key",S3_BUCKET_NAME:"private-test-bucket",S3_REGION:"us-east-1",S3_ACCESS_KEY_ID:"test-only",S3_SECRET_ACCESS_KEY:"test-only",VIDIO_PAID_GENERATION_ENABLED:"true",VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY:"3"});
const subject=`production-test-${randomUUID()}`;
const owner=`${process.env.OAUTH_ISSUER}|${subject}`;
let token="";
let otherToken="";
let signToken:(claims?:JWTPayload)=>Promise<string>;
let clip:Buffer;
const ranges:Array<string|undefined>=[];
let deletionFails=false;
let putProbe:(()=>Promise<void>)|undefined;
const objects=new Map<string,{buffer:Buffer;mime:string}>();
let privateBucket=true;
before(async()=>{
  for (const name of ["0001_studio.sql","0002_job_lifecycle.sql","0003_result_ownership.sql","0004_widget_uploads.sql","0005_release_safety.sql","0006_cost_consent.sql","0007_english_only.sql","0008_worker_health.sql"]) await database().query(await readFile(`migrations/${name}`,"utf8"));
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  clip=await videoFixture();
  const jwk={...await exportJWK(publicKey),kid:"test-key",alg:"RS256",use:"sig"};
  mock.method(globalThis,"fetch",async()=>Response.json({keys:[jwk]}));
  signToken=(claims={})=>new SignJWT({scope:"vidio:studio",sub:subject,iss:process.env.OAUTH_ISSUER!,aud:"vidio-test",exp:Math.floor(Date.now()/1000)+3600,...claims}).setProtectedHeader({alg:"RS256",kid:"test-key"}).sign(privateKey);
  token=await signToken();
  otherToken=await signToken({sub:"other-user"});
  mock.method(S3Client.prototype,"send",async(command:unknown)=>{
    if (command instanceof GetPublicAccessBlockCommand) return {PublicAccessBlockConfiguration:{BlockPublicAcls:privateBucket,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
    if (command instanceof PutObjectCommand) {
      await putProbe?.();
      assert.equal(command.input.ACL,undefined);
      assert.equal(command.input.CacheControl,"private, no-store");
      assert.ok(Buffer.isBuffer(command.input.Body));
      objects.set(command.input.Key!,{buffer:Buffer.from(command.input.Body),mime:command.input.ContentType!});
      return {};
    }
    if (command instanceof GetObjectCommand) {
      ranges.push(command.input.Range);
      const object=objects.get(command.input.Key!);
      if (!object) throw new Error("Missing test object");
      if (command.input.Range) {
        const match=/^bytes=(\d+)-(\d+)$/.exec(command.input.Range)!;
        const start=Number(match[1]),end=Number(match[2]);
        const part=object.buffer.subarray(start,end+1);
        return {Body:Readable.from([part]),ContentLength:part.length,ContentRange:`bytes ${start}-${end}/${object.buffer.length}`,ContentType:object.mime};
      }
      return {Body:Readable.from([object.buffer]),ContentLength:object.buffer.length,ContentType:object.mime};
    }
    if (command instanceof DeleteObjectCommand) {if (deletionFails) throw new Error("Mock deletion failure");objects.delete(command.input.Key!);return {};}
    throw new Error("Unexpected storage command");
  });
});
after(async()=>{
  mock.restoreAll();
  await database().query("DELETE FROM vidio_projects WHERE owner_id=$1",[owner]);
  await database().end();
});
function request(path:string,body?:unknown,bearer=token) {
  return new Request(`https://vidio.example.test${path}`,{method:body===undefined ? "GET" : "POST",headers:{Authorization:`Bearer ${bearer}`,"Content-Type":"application/json"},body:body===undefined ? undefined : JSON.stringify(body)});
}
const params=(id:string)=>({params:Promise.resolve({jobId:id})});
test("authenticated production API returns an immediate job ID and resumes known tasks without another paid submit",async()=>{
  let project=await createProject(owner,{name:"Mock production",language:"english",ratio:"16:9"});
  const set=await scripts(request("/scripts",{revision:0,scripts:[1,2].map(id=>({id,script:`Scene ${id}`,prompt:"Mock visual"}))}),{params:Promise.resolve({projectId:project.id})});
  assert.equal(set.status,200);
  project=await getProject(owner,project.id);
  const input={projectId:project.id,revision:project.revision,confirmed:true,idempotencyKey:randomUUID()};
  assert.equal((await start(request("/api/studio/jobs",{operation:"generate_segments",input}))).status,409);
  const approval=await createConsent(request("/api/studio/consent",{
    projectId:project.id,
    revision:project.revision,
    operation:"start_video_job",
    idempotencyKey:input.idempotencyKey,
  }));
  assert.equal(approval.status,200);
  const consent=(await approval.json() as {consent:{token:string}}).consent.token;
  const response=await start(request("/api/studio/jobs",{operation:"generate_segments",input,consentToken:consent}));
  assert.equal(response.status,202);
  const {jobId}=await response.json() as {jobId:string};
  assert.match(jobId,/^[\da-f-]{36}$/);
  assert.equal((await getJob(owner,jobId)).lifecycleStatus,"queued");
  assert.equal((await start(request("/api/studio/jobs",{operation:"generate_segments",input,consentToken:consent}))).status,202);
  assert.equal((await start(request("/api/studio/jobs",{operation:"generate_segments",input:{...input,idempotencyKey:randomUUID()},consentToken:consent}))).status,409);
  assert.equal((await status(request("/jobs"),params(jobId))).status,200);
  assert.equal((await status(request("/jobs",undefined,otherToken),params(jobId))).status,404);
  assert.equal((await retry(request("/retry",{},otherToken),params(jobId))).status,404);
  const submits:number[]=[];
  let transient=true;
  const provider:VideoProvider={
    submit:async(_project,script)=>{submits.push(script.id);return `task-${script.id}`;},
    poll:async(id)=>{
      if (id==="task-2" && transient) {transient=false;throw new StudioError("POLL","Mock transient error");}
      return {id,status:"succeeded",duration:5,content:{video_url:"https://cdn.example.test/video.mp4"}};
    },
    download:async()=>clip,
  };
  await runJob(jobId,(job,project,context)=>executeVideoJob(job,project,context,provider));
  const partial=await getJob(owner,jobId);
  assert.equal(partial.status,"queued");
  assert.equal(partial.segments?.[0].status,"completed");
  const firstAsset=partial.segments?.[0].assetId;
  await database().query("UPDATE vidio_jobs SET next_attempt_at=now() WHERE id=$1",[jobId]);
  await runJob(jobId,(job,project,context)=>executeVideoJob(job,project,context,provider));
  assert.deepEqual(submits,[1,2]);
  const completed=await getJob(owner,jobId);
  assert.equal(completed.lifecycleStatus,"completed");
  assert.equal(completed.segments?.[0].assetId,firstAsset);
  assert.equal(completed.segments?.[0].duration,2);
  project=await getProject(owner,project.id);
  const regenerate=await startJob(owner,"regenerate_segment",{...input,revision:project.revision,segmentId:2,idempotencyKey:randomUUID()});
  await runJob(regenerate.id,(job,project,context)=>executeVideoJob(job,project,context,provider));
  assert.deepEqual(submits,[1,2,2]);
  project=await getProject(owner,project.id);
  await assert.rejects(()=>startJob(owner,"regenerate_segment",{...input,revision:project.revision,segmentId:1,idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError && error.code==="BUDGET");
  const compose=await startJob(owner,"compose_video",{...input,revision:project.revision,segmentIds:[1,2],idempotencyKey:randomUUID()});
  await runJob(compose.id,async(job,project)=>{
    project.finalAssetId=await registerAsset(job.owner,project.id,"video/mp4",Buffer.from("private-final-video"));
    project.stage="done";
    return project;
  });
  const final=(await getProject(owner,project.id)).finalAssetId!;
  const signed=await signedAssetUrl(owner,final);
  assert.equal(new URL(signed).searchParams.get("X-Amz-Expires"),"600");
  await assert.rejects(()=>signedAssetUrl("other-owner",final));
  await assert.rejects(()=>readAsset("other-owner",final));
  const finalRequest=new Request(`https://vidio.example.test/api/media/${final}?token=${await mediaToken(owner,final)}`,{headers:{Range:"bytes=0-6"}});
  const finalResponse=await media(finalRequest,{params:Promise.resolve({assetId:final})});
  assert.equal(finalResponse.status,206);
  assert.equal(await finalResponse.text(),"private");
  assert.equal(finalResponse.headers.get("Cache-Control"),"private, no-store");
  const wrong=new Request(`https://vidio.example.test/api/media/${final}?token=${await mediaToken("other-owner",final)}`);
  assert.equal((await media(wrong,{params:Promise.resolve({assetId:final})})).status,404);
});
test("private storage fails closed and cannot construct user-controlled object paths",async()=>{
  privateBucket=false;
  try {await assert.rejects(()=>new PrivateObjectStore(new S3Client({region:"us-east-1"}),"private-test-bucket").verifyPrivate());}
  finally {privateBucket=true;}
  assert.throws(()=>objectKey("../../etc/passwd",randomUUID()));
  assert.equal((await start(request("/jobs",{operation:"generate_segments",input:{projectId:randomUUID(),revision:0,confirmed:false}}))).status,400);
  assert.equal((await start(new Request("https://vidio.example.test/jobs",{method:"POST",body:"{}"}))).status,401);
  assert.equal((await start(request("/jobs",{extra:true}))).status,400);
});
test("unknown submissions also block new idempotency keys from creating duplicate paid jobs",async()=>{
  process.env.VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY="4";
  try {
    const project=await createProject(owner,{name:"Unknown submission",language:"english",ratio:"16:9"});
    await scripts(request("/scripts",{revision:0,scripts:[{id:1,script:"Mock",prompt:"Mock"}]}),{params:Promise.resolve({projectId:project.id})});
    const input={projectId:project.id,revision:1,confirmed:true,idempotencyKey:randomUUID()};
    const job=await startJob(owner,"generate_segments",input);
    const provider:VideoProvider={submit:async()=>{throw new StudioError("SUBMISSION_UNKNOWN","Mock lost response");},poll:async()=>{throw new Error("Must not poll");},download:async()=>{throw new Error("Must not download");}};
    await runJob(job.id,(job,project,context)=>executeVideoJob(job,project,context,provider));
    assert.equal((await getJob(owner,job.id)).errorCode,"SUBMISSION_UNKNOWN");
    await assert.rejects(()=>startJob(owner,"generate_segments",{...input,idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError && error.code==="RECONCILIATION");
  } finally {process.env.VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY="3";}
});
test("production uploads validate bytes, MIME, size and project ownership before private writes",async()=>{
  const project=await createProject(owner,{name:"Upload test",language:"english",ratio:"16:9"});
  const png=await readFile("src/app/opengraph-image.png");
  const send=(bytes:Uint8Array,mime:string,bearer=token)=>{
    const form=new FormData();
    form.set("projectId",project.id);form.set("revision","0");form.set("image",new File([Uint8Array.from(bytes)],"image.png",{type:mime}));
    return upload(new Request("https://vidio.example.test/api/studio/upload",{method:"POST",headers:{Authorization:`Bearer ${bearer}`},body:form}));
  };
  const writes=objects.size;
  assert.equal((await send(png,"image/jpeg")).status,400);
  assert.equal((await send(new Uint8Array(24),"image/png")).status,400);
  assert.equal((await send(png,"image/png",otherToken)).status,404);
  assert.equal(objects.size,writes);
  assert.equal((await upload(new Request("https://vidio.example.test/api/studio/upload",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Length":"5100001"},body:"x"}))).status,413);
  const uploaded=await send(png,"image/png");
  assert.equal(uploaded.status,200);
  assert.equal((await uploaded.json()).structuredContent.mode,"production");
  const saved=await getProject(owner,project.id);
  assert.ok(saved.imageAssetId);
  assert.equal((await readAsset(owner,saved.imageAssetId!)).mime,"image/png");
});
test("OAuth negative cases fail on every protected HTTP surface without bootstrapping demo sessions",async()=>{
  const invalid=["", "forged",await signToken({exp:Math.floor(Date.now()/1000)-10}),await signToken({iss:"https://wrong.example.test"}),await signToken({aud:"other-app"}),await signToken({scope:"other:scope"}),await signToken({scope:undefined}),await signToken({exp:undefined}),await signToken({sub:undefined}),await new SignJWT({sub:subject,scope:"vidio:studio"}).setProtectedHeader({alg:"HS256"}).setIssuer(process.env.OAUTH_ISSUER!).setAudience("vidio-test").setExpirationTime("1h").sign(signingKey())];
  for (const bearer of invalid) {
    const calls=[start(request("/jobs",{},bearer)),status(request("/jobs",undefined,bearer),params(randomUUID())),retry(request("/retry",{},bearer),params(randomUUID())),scripts(request("/scripts",{},bearer),{params:Promise.resolve({projectId:randomUUID()})}),upload(request("/upload",{},bearer)),tools(request("/tools",{},bearer)),session(request("/session",{},bearer)),mcp(request("/mcp",{},bearer))];
    for (const response of await Promise.all(calls)) {
      assert.equal(response.status,401);
      assert.equal(response.headers.has("set-cookie"),false);
      assert.match((await response.json()).error.message,/token|Bearer|scope/i);
    }
  }
  const response=await session(request("/session",{}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).mode,"production");
  assert.equal(response.headers.has("set-cookie"),false);
  assert.equal((await tools(new Request("https://vidio.example.test/tools",{method:"POST",headers:{Authorization:`Bearer ${token}`,Origin:"https://attacker.example.test"},body:"{}"}))).status,403);
});
test("ranges reject before storage reads, expiry stays private, and concurrent streams release admission",async()=>{
  const project=await createProject(owner,{name:"Range safety",language:"english",ratio:"16:9"});
  const id=await registerAsset(owner,project.id,"video/mp4",clip);
  const base=`https://vidio.example.test/api/media/${id}?token=${await mediaToken(owner,id)}`;
  const send=(range:string)=>media(new Request(base,{headers:{Range:range}}),{params:Promise.resolve({assetId:id})});
  const count=ranges.length;
  assert.equal((await send("bytes=99999999999999999-")).status,416);
  assert.equal((await send("bytes=0-1,3-4")).status,416);
  assert.equal(ranges.length,count);
  const tiny=await send("bytes=0-0");
  assert.equal(tiny.status,206);
  assert.equal((await tiny.arrayBuffer()).byteLength,1);
  assert.equal(ranges.at(-1),"bytes=0-0");
  const suffix=await send("bytes=-7");
  assert.equal((await suffix.arrayBuffer()).byteLength,7);
  const open=await Promise.all(Array.from({length:4},()=>send("bytes=0-")));
  assert.ok(open.every(response=>response.status===206));
  assert.equal((await send("bytes=0-")).status,429);
  await Promise.all(open.map(response=>response.body!.cancel()));
  const again=await send("bytes=0-0");assert.equal(again.status,206);await again.arrayBuffer();
  const expiredClaims=await new SignJWT({assetId:id}).setProtectedHeader({alg:"HS256"}).setSubject(owner).setIssuer("vidio-preview").setAudience("vidio-media").setExpirationTime(Math.floor(Date.now()/1000)-10).sign(signingKey());
  const rejected=await media(new Request(`https://vidio.example.test/api/media/${id}?token=${expiredClaims}`),{params:Promise.resolve({assetId:id})});
  assert.equal(rejected.status,401);
  assert.equal(JSON.stringify(await rejected.json()).includes(expiredClaims),false);
});
test("storage intents survive rollback, stay quota-accounted and clean up without deleting committed assets",async()=>{
  const project=await createProject(owner,{name:"Write rollback",language:"english",ratio:"16:9"});
  const keep=await registerAsset(owner,project.id,"video/mp4",clip);
  let orphan="";
  await assert.rejects(()=>transaction(async client=>{
    orphan=await registerAsset(owner,project.id,"video/mp4",clip,client);
    throw new Error("Mock caller rollback");
  }));
  assert.equal((await database().query("SELECT id FROM vidio_assets WHERE id=$1",[orphan])).rows.length,0);
  assert.equal((await database().query("SELECT id FROM vidio_asset_intents WHERE id=$1",[orphan])).rows.length,1);
  assert.ok(objects.has(objectKey(project.id,orphan)));
  await database().query("UPDATE vidio_asset_intents SET created_at=now()-interval '3 hours' WHERE id=ANY($1::uuid[])",[[keep,orphan]]);
  deletionFails=true;
  try {
    await cleanupAssets();
    assert.ok(objects.has(objectKey(project.id,orphan)));
    assert.equal((await database().query("SELECT id FROM vidio_asset_intents WHERE id=$1",[orphan])).rows.length,1);
  } finally {deletionFails=false;}
  await cleanupAssets();
  assert.equal(objects.has(objectKey(project.id,orphan)),false);
  assert.equal((await database().query("SELECT id FROM vidio_asset_intents WHERE id=$1",[orphan])).rows.length,0);
  assert.ok(objects.has(objectKey(project.id,keep)));
  assert.equal((await readAsset(owner,keep)).buffer.length,clip.length);
  const reservation=randomUUID();
  await database().query("INSERT INTO vidio_asset_intents(id,owner_id,project_id,size,storage_backend) VALUES($1,$2,$3,1000000000,'s3')",[reservation,owner,project.id]);
  try {await assert.rejects(()=>registerAsset(owner,project.id,"video/mp4",clip),(error:unknown)=>error instanceof StudioError && error.code==="LIMIT");}
  finally {await database().query("DELETE FROM vidio_asset_intents WHERE id=$1",[reservation]);}
});
test("global storage quota lock is released before remote writes",async()=>{
  const project=await createProject(owner,{name:"Quota lock scope",language:"english",ratio:"16:9"});
  let checked=false;
  putProbe=async()=>{
    const client=await database().connect();
    try {
      const acquired=(await client.query("SELECT pg_try_advisory_lock(4112027) AS acquired")).rows[0].acquired;
      assert.equal(acquired,true);
      if (acquired) await client.query("SELECT pg_advisory_unlock(4112027)");
      checked=true;
    } finally {client.release();}
  };
  try {await registerAsset(owner,project.id,"video/mp4",clip);assert.equal(checked,true);}
  finally {putProbe=undefined;}
});
test("durable request limits isolate owners, roll over and return HTTP429",async()=>{
  const limited=`rate-${randomUUID()}`;
  await database().query("INSERT INTO vidio_request_limits VALUES($1,date_trunc('minute',now()),240)",[limited]);
  await assert.rejects(()=>rateLimit(limited),(error:unknown)=>error instanceof StudioError && error.code==="RATE_LIMIT");
  await rateLimit(`other-${limited}`);
  await database().query("UPDATE vidio_request_limits SET window_at=now()-interval '2 minutes' WHERE owner_id=$1",[limited]);
  await rateLimit(limited);
  assert.equal((await database().query("SELECT requests FROM vidio_request_limits WHERE owner_id=$1",[limited])).rows[0].requests,1);
  const limitedToken=await signToken({sub:limited}),limitedOwner=`${process.env.OAUTH_ISSUER}|${limited}`;
  await database().query("INSERT INTO vidio_request_limits VALUES($1,date_trunc('minute',now()),240)",[limitedOwner]);
  assert.equal((await session(request("/session",{},limitedToken))).status,429);
  assert.equal((await mcp(request("/mcp",{},limitedToken))).status,429);
});
test("lost submitted tasks cannot bypass reconciliation through claim deadlines and new keys",async()=>{
  process.env.VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY="20";
  try {
    const project=await createProject(owner,{name:"Lost task",language:"english",ratio:"16:9"});
    await scripts(request("/scripts",{revision:0,scripts:[{id:1,script:"Approved",prompt:"Mock"}]}),{params:Promise.resolve({projectId:project.id})});
    const input={projectId:project.id,revision:1,confirmed:true,idempotencyKey:randomUUID()};
    const job=await startJob(owner,"generate_segments",input),claimed=(await claimJob(job.id))!;
    await completedSegment(claimed,1);
    await providerCheckpoint(claimed,1);
    await providerCheckpoint(claimed,1,"known-provider-task");
    await database().query("UPDATE vidio_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
    await recoverJobs();
    await database().query("UPDATE vidio_jobs SET deadline_at=now()-interval '1 second',next_attempt_at=now() WHERE id=$1",[job.id]);
    assert.equal(await claimJob(job.id),null);
    const stopped=await getJob(owner,job.id);
    assert.equal(stopped.status,"failed");
    assert.equal(stopped.segments?.[0].status,"failed");
    assert.equal((await executeTool(owner,"get_project",{projectId:project.id})).structuredContent.job?.id,job.id);
    const current=await getProject(owner,project.id);
    await assert.rejects(()=>startJob(owner,"generate_segments",{...input,revision:current.revision,idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError && error.code==="RECONCILIATION");
  } finally {process.env.VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY="3";}
});
test("production video validation derives real duration and rejects malformed files, missing audio and wrong ratios",async()=>{
  assert.equal(await validateProviderVideo(clip,"16:9"),2);
  await assert.rejects(()=>validateProviderVideo(Buffer.from("\x00\x00\x00\x18ftyptruncated"),"16:9"));
  await assert.rejects(()=>validateProviderVideo(clip,"9:16"));
  const silent=await videoFixture("16:9",false);
  await assert.rejects(()=>validateProviderVideo(silent,"16:9"));
  assert.equal(await validateProviderVideo(await videoFixture("9:16"),"9:16"),2);
  const project=await createProject(owner,{name:"Composition budget",language:"english",ratio:"16:9"});
  const id=await registerAsset(owner,project.id,"video/mp4",clip);
  project.segments=[{id:1,assetId:id,duration:2,script:"Test"}];
  await database().query("UPDATE vidio_assets SET size=90000000 WHERE id=$1",[id]);
  const before=ranges.length;
  await assert.rejects(()=>composeOwnedSegments(owner,project,[1]),(error:unknown)=>error instanceof StudioError && error.code==="ASSET_LIMIT");
  assert.equal(ranges.length,before);
  await database().query("UPDATE vidio_assets SET size=$2 WHERE id=$1",[id,clip.length]);
});

test("production paid MCP tools require a server-issued single-use human approval",async()=>{
  const consentSubject=`consent-${randomUUID()}`;
  const consentBearer=await signToken({sub:consentSubject});
  const owner=`${process.env.OAUTH_ISSUER}|${consentSubject}`;
  let project=await createProject(owner,{name:"Consent production",language:"english",ratio:"16:9"});
  const set=await scripts(request("/scripts",{revision:0,scripts:[1,2].map(id=>({id,script:`Scene ${id}`,prompt:"Mock visual"}))},consentBearer),{params:Promise.resolve({projectId:project.id})});
  assert.equal(set.status,200);
  project=await getProject(owner,project.id);
  const base={projectId:project.id,revision:project.revision,confirmed:true as const};
  const restBypass=await tools(request("/api/studio/tools",{
    name:"generate_segments",
    arguments:{...base,idempotencyKey:randomUUID()},
  },consentBearer));
  assert.equal(restBypass.status,409);
  await assert.rejects(executeMcpTool(owner,"start_video_job",{...base,idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError&&error.code==="CONSENT"&&error.status===409);
  await assert.rejects(executeMcpTool(owner,"grant_cost_consent",{projectId:project.id,revision:project.revision+1,operation:"start_video_job",idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError&&error.code==="REVISION");
  const key=randomUUID();
  const grant=await executeMcpTool(owner,"grant_cost_consent",{projectId:project.id,revision:project.revision,operation:"start_video_job",idempotencyKey:key});
  const token=grant.structuredContent.consent!.token;
  await assert.rejects(executeMcpTool(owner,"start_video_job",{...base,idempotencyKey:randomUUID(),consentToken:token}),(error:unknown)=>error instanceof StudioError&&error.code==="CONSENT");
  await assert.rejects(executeMcpTool(owner,"start_video_job",{...base,consentToken:token}),(error:unknown)=>error instanceof StudioError&&error.code==="CONSENT");
  await assert.rejects(executeMcpTool(owner,"start_video_job",{...base,revision:project.revision+1,idempotencyKey:key,consentToken:token}),(error:unknown)=>error instanceof StudioError&&["CONSENT","REVISION"].includes(error.code));
  await assert.rejects(executeMcpTool("other-owner","grant_cost_consent",{projectId:project.id,revision:project.revision,operation:"regenerate_segment",idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError&&error.code==="NOT_FOUND");
  await assert.rejects(executeMcpTool("other-owner","regenerate_segment",{...base,segmentId:1,idempotencyKey:key,consentToken:token}),(error:unknown)=>error instanceof StudioError&&["CONSENT","NOT_FOUND"].includes(error.code));
  await assert.rejects(executeMcpTool("other-owner","compose_final_video",{...base,segmentIds:[1],idempotencyKey:key,consentToken:token}),(error:unknown)=>error instanceof StudioError&&["CONSENT","NOT_FOUND"].includes(error.code));
  for (const name of ["identify_product","generate_scripts"] as const)
    await assert.rejects(executeMcpTool(owner,name,{projectId:project.id,revision:project.revision,idempotencyKey:randomUUID()}),(error:unknown)=>error instanceof StudioError&&error.code==="NOT_CONFIGURED"&&error.status===503);
  await assert.rejects(executeMcpTool(owner,"compose_final_video",{...base,idempotencyKey:randomUUID(),consentToken:token,segmentIds:[1]}),(error:unknown)=>error instanceof StudioError&&error.code==="CONSENT");
  await assert.rejects(executeMcpTool("other-owner","start_video_job",{...base,idempotencyKey:randomUUID(),consentToken:token}),(error:unknown)=>error instanceof StudioError&&["CONSENT","NOT_FOUND"].includes(error.code));
  const started=await executeMcpTool(owner,"start_video_job",{...base,idempotencyKey:key,consentToken:token});
  assert.ok(started.structuredContent.job?.id);
  const replay=await executeMcpTool(owner,"start_video_job",{...base,idempotencyKey:key,consentToken:token});
  assert.equal(replay.structuredContent.job?.id,started.structuredContent.job?.id);
  await assert.rejects(executeMcpTool(owner,"start_video_job",{...base,idempotencyKey:randomUUID(),consentToken:token}),(error:unknown)=>error instanceof StudioError&&error.code==="CONSENT");
  const used=await database().query("SELECT used_at,idempotency_key FROM vidio_cost_consents WHERE id=$1",[token]);
  assert.ok(used.rows[0].used_at);
  assert.equal(used.rows[0].idempotency_key,key);
  await database().query("DELETE FROM vidio_projects WHERE owner_id=$1",[owner]);
});

test("provider failures never leak URLs, task IDs or secrets into job records, structured results or logs",async()=>{
  const subject=`leak-${randomUUID()}`;
  const bearer=await signToken({sub:subject});
  const owner=`${process.env.OAUTH_ISSUER}|${subject}`;
  const logs:string[]=[];
  const spies=(["log","error","warn"] as const).map(level=>mock.method(console,level,(...args:unknown[])=>{logs.push(args.map(arg=>typeof arg==="string" ? arg : JSON.stringify(arg)).join(" "));}));
  try {
    const project=await createProject(owner,{name:"Leak test",language:"english",ratio:"16:9"});
    await scripts(request("/scripts",{revision:0,scripts:[{id:1,script:"Mock",prompt:"Mock"}]},bearer),{params:Promise.resolve({projectId:project.id})});
    const job=await startJob(owner,"generate_segments",{projectId:project.id,revision:1,confirmed:true,idempotencyKey:randomUUID()});
    const secretUrl="https://ark.example.test/tasks/task-991?sig=SECRETSIG&key=AKIASECRET";
    const provider:VideoProvider={submit:async()=>{throw new Error(`Provider rejected ${secretUrl} for /tmp/vidio/work/clip.mp4`);},poll:async()=>{throw new Error("Must not poll");},download:async()=>{throw new Error("Must not download");}};
    await runJob(job.id,(job,project,context)=>executeVideoJob(job,project,context,provider));
    const failed=await getJob(owner,job.id);
    assert.equal(failed.status,"failed");
    const status=await executeMcpTool(owner,"get_video_job_status",{jobId:job.id});
    const read=await executeMcpTool(owner,"get_project",{projectId:project.id});
    for (const text of [JSON.stringify(failed),JSON.stringify(status.structuredContent),JSON.stringify(read.structuredContent),logs.join("\n")]) {
      for (const secret of ["SECRETSIG","AKIASECRET","task-991","ark.example.test","/tmp/vidio"]) assert.doesNotMatch(text,new RegExp(secret),`leaked ${secret}`);
    }
    for (const text of [JSON.stringify(status.structuredContent),JSON.stringify(read.structuredContent)]) assert.doesNotMatch(text,/https?:\/\//,"public structured results must not contain URLs");
  } finally {
    spies.forEach(spy=>spy.mock.restore());
    await database().query("DELETE FROM vidio_projects WHERE owner_id=$1",[owner]);
  }
});
