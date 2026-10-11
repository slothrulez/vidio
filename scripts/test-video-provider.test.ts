import { test,mock,afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ArkVideoProvider } from "../src/studio/video-provider";
import { StudioError,type StudioProject } from "../src/studio/types";

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
