import { test,mock,afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ArkVideoProvider } from "../src/studio/video-provider";
import { StudioError,type StudioProject } from "../src/studio/types";
import { WanVideoProvider, WAN_SPACE, WAN_MODEL } from "../src/studio/wan-provider";
import { normalizeGeneratedVideo } from "../src/studio/generated-media";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

Object.assign(process.env,{ARK_API_KEY:"test-only-provider-key",VIDEO_MODEL_EP:"test-only-model",ARK_BASE_URL:"https://ark.cn-beijing.volces.com",VIDIO_PROVIDER_MEDIA_HOSTS:"cdn.example.test"});
const project:StudioProject={id:randomUUID(),name:"Provider test",revision:0,language:"english",ratio:"16:9",stage:"scripted",features:[],scripts:[{id:1,script:"Mock narration",prompt:"Mock visual"}],segments:[],createdAt:new Date(0).toISOString(),mode:"production"};
afterEach(()=>mock.restoreAll());
test("Ark submits once with the documented task body and treats lost responses as unknown",async()=>{
  let requests=0;
  mock.method(globalThis,"fetch",async(_url:unknown,init:RequestInit)=>{
    requests++;
    assert.equal(init.method,"POST");
    assert.equal(init.redirect,"error");
    assert.deepEqual(JSON.parse(String(init.body)).content,[{type:"text",text:"Mock visual\nNarration: Mock narration"}]);
    throw new TypeError("Mock connection lost");
  });
  await assert.rejects(()=>new ArkVideoProvider().submit(project,project.scripts[0],undefined,new AbortController().signal),(error:unknown)=>error instanceof StudioError && error.code==="SUBMISSION_UNKNOWN");
  assert.equal(requests,1);
});
test("Ark polling never submits a replacement and validates the requested task ID",async()=>{
  const requests:string[]=[];
  mock.method(globalThis,"fetch",async(url:unknown,init:RequestInit)=>{
    requests.push(String(url));
    assert.notEqual(init.method,"POST");
    return Response.json({id:"task-other",status:"succeeded",content:{video_url:"https://cdn.example.test/a.mp4"}});
  });
  await assert.rejects(()=>new ArkVideoProvider().poll("task-expected",new AbortController().signal));
  assert.deepEqual(requests,["https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/task-expected"]);
  mock.restoreAll();
  mock.method(globalThis,"fetch",async()=>Response.json({id:"task-expected",status:"expired"}));
  assert.equal((await new ArkVideoProvider().poll("task-expected",new AbortController().signal)).status,"expired");
});
test("Ark media is HTTPS, host-allowlisted, bounded, signature-checked and never follows redirects",async()=>{
  const provider=new ArkVideoProvider();
  const signal=new AbortController().signal;
  let calls=0;
  mock.method(globalThis,"fetch",async(_url:unknown,init:RequestInit)=>{
    calls++;
    assert.equal(init.redirect,"error");
    return new Response(null,{status:302,headers:{Location:"http://127.0.0.1/private"}});
  });
  await assert.rejects(()=>provider.download("http://cdn.example.test/a.mp4",signal));
  await assert.rejects(()=>provider.download("https://untrusted.example.test/a.mp4",signal));
  assert.equal(calls,0);
  await assert.rejects(()=>provider.download("https://cdn.example.test/a.mp4",signal));
  assert.equal(calls,1);
  mock.restoreAll();
  mock.method(globalThis,"fetch",async()=>new Response("not-mp4",{headers:{"Content-Type":"video/mp4"}}));
  await assert.rejects(()=>provider.download("https://cdn.example.test/a.mp4",signal));
});

