import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { config } from "dotenv";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { issueLocalMcpToken } from "../src/studio/mcp-auth";
import { toolOutputSchema } from "../src/studio/types";

config({ path: ".env.local", quiet: true });
const base = process.env.TEST_APP_ORIGIN ?? "http://localhost:5000";
const client = new Client({ name: "vidio-identification-acceptance", version: "1.0.0" });
async function main() {
  const unauthenticated = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /Bearer/);
  const token = await issueLocalMcpToken();
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const tools = await client.listTools();
  for (const name of ["identify_product", "generate_scripts"])
    assert.ok(tools.tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === false));
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return toolOutputSchema.parse(result.structuredContent);
  }
  let project = (await call("create_project", { name: "Owned fixture product" })).project!;
  for (const operation of ["identify_product", "generate_scripts"]) {
    const result = await call(operation, { projectId: project.id, revision: project.revision });
    assert.ok(result.job?.id);
    if (operation === "generate_scripts") assert.equal(result.job.operation, "generate_scripts");
    let complete = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = (await call("get_job", { jobId: result.job.id })).job!;
      assert.notEqual(status.status, "failed");
      if (status.status === "succeeded") { complete = true; break; }
      await setTimeout(500);
    }
    assert.ok(complete, "Worker did not complete the fixture job");
    project = (await call("get_project", { projectId: project.id })).project!;
    assert.equal(project.stage, operation === "identify_product" ? "identified" : "scripted");
  }
  assert.equal(project.scripts.length, 4);
  assert.equal(JSON.stringify(project).includes("localPath"), false);
  await client.close();
  console.log("Authenticated identify_product and generate_scripts passed through Streamable HTTP; fixture results only, no providers called.");
}
main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "MCP identification checks failed");
  await client.close(); process.exitCode = 1;
});
