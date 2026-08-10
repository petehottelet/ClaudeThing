#!/usr/bin/env node
/**
 * Device deployment helper. Stock-firmware operations remain reboot-volatile.
 * The firmware provisioning command writes only ClaudeThing application state
 * after verifying that the device is already running the ClaudeThing distro.
 * This tool never writes a bootloader, partition table, kernel, or rootfs.
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEVICE_WEBAPP = "/usr/share/qt-superbird-app/webapp";
const DEVICE_STAGING = "/tmp/carthing-usage-dashboard";
const here = path.dirname(fileURLToPath(import.meta.url));

function parse(argv) {
  const command = argv[0] ?? "help";
  const flags = new Map();
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (!item?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(item.slice(2), next);
      index++;
    } else {
      flags.set(item.slice(2), "true");
    }
  }
  return { command, flags };
}

function adbArgs(flags, args) {
  const serial = flags.get("serial");
  return [...(serial ? ["-s", serial] : []), ...args];
}

function run(command, args, opts = {}) {
  if (opts.dryRun) {
    console.log([command, ...args].map((item) => JSON.stringify(item)).join(" "));
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || opts.allowFailure) resolve({ stdout, stderr, code });
      else reject(new Error(`${command} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function runAdb(flags, args, opts = {}) {
  const adb = flags.get("adb") ?? process.env.CARTHING_ADB ?? "adb";
  return run(adb, adbArgs(flags, args), { ...opts, dryRun: flags.has("dry-run") });
}

const REMOTE_STATUS_MARKER = "__CLAUDETHING_REMOTE_STATUS__=";

/**
 * Some ADB builds used by the device always return a successful host-side
 * status for `adb shell`, even when the remote command failed. Append an
 * explicit marker inside the remote shell and use that as the authoritative
 * status instead of trusting the ADB process exit code.
 */
async function runRemoteCheck(flags, command) {
  const script = `{ ${command}; }; claudething_status=$?; printf '${REMOTE_STATUS_MARKER}%s\\n' "$claudething_status"`;
  const result = await runAdb(flags, ["shell", script], { allowFailure: true });
  if (flags.has("dry-run")) return { ...result, code: 0 };

  const marker = new RegExp(`${REMOTE_STATUS_MARKER}(\\d+)`);
  const match = result.stdout.match(marker);
  return {
    ...result,
    stdout: result.stdout.replace(marker, "").trim(),
    code: match ? Number(match[1]) : (result.code || 255),
  };
}

async function ensureDevice(flags) {
  const result = await runAdb(flags, ["get-state"]);
  if (!flags.has("dry-run") && result.stdout.trim() !== "device") {
    throw new Error("ADB did not report a ready device.");
  }
}

function resolveTimeZone(flags) {
  const requested = flags.get("time-zone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (typeof requested !== "string" || requested.length < 1 || requested.length > 128) {
    throw new Error("--time-zone must be a valid IANA time-zone identifier.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: requested }).format(0);
  } catch {
    throw new Error(`Invalid IANA time zone: ${requested}`);
  }
  return requested;
}

function resolveDisplayName(flags, flag, fallback) {
  const value = (flags.get(flag) ?? fallback).trim();
  if (value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`--${flag} must be a 1–100 character display name without control characters.`);
  }
  return value;
}

