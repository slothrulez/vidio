import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { database } from "../src/studio/db";
import { POST } from "../src/app/mcp/route";
import { issueLocalMcpToken } from "../src/studio/mcp-auth";
import { createProject, getProject, saveProject } from "../src/studio/store";
import { executeDemo } from "../src/studio/demo";
import { composeOwnedSegments, subtitleFiles } from "../src/studio/composition";
import { readAsset, assetPath } from "../src/studio/assets";
import { toolOutputSchema, toolMetaSchema } from "../src/studio/types";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Use a disposable TEST_DATABASE_URL ending in _test");
process.env.DATABASE_URL = url;
process.env.VIDIO_MODE = "demo";
process.env.VIDIO_MCP_LOCAL_AUTH = "true";
process.env.VIDIO_PREVIEW_SECRET = randomBytes(32).toString("hex");
const subject = randomUUID();
const owner = `mcp-local|${subject}`;
let token = "",
  other = "";
before(async () => {
  for (const name of [
    "0001_studio.sql",
    "0002_job_lifecycle.sql",
    "0003_result_ownership.sql",
    "0004_widget_uploads.sql",
  ])
    await database().query(await readFile(`migrations/${name}`, "utf8"));
  token = await issueLocalMcpToken(subject);
  other = await issueLocalMcpToken(randomUUID());
});
after(async () => {
  await database().query("DELETE FROM vidio_projects WHERE owner_id=$1", [
    owner,
  ]);
  await database().end();
});
async function rpc(
  method: string,
  params: Record<string, unknown>,
  bearer = token,
) {
  const result = await POST(
    new Request("http://localhost:5000/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.error, undefined);
  return body.result;
}
async function call(
  name: string,
  args: Record<string, unknown>,
  bearer = token,
) {
  return rpc("tools/call", { name, arguments: args }, bearer);
}
test("Streamable HTTP uploads are app-only, owner-scoped, chunk-idempotent and finalize to stable image IDs", async () => {
  const listed = await rpc("tools/list", {});
  for (const name of [
    "begin_image_upload",
    "append_image_chunk",
    "finish_image_upload",
    "abort_image_upload",
    "save_scripts",
  ])
    assert.deepEqual(
      listed.tools.find((tool: { name: string }) => tool.name === name)._meta.ui
        .visibility,
      ["app"],
    );
  for (const name of [
    "identify_product",
    "generate_scripts",
    "start_video_job",
    "get_video_job_status",
    "regenerate_segment",
    "compose_final_video",
    "get_final_video",
  ])
    assert.equal(
      listed.tools.find((tool: { name: string }) => tool.name === name)._meta.ui
        .resourceUri,
      "ui://vidio/studio-v2.html",
    );
  const created = await call("create_project", {
    name: "Private mug",
    language: "cantonese",
    ratio: "9:16",
  });
  let project = toolOutputSchema.parse(created.structuredContent).project!;
  const bytes = await readFile("src/app/opengraph-image.png");
  for (let index = 0; index < 2; index++) {
    const begun = await call("begin_image_upload", {
      projectId: project.id,
      revision: project.revision,
      mime: "image/png",
      size: bytes.length,
    });
    const uploadId = toolMetaSchema.parse(begun._meta).upload!.id;
    const chunk = { uploadId, offset: 0, data: bytes.toString("base64") };
    assert.equal(
      (await call("append_image_chunk", chunk, other)).isError,
      true,
    );
    const saved = await call("append_image_chunk", chunk);
    assert.equal(
      toolMetaSchema.parse(saved._meta).upload!.offset,
      bytes.length,
    );
    assert.equal(
      toolMetaSchema.parse((await call("append_image_chunk", chunk))._meta)
        .upload!.offset,
      bytes.length,
    );
    const finalized = await call("finish_image_upload", { uploadId });
    assert.equal(finalized.isError, undefined);
    project = toolOutputSchema.parse(finalized.structuredContent).project!;
    assert.equal(
      (await call("finish_image_upload", { uploadId })).structuredContent
        .project.revision,
      project.revision,
    );
  }
  assert.equal(project.imageAssetIds?.length, 2);
  assert.equal(project.language, "cantonese");
  assert.equal(project.imageAssetId, project.imageAssetIds?.[0]);
  assert.equal(
    (
      await call("begin_image_upload", {
        projectId: project.id,
        revision: 0,
        mime: "image/png",
        size: bytes.length,
      })
    ).isError,
    true,
  );
  assert.equal(
    (await readAsset(owner, project.imageAssetIds![1])).mime,
    "image/png",
  );
});
test("malformed, oversized, partial, expired and spoofed uploads fail without attaching an asset", async () => {
  const project = await createProject(owner, {
    name: "Invalid upload",
    language: "mandarin",
    ratio: "16:9",
  });
  assert.equal(
    (
      await call("begin_image_upload", {
        projectId: project.id,
        revision: 0,
        mime: "image/svg+xml",
        size: 25,
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await call("begin_image_upload", {
        projectId: project.id,
        revision: 0,
        mime: "image/png",
        size: 5_000_001,
      })
    ).isError,
    true,
  );
  const begin = await call("begin_image_upload", {
    projectId: project.id,
    revision: 0,
    mime: "image/png",
    size: 24,
  });
  const uploadId = toolMetaSchema.parse(begin._meta).upload!.id;
  assert.equal((await call("abort_image_upload",{uploadId},other)).isError,undefined);
  assert.equal((await call("finish_image_upload",{uploadId})).isError,true);
  assert.equal((await call("finish_image_upload", { uploadId })).isError, true);
  assert.equal(
    (
      await call("append_image_chunk", {
        uploadId,
        offset: 0,
        data: "not valid base64",
      })
    ).isError,
    true,
  );
  await call("append_image_chunk", {
    uploadId,
    offset: 0,
    data: Buffer.alloc(24).toString("base64"),
  });
  assert.equal((await call("finish_image_upload", { uploadId })).isError, true);
  assert.equal((await getProject(owner, project.id)).imageAssetId, undefined);
  await database().query(
    "UPDATE vidio_image_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",
    [uploadId],
  );
  assert.equal((await call("finish_image_upload", { uploadId })).isError, true);
  assert.equal((await call("abort_image_upload",{uploadId})).isError,undefined);
  assert.equal((await call("finish_image_upload",{uploadId})).isError,true);
});
test("composition produces a real MP4 with timed Chinese captions and original instrumental audio", async () => {
  const project = await createProject(owner, {
    name: "Subtitle test",
    language: "cantonese",
    ratio: "16:9",
  });
  project.scripts = [
    { id: 1, script: "你好，日常好物。", prompt: "Sample only" },
    { id: 2, script: "一齊睇真啲。", prompt: "Sample only" },
  ];
  await saveProject(owner, project);
  const updated = await executeDemo(
    owner,
    randomUUID(),
    "generate_segments",
    { projectId: project.id, revision: 0, confirmed: true },
    project,
    {
      signal: new AbortController().signal,
      checkpoint: async () => {},
      segment: async (_id, produce) => produce(),
    },
  );
  await composeOwnedSegments(
    owner,
    updated,
    [1, 2],
    undefined,
    async () => {},
    { subtitles: true, backgroundMusic: "soft" },
  );
  assert.ok(updated.finalAssetId);
  assert.ok(updated.captionAssetId);
  const caption = await readAsset(owner, updated.captionAssetId!);
  assert.equal(caption.mime, "text/vtt");
  assert.match(caption.buffer.toString(), /00:00:02.000 --> 00:00:04.000/);
  assert.match(caption.buffer.toString(), /一齊睇真啲/);
  const probe = await promisify(execFile)("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,codec_type:format=duration",
    "-of",
    "json",
    assetPath(updated.finalAssetId!),
  ]);
  const info = JSON.parse(probe.stdout);
  assert.ok(
    info.streams.some(
      (stream: { codec_name: string }) => stream.codec_name === "mov_text",
    ),
  );
  assert.ok(
    info.streams.some(
      (stream: { codec_type: string }) => stream.codec_type === "audio",
    ),
  );
  assert.ok(Number(info.format.duration) >= 3.8);
  assert.equal(
    subtitleFiles([
      {
        id: 1,
        assetId: randomUUID(),
        duration: 2,
        script: "</script>\n\n00:10:00 --> injected",
      },
    ]).vtt.includes("</script>"),
    false,
  );
});
