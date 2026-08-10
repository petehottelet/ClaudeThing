#!/usr/bin/env node
/**
 * Cross-platform one-file setup orchestrator (macOS, Linux, Windows).
 *
 * Run: node setup/setup.mjs [--host-only] [--device-only] [--skip-verify]
 *                           [--yes] [--no-status] [--no-open]
 * Platform wrappers: mac/setup-carthing.command, windows/setup-carthing.cmd,
 * linux/setup-carthing.sh. Agents drive this file directly — see AGENTS.md.
 *
 * While it runs, a live status page (setup/status-server.mjs) shows step
 * states and firmware-backup progress at http://127.0.0.1:8799 — the thing
 * to watch, since the Car Thing's own screen is black for most of the
 * device phase.
 *
 * Phases (pausing before anything that touches the device):
 *   1. Prerequisites (per OS).
 *   2. Build and verify this repository's release payload.
 *   3. Install the host collector (reversible; uninstaller included).
 *   4. Device link: burn mode -> FULL firmware backup (hard gate) ->
 *      temporary ADB kernel -> stock-app backup -> temporary deploy.
 *
 * Licensing posture: the third-party USB flash utility and its Apache-2.0
 * dependency are downloaded at run time on the user's machine; nothing
 * third-party is redistributed with this repository.
 *
 * Windows note: burn-mode USB drivers are unreliable on Windows, so the
 * unlock/backup/ADB-kernel phase requires macOS or Linux. Windows fully
 * supports the host install and — once the device is already in ADB mode —
 * the backup/deploy phase.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  beginRun,
  disableStatus,
  failStatus,
  openInBrowser,
  startStatusServer,
  statusEvent,
  STATUS_URL,
} from "./status.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.platform; // darwin | linux | win32
const HOME = os.homedir();
const WORK_DIR = path.join(HOME, "CarThingDeploy");
const BACKUP_DIR = path.join(HOME, "CarThingBackups");
const SBT_DIR = path.join(WORK_DIR, "superbird-tool");
const VENV_DIR = path.join(WORK_DIR, "venv");
const SBT_REPO = "https://github.com/bishopdynamics/superbird-tool.git";
const PYAMLBOOT_PKG = "git+https://github.com/superna9999/pyamlboot";

const TOKEN_FILE =
  PLATFORM === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local"), "CarThingCollector", "pairing.token")
    : PLATFORM === "darwin"
      ? path.join(HOME, "Library", "Application Support", "CarThingCollector", "pairing.token")
      : path.join(HOME, ".config", "CarThingCollector", "pairing.token");

const args = new Set(process.argv.slice(2));
const HOST_ONLY = args.has("--host-only");
const DEVICE_ONLY = args.has("--device-only");
const SKIP_VERIFY = args.has("--skip-verify");
// --yes auto-acknowledges the informational pauses (banner, pairing-token
// note) and reuses a verified prior firmware backup without asking. It never
// skips the physical steps or the final is-it-on-the-screen check.
const YES = args.has("--yes");
const NO_STATUS = args.has("--no-status");
const NO_OPEN = args.has("--no-open");

if (args.has("--help") || args.has("-h")) {
  console.log(
    "Usage: node setup/setup.mjs [--host-only] [--device-only] [--skip-verify] [--yes] [--no-status] [--no-open]",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Small console helpers
// ---------------------------------------------------------------------------

function say(msg) {
  console.log(`\n\x1b[1m${msg}\x1b[0m`);
}
function info(msg) {
  console.log(`  ${msg}`);
}
function fail(msg) {
  failStatus(msg);
  console.error(`\n\x1b[31mSTOP: ${msg}\x1b[0m`);
  console.error("Nothing risky was done beyond this point. Re-run this setup safely at any time.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}
async function pause(msg) {
  await ask(`\n>>> ${msg} [press Enter to continue, Ctrl+C to abort] `);
}
// Informational pauses only — physical device gates never go through this.
async function ack(msg) {
  if (YES) {
    info(`(--yes) ${msg}`);
    return;
  }
  await pause(msg);
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: PLATFORM === "win32",
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return res.status === 0;
}
function runCapture(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    shell: PLATFORM === "win32",
    cwd: opts.cwd ?? REPO_ROOT,
  });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}
function has(cmd) {
  const probe = PLATFORM === "win32" ? ["where", [cmd]] : ["which", [cmd]];
  return spawnSync(probe[0], probe[1], { stdio: "ignore", shell: PLATFORM === "win32" }).status === 0;
}

function executablePath(cmd) {
  const probe = PLATFORM === "win32" ? ["where", [cmd]] : ["which", [cmd]];
  const res = runCapture(probe[0], probe[1]);
  return res.ok ? (res.out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null) : null;
}

function commandWithArgs(executable, ...commandArgs) {
  const quoted = /\s/.test(executable) ? `"${executable.replaceAll('"', '\\"')}"` : executable;
  return [quoted, ...commandArgs].join(" ");
}

function dirSizeKb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    return 0;
  }
  return Math.floor(total / 1024);
}

// Python interpreter inside our venv.
const VENV_PY =
  PLATFORM === "win32" ? path.join(VENV_DIR, "Scripts", "python.exe") : path.join(VENV_DIR, "bin", "python");
// On Linux, raw USB access typically needs root. On macOS, caffeinate keeps
// the machine awake through the multi-hour firmware dump (lid must stay open).
const PY_PREFIX =
  PLATFORM === "linux" ? ["sudo", VENV_PY] : PLATFORM === "darwin" ? ["caffeinate", "-i", VENV_PY] : [VENV_PY];

function sbt(toolArgs) {
  const [head, ...rest] = PY_PREFIX;
  return run(head, [...rest, "superbird_tool.py", ...toolArgs], { cwd: SBT_DIR });
}
function sbtCapture(toolArgs) {
  const [head, ...rest] = PY_PREFIX;
  return runCapture(head, [...rest, "superbird_tool.py", ...toolArgs], { cwd: SBT_DIR });
}

// ---------------------------------------------------------------------------
// Phase 1 — prerequisites
// ---------------------------------------------------------------------------

async function phasePrereqs() {
  statusEvent("prereqs", "start");
  say("[1/4] Checking prerequisites");
  if (PLATFORM === "darwin") {
    if (!has("brew")) {
      info("Homebrew is missing. Install it from https://brew.sh, then re-run this setup.");
      fail("Homebrew required on macOS.");
    }
    for (const pkg of ["python3", "libusb", "android-platform-tools"]) {
      const check = runCapture("brew", ["list", pkg]);
      if (!check.ok) {
        info(`Installing ${pkg}…`);
        if (!run("brew", ["install", pkg])) fail(`Could not install ${pkg} with Homebrew.`);
      }
    }
  } else if (PLATFORM === "linux") {
    const missing = [];
    if (!has("python3")) missing.push("python3 python3-venv");
    if (!has("adb")) missing.push("adb (package: android-tools-adb or android-tools)");
    if (!has("git")) missing.push("git");
    if (missing.length > 0) {
      info("Missing packages: " + missing.join(", "));
      info("Install them with your package manager, e.g.:");
      info("  sudo apt-get install -y python3 python3-venv libusb-1.0-0 android-tools-adb git");
      fail("Install the packages above, then re-run this setup.");
    }
  } else {
    // Windows: host phase needs nothing extra; device phase needs adb only.
    if (!has("adb") && !HOST_ONLY) {
      info("adb is not installed. Installing via winget…");
      if (!run("winget", ["install", "--id", "Google.PlatformTools", "-e", "--silent"])) {
        info("Could not install adb automatically. Install 'Google.PlatformTools' via winget and re-run.");
      }
    }
  }
  if (!has("git")) fail("git is required and was not found on PATH.");
  info("Prerequisites OK.");
  statusEvent("prereqs", "done");
}

// ---------------------------------------------------------------------------
// Phase 2 — build the release
// ---------------------------------------------------------------------------

async function phaseBuild() {
  statusEvent("build", "start");
  say("[2/4] Building and verifying the release payload");
  const marker = path.join(REPO_ROOT, "release", "install", "install.mjs");
  if (existsSync(marker) && SKIP_VERIFY) {
    info("release/ present and --skip-verify set — skipping rebuild.");
    statusEvent("build", "skip", "release/ present, --skip-verify");
    return;
  }
  if (!run("npm", ["install"])) fail("npm install failed.");
  if (!run("npm", ["run", "verify"])) fail("Verification failed — the payload is not certified.");
  statusEvent("build", "done");
}

// ---------------------------------------------------------------------------
// Phase 3 — host collector
// ---------------------------------------------------------------------------

async function phaseHost() {
  statusEvent("host", "start");
  say("[3/4] Installing the host collector on this machine");
  if (existsSync(TOKEN_FILE)) {
    info("Existing pairing token found — keeping it.");
  } else {
    info("No pairing token on this machine yet.");
    info("If another computer already runs the collector and should feed the same");
    info(`device, copy its pairing.token to: ${TOKEN_FILE}`);
    await ack("Press Enter to continue (a new token is created if none was copied)");
  }
  const hostName = PLATFORM === "darwin" ? "mac" : PLATFORM === "win32" ? "pc" : "linux";
  const installArgs = [path.join("release", "install", "install.mjs"), "--host-name", hostName];
  const adbPath = executablePath("adb");
  if (adbPath) installArgs.push("--adb-command", adbPath);
  const codexPath = executablePath("codex");
  if (codexPath) installArgs.push("--codex-command", commandWithArgs(codexPath, "app-server"));
  if (!run("node", installArgs)) {
    fail("Host installation failed.");
  }
  info("Collector installed and running. It starts automatically at login.");
  statusEvent("host", "done");
}

// ---------------------------------------------------------------------------
// Phase 4 — device link
// ---------------------------------------------------------------------------

async function ensureFlashTool() {
  mkdirSync(WORK_DIR, { recursive: true });
  if (!existsSync(SBT_DIR)) {
    info("Downloading the Car Thing USB flash utility…");
    if (!run("git", ["clone", SBT_REPO, SBT_DIR])) fail("Could not download the USB flash utility.");
  }
  if (!existsSync(VENV_PY)) {
    if (!run("python3", ["-m", "venv", VENV_DIR]) && !run("python", ["-m", "venv", VENV_DIR])) {
      fail("Could not create a Python environment.");
    }
  }
  run(VENV_PY, ["-m", "pip", "-q", "install", "--upgrade", "pip"]);
  if (!run(VENV_PY, ["-m", "pip", "-q", "install", PYAMLBOOT_PKG])) {
    fail("Could not install the USB protocol library (pyamlboot).");
  }
}

/**
 * The device has three distinct USB states with different capabilities
 * (learned the hard way — see AGENTS.md):
 *   "usb"  — "USB Mode (buttons 1 & 4 held at boot)": good for the firmware
 *            dump, but --boot_adb_kernel FAILS from here (superbird-tool
 *            caveat: it only works from a burn mode the device entered on
 *            its own at boot).
 *   "burn" — "USB Burn Mode (ready for commands)": the state after
 *            --enable_burn_mode + a plain replug. The ADB kernel boots from
 *            here in ~10 s. (After a FAILED command this same string can
 *            describe a wedged session — only a device-end power cycle
 *            clears it.)
 *   "not-ready" — a half-initialized session from an earlier failure;
 *            power-cycle at the device end.
 */
