#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, homedir, hostname, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, "..");

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

async function exists(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function quoteCmd(value) {
  if (!/[\s"]/.test(value)) return value;
  const escaped = value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

function localAddresses() {
  const values = [];
  for (const rows of Object.values(networkInterfaces())) {
    for (const row of rows ?? []) {
      if (row.family === "IPv4" && !row.internal) values.push(row.address);
    }
  }
  return [...new Set(values)];
}

function discoverCommand(system, name) {
  const lookup = system === "win32" ? "where.exe" : "/usr/bin/which";
  const result = spawnSync(lookup, [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
}

async function writeAtomic(file, value, mode) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode });
  await rename(temporary, file);
}

const args = flags(process.argv.slice(2));
const allowedFlags = new Set([
  "help",
  "port",
  "host-name",
  "peer",
  "peer-host",
  "pairing-token-file",
  "show-pairing-url",
  "install-root",
  "no-start",
  "no-claude-statusline",
  "configure-firewall",
  "no-adb",
  "adb-command",
  "adb-serial",
  "no-codex-appserver",
  "codex-command",
  "dashboard-config",
]);
if (args.has("help")) {
  console.log(`Usage: node install.mjs [options]

  --host-name NAME             stable label for this computer
  --port PORT                  collector port (default 8790)
  --peer URL --peer-host NAME  synchronize a second collector
  --pairing-token-file FILE    seed the shared token from another host
  --show-pairing-url           print a secret-bearing browser pairing URL
  --configure-firewall         add a Windows private-network inbound rule
  --no-adb                     disable automatic USB tunnel recovery
  --adb-command FILE           custom ADB executable (auto-detected when available)
  --adb-serial ID              select one ADB device
  --no-codex-appserver         disable Codex quota-window collection
  --codex-command COMMAND      override the Codex app-server command
                               (macOS auto-detects ChatGPT's bundled binary)
  --dashboard-config FILE      human-editable JSONC display preferences
  --no-claude-statusline       preserve Claude settings without installing the hook
  --no-start                   do not register or launch the collector
  --install-root DIR           override the per-user install directory`);
  process.exit(0);
}
for (const key of args.keys()) {
  if (!allowedFlags.has(key)) throw new Error(`Unknown installer option: --${key}`);
}
const system = platform();
if (system !== "win32" && system !== "darwin") {
  throw new Error("The guided installer currently supports Windows and macOS.");
}

const port = Number(args.get("port") ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535.");
const hostName = args.get("host-name") ?? hostname();
if (!/^[A-Za-z0-9._-]{1,64}$/.test(hostName)) throw new Error("--host-name contains unsupported characters.");
const peer = args.get("peer") ?? null;
const peerHost = args.get("peer-host") ?? null;
if (peer && !peerHost) throw new Error("--peer-host is required with --peer so missing-host totals are labeled from first boot.");
if (peer) {
  const parsed = new URL(peer);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("--peer must be an http(s) URL without embedded credentials.");
  }
}

const collectorSource = (await exists(join(sourceRoot, "collector")))
  ? join(sourceRoot, "collector")
  : join(sourceRoot, "apps", "collector", "dist");
const uiSource = (await exists(join(sourceRoot, "device-ui")))
  ? join(sourceRoot, "device-ui")
  : join(sourceRoot, "apps", "device-ui", "dist");
if (!(await exists(collectorSource)) || !(await exists(uiSource))) {
  throw new Error("Build artifacts are missing. Run `npm run package` first.");
}

const claudeSettings = join(homedir(), ".claude", "settings.json");
let settings = {};
if (!args.has("no-claude-statusline")) {
  try {
    const rawSettings = await readFile(claudeSettings, "utf8");
    try {
      settings = JSON.parse(rawSettings);
    } catch {
      throw new Error(`Claude settings are not valid JSON; refusing to replace them: ${claudeSettings}`);
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Claude settings must contain a JSON object: ${claudeSettings}`);
  }
}

const installRoot = args.get("install-root")
  ? resolve(args.get("install-root"))
  : system === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CarThingCollector")
    : join(homedir(), "Library", "Application Support", "CarThingCollector");
const collectorDir = join(installRoot, "collector");
const uiDir = join(installRoot, "device-ui");
const tokenFile = join(installRoot, "pairing.token");
const dashboardConfigFile = args.get("dashboard-config")
  ? resolve(args.get("dashboard-config"))
  : join(installRoot, "dashboard-config.jsonc");
const providerDirectory = join(dirname(dashboardConfigFile), "providers");
const dashboardCatalogFile = join(dirname(dashboardConfigFile), "dashboard-config.catalog.jsonc");
const installManifestFile = join(installRoot, "install-manifest.json");
let previousInstallManifest = {};
try {
  const parsed = JSON.parse(await readFile(installManifestFile, "utf8"));
  if (parsed?.product === "carthing-usage-dashboard" && parsed.version === 1) previousInstallManifest = parsed;
} catch {
  // First install or an invalid legacy manifest that should not influence it.
}
const pairingTokenFile = args.get("pairing-token-file")
  ? resolve(args.get("pairing-token-file"))
  : null;
await mkdir(installRoot, { recursive: true, mode: 0o700 });
await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
const dashboardTemplate = await readFile(join(here, "dashboard-config.example.jsonc"), "utf8");
// Keep the human-edited config untouched while publishing the newest complete
// commented catalog beside it on every install and upgrade.
await writeAtomic(dashboardCatalogFile, dashboardTemplate, 0o600);
try {
  await stat(dashboardConfigFile);
} catch {
  await mkdir(dirname(dashboardConfigFile), { recursive: true, mode: 0o700 });
  await writeAtomic(
    dashboardConfigFile,
    dashboardTemplate,
    0o600,
  );
}

let preservedStatuslineChain = null;
try {
  const candidate = JSON.parse(
    await readFile(join(collectorDir, "statusline-chain.json"), "utf8"),
  );
  if (candidate?.version === 1 && typeof candidate.command === "string") {
    preservedStatuslineChain = candidate;
  }
} catch {
  // First install, no prior chain, or an invalid chain that should not survive.
}

let token;
let existingToken = false;
try {
  token = (await readFile(tokenFile, "utf8")).trim();
  existingToken = true;
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    throw new Error(`Unable to read existing pairing token: ${tokenFile}`);
  }
  if (pairingTokenFile) {
    try {
      token = (await readFile(pairingTokenFile, "utf8")).trim();
    } catch {
      throw new Error(`Unable to read --pairing-token-file: ${pairingTokenFile}`);
    }
  } else {
    token = randomBytes(32).toString("base64url");
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error(`Invalid pairing token in seed file: ${pairingTokenFile}`);
  }
  await writeAtomic(tokenFile, `${token}\n`, 0o600);
}
if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error(`Invalid pairing token: ${tokenFile}`);
if (existingToken && pairingTokenFile) {
  let suppliedToken;
  try {
    suppliedToken = (await readFile(pairingTokenFile, "utf8")).trim();
  } catch {
    throw new Error(`Unable to read --pairing-token-file: ${pairingTokenFile}`);
  }
  if (suppliedToken !== token) {
    throw new Error("The installed pairing token does not match --pairing-token-file. Refusing to break existing device pairing.");
  }
}

// Stage both payloads before replacing a working install. A failed copy can
// leave a harmless `.new` directory, but never a half-populated live path.
const collectorStaging = `${collectorDir}.new`;
const uiStaging = `${uiDir}.new`;
await rm(collectorStaging, { recursive: true, force: true });
await rm(uiStaging, { recursive: true, force: true });
try {
  await cp(collectorSource, collectorStaging, { recursive: true });
  await cp(uiSource, uiStaging, { recursive: true });
  // Stamp the host's IANA time zone over the checked-in default so browsers
  // served by the collector (including a bridged device kiosk) render clocks
  // and "Today" buckets in this machine's zone rather than falling back to
  // their own. Endpoints stay empty (same-origin fallback) and the pairing
  // token stays null: this file is served without authentication.
  const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await writeAtomic(
    join(uiStaging, "runtime-config.js"),
    `// Generated by the installer. Keep secrets out of this unauthenticated file.\n` +
      `window.__CARTHING_CONFIG__ = { endpoints: [], pairingToken: null, timeZone: ${JSON.stringify(hostTimeZone)}, youtubeChannel: "YouTube Channel", ga4Property: "Website Analytics" };\n`,
    0o644,
  );
  await rm(collectorDir, { recursive: true, force: true });
  await rename(collectorStaging, collectorDir);
  await rm(uiDir, { recursive: true, force: true });
  await rename(uiStaging, uiDir);
} catch (error) {
  await rm(collectorStaging, { recursive: true, force: true });
  await rm(uiStaging, { recursive: true, force: true });
  throw error;
}

if (system === "win32") {
  const acl = spawnSync("icacls", [tokenFile, "/inheritance:r", "/grant:r", `${userInfo().username}:(F)`], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (acl.status !== 0) console.warn(`Could not restrict pairing-token ACL: ${tokenFile}`);
}

const collectorArgs = [
  join(collectorDir, "collector.cjs"),
  "--token-file", tokenFile,
  "--ui-dir", uiDir,
  "--host-name", hostName,
  "--port", String(port),
  "--dashboard-config", dashboardConfigFile,
  "--provider-dir", providerDirectory,
];
if (peer) collectorArgs.push("--peer", peer, "--peer-host", peerHost);
if (args.has("no-adb")) collectorArgs.push("--no-adb");
const adbCommand = args.get("adb-command")
  ?? (typeof previousInstallManifest.adbCommand === "string" ? previousInstallManifest.adbCommand : null)
  ?? discoverCommand(system, "adb");
const adbSerial = args.get("adb-serial")
  ?? (typeof previousInstallManifest.adbSerial === "string" ? previousInstallManifest.adbSerial : null);
if (adbCommand) collectorArgs.push("--adb-command", adbCommand);
if (adbSerial) collectorArgs.push("--adb-serial", adbSerial);
if (args.has("no-codex-appserver")) collectorArgs.push("--no-codex-appserver");
let codexCommand = args.get("codex-command") ?? null;
if (!codexCommand && !args.has("no-codex-appserver") && system === "darwin") {
  const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  try {
    if ((await stat(bundledCodex)).isFile()) codexCommand = `${bundledCodex} app-server`;
  } catch {
    // The collector's normal `codex app-server` fallback remains available.
  }
}
if (codexCommand) collectorArgs.push("--codex-command", codexCommand);
await writeAtomic(
  join(collectorDir, "collector-config.json"),
  `${JSON.stringify({ version: 1, port, tokenFile }, null, 2)}\n`,
  0o600,
);
await writeAtomic(
  installManifestFile,
  `${JSON.stringify({ product: "carthing-usage-dashboard", version: 1, hostName, port, adbCommand, adbSerial }, null, 2)}\n`,
  0o600,
);

if (!args.has("no-claude-statusline")) {
  await mkdir(dirname(claudeSettings), { recursive: true });
  const prior = settings && typeof settings === "object" ? settings.statusLine : null;
  if (!prior || prior.type === "command") {
    const hook = join(collectorDir, "claude-statusline.mjs");
    const alreadyInstalled = typeof prior?.command === "string" && prior.command.includes("claude-statusline.mjs");
    const priorCommand = !alreadyInstalled && typeof prior?.command === "string" ? prior.command : null;
    if (priorCommand) {
      await writeAtomic(
        join(collectorDir, "statusline-chain.json"),
        `${JSON.stringify({ version: 1, command: priorCommand }, null, 2)}\n`,
        0o600,
      );
    } else if (alreadyInstalled && preservedStatuslineChain) {
      await writeAtomic(
        join(collectorDir, "statusline-chain.json"),
        `${JSON.stringify(preservedStatuslineChain, null, 2)}\n`,
        0o600,
      );
    }
    const backup = join(installRoot, "claude-settings.before-carthing.json");
    try {
      await stat(backup);
    } catch {
      await writeAtomic(backup, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
    }
    settings.statusLine = {
      ...(prior && typeof prior === "object" ? prior : {}),
      type: "command",
      command: `${quoteCmd(process.execPath)} ${quoteCmd(hook)}`,
      refreshInterval: prior?.refreshInterval ?? 5,
    };
    await writeAtomic(claudeSettings, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  } else {
    console.warn("Claude statusLine is not command-based; it was preserved. Configure the installed hook manually.");
  }
}

if (system === "win32" && !args.has("no-start")) {
  const launcher = join(installRoot, "start-collector.cmd");
  const command = [quoteCmd(process.execPath), ...collectorArgs.map(quoteCmd)].join(" ");
  await writeAtomic(launcher, `@echo off\r\n${command}\r\n`, 0o700);
  const startup = join(
    process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  );
  await mkdir(startup, { recursive: true });
  const vbsPath = join(startup, "CarThingCollector.vbs");
  const escaped = launcher.replaceAll("\"", "\"\"");
  await writeAtomic(
    vbsPath,
    `CreateObject("Wscript.Shell").Run Chr(34) & "${escaped}" & Chr(34), 0, False\r\n`,
    0o700,
  );
  spawn(process.execPath, collectorArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
} else if (system === "darwin" && !args.has("no-start")) {
  const label = "com.carthing.collector";
  const agents = join(homedir(), "Library", "LaunchAgents");
  const plist = join(agents, `${label}.plist`);
  await mkdir(agents, { recursive: true });
  const argumentsXml = [process.execPath, ...collectorArgs]
    .map((value) => `      <string>${xml(value)}</string>`)
    .join("\n");
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(installRoot, "collector.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(installRoot, "collector-error.log"))}</string>
</dict></plist>
`;
  await writeAtomic(plist, document, 0o600);
  spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["load", plist], { stdio: "ignore" });
  if (loaded.status !== 0) console.warn(`Run: launchctl load ${plist}`);
}

if (system === "win32" && args.has("configure-firewall")) {
  const ruleArgs = [
    "name=Car Thing Collector",
    "new",
    "enable=yes",
    "dir=in",
    "action=allow",
    `program=${process.execPath}`,
    "protocol=TCP",
    `localport=${port}`,
    "profile=private",
  ];
  let result = spawnSync(
    "netsh",
    ["advfirewall", "firewall", "set", "rule", ...ruleArgs],
    { stdio: "ignore", windowsHide: true },
  );
  if (result.status !== 0) result = spawnSync(
    "netsh",
    [
      "advfirewall", "firewall", "add", "rule",
      "name=Car Thing Collector",
      "dir=in",
      "action=allow",
      `program=${process.execPath}`,
      "protocol=TCP",
      `localport=${port}`,
      "profile=private",
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) console.warn("Private-network firewall rule was not installed; rerun from an elevated terminal.");
}

const addresses = localAddresses();
console.log(`Installed to ${installRoot}`);
console.log(`Pairing token: ${tokenFile}`);
if (args.has("show-pairing-url")) {
  for (const address of addresses.length ? addresses : ["YOUR_COMPUTER_IP"]) {
    const endpoint = `${address}:${port}`;
    console.log(`Pairing URL: http://${endpoint}/#token=${token}&endpoints=${endpoint}`);
  }
  console.log("The token is in the URL fragment and is scrubbed by the display immediately after pairing.");
} else {
  console.log("Pairing URL hidden; use --show-pairing-url only in a private terminal when needed.");
}
if (system === "win32" && !args.has("configure-firewall")) {
  console.log("USB/ADB works without a firewall rule. For LAN or bridge use, rerun with --configure-firewall from an elevated terminal.");
}
