import { build } from "esbuild";
import { spawnSync } from "node:child_process";
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

if (process.platform === "darwin") {
  const helperSource = resolve(app, "..", "..", "host", "macos", "claudething-bluetooth-helper.m");
  const helperInfo = resolve(app, "..", "..", "host", "macos", "Info.plist");
  const helperOutput = resolve(dist, "claudething-bluetooth-helper");
  const compiled = spawnSync("xcrun", [
    "clang",
    "-fobjc-arc",
    "-mmacosx-version-min=13.0",
    "-arch", "arm64",
    "-arch", "x86_64",
    "-framework", "Foundation",
    "-framework", "IOBluetooth",
    `-Wl,-sectcreate,__TEXT,__info_plist,${helperInfo}`,
    helperSource,
    "-o", helperOutput,
  ], { encoding: "utf8" });
  if (compiled.status !== 0) {
    throw new Error(`Unable to build the macOS Bluetooth helper:\n${compiled.stderr}`);
  }
  const signed = spawnSync("codesign", [
    "--force",
    "--sign", "-",
    "--identifier", "ai.claudething.bluetooth-helper",
    helperOutput,
  ], { encoding: "utf8" });
  if (signed.status !== 0) {
    throw new Error(`Unable to ad-hoc sign the macOS Bluetooth helper:\n${signed.stderr}`);
  }
}

console.log(
  "collector: dist/collector.cjs + statusline hook" +
  (process.platform === "darwin" ? " + universal macOS Bluetooth helper" : ""),
);
