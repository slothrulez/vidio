import { test, mock } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { parseRegenerationResult } from "../src/agent/transport";
import { regenerateSegment } from "../src/agent/tools";
import { VideoAgentExecutor } from "../src/agent/graph";

const done = `data: ${JSON.stringify({ type: "done", data: { video: { url: "https://example.com/video.mp4", localPath: "/tmp/owned/video.mp4", duration: 5 }, audio: { url: "https://example.com/audio.mp3", localPath: "/tmp/owned/audio.mp3" } } })}\n\n`;

test("normalizes completed SSE and legacy JSON regeneration results", () => {
  const segment = parseRegenerationResult(
    `data: {"type":"start"}\r\n\r\n${done}`,
    2,
    "Script",
  );
  assert.equal(segment.videoUrl, "https://example.com/video.mp4");
  assert.equal(segment.audioPath, "/tmp/owned/audio.mp3");
  assert.equal(
    parseRegenerationResult(
      { videoUrl: "https://example.com/video.mp4" },
      2,
      "Script",
    ).id,
    2,
  );
});

test("stream errors and premature termination are not successes", () => {
  assert.throws(
    () =>
      parseRegenerationResult(
        'data: {"type":"error","data":{"message":"failed"}}\n',
        1,
        "",
      ),
    /failed/,
  );
  assert.throws(
    () => parseRegenerationResult('data: {"type":"start"}\n', 1, ""),
    /without a completed/,
  );
});

test("regeneration helper sends the route imageUrl field and reads SSE", async () => {
  const post = mock.method(
    axios,
    "post",
    async (_url: string, body: Record<string, unknown>) => {
      assert.equal(body.imageUrl, "https://example.com/product.png");
      assert.equal(body.productImageUrl, undefined);
      return { data: done };
    },
  );
  try {
    const result = await regenerateSegment(
      2,
      "Script",
      "Prompt",
      "https://example.com/product.png",
      "Product",
    );
    assert.equal(result.success, true);
    assert.equal(
      (result.data?.segment as { videoUrl: string }).videoUrl,
      "https://example.com/video.mp4",
    );
  } finally {
    post.mock.restore();
  }
});

test("stream executor preserves video-mode scripts and prompts without executing a provider", async () => {
  const executor = new VideoAgentExecutor();
  const scripts = ["Keep this script"];
  Reflect.set(executor, "graph", {
    stream: async function* (input: { scripts: unknown; prompts: unknown }) {
      assert.deepEqual(input.scripts, scripts);
      assert.deepEqual(input.prompts, scripts);
      yield { init: {} };
    },
  });
  for await (const result of executor.streamExecute({
    scripts,
    prompts: scripts,
  }))
    assert.equal(result.node, "init");
});
