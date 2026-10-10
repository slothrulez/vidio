import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { toolOutputSchema } from "../src/studio/types";
import { widgetUri } from "../src/studio/mcp";

const base = process.env.TEST_APP_ORIGIN ?? "http://localhost:5000";
const client = new Client(
  { name: "vidio-offline-acceptance", version: "1.0.0" },
  { capabilities: {} },
);
let checks = 0;
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  checks++;
  return {
    data: toolOutputSchema.parse(result.structuredContent),
    media: z
      .object({ media: z.record(z.string(), z.string()).optional() })
      .parse(result._meta ?? {}).media,
  };
}
async function main() {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 14);
  checks++;
  assert.equal(
    tools.tools.find((tool) => tool.name === "render_project")?._meta?.[
      "openai/outputTemplate"
    ],
    widgetUri,
  );
  checks++;
  const resource = await client.readResource({ uri: widgetUri });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.ok(
    "text" in resource.contents[0] &&
      resource.contents[0].text.includes("vidio"),
  );
  checks++;
  let project = (
    await call("create_project", {
      name: "Sample essential",
      language: "english",
      ratio: "16:9",
    })
  ).data.project!;
  const bad = await client.callTool({
    name: "generate_segments",
    arguments: {
      projectId: project.id,
      revision: project.revision,
      confirmed: false,
    },
  });
  assert.equal(bad.isError, true);
  checks++;
  async function run(operation: string, extra: Record<string, unknown> = {}) {
    const queued = await call(operation, {
      projectId: project.id,
      revision: project.revision,
      confirmed: true,
      ...extra,
    });
    const job = queued.data.job!;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = (await call("get_job", { jobId: job.id })).data.job!;
      if (status.status === "succeeded") {
        project = (await call("get_project", { projectId: project.id })).data
          .project!;
        return;
      }
      assert.notEqual(status.status, "failed", status.error ?? "Worker failed");
      assert.notEqual(status.status, "cancelled");
      await setTimeout(500);
    }
    throw new Error("Timed out waiting for the worker");
  }
  await run("identify_product");
  assert.equal(project.stage, "identified");
  checks++;
  await run("draft_scripts");
  assert.equal(project.scripts.length, 4);
  checks++;
  project = (
    await call("update_script", {
      projectId: project.id,
      revision: project.revision,
      id: 1,
      script: "An edited fixture script.",
      prompt: "Soft studio lighting",
    })
  ).data.project!;
  assert.equal(project.scripts[0].script, "An edited fixture script.");
  checks++;
  await run("preview_voice");
  assert.ok(project.voiceAssetId);
  checks++;
  await run("generate_segments");
  assert.equal(project.segments.length, 4);
  checks++;
  const before = project.segments.map((segment) => segment.assetId);
  await run("regenerate_segment", { segmentId: 2 });
  assert.equal(project.segments[0].assetId, before[0]);
  assert.notEqual(project.segments[1].assetId, before[1]);
  checks++;
  await run("compose_video", { segmentIds: [1, 3] });
  assert.equal(project.stage, "done");
  checks++;
  const download = await call("get_download", { projectId: project.id });
  assert.equal(JSON.stringify(download.data).includes("?token="), false);
  checks++;
  const mediaUrl = download.media![project.finalAssetId!];
  const localMedia = new URL(mediaUrl);
  localMedia.protocol = new URL(base).protocol;
  localMedia.host = new URL(base).host;
  const range = await fetch(localMedia, { headers: { Range: "bytes=0-99" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  checks++;
  const unsigned = new URL(localMedia);
  unsigned.search = "";
  assert.equal((await fetch(unsigned)).status, 401);
  checks++;
  const disallowed = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Origin: "https://attacker.example.com",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(disallowed.status, 403);
  checks++;
  for (const route of [
    "/api/chat-agent",
    "/api/generate-product-video",
    "/api/file",
    "/api/video-proxy",
    "/api/upload-image",
  ]) {
    assert.equal((await fetch(`${base}${route}`)).status, 503);
    checks++;
  }
  const session = await fetch(`${base}/api/studio/session`, { method: "POST" });
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const ownRead = await fetch(`${base}/api/studio/tools`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "get_project",
      arguments: { projectId: project.id },
    }),
  });
  assert.equal(ownRead.status, 404);
  checks++;
  const create = await fetch(`${base}/api/studio/tools`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "create_project",
      arguments: { name: "Owned image fixture" },
    }),
  });
  const owned = toolOutputSchema.parse(
    (await create.json()).structuredContent,
  ).project!;
  const form = new FormData();
  form.set("projectId", owned.id);
  form.set("revision", String(owned.revision));
  form.set(
    "image",
    new File([await readFile("src/app/icon.png")], "fixture.png", {
      type: "image/png",
    }),
  );
  const upload = await fetch(`${base}/api/studio/upload`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  assert.equal(upload.status, 200, await upload.text());
  checks++;
  const cancellation = await call("identify_product", {
    projectId: project.id,
    revision: project.revision,
    confirmed: false,
  });
  await call("cancel_job", { jobId: cancellation.data.job!.id });
  console.log(
    `${checks} protocol, worker, media and ownership checks passed; no external providers were called.`,
  );
  await client.close();
}
main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "MCP checks failed");
  await client.close();
  process.exit(1);
});
