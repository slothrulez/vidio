import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { issueLocalMcpToken, mcpActor, mcpChallenge } from "../src/studio/mcp-auth";
import { previewSession } from "../src/studio/auth";
import { signingKey } from "../src/studio/config";
import { mcpSchemas } from "../src/studio/mcp-contracts";
import { addMcpToolAuthMetadata, createMcpServer } from "../src/studio/mcp";
import { InMemoryTransport, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { GET as protectedResource } from "../src/app/.well-known/oauth-protected-resource/mcp/route";
import { POST as mcpPost } from "../src/app/mcp/route";

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
test("production OAuth discovery metadata matches the advertised MCP resource", async () => {
  Object.assign(process.env, {
    VIDIO_MODE: "production",
    VIDIO_MCP_LOCAL_AUTH: "false",
    VIDIO_PUBLIC_ORIGIN: "https://studio.example.test",
    OAUTH_ISSUER: "https://identity.example.test/tenant",
    OAUTH_JWKS_URL: "https://identity.example.test/tenant/jwks",
    OAUTH_AUDIENCE: "https://studio.example.test/mcp",
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
    S3_BUCKET_NAME: "private-test-bucket",
    S3_REGION: "us-east-1",
    VIDIO_MEDIA_SECRET: "test-only-media-signing-secret-not-a-real-key",
  });
  try {
    const response = protectedResource();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: "https://studio.example.test/mcp",
      authorization_servers: ["https://identity.example.test/tenant"],
      scopes_supported: ["vidio:studio"],
    });
    assert.equal(
      mcpChallenge(),
      'Bearer resource_metadata="https://studio.example.test/.well-known/oauth-protected-resource/mcp", scope="vidio:studio"',
    );
    const unauthorized = await mcpPost(new Request("https://studio.example.test/mcp", {
      method: "POST",
      headers: { host: "studio.example.test", "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("www-authenticate"), mcpChallenge());
  } finally {
    Object.assign(process.env, {
      VIDIO_MODE: "demo",
      VIDIO_MCP_LOCAL_AUTH: "true",
      VIDIO_PREVIEW_SECRET: "test-only-mcp-authentication-signing-key",
    });
    delete process.env.VIDIO_PUBLIC_ORIGIN;
    delete process.env.OAUTH_ISSUER;
    delete process.env.OAUTH_JWKS_URL;
    delete process.env.OAUTH_AUDIENCE;
    delete process.env.DATABASE_URL;
    delete process.env.S3_BUCKET_NAME;
    delete process.env.S3_REGION;
    delete process.env.VIDIO_MEDIA_SECRET;
  }
});
test("all MCP tools publish OAuth schemes in compatibility metadata", async () => {
  const server = createMcpServer(randomUUID());
  const client = new Client({ name: "vidio-contract-test", version: "1.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 7);
    for (const tool of tools) {
      const descriptor = tool as unknown as {
        _meta?: Record<string, unknown>;
      };
      assert.deepEqual(descriptor._meta?.securitySchemes, [
        { type: "oauth2", scopes: ["vidio:studio"] },
      ], tool.name);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
test("HTTP tools/list response carries top-level OAuth schemes while preserving compatibility metadata", async () => {
  const schemes = [{ type: "oauth2", scopes: ["vidio:studio"] }];
  const original = Response.json({
    jsonrpc: "2.0",
    id: 7,
    result: { tools: [{ name: "get_project", _meta: { securitySchemes: schemes, ui: { resourceUri: "ui://vidio/studio-v2.html" } } }] },
  });
  const decorated = await addMcpToolAuthMetadata(original, { jsonrpc: "2.0", id: 7, method: "tools/list" });
  const payload = await decorated.json();
  assert.deepEqual(payload.result.tools[0].securitySchemes, schemes);
  assert.deepEqual(payload.result.tools[0]._meta.securitySchemes, schemes);
  assert.equal(payload.result.tools[0]._meta.ui.resourceUri, "ui://vidio/studio-v2.html");
  assert.equal((await addMcpToolAuthMetadata(original, { method: "tools/call" })).status, 200);
});
test("stateless Streamable HTTP tools/list returns all tools with OAuth schemes", async () => {
  const server = createMcpServer(randomUUID());
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const requestBody = { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} };
  try {
    await server.connect(transport);
    const request = new Request("http://localhost:5000/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(requestBody),
    });
    const response = await transport.handleRequest(request, { parsedBody: requestBody });
    assert.equal(response.status, 200);
    const payload = await (await addMcpToolAuthMetadata(response, requestBody)).json();
    assert.ok(payload.result.tools.length >= 7);
    for (const tool of payload.result.tools) {
      assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["vidio:studio"] }], tool.name);
      assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes, tool.name);
    }
  } finally {
    await server.close();
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
test("MCP project creation defaults to English and rejects other voiceover languages", () => {
  assert.equal(mcpSchemas.create_project.parse({}).language, "english");
  assert.equal(mcpSchemas.create_project.parse({ language: "english" }).language, "english");
  for (const language of ["mandarin", "cantonese"])
    assert.throws(() => mcpSchemas.create_project.parse({ language }));
});
test("paid-job contracts require explicit approval and well-formed segment selections", () => {
  const common = { projectId: randomUUID(), revision: 2 };
  for (const name of ["start_video_job", "regenerate_segment", "compose_final_video"] as const) {
    const schema = mcpSchemas[name];
    assert.throws(() => schema.parse(common));
    assert.throws(() => schema.parse({ ...common, confirmed: false }));
    assert.throws(() => schema.parse({ ...common, confirmed: true, unsafePath: "/tmp" }));
  }
  assert.throws(() => mcpSchemas.regenerate_segment.parse({ ...common, confirmed: true }));
  assert.throws(() => mcpSchemas.regenerate_segment.parse({ ...common, confirmed: true, segmentId: 10 }));
  assert.throws(() => mcpSchemas.compose_final_video.parse({ ...common, confirmed: true, segmentIds: [1, 1] }));
  assert.throws(() => mcpSchemas.compose_final_video.parse({ ...common, confirmed: true, segmentIds: [] }));
  assert.deepEqual(mcpSchemas.start_video_job.parse({ ...common, confirmed: true }), { ...common, confirmed: true });
});
