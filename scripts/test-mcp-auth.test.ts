import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { issueLocalMcpToken, mcpActor, mcpChallenge } from "../src/studio/mcp-auth";
import { previewSession } from "../src/studio/auth";
import { signingKey } from "../src/studio/config";
import { mcpSchemas } from "../src/studio/mcp-contracts";

process.env.VIDIO_MODE = "demo";
process.env.VIDIO_MCP_LOCAL_AUTH = "true";
process.env.VIDIO_PREVIEW_SECRET = "test-only-mcp-authentication-signing-key";
const request = (token?: string, host = "localhost:5000") => new Request(`http://${host}/mcp`, {
  headers: token ? { Authorization: `Bearer ${token}`, Host: host } : { Host: host },
});

test("MCP requires an expiring scoped bearer and isolates local owners", async () => {
  const owner = randomUUID(), token = await issueLocalMcpToken(owner);
  assert.equal(await mcpActor(request(token)), `mcp-local|${owner}`);
  assert.notEqual(await mcpActor(request(await issueLocalMcpToken())), `mcp-local|${owner}`);
  await assert.rejects(() => mcpActor(request()));
  await assert.rejects(() => mcpActor(request("forged")));
  await assert.rejects(() => mcpActor(request(token, "public.example.com")));
  const browserToken = await previewSession();
  await assert.rejects(() => mcpActor(request(browserToken)));
  assert.match(mcpChallenge(), /Bearer.*vidio:studio/);
});
test("MCP rejects expiry, scope and audience substitutions", async () => {
  for (const [audience, scope, expiry] of [["vidio-mcp", "vidio:studio", 1], ["vidio-mcp", "other", "15m"], ["vidio-media", "vidio:studio", "15m"]] as const) {
    const token = await new SignJWT({ scope }).setProtectedHeader({ alg: "HS256" })
      .setSubject(randomUUID()).setIssuer("vidio-local-mcp").setAudience(audience)
      .setExpirationTime(expiry).sign(signingKey());
    await assert.rejects(() => mcpActor(request(token)));
  }
});
test("local tokens fail closed when opt-in or demo mode is missing", async () => {
  process.env.VIDIO_MCP_LOCAL_AUTH = "false";
  await assert.rejects(() => issueLocalMcpToken());
  await assert.rejects(() => mcpActor(request()));
  process.env.VIDIO_MCP_LOCAL_AUTH = "true";
  process.env.VIDIO_MODE = "live";
  await assert.rejects(() => issueLocalMcpToken());
  await assert.rejects(() => mcpActor(request()));
  process.env.VIDIO_MODE = "demo";
});
test("recognition and script MCP schemas reject unrelated fields and arbitrary sources", () => {
  const input = { projectId: randomUUID(), revision: 0 };
  assert.equal(mcpSchemas.generate_scripts.parse(input).confirmed, false);
  for (const schema of [mcpSchemas.identify_product, mcpSchemas.generate_scripts]) {
    for (const extra of [{ imageUrl: "http://169.254.169.254" }, { folderPath: "/etc/passwd" }, { segmentId: 1 }, { mock: false }])
      assert.throws(() => schema.parse({ ...input, ...extra }));
    assert.throws(() => schema.parse({ ...input, revision: -1 }));
  }
});
