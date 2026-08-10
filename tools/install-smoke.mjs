#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (!new Set(["win32", "darwin"]).has(process.platform)) {
  console.log("install smoke: skipped (installer target is Windows/macOS)");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "release", "install", "install.mjs");
const temporary = await mkdtemp(path.join(os.tmpdir(), "carthing-install-smoke-"));
const installRoot = path.join(temporary, "installed");
const seed = path.join(temporary, "shared.token");
const wrongSeed = path.join(temporary, "wrong.token");
const fakeHome = path.join(temporary, "home");
const token = "install_smoke_shared_token_12345678901234567890";

function run(extra = []) {
  return spawnSync(
    process.execPath,
    [
      installer,
      "--install-root", installRoot,
      "--pairing-token-file", seed,
      "--host-name", "smoke-host",
      "--no-start",
      "--no-adb",
      ...extra,
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    },
  );
}

try {
  await mkdir(path.join(fakeHome, ".claude"), { recursive: true });
  await writeFile(
    path.join(fakeHome, ".claude", "settings.json"),
    `${JSON.stringify({ statusLine: { type: "command", command: "existing-status-command" } })}\n`,
    "utf8",
  );
  await writeFile(seed, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    wrongSeed,
    "install_smoke_different_token_123456789012345678\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const first = run();
  if (first.status !== 0) throw new Error(first.stderr || first.stdout || "installer failed");
  if (first.stdout.includes(token)) throw new Error("installer exposed the pairing token in routine output");
  if ((await readFile(path.join(installRoot, "pairing.token"), "utf8")).trim() !== token) {
    throw new Error("installer did not preserve the seeded pairing token");
  }
  await stat(path.join(installRoot, "collector", "collector.cjs"));
  await stat(path.join(installRoot, "device-ui", "index.html"));
  await stat(path.join(installRoot, "install-manifest.json"));
  const dashboardConfig = path.join(installRoot, "dashboard-config.jsonc");
  await stat(dashboardConfig);
  const dashboardCatalog = path.join(installRoot, "dashboard-config.catalog.jsonc");
  const firstCatalog = await readFile(dashboardCatalog, "utf8");
  if (!firstCatalog.includes('"id": "ibmbob"')) {
    throw new Error("installer did not publish the complete provider catalog");
  }
  const customizedConfig = (await readFile(dashboardConfig, "utf8")).replace(
    '"rotationSeconds": 10',
    '"rotationSeconds": 17',
  );
  await writeFile(dashboardConfig, customizedConfig, "utf8");
  const firstChain = JSON.parse(
    await readFile(path.join(installRoot, "collector", "statusline-chain.json"), "utf8"),
  );
  if (firstChain.command !== "existing-status-command") {
    throw new Error("installer did not preserve the existing Claude status line");
  }

  const second = run();
  if (second.status !== 0) throw new Error("idempotent reinstall failed");
  if (!(await readFile(dashboardConfig, "utf8")).includes('"rotationSeconds": 17')) {
    throw new Error("reinstall replaced the human-edited dashboard config");
  }
  if ((await readFile(dashboardCatalog, "utf8")) !== firstCatalog) {
    throw new Error("idempotent reinstall produced an inconsistent provider catalog");
  }
  const secondChain = JSON.parse(
    await readFile(path.join(installRoot, "collector", "statusline-chain.json"), "utf8"),
  );
  if (secondChain.command !== "existing-status-command") {
    throw new Error("reinstall lost the existing Claude status-line chain");
  }

  const mismatch = spawnSync(
    process.execPath,
    [
      installer,
      "--install-root", installRoot,
      "--pairing-token-file", wrongSeed,
      "--no-start",
      "--no-claude-statusline",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    },
  );
  if (mismatch.status === 0 || !mismatch.stderr.includes("does not match")) {
    throw new Error("installer did not reject a mismatched shared token");
  }
  if ((await readFile(path.join(installRoot, "pairing.token"), "utf8")).trim() !== token) {
    throw new Error("mismatch check changed the installed token");
  }
  console.log("install smoke: token sharing, dashboard-config preservation, staged copy, status-line preservation, idempotence, and mismatch refusal passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
