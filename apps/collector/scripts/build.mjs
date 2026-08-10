import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const dist = resolve(app, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [resolve(app, "src/index.ts")],
  outfile: resolve(dist, "collector.cjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  legalComments: "none",
});
await copyFile(
  resolve(app, "statusline/claude-statusline.mjs"),
  resolve(dist, "claude-statusline.mjs"),
);

console.log("collector: dist/collector.cjs + statusline hook");
