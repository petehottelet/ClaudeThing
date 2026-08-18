#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

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

const args = flags(process.argv.slice(2));
if (args.has("help")) {
  console.log("Usage: claudething authorize-claude [--install-root DIR]");
  process.exit(0);
}
for (const key of args.keys()) {
  if (!["help", "install-root"].includes(key)) throw new Error(`Unknown option: --${key}`);
}
if (platform() !== "darwin") {
  throw new Error("authorize-claude is needed only on macOS; other hosts use Claude's credential file directly.");
}

const installRoot = args.get("install-root")
  ? resolve(args.get("install-root"))
  : join(homedir(), "Library", "Application Support", "CarThingCollector");
const destination = join(installRoot, "claude-credentials.json");

const credential = await new Promise((resolvePromise, reject) => {
  execFile(
    "/usr/bin/security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(new Error("Claude Keychain authorization was not completed.")) : resolvePromise(stdout.trim()),
  );
});

let parsed;
try {
  parsed = JSON.parse(credential);
} catch {
  throw new Error("Claude's Keychain credential was not valid JSON; nothing was saved.");
}
const oauth = parsed && typeof parsed === "object" && !Array.isArray(parsed)
  ? (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object" ? parsed.claudeAiOauth : parsed)
  : null;
if (!oauth || typeof oauth.refreshToken !== "string" || oauth.refreshToken.length < 16) {
  throw new Error("Claude's Keychain item did not contain a reusable OAuth login; run `claude auth login` first.");
}

await mkdir(installRoot, { recursive: true, mode: 0o700 });
const temporary = `${destination}.tmp-${process.pid}`;
try {
  await writeFile(temporary, `${credential}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Claude authorization saved to ${destination}`);
console.log("Run `claudething install` to enable unattended Claude updates without Keychain prompts.");
