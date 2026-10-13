import { build } from "tsup";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

await mkdir(".vidio", { recursive: true });
await build({
  entry: { widget: "src/chatgpt/index.tsx" },
  outDir: ".vidio/widget",
  format: ["iife"],
  platform: "browser",
  bundle: true,
  minify: true,
  clean: true,
  splitting: false,
  define: { "process.env.NODE_ENV": '"production"' },
  noExternal: [/.*/],
});
const cssPath = path.resolve("src/app/globals.css");
const css = (
  await postcss([tailwind({ base: process.cwd() })]).process(
    await readFile(cssPath, "utf8"),
    { from: cssPath },
  )
).css;
const js = await readFile(".vidio/widget/widget.global.js", "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>vidio studio</title><style>${css.replaceAll("</style", "<\\/style")}</style></head><body><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await writeFile(".vidio/widget.html", html);
console.log("vidio MCP Apps resource built");
