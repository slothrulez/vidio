import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { database } from "../src/studio/db";

config({ path: ".env.local", quiet: true });
async function main() {
  await database().query(await readFile("migrations/0001_studio.sql", "utf8"));
  await database().end();
  console.log("vidio studio migrations applied");
}
main().catch(() => {
  console.error(
    "Studio migration failed; check database connectivity and privileges.",
  );
  process.exit(1);
});
