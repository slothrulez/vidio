import { config } from "dotenv";
import { readFile, readdir } from "node:fs/promises";
import { database, transaction } from "../src/studio/db";

config({ path: ".env.local", quiet: true });
async function main() {
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(4112028)");
    await client.query("CREATE TABLE IF NOT EXISTS vidio_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir("migrations")).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name)).sort()) {
      if ((await client.query("SELECT name FROM vidio_migrations WHERE name=$1", [name])).rows.length) continue;
      await client.query(await readFile(`migrations/${name}`, "utf8"));
      await client.query("INSERT INTO vidio_migrations(name) VALUES($1)", [name]);
    }
  });
  await database().end();
  console.log("vidio studio migrations applied");
}
main().catch(() => {
  console.error(
    "Studio migration failed; check database connectivity and privileges.",
  );
  process.exit(1);
});
