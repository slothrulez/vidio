import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { redactUrl, redactText, safeLogError } from "../src/lib/log-redact";

const signed="https://bucket.tos-cn-beijing.volces.com/owner/project/asset.mp4?X-Amz-Signature=SECRETSIG&X-Amz-Credential=AKIASECRET";

test("redaction keeps only scheme and host of URLs", () => {
  assert.equal(redactUrl(signed), "https://bucket.tos-cn-beijing.volces.com/…");
  assert.equal(redactUrl(undefined), "[none]");
  assert.equal(redactUrl("not a url"), "[redacted]");
});

test("redacted text and errors never contain signatures, tokens, keys or paths", () => {
  const text=redactText(`Provider failed for ${signed} with Authorization: Bearer eyJabc.def.ghi api_key=ark-secret at /tmp/vidio/work/clip.mp4`);
  for (const secret of ["SECRETSIG","AKIASECRET","eyJabc","ark-secret","/tmp/vidio"]) assert.doesNotMatch(text,new RegExp(secret));
  assert.match(text,/Bearer \[redacted\]/);
  assert.match(text,/\[path\]/);
  const error=safeLogError(new Error(`Task task-123 at ${signed}`));
  assert.doesNotMatch(error,/SECRETSIG/);
  assert.doesNotMatch(safeLogError({ response: { data: { url: signed } } }),/SECRETSIG/);
  assert.ok(redactText("x".repeat(1000)).length<=301);
});

test("legacy agent and API logs do not interpolate raw URLs, paths or error objects", async () => {
  const files=["src/agent/tools.ts","src/agent/chat-node.ts","src/app/api/generate-video/route.ts","src/app/api/chat-agent/route.ts","src/app/api/video-task/generate-segment/route.ts"];
  for (const file of files) {
    const lines=(await readFile(file,"utf8")).split("\n");
    lines.forEach((line,index)=>{
      if (!/console\.(log|error|warn)/.test(line)) return;
      assert.doesNotMatch(line,/\.substring\(0, ?\d+\)/,`${file}:${index+1} truncates instead of redacting`);
      assert.doesNotMatch(line,/\$\{(?!redactUrl|safeLogError|redactText)[\w.]*(?:Url|url|Path|Dir)\}/,`${file}:${index+1} logs a raw URL or path`);
      assert.doesNotMatch(line,/,\s*\w*[eE]rror\s*\)\s*;?\s*$/,`${file}:${index+1} logs a raw error object`);
      assert.doesNotMatch(line,/error\.stack|JSON\.stringify\(\w*[eE]rror/,`${file}:${index+1} logs error internals`);
    });
  }
});
