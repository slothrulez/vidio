import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
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
test("image validation checks signatures, dimensions and bounded size", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(100, 20);
  validateImage(png, "image/png");
  assert.throws(() =>
    validateImage(
      Buffer.from("<svg><script>alert(1)</script></svg>"),
      "image/png",
    ),
  );
  png.writeUInt32BE(5000, 16);
  assert.throws(() => validateImage(png, "image/png"));
  assert.throws(() => validateImage(Buffer.alloc(5_000_001), "image/png"));
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
