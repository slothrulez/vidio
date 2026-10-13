import { test } from "node:test";
import assert from "node:assert/strict";
import { isDevelopmentMode } from "../src/server-mode";
import { checkReadiness, WORKER_HEARTBEAT_MAX_AGE_SECONDS } from "../src/studio/health";
import { isWorkerEntryPoint } from "../src/worker";

test("worker entrypoint detection supports Windows and POSIX paths", () => {
  assert.equal(isWorkerEntryPoint("D:\\Projects\\vidio\\src\\worker.ts"), true);
  assert.equal(isWorkerEntryPoint("/srv/vidio/src/worker.ts"), true);
  assert.equal(isWorkerEntryPoint("D:\\Projects\\vidio\\scripts\\test-health.test.ts"), false);
  assert.equal(isWorkerEntryPoint(undefined), false);
});

test("production Node environment starts Next in production without provider-specific flags", () => {
  assert.equal(isDevelopmentMode({ NODE_ENV: "production" }), false);
  assert.equal(isDevelopmentMode({ COZE_PROJECT_ENV: "PROD" }), false);
  assert.equal(isDevelopmentMode({ NODE_ENV: "development" }), true);
});

test("readiness requires a successful database and fresh worker probe without leaking errors", async () => {
  assert.equal(WORKER_HEARTBEAT_MAX_AGE_SECONDS, 30);
  assert.equal(await checkReadiness("production", async () => undefined), true);
  assert.equal(await checkReadiness("production", async () => { throw new Error("database secret details"); }), false);
});