const eventId="a".repeat(32);
const spaceUrl="https://naxyiudu228-wan22-ti2v-5b.hf.space";
function availability() { return Response.json({runtime:{stage:"RUNNING",hardware:{current:"zero-a10g"},sha:"566d80f899a628836941d69d8eb62ae1141142c8"}}); }
test("Wan uploads image bytes, supports image and text prompts, and never forwards credentials",async()=>{
  const inputs:unknown[][]=[];
  const provider=new WanVideoProvider();
  mock.method(globalThis,"fetch",async(url:unknown,init:RequestInit)=>{
    assert.equal(init.credentials,"omit"); assert.equal(init.redirect,"error");
    assert.equal(new Headers(init.headers).get("Authorization"),null);
    if (String(url).includes(`/api/spaces/${WAN_SPACE}`)) return availability();
    if (String(url).endsWith("/upload")) {
      assert.ok(init.body instanceof FormData);
      const file=init.body.get("files"); assert.ok(file instanceof Blob);
      assert.equal(await file.text(),"synthetic PNG bytes");
      return Response.json(["/tmp/gradio/hash/product.png"]);
    }
    const body=JSON.parse(String(init.body)); inputs.push(body.data);
    return Response.json({event_id:eventId});
  });
  const signal=new AbortController().signal;
  const image=await provider.uploadImage(Buffer.from("synthetic PNG bytes"),"image/png",signal);
  assert.equal(await provider.submit(project,project.scripts[0],image,signal),eventId);
  assert.equal(await provider.submit(project,project.scripts[0],undefined,signal),eventId);
  assert.deepEqual(inputs[0][0],{path:image,meta:{_type:"gradio.FileData"}});
  assert.equal(inputs[1][0],null); assert.equal(inputs[1][1],"Mock visual");
  assert.equal(provider.modelName,WAN_MODEL);
  await assert.rejects(()=>provider.submit(project,project.scripts[0],"https://private.test/signed?token=secret",signal),{code:"PROVIDER_UPLOAD"});
});
test("Wan submission checks free hardware, bounds ambiguity and never automatically resubmits",async()=>{
  const provider=new WanVideoProvider(),signal=new AbortController().signal;
  mock.method(globalThis,"fetch",async()=>Response.json({runtime:{stage:"RUNNING",hardware:{current:"a10g-large"},sha:"566d80f899a628836941d69d8eb62ae1141142c8"}}));
  await assert.rejects(()=>provider.submit(project,project.scripts[0],undefined,signal),{code:"PROVIDER_UNAVAILABLE"});
  mock.restoreAll(); let submissions=0;
  mock.method(globalThis,"fetch",async(url:unknown)=>{
    if (String(url).includes("/api/spaces/")) return availability();
    submissions++; throw new TypeError("Lost response");
  });
  await assert.rejects(()=>provider.submit(project,project.scripts[0],undefined,signal),{code:"SUBMISSION_UNKNOWN"});
  assert.equal(submissions,1);
  mock.restoreAll();
  mock.method(globalThis,"fetch",async(url:unknown)=>String(url).includes("/api/spaces/") ? availability() : new Response("quota",{status:429}));
  await assert.rejects(()=>provider.submit(project,project.scripts[0],undefined,signal),{code:"PROVIDER_REJECTED"});
});
test("Wan resumes a saved event stream and retrieves only the approved generated MP4",async()=>{
  const provider=new WanVideoProvider(),signal=new AbortController().signal;
  let running=0;
  const requests:string[]=[];
  mock.method(globalThis,"fetch",async(url:unknown,init:RequestInit)=>{
    requests.push(String(url)); assert.notEqual(init.method,"POST");
    if (String(url).endsWith(eventId)) {
      const chunks=["event: hea","rtbeat\ndata: null\n\nevent: generating\ndata: null\n\nevent: complete\ndata: ",JSON.stringify([{url:`${spaceUrl}/gradio_api/file=/tmp/gradio/result.mp4`},42]),"\n\n"];
      return new Response(new ReadableStream({start(controller){for(const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close();}}));
    }
    return new Response(Buffer.from("0000ftyp-real-signature"),{headers:{"content-type":"video/mp4"}});
  });
  const result=await provider.poll(eventId,signal,async()=>{running++;});
  assert.equal(result.status,"succeeded"); assert.equal(running,1);
  assert.equal((await provider.download(result.content!.video_url!,signal)).toString(),"0000ftyp-real-signature");
  await assert.rejects(()=>provider.download("https://untrusted.example/video.mp4",signal),{code:"PROVIDER_MEDIA"});
  await assert.rejects(()=>provider.download(`${spaceUrl}/some-proxy?url=http://localhost`,signal),{code:"PROVIDER_MEDIA"});
  assert.equal(requests.length,2);
});
test("Wan exposes quota errors without static fallback, redacts secrets, and preserves unknown tasks",async()=>{
  const provider=new WanVideoProvider(),signal=new AbortController().signal;
  mock.method(globalThis,"fetch",async()=>new Response('event: error\ndata: "GPU quota exceeded; token=private-secret"\n\n'));
  const failed=await provider.poll(eventId,signal);
  assert.equal(failed.status,"failed"); assert.match(failed.error!,/quota exceeded/); assert.ok(!failed.error!.includes("private-secret"));
  mock.restoreAll();
  mock.method(globalThis,"fetch",async()=>new Response("event: error\ndata: null\n\n"));
  assert.match((await provider.poll(eventId,signal)).error!,/without details/);
  mock.restoreAll();
  mock.method(globalThis,"fetch",async()=>new Response("event: heartbeat\ndata: null\n\n"));
  await assert.rejects(()=>provider.poll(eventId,signal),{code:"POLL"});
  mock.restoreAll();
  mock.method(globalThis,"fetch",async()=>new Response(null,{status:404}));
  assert.equal((await provider.poll(eventId,signal)).status,"expired");
});
test("Wan refuses foreign media, invalid signatures and malformed completed outputs",async()=>{
  const provider=new WanVideoProvider(),signal=new AbortController().signal;
  mock.method(globalThis,"fetch",async()=>new Response('event: complete\ndata: [{"url":"https://cdn.untrusted.test/video.mp4"}]\n\n'));
  await assert.rejects(()=>provider.poll(eventId,signal),{code:"PROVIDER_MEDIA"});
  mock.restoreAll();
  mock.method(globalThis,"fetch",async()=>new Response("not MP4",{headers:{"content-type":"video/mp4"}}));
  await assert.rejects(()=>provider.download(`${spaceUrl}/gradio_api/file=/tmp/gradio/bad.mp4`,signal),{code:"PROVIDER_MEDIA"});
});
test("silent generated footage is decoded and normalized to H.264/AAC without inventing narration",async()=>{
  const workspace=await mkdtemp(path.join(tmpdir(),"vidio-normalize-test-"));
  try {
    const input=path.join(workspace,"silent.mp4");
    await promisify(execFile)("ffmpeg",["-v","error","-f","lavfi","-i","testsrc2=size=256x256:rate=12","-t","1.5","-c:v","libx264","-pix_fmt","yuv420p",input]);
    const generated=await readFile(input);
    const normalized=await normalizeGeneratedVideo(generated,"9:16",new AbortController().signal);
    assert.ok(normalized.duration>=1.4 && normalized.duration<1.7);
    assert.ok(normalized.buffer.length>1000);
    await assert.rejects(()=>normalizeGeneratedVideo(generated.subarray(0,generated.length/2),"9:16",new AbortController().signal),{code:"PROVIDER_MEDIA"});
    await assert.rejects(()=>normalizeGeneratedVideo(Buffer.from("not video"),"16:9",new AbortController().signal),{code:"PROVIDER_MEDIA"});
  } finally { await rm(workspace,{recursive:true,force:true}); }
});