function deviceUsbState() {
  const res = sbtCapture(["--find_device"]);
  const out = res.out ?? "";
  if (/usb burn mode/i.test(out)) return "burn";
  if (/usb mode/i.test(out)) return "usb";
  if (/not ready/i.test(out)) return "not-ready";
  return "none";
}

async function waitForUsbState(wanted, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const state = deviceUsbState();
    if (wanted.includes(state)) return state;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function adbDeviceReady() {
  const res = runCapture("adb", ["devices"]);
  if (!res.ok) return false;
  return res.out.split("\n").some((l) => /^\S+\s+device$/.test(l.trim()));
}

async function phaseDevice() {
  say("[4/4] Device link");

  // If the device is already reachable over ADB (e.g. unlocked earlier, or
  // from another machine), skip straight to backup + deploy — this is the
  // path that also works on Windows.
  if (has("adb") && adbDeviceReady()) {
    info("A device is already visible on ADB — skipping the unlock steps.");
    for (const id of ["burn", "backup", "verify", "burnenv", "adb"]) {
      statusEvent(id, "skip", "device already on ADB");
    }
  } else if (PLATFORM === "win32") {
    say("Windows cannot perform the burn-mode unlock (unreliable USB drivers).");
    info("Run this setup once on a Mac or Linux machine to unlock and back up the");
    info("device. After that, this Windows machine can deploy whenever the device");
    info("is in ADB mode. Host installation is complete; stopping here.");
    statusEvent("burn", "info", "burn-mode unlock requires macOS or Linux; stopped after host install");
    return;
  } else {
    await ensureFlashTool();

    statusEvent("burn", "start");
    say("Putting the Car Thing into USB mode");
    info("  a. Unplug the USB cable AT THE CAR THING end (a port swap is not a power cycle).");
    info("  b. Hold preset buttons 1 AND 4 — the outer two of the four grouped buttons.");
    info("  c. While holding both, plug USB back in: direct port, no hub, and a cable");
    info("     you know carries data. Keep holding ~3 seconds, then release.");
    info("  d. The screen stays BLACK — that is normal. 'use adapter' or any picture");
    info("     means the hold did not take: unplug at the device end and redo it.");
    info("Watching for the device (up to 3 minutes; do the steps above now)…");
    const entryState = await waitForUsbState(["usb", "burn"], 180);
    if (!entryState) {
      fail(
        "Could not find the Car Thing on USB. A black screen with nothing detected " +
          "usually means a charge-only cable — use one that has synced data before. " +
          "Unplug at the device end, count to five, redo the button hold, and re-run.",
      );
    }
    statusEvent("burn", "done", entryState === "burn" ? "device boots straight to burn mode" : "device in USB mode");
    say("Device detected.");

    // FULL BACKUP — hard gate.
    statusEvent("backup", "start");
    say("Full firmware backup (your factory-restore copy)");
    mkdirSync(BACKUP_DIR, { recursive: true });
    let dumpDir = null;
    for (const entry of readdirSync(BACKUP_DIR)) {
      const p = path.join(BACKUP_DIR, entry);
      if (entry.startsWith("full-dump-") && statSync(p).isDirectory() && dirSizeKb(p) >= 3_000_000) {
        dumpDir = p;
      }
    }
    if (dumpDir && !YES) {
      const reuse = await ask(`>>> Previous full backup found (${dumpDir}). Reuse it? [Y/n] `);
      if (reuse.trim().toLowerCase() === "n") dumpDir = null;
    }
    if (dumpDir) {
      statusEvent("backup", "info", dumpDir);
      statusEvent("backup", "skip", `reusing ${path.basename(dumpDir)}`);
      info(`Reusing the verified backup at ${dumpDir}.`);
    } else {
      dumpDir = path.join(BACKUP_DIR, `full-dump-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`);
      statusEvent("backup", "info", dumpDir);
      info(`Writing to: ${dumpDir}`);
      info("Measured reality: ~310 KB/s over this link, ~3.6 GB total — expect the");
      info(`dump to take 3 to 3.5 HOURS. Watch it at ${STATUS_URL}`);
      info("Do not unplug the device.");
      if (PLATFORM === "darwin") info("caffeinate keeps this Mac awake, but only while the lid is open.");
      if (!sbt(["--dump_device", dumpDir])) {
        // A partial dump can never be used for a restore; clearing it keeps
        // the reuse scan honest on the next run.
        if (dirSizeKb(dumpDir) < 3_000_000) {
          rmSync(dumpDir, { recursive: true, force: true });
          info("Removed the incomplete dump folder.");
        }
        fail(
          "Firmware dump FAILED. No changes were made to the device. A wedged " +
            "burn-mode session survives port swaps — unplug at the DEVICE end, " +
            "count to five, redo the button hold, then re-run this setup.",
        );
      }
      statusEvent("backup", "done");
    }

    statusEvent("verify", "start");
    const sizeKb = dirSizeKb(dumpDir);
    if (sizeKb < 3_000_000) {
      fail(
        `The dump looks too small (${Math.floor(sizeKb / 1024)} MB; a real dump is ~3.6 GB). ` +
          "Treat it as failed: power-cycle the device at its end and re-run.",
      );
    }
    statusEvent("verify", "done", `${Math.floor(sizeKb / 1024)} MB`);
    say(`Full backup OK (${Math.floor(sizeKb / 1024)} MB).`);
    info(`Factory restore, if ever needed: superbird_tool.py --restore_device "${dumpDir}"`);

    // --boot_adb_kernel only works from a burn mode the device entered on its
    // own at boot (superbird-tool caveat) — never from the button-hold state.
    // --enable_burn_mode sets a reversible u-boot flag so a plain replug
    // lands there; --disable_burn_mode undoes it.
    statusEvent("burnenv", "start");
    if (entryState === "burn") {
      statusEvent("burnenv", "skip", "device already boots to burn mode");
      info("Device already boots to burn mode — no replug needed.");
    } else {
      say("Arming burn mode (reversible) for the ADB kernel boot");
      if (!sbt(["--enable_burn_mode"])) {
        fail("Could not arm burn mode. Power-cycle the device at its end and re-run.");
      }
      info("Now a PLAIN replug — no buttons this time:");
      info("  Unplug the cable at the Car Thing, count to five, plug it back in.");
      info("  A frozen Spotify logo on the screen is NORMAL in this state.");
      info("Watching for burn mode (up to 3 minutes)…");
      if (!(await waitForUsbState(["burn"], 180))) {
        fail("Device did not come back in burn mode. Replug it (no buttons) and re-run.");
      }
      statusEvent("burnenv", "done");
      info("Burn mode armed. To boot the stock interface again later, run");
      info(`--disable_burn_mode from ${SBT_DIR}.`);
    }

    // Temporary ADB kernel — loaded into memory; nothing persistent is written.
    statusEvent("adb", "start");
    say("Booting the temporary ADB kernel");
    if (!sbt(["--boot_adb_kernel", "A"])) {
      // The device leaves burn mode before the tool hears a reply, so the
      // exit status can be a false negative. ADB enumeration is the truth.
      info("The boot command reported failure — checking ADB anyway (often a false negative).");
    }
    info("Waiting for the device on ADB (up to 2 minutes)…");
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      up = adbDeviceReady();
    }
    if (!up) {
      fail(
        "Device never appeared on ADB. Replug it (no buttons — burn mode is armed) " +
          "and re-run; from the right state this boots in about 10 seconds.",
      );
    }
    statusEvent("adb", "done");
    say("ADB is up.");
  }

  // Backup stock app (enforced) and deploy — works on every OS.
  statusEvent("stock", "start");
  say("Backing up the stock app and deploying the dashboard");
  const deviceTool = path.join("release", "device", "device-tool.mjs");
  if (!run("node", [deviceTool, "doctor"])) fail("Device doctor check failed — see output above.");
  const webappBackup = path.join(BACKUP_DIR, "stock-webapp");
  if (existsSync(path.join(webappBackup, "backup.json"))) {
    info(`Reusing the existing stock web app backup at ${webappBackup}.`);
    statusEvent("stock", "skip", "reusing existing stock backup");
  } else {
    if (!run("node", [deviceTool, "backup", "--output", webappBackup])) {
      fail("Stock web app backup failed. Deployment is blocked without it.");
    }
    statusEvent("stock", "done");
  }
  if (!run("node", [deviceTool, "tunnel"])) {
    fail("Could not establish the ADB reverse tunnel to the host collector.");
  }
  statusEvent("deploy", "start");
  if (
    !run("node", [
      deviceTool,
      "deploy-temporary",
      "--backup-dir",
      webappBackup,
      "--token-file",
      TOKEN_FILE,
      "--ui-dir",
      path.join("release", "device-ui"),
      "--endpoints",
      "127.0.0.1:8790",
    ])
  ) {
    fail("Deployment failed. The device is unchanged after a reboot.");
  }
  statusEvent("deploy", "done");

  // The tool reporting success is not the same as pixels on the screen —
  // only a human can close that loop.
  statusEvent("live", "start");
  say("The device tool reports the dashboard deployed.");
  const seen = await ask(">>> Look at the Car Thing: is the usage dashboard on its screen? [y/N] ");
  if (seen.trim().toLowerCase().startsWith("y")) {
    statusEvent("live", "done");
    say("Done — the usage dashboard is live on the Car Thing.");
  } else {
    statusEvent(
      "live",
      "error",
      "deploy reported success but the screen did not show the dashboard — see the failure playbook in AGENTS.md",
    );
    info("Deploy reported success but the screen disagrees. The device is safe (a");
    info("reboot restores stock). Known causes and fixes: AGENTS.md, 'Deployed but");
    info("not rendering'.");
  }
  info("Undo: node release/device/device-tool.mjs rollback   (or just reboot the device)");
  info("After a power cycle the device returns to stock; re-run this setup —");
  info("completed steps (backups, installs) are detected and skipped.");
}

// ---------------------------------------------------------------------------

(async () => {
  say("Car Thing AI Usage Dashboard — setup");
  info(`Platform:   ${PLATFORM === "darwin" ? "macOS" : PLATFORM === "win32" ? "Windows" : "Linux"}`);
  info(`Repository: ${REPO_ROOT}`);
  info(`Backups:    ${BACKUP_DIR}  (keep this folder safe — it is your undo)`);
  if (NO_STATUS) {
    disableStatus();
  } else {
    beginRun(`${PLATFORM}${HOST_ONLY ? " host-only" : DEVICE_ONLY ? " device-only" : ""}`);
    const url = await startStatusServer();
    info(`Status page: ${url}  (live progress — the device's own screen stays black`);
    info("during the device steps; this page is the thing to watch)");
    if (!NO_OPEN && process.stdout.isTTY) openInBrowser(url);
  }
  if (!DEVICE_ONLY) await ack("This installs prerequisites and the host collector, then guides the device steps.");

  if (!DEVICE_ONLY) {
    await phasePrereqs();
    await phaseBuild();
    await phaseHost();
  }
  if (!HOST_ONLY) await phaseDevice();

  rl.close();
})().catch((err) => {
  fail(err?.message ?? String(err));
});
