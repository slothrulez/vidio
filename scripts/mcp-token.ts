import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { issueLocalMcpToken } from "../src/studio/mcp-auth";

config({ path: ".env.local", quiet: true });
async function main() {
  const directory = path.join(process.cwd(), ".vidio");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "mcp-token"), await issueLocalMcpToken(), {
    flag: "wx", mode: 0o600,
  });
  console.log("Created an ignored private .vidio/mcp-token file, valid for 15 minutes. Existing files are never overwritten.");
}
main().catch(() => {
  console.error("Could not issue a local token: check demo authentication configuration and remove an expired token file before retrying.");
  process.exitCode = 1;
});
