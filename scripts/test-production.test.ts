import { test,before,after,mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { SignJWT,generateKeyPair,exportJWK } from "jose";
import { S3Client,PutObjectCommand,GetObjectCommand,GetPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { database } from "../src/studio/db";
import { createProject,getProject,getJob,startJob } from "../src/studio/store";
import { runJob } from "../src/worker";
import { executeVideoJob,type VideoProvider } from "../src/studio/video-provider";
import { mediaToken,readAsset,signedAssetUrl,registerAsset } from "../src/studio/assets";
import { PrivateObjectStore,objectKey } from "../src/studio/object-store";
import { StudioError } from "../src/studio/types";
import { POST as start } from "../src/app/api/studio/jobs/route";
import { GET as status } from "../src/app/api/studio/jobs/[jobId]/route";
import { POST as retry } from "../src/app/api/studio/jobs/[jobId]/retry/route";
import { PUT as scripts } from "../src/app/api/studio/projects/[projectId]/scripts/route";
import { POST as upload } from "../src/app/api/studio/upload/route";
import { GET as media } from "../src/app/api/media/[assetId]/route";

const url=process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("Use a disposable TEST_DATABASE_URL ending in _test");
process.env.DATABASE_URL=url;
Object.assign(process.env,{VIDIO_MODE:"production",VIDIO_PUBLIC_ORIGIN:"https://vidio.example.test",OAUTH_ISSUER:"https://issuer.example.test",OAUTH_JWKS_URL:"https://issuer.example.test/jwks",OAUTH_AUDIENCE:"vidio-test",VIDIO_MEDIA_SECRET:"test-only-media-secret-not-a-real-key",S3_BUCKET_NAME:"private-test-bucket",S3_REGION:"us-east-1",S3_ACCESS_KEY_ID:"test-only",S3_SECRET_ACCESS_KEY:"test-only",VIDIO_PAID_GENERATION_ENABLED:"true",VIDIO_MAX_PAID_SEGMENTS_PER_OWNER_DAY:"3"});
const subject=`production-test-${randomUUID()}`;
const owner=`${process.env.OAUTH_ISSUER}|${subject}`;
let token="";
let otherToken="";
const objects=new Map<string,{buffer:Buffer;mime:string}>();
let privateBucket=true;
before(async()=>{
  for (const name of ["0001_studio.sql","0002_job_lifecycle.sql","0003_result_ownership.sql"]) await database().query(await readFile(`migrations/${name}`,"utf8"));
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const jwk={...await exportJWK(publicKey),kid:"test-key",alg:"RS256",use:"sig"};
  mock.method(globalThis,"fetch",async()=>Response.json({keys:[jwk]}));
  const sign=(sub:string)=>new SignJWT({scope:"vidio:studio"}).setProtectedHeader({alg:"RS256",kid:"test-key"}).setSubject(sub).setIssuer(process.env.OAUTH_ISSUER!).setAudience("vidio-test").setIssuedAt().setExpirationTime("1h").sign(privateKey);
  token=await sign(subject);
  otherToken=await sign("other-user");
  mock.method(S3Client.prototype,"send",async(command:unknown)=>{
    if (command instanceof GetPublicAccessBlockCommand) return {PublicAccessBlockConfiguration:{BlockPublicAcls:privateBucket,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.ACL,undefined);
      assert.equal(command.input.CacheControl,"private, no-store");
      assert.ok(Buffer.isBuffer(command.input.Body));
      objects.set(command.input.Key!,{buffer:Buffer.from(command.input.Body),mime:command.input.ContentType!});
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object=objects.get(command.input.Key!);
      if (!object) throw new Error("Missing test object");
      return {Body:Readable.from([object.buffer]),ContentLength:object.buffer.length,ContentType:object.mime};
    }
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
  const response=await start(request("/api/studio/jobs",{operation:"generate_segments",input}));
  assert.equal(response.status,202);
  const {jobId}=await response.json() as {jobId:string};
  assert.match(jobId,/^[\da-f-]{36}$/);
  assert.equal((await getJob(owner,jobId)).lifecycleStatus,"queued");
  assert.equal((await start(request("/api/studio/jobs",{operation:"generate_segments",input}))).status,202);
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
    download:async()=>Buffer.from("\x00\x00\x00\x18ftypmock-production-video"),
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
  assert.equal((await send(png,"image/png")).status,200);
  const saved=await getProject(owner,project.id);
  assert.ok(saved.imageAssetId);
  assert.equal((await readAsset(owner,saved.imageAssetId!)).mime,"image/png");
});
