#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arguments_ = new Set(process.argv.slice(2));
const production = arguments_.has("--prod");
const skipApplication = arguments_.has("--skip-app-build");
const config = production
  ? "firmware/kas/claudething-prod.yml"
  : "firmware/kas/claudething.yml";
const buildConfig = process.platform === "darwin"
  ? `${config}:firmware/kas/low-memory.yml`
  : config;

/** Homebrew coreutils and pip --user scripts are intentionally not always
 * linked into a non-interactive macOS PATH. Discover their standard locations
 * so an installed prerequisite works from npm, LaunchAgents, and Codex alike. */
function augmentMacBuildPath() {
  if (process.platform !== "darwin") return;
  const candidates = [
    "/opt/homebrew/opt/coreutils/libexec/gnubin",
    "/usr/local/opt/coreutils/libexec/gnubin",
  ];
  const pythonRoot = join(os.homedir(), "Library", "Python");
  try {
    const versions = readdirSync(pythonRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    candidates.push(...versions.map((version) => join(pythonRoot, version, "bin")));
  } catch {
    // A pip user directory is optional; the normal PATH can still provide Kas.
  }
  const additions = candidates.filter((candidate) => existsSync(candidate));
  if (additions.length > 0) {
    process.env.PATH = [...additions, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
  }
}

augmentMacBuildPath();

for (const argument of arguments_) {
  if (!["--prod", "--skip-app-build"].includes(argument)) {
    throw new Error(`Unknown firmware build option: ${argument}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function available(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

if (!skipApplication) run("npm", ["run", "build", "-w", "apps/device-ui"]);
run(process.execPath, ["firmware/scripts/stage-ui.mjs"]);
run(process.execPath, ["firmware/scripts/verify.mjs"]);

if (!available("kas-container")) {
  throw new Error("kas-container is required. See firmware/README.md for host setup.");
}

if (process.platform === "darwin") {
  if (!available("docker")) throw new Error("Docker Desktop is required for a macOS Yocto build.");
  run("docker", ["info"], { stdio: "ignore" });
  run("docker", ["volume", "create", "claudething-yocto"], { stdio: "ignore" });
  run("kas-container", [
    "--runtime-args",
    "-e KAS_DOCKER_ROOTLESS=1 -e KAS_BUILD_DIR=/build/build -v claudething-yocto:/build",
    "build",
    buildConfig,
  ]);

  const deploy = resolve(repository, "firmware/build/deploy");
  await mkdir(deploy, { recursive: true });
  run("docker", [
    "run",
    "--rm",
    "-v", "claudething-yocto:/build:ro",
    "-v", `${deploy}:/out`,
    "alpine",
    "sh",
    "-c",
    "test -d /build/build/tmp/deploy && cp -R /build/build/tmp/deploy/. /out/",
  ]);
} else {
  run("kas-container", ["build", buildConfig]);
}

console.log(`ClaudeThing ${production ? "production" : "development"} firmware build complete.`);
