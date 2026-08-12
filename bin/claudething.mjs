#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);

function usage() {
  console.log(`ClaudeThing.ai host tools

Usage:
  claudething install [options]     Install or upgrade the host collector
  claudething uninstall [options]   Remove the host collector
  claudething doctor [options]      Check a USB-connected ClaudeThing display
  claudething version               Print the installed package version
  claudething help                  Show this help

The npm package installs the host-side software. It never flashes firmware.
Firmware images and the guarded flashing runbook are published at:
https://github.com/petehottelet/ClaudeThing/releases`);
}

async function runNode(script, scriptArgs) {
  const child = spawn(process.execPath, [script, ...scriptArgs], {
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(`Unable to start ClaudeThing: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

switch (command) {
  case undefined:
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  case "version":
  case "--version":
  case "-v": {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    console.log(manifest.version);
    break;
  }
  case "install":
    await runNode(resolve(packageRoot, "release/install/install.mjs"), args);
    break;
  case "uninstall":
    await runNode(resolve(packageRoot, "release/install/uninstall.mjs"), args);
    break;
  case "doctor":
    await runNode(resolve(packageRoot, "release/device/device-tool.mjs"), ["doctor", ...args]);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    usage();
    process.exitCode = 1;
}
