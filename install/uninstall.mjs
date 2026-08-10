#!/usr/bin/env node
import { homedir, platform } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function flags(argv) {
  const out = new Map();
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      out.set(item.slice(2), next);
      index++;
    } else {
      out.set(item.slice(2), "true");
    }
  }
  return out;
}

async function writeAtomic(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

const args = flags(process.argv.slice(2));
if (args.has("help")) {
  console.log("Usage: node uninstall.mjs [--install-root DIR] [--remove-firewall]");
  process.exit(0);
}
for (const key of args.keys()) {
  if (!["install-root", "remove-firewall"].includes(key)) {
    throw new Error(`Unknown uninstaller option: --${key}`);
  }
}

const system = platform();
if (system !== "win32" && system !== "darwin") {
  throw new Error("The guided uninstaller currently supports Windows and macOS.");
}
const installRoot = args.get("install-root")
  ? resolve(args.get("install-root"))
  : system === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CarThingCollector")
    : join(homedir(), "Library", "Application Support", "CarThingCollector");
if (installRoot === parse(installRoot).root || installRoot === resolve(homedir())) {
  throw new Error("Refusing an unsafe uninstall target.");
}

let manifest;
try {
  manifest = JSON.parse(await readFile(join(installRoot, "install-manifest.json"), "utf8"));
} catch {
  throw new Error(`No valid Car Thing install marker found at: ${installRoot}`);
}
if (manifest?.product !== "carthing-usage-dashboard" || manifest?.version !== 1) {
  throw new Error(`Install marker did not match this product: ${installRoot}`);
}

if (system === "win32") {
  const startup = join(
    process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CarThingCollector.vbs",
  );
  await rm(startup, { force: true });
} else {
  const plist = join(homedir(), "Library", "LaunchAgents", "com.carthing.collector.plist");
  try {
    await stat(plist);
    spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  } catch {
    // Service was not registered.
  }
  await rm(plist, { force: true });
}

// Restore only the statusLine field, and only if it still points at our hook.
// Other Claude settings edited after installation remain untouched.
const claudeSettings = join(homedir(), ".claude", "settings.json");
const backup = join(installRoot, "claude-settings.before-carthing.json");
try {
  const current = JSON.parse(await readFile(claudeSettings, "utf8"));
  const before = JSON.parse(await readFile(backup, "utf8"));
  const command = current?.statusLine?.command;
  const expectedHook = join(installRoot, "collector", "claude-statusline.mjs")
    .replaceAll("\\", "/")
    .toLowerCase();
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    typeof command === "string" &&
    command.replaceAll("\\", "/").toLowerCase().includes(expectedHook)
  ) {
    if (Object.prototype.hasOwnProperty.call(before, "statusLine")) current.statusLine = before.statusLine;
    else delete current.statusLine;
    await writeAtomic(claudeSettings, `${JSON.stringify(current, null, 2)}\n`);
  }
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    console.warn("Claude statusLine could not be restored automatically; settings were left untouched.");
  }
}

if (system === "win32" && args.has("remove-firewall")) {
  spawnSync(
    "netsh",
    ["advfirewall", "firewall", "delete", "rule", "name=Car Thing Collector"],
    { stdio: "inherit", windowsHide: true },
  );
}

await rm(installRoot, { recursive: true, force: true });
console.log(`Removed Car Thing Collector from ${installRoot}`);
if (system === "win32") {
  console.log("If the collector was running, sign out or restart Windows to end that in-memory process.");
}
