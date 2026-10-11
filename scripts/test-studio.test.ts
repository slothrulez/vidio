import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StudioError } from "../src/studio/types";
import { byteRange } from "../src/studio/media";
import { proxy } from "../src/proxy";
import { NextRequest } from "next/server";
import { actor, previewSession } from "../src/studio/auth";
import {
  mediaToken,
  verifyMediaToken,
  validateImage,
  assetPath,
} from "../src/studio/assets";
import { signingKey, requireDemoMode, checkOrigin } from "../src/studio/config";
import { boundedBody } from "../src/studio/request";
import { schemas, safeError } from "../src/studio/service";
import { validateOperation } from "../src/studio/store";
import { type StudioProject } from "../src/studio/types";

process.env.VIDIO_MODE = "demo";
process.env.VIDIO_PREVIEW_SECRET =
  "test-only-signing-key-not-a-real-credential";
process.env.VIDIO_PUBLIC_ORIGIN = "https://vidio.example.com";
const project: StudioProject = {
  id: randomUUID(),
  name: "Example",
  revision: 0,
  stage: "scripted",
  language: "english",
  ratio: "16:9",
  features: ["sample"],
  scripts: [{ id: 1, script: "Example", prompt: "Example" }],
  segments: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  mode: "demo",
};

test("preview sessions bind a unique owner and reject forged and expired tokens", async () => {
  const first = await previewSession(),
    second = await previewSession();
  const request = (token: string) =>
    new Request("https://vidio.example.com", {
      headers: { Cookie: `vidio_preview=${token}` },
    });
  assert.notEqual(await actor(request(first)), await actor(request(second)));
  await assert.rejects(() => actor(request("invalid")));
  const expired = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("owner")
    .setAudience("vidio-studio")
    .setIssuer("vidio-preview")
    .setExpirationTime(1)
    .sign(signingKey());
  await assert.rejects(() => actor(request(expired)));
});
test("media tokens are scoped to their exact asset and a different audience", async () => {
  const asset = randomUUID(),
    token = await mediaToken("owner", asset);
  assert.equal(await verifyMediaToken(token, asset), "owner");
  await assert.rejects(() => verifyMediaToken(token, randomUUID()));
  await assert.rejects(() =>
    actor(
      new Request("https://vidio.example.com", {
        headers: { Cookie: `vidio_preview=${token}` },
      }),
    ),
  );
  assert.throws(() => assetPath("../../etc/passwd"));
});
test("schemas reject arbitrary URLs, paths, oversized scripts and client provider-mode switches", () => {
  assert.throws(() =>
    schemas.create_project.parse({
      name: "Example",
      imageUrl: "http://169.254.169.254",
    }),
  );
  assert.throws(() =>
    schemas.generate_segments.parse({
      projectId: project.id,
      revision: 0,
      folderPath: "/tmp/arbitrary",
      mock: false,
    }),
  );
  assert.throws(() =>
    schemas.update_script.parse({
      projectId: project.id,
      revision: 0,
      id: 1,
      script: "x".repeat(1001),
      prompt: "sample",
    }),
  );
});
test("media stages require confirmation, scripts, and owned unique segment selections", () => {
  assert.throws(() =>
    validateOperation("generate_segments", project, {
      projectId: project.id,
      revision: 0,
      confirmed: false,
    }),
  );
  assert.throws(() =>
    validateOperation("compose_video", project, {
      projectId: project.id,
      revision: 0,
      confirmed: true,
      segmentIds: [1, 1],
    }),
  );
  assert.throws(() =>
    validateOperation("regenerate_segment", project, {
      projectId: project.id,
      revision: 0,
      confirmed: true,
      segmentId: 2,
    }),
  );
});
test("image validation fully decodes real images and rejects truncated headers, spoofing and size limits", async () => {
  const png = await readFile("src/app/opengraph-image.png");
  await validateImage(png, "image/png");
  await assert.rejects(() => validateImage(png.subarray(0,24),"image/png"));
  await assert.rejects(() => validateImage(png.subarray(0,png.length/2),"image/png"));
  await assert.rejects(() => validateImage(png,"image/jpeg"));
  await assert.rejects(() =>
    validateImage(
      Buffer.from("<svg><script>alert(1)</script></svg>"),
      "image/png",
    ),
  );
  png.writeUInt32BE(5000, 16);
  await assert.rejects(() => validateImage(png, "image/png"));
  await assert.rejects(() => validateImage(Buffer.alloc(5_000_001), "image/png"));
});
test("media range parsing bounds integers, supports suffixes and rejects invalid or multiple ranges",()=>{
  assert.deepEqual(byteRange(null,20),{start:0,end:19});
  assert.deepEqual(byteRange("bytes=0-0",20),{start:0,end:0});
  assert.deepEqual(byteRange("bytes=-7",20),{start:13,end:19});
  assert.deepEqual(byteRange("bytes=10-",20),{start:10,end:19});
  assert.deepEqual(byteRange("bytes=10-100",20),{start:10,end:19});
  for (const value of ["bytes=-0","bytes=-","bytes=20-","bytes=9-4","bytes=0-1,2-3","bytes=999999999999999999999-"]) assert.equal(byteRange(value,20),undefined);
});
test("real JPEGs decode, truncated JPEGs fail, and image decoder admission is bounded and released",async()=>{
  const {stdout:jpeg}=await promisify(execFile)("ffmpeg",["-hide_banner","-loglevel","error","-i","src/app/opengraph-image.png","-frames:v","1","-f","image2pipe","-vcodec","mjpeg","pipe:1"],{encoding:"buffer",timeout:5000,maxBuffer:5_000_000});
  await validateImage(jpeg,"image/jpeg");
  await assert.rejects(()=>validateImage(jpeg.subarray(0,jpeg.length/2),"image/jpeg"));
  const results=await Promise.allSettled([validateImage(jpeg,"image/jpeg"),validateImage(jpeg,"image/jpeg"),validateImage(jpeg,"image/jpeg")]);
  assert.equal(results.filter(result=>result.status==="fulfilled").length,2);
  const rejected=results.find(result=>result.status==="rejected")!;
  assert.equal(rejected.status,"rejected");
  if (rejected.status==="rejected") {assert.ok(rejected.reason instanceof StudioError);assert.equal(rejected.reason.code,"RATE_LIMIT");}
  await validateImage(jpeg,"image/jpeg");
});
test("production and unknown modes never expose legacy APIs; private development website contracts remain",()=>{
  const prior={VIDIO_MODE:process.env.VIDIO_MODE,NODE_ENV:process.env.NODE_ENV,COZE_PROJECT_ENV:process.env.COZE_PROJECT_ENV};
  try {
    const env=process.env as Record<string,string|undefined>;
    for (const mode of [undefined,"production","prodution","legacy","demo"]) {
      if (mode===undefined) delete env.VIDIO_MODE; else env.VIDIO_MODE=mode;
      env.NODE_ENV="production";
      assert.equal(proxy(new NextRequest("https://vidio.example/api/generate-video")).status,503);
      assert.equal(proxy(new NextRequest("https://vidio.example/api/studio/jobs")).status,200);
      assert.equal(proxy(new NextRequest("https://vidio.example/api/media/any")).status,200);
      assert.equal(proxy(new NextRequest("https://vidio.example/")).status,200);
    }
    env.NODE_ENV="development";delete env.COZE_PROJECT_ENV;
    for (const mode of [undefined,"legacy"]) {
      if (mode===undefined) delete env.VIDIO_MODE;else env.VIDIO_MODE=mode;
      assert.equal(proxy(new NextRequest("http://localhost:5000/api/generate-video")).status,200);
    }
    env.VIDIO_MODE="prodution";
    assert.equal(proxy(new NextRequest("http://localhost:5000/api/file")).status,503);
  } finally {for (const [key,value] of Object.entries(prior)) {if (value===undefined) delete process.env[key];else process.env[key]=value;}}
});
test("streaming body limits apply even without a Content-Length header", async () => {
  const request = new Request("https://vidio.example.com", {
    method: "POST",
    body: "x".repeat(20),
  });
  await assert.rejects(() => boundedBody(request, 10));
});
test("origin and disabled-mode boundaries fail closed and internal errors are sanitized", () => {
  assert.throws(() =>
    checkOrigin(
      new Request("https://vidio.example.com", {
        headers: { Origin: "https://attacker.example.com" },
      }),
    ),
  );
  process.env.VIDIO_MODE = "live";
  assert.throws(requireDemoMode);
  process.env.VIDIO_MODE = "demo";
  assert.equal(
    safeError(
      new Error("provider-token-private-file-path"),
    ).body.error.message.includes("provider-token"),
    false,
  );
});
