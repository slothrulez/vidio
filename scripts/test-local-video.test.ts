import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderProductScene } from "../src/studio/local-video";
import { probeVideo } from "../src/studio/video-provider";

const run = promisify(execFile);

test("local renderer creates a decodable animated MP4 with marketing caption and optional audio", async () => {
  const image = await readFile("src/app/opengraph-image.png");
  const mp4 = await renderProductScene(image, "image/png", "16:9", "Meet the product. Made for your everyday.");
  const directory = await mkdtemp(path.join(tmpdir(), "vidio-video-test-"));
  try {
    const file = path.join(directory, "result.mp4");
    await writeFile(file, mp4);
    const duration = await probeVideo(file, "16:9");
    assert.ok(duration >= 4.9 && duration <= 5.1);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", file]);
    assert.match(stdout, /"codec_name": "h264"/);
    assert.match(stdout, /"codec_name": "aac"/);
    assert.ok(mp4.length > 10_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