async function hashTree(root) {
  const rows = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const digest = createHash("sha256").update(await readFile(full)).digest("hex");
        rows.push({ path: path.relative(root, full).replaceAll("\\", "/"), sha256: digest });
      }
    }
  }
  await visit(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

async function backup(flags) {
  const outputRaw = flags.get("output");
  if (!outputRaw) throw new Error("backup requires --output <new-directory>.");
  const output = path.resolve(outputRaw);
  try {
    await stat(output);
    throw new Error(`Refusing to overwrite existing backup path: ${output}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }
  await ensureDevice(flags);
  if (flags.has("dry-run")) {
    await runAdb(flags, ["pull", `${DEVICE_WEBAPP}/`, output]);
    return;
  }
  await mkdir(output, { recursive: false });
  const webapp = path.join(output, "stock-webapp");
  await runAdb(flags, ["pull", `${DEVICE_WEBAPP}/`, webapp]);
  const files = await hashTree(webapp);
  if (files.length === 0) throw new Error("Backup completed with zero files; deployment remains blocked.");
  await writeFile(
    path.join(output, "backup.json"),
    `${JSON.stringify({ version: 1, source: DEVICE_WEBAPP, createdAt: new Date().toISOString(), files }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(`Stock web app backed up and hashed: ${output}`);
}

async function deployTemporary(flags) {
  const backupDir = flags.get("backup-dir");
  const tokenFile = flags.get("token-file");
  if (!backupDir || !tokenFile) {
    throw new Error("deploy-temporary requires --backup-dir and --token-file.");
  }
  const marker = JSON.parse(await readFile(path.resolve(backupDir, "backup.json"), "utf8"));
  if (marker?.version !== 1 || marker?.source !== DEVICE_WEBAPP || !Array.isArray(marker.files) || marker.files.length === 0) {
    throw new Error("The backup marker is invalid; deployment is blocked.");
  }
  const token = (await readFile(path.resolve(tokenFile), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Pairing token must be 32–256 base64url characters.");
  const endpoints = (flags.get("endpoints") ?? "127.0.0.1:8790")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => {
      const match = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/.exec(value);
      const port = Number(match?.[2]);
      return Boolean(match) && Number.isInteger(port) && port >= 1 && port <= 65535;
    });
  if (endpoints.length === 0) throw new Error("No valid --endpoints were supplied.");
  const timeZone = resolveTimeZone(flags);
  const youtubeChannel = resolveDisplayName(flags, "youtube-channel", "YouTube Channel");
  const ga4Property = resolveDisplayName(flags, "ga4-property", "Website Analytics");
  const uiSource = path.resolve(flags.get("ui-dir") ?? path.join(here, "..", "device-ui"));
  await stat(path.join(uiSource, "index.html"));
  await ensureDevice(flags);
  const mounts = await runAdb(flags, ["shell", "cat", "/proc/mounts"]);
  if (!flags.has("dry-run") && mounts.stdout.includes(` ${DEVICE_WEBAPP} `)) {
    throw new Error("The dashboard is already mounted. Run rollback before deploying again.");
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), "carthing-device-ui-"));
  try {
    await cp(uiSource, staging, { recursive: true });
    await writeFile(
      path.join(staging, "runtime-config.js"),
      `window.__CARTHING_CONFIG__ = ${JSON.stringify({ endpoints, pairingToken: token, timeZone, youtubeChannel, ga4Property })};\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await runAdb(flags, ["shell", "rm", "-rf", DEVICE_STAGING]);
    await runAdb(flags, ["push", `${staging}${path.sep}.`, `${DEVICE_STAGING}/`]);
    await runAdb(flags, ["shell", "mount", "--bind", DEVICE_STAGING, DEVICE_WEBAPP]);
    await runAdb(flags, ["shell", "supervisorctl", "restart", "superbird"]);
    console.log("Temporary dashboard deployed. A reboot or `rollback` restores the stock web app.");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function rollback(flags) {
  await ensureDevice(flags);
  await runAdb(flags, ["shell", "umount", DEVICE_WEBAPP], { allowFailure: true });
  await runAdb(flags, ["shell", "supervisorctl", "restart", "superbird"]);
  console.log("Bind mount removed; the stock web app is active.");
}

async function tunnel(flags) {
  const port = Number(flags.get("port") ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535.");
  await ensureDevice(flags);
  await runAdb(flags, ["reverse", `tcp:${port}`, `tcp:${port}`]);
  console.log(`ADB reverse active: device localhost:${port} -> host localhost:${port}`);
}

async function provisionFirmware(flags) {
  const tokenFile = flags.get("token-file");
  if (!tokenFile) throw new Error("provision-firmware requires --token-file.");
  const token = (await readFile(path.resolve(tokenFile), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error("Pairing token must be 32–256 base64url characters.");
  }
  const endpoints = (flags.get("endpoints") ?? "127.0.0.1:8790")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => {
      const match = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/.exec(value);
      const port = Number(match?.[2]);
      return Boolean(match) && Number.isInteger(port) && port >= 1 && port <= 65535;
    });
  if (endpoints.length === 0) throw new Error("No valid --endpoints were supplied.");
  const timeZone = resolveTimeZone(flags);
  const youtubeChannel = resolveDisplayName(flags, "youtube-channel", "YouTube Channel");
  const ga4Property = resolveDisplayName(flags, "ga4-property", "Website Analytics");

  await ensureDevice(flags);
  const identity = await runRemoteCheck(flags, "grep -qx ID=claudething /etc/os-release");
  if (!flags.has("dry-run") && identity.code !== 0) {
    throw new Error("The connected device is not running ClaudeThing firmware; provisioning is blocked.");
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), "claudething-provision-"));
  const config = path.join(staging, "runtime-config.js");
  try {
    await writeFile(
      config,
      `window.__CARTHING_CONFIG__ = ${JSON.stringify({ endpoints, pairingToken: token, timeZone, youtubeChannel, ga4Property })};\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await runAdb(flags, ["push", config, "/tmp/claudething-runtime-config.js.new"]);
    await runAdb(flags, ["shell", "install", "-d", "-m", "0700", "/var/lib/claudething"]);
    await runAdb(flags, [
      "shell", "install", "-m", "0600",
      "/tmp/claudething-runtime-config.js.new",
      "/var/lib/claudething/runtime-config.js",
    ]);
    await runAdb(flags, ["shell", "rm", "-f", "/tmp/claudething-runtime-config.js.new"]);
    await runAdb(flags, ["shell", "sync"]);
    await runAdb(flags, ["reverse", "tcp:8790", "tcp:8790"]);
    await runAdb(flags, [
      "shell", "systemctl", "restart", "claudething-ui.service", "chromium-kiosk.service",
    ]);
    const ready = await runRemoteCheck(flags,
      "attempt=0; stable=0; " +
      "while [ \"$attempt\" -lt 30 ] && [ \"$stable\" -lt 3 ]; do " +
      "rm -f /tmp/claudething-health-index.html; " +
      "/bin/busybox wget -q -O /tmp/claudething-health-index.html http://127.0.0.1:8080/ 2>/dev/null; " +
      "if systemctl is-active --quiet claudething-ui.service chromium-kiosk.service " +
      "&& grep -q '<title>Usage Dashboard</title>' /tmp/claudething-health-index.html; " +
      "then stable=$((stable + 1)); else stable=0; fi; " +
      "attempt=$((attempt + 1)); [ \"$stable\" -ge 3 ] || sleep 0.5; done; " +
      "rm -f /tmp/claudething-health-index.html; [ \"$stable\" -ge 3 ]",
    );
    if (!flags.has("dry-run") && ready.code !== 0) {
      throw new Error("Firmware provisioning completed, but the dashboard did not become healthy. Run `doctor` for component checks.");
    }
    console.log(`ClaudeThing firmware paired, healthy, and using time zone ${timeZone}.`);
    console.log(`Dashboards configured for YouTube "${youtubeChannel}" and GA4 "${ga4Property}".`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function doctor(flags) {
  await ensureDevice(flags);
  const identity = await runRemoteCheck(flags, "grep -qx ID=claudething /etc/os-release");
  const firmware = flags.has("dry-run") || identity.code === 0;
  console.log(`device: ${firmware ? "ClaudeThing firmware" : "stock-compatible environment"}`);
  const checks = firmware
    ? [
        ["httpd applet", "/bin/busybox --list | grep -qx httpd"],
        ["display service", "systemctl is-active --quiet superbird-weston.service"],
        ["dashboard service", "systemctl is-active --quiet claudething-ui.service"],
        ["browser service", "systemctl is-active --quiet chromium-kiosk.service"],
        ["dashboard HTTP", "/bin/busybox wget -q -O - http://127.0.0.1:8080/ 2>/dev/null | grep -q '<title>Usage Dashboard</title>'"],
      ]
    : [
        ["webapp", `test -d ${DEVICE_WEBAPP}`],
        ["application supervisor", "supervisorctl status superbird >/dev/null"],
      ];
  let failed = false;
  for (const [name, command] of checks) {
    const result = await runRemoteCheck(flags, command);
    failed ||= result.code !== 0;
    console.log(`${name}: ${result.code === 0 ? "ok" : "failed"}`);
  }
  if (!flags.has("dry-run") && failed) process.exitCode = 1;
}

const { command, flags } = parse(process.argv.slice(2));
if (command === "doctor") await doctor(flags);
else if (command === "backup") await backup(flags);
else if (command === "deploy-temporary") await deployTemporary(flags);
else if (command === "rollback") await rollback(flags);
else if (command === "tunnel") await tunnel(flags);
else if (command === "provision-firmware") await provisionFirmware(flags);
else {
  console.log(`Usage:
  node device-tool.mjs doctor [--serial ID] [--dry-run]
  node device-tool.mjs backup --output DIR [--serial ID]
  node device-tool.mjs tunnel [--port 8790] [--serial ID]
  node device-tool.mjs provision-firmware --token-file FILE [--endpoints host:port,...] [--time-zone IANA] [--youtube-channel NAME] [--ga4-property NAME] [--serial ID]
  node device-tool.mjs deploy-temporary --backup-dir DIR --token-file FILE [--ui-dir DIR] [--endpoints host:port,...] [--time-zone IANA] [--youtube-channel NAME] [--ga4-property NAME]
  node device-tool.mjs rollback [--serial ID]

Firmware flashing is intentionally separate and requires the gates in firmware/README.md.`);
}
