import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { database } from "../src/studio/db";
import {
  createProject,
  getProject,
  startJob,
  getJob,
  cancelJob,
} from "../src/studio/store";
import { executeDemo } from "../src/studio/demo";

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("/vidio_test"))
  throw new Error(
    "Set TEST_DATABASE_URL to the disposable vidio_test database; never run against user data.",
  );
process.env.DATABASE_URL = connection;
process.env.VIDIO_MODE = "demo";
const owner = `integration-${randomUUID()}`;
after(async () => {
  await database().query("DELETE FROM vidio_projects WHERE owner_id=$1", [
    owner,
  ]);
  await database().end();
});

test("durable owned projects/jobs enforce revisions, concurrency, idempotency and cancellation", async () => {
  await database().query(await readFile("migrations/0001_studio.sql", "utf8"));
  const project = await createProject(owner, {
    name: "Fixture",
    language: "english",
    ratio: "16:9",
  });
  assert.equal((await getProject(owner, project.id)).id, project.id);
  await assert.rejects(() => getProject("wrong-owner", project.id));
  await assert.rejects(() =>
    startJob(owner, "identify_product", {
      projectId: project.id,
      revision: 9,
      confirmed: false,
    }),
  );
  const input = {
    projectId: project.id,
    revision: 0,
    confirmed: false,
    idempotencyKey: randomUUID(),
  };
  const job = await startJob(owner, "identify_product", input);
  assert.equal((await startJob(owner, "identify_product", input)).id, job.id);
  await assert.rejects(() => startJob(owner, "draft_scripts", input));
  await assert.rejects(() =>
    startJob(owner, "identify_product", {
      ...input,
      idempotencyKey: randomUUID(),
    }),
  );
  await assert.rejects(() => getJob("wrong-owner", job.id));
  const recovered = await getProject(owner, project.id);
  assert.equal(recovered.activeJobId, job.id);
  await cancelJob(owner, job.id);
  await assert.rejects(
    () => executeDemo(owner, job.id, "identify_product", input, recovered),
    /cancelled/,
  );
});
