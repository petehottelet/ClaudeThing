/**
 * Collector configuration from CLI flags and environment variables.
 *
 * Flags (all optional):
 *   --port <n>            listen port (default 8790, env CARTHING_PORT)
 *   --bind <address>      listen address (production 0.0.0.0; mock 127.0.0.1)
 *   --token-file <path>   pairing token file (env CARTHING_TOKEN_FILE)
 *   --token <t>           legacy/development override; leaks via process lists
 *   --host-name <name>    host label used in observations (default os.hostname())
 *   --peer <url>          peer collector base URL, e.g. http://mac.local:8790
 *   --peer-host <name>    pinned peer identity for partial-total detection
 *   --ui-dir <dir>        serve the packaged device UI from this directory
 *   --allowed-origins <csv> exact browser origins permitted for CORS
 *   --mock <fixture>      serve a synthetic fixture instead of real adapters
 *   --claude-dir <dir>    Claude Code JSONL projects dir (default <home>/.claude/projects)
 *   --codex-dir <dir>     Codex sessions dir (default <home>/.codex/sessions)
 *   --data-dir <dir>      collector state dir (default <home>/.carthing-collector)
 *   --dashboard-config <file> non-secret JSONC display preferences
 *   --provider-dir <dir> validated JSON bridge files (default beside dashboard config)
 *   --codex-command <cmd> codex app-server launch command (default "codex app-server")
 *   --adb-command <path>  ADB executable (default "adb")
 *   --adb-serial <id>     target a specific ADB device
 *   --no-adb              disable automatic ADB reverse-tunnel recovery
 *   --no-codex-appserver  use rollout logs only; quota windows unavailable
 *   --no-claude-oauth     disable the continuous Claude quota poller
 */

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { FIXTURE_NAMES, type FixtureName } from "@carthing/contracts/fixtures";

export const COLLECTOR_VERSION = "0.1.0";

export interface CollectorConfig {
  port: number;
  bindHost: string;
  token: string | null;
  tokenSource: "flag" | "environment" | "file" | null;
  hostName: string;
  peerUrl: string | null;
  peerHostName: string | null;
  allowedOrigins: string[];
  uiDir: string | null;
  adbEnabled: boolean;
  adbCommand: string;
  adbSerial: string | null;
  codexAppServerEnabled: boolean;
  claudeOauthEnabled: boolean;
  mock: FixtureName | null;
  claudeDir: string;
  codexDir: string;
  dataDir: string;
  dashboardConfigPath: string;
  providerDirectory: string;
  codexCommand: string;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(arg.slice(2), next);
        i++;
      } else {
        flags.set(arg.slice(2), "");
      }
    }
  }
  return flags;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CollectorConfig {
  const flags = parseFlags(argv);
  const home = os.homedir();

  const portRaw = flags.get("port") ?? env.CARTHING_PORT;
  const port = portRaw !== undefined && portRaw !== "" ? Number(portRaw) : 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${String(portRaw)}`);
  }

  const mockRaw = flags.get("mock") || null;
  if (mockRaw !== null && !(FIXTURE_NAMES as string[]).includes(mockRaw)) {
    throw new Error(`Unknown --mock fixture "${mockRaw}". Valid fixtures: ${FIXTURE_NAMES.join(", ")}`);
  }

  const tokenFile = flags.get("token-file") ?? env.CARTHING_TOKEN_FILE ?? null;
  let token: string | null = null;
  let tokenSource: CollectorConfig["tokenSource"] = null;
  if (flags.has("token")) {
    token = flags.get("token") || null;
    tokenSource = token ? "flag" : null;
  } else if (env.CARTHING_TOKEN) {
    token = env.CARTHING_TOKEN;
    tokenSource = "environment";
  } else if (tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf8").trim() || null;
      tokenSource = token ? "file" : null;
    } catch {
      throw new Error(`Unable to read pairing token file: ${tokenFile}`);
    }
  }
  const peerRaw = flags.get("peer") ?? env.CARTHING_PEER ?? null;
  if (peerRaw) {
    let peerUrl: URL;
    try {
      peerUrl = new URL(peerRaw);
    } catch {
      throw new Error(`Invalid --peer URL: ${peerRaw}`);
    }
    if (!(["http:", "https:"] as string[]).includes(peerUrl.protocol) || peerUrl.username || peerUrl.password) {
      throw new Error("--peer must be an http(s) URL without embedded credentials.");
    }
  }
  const allowedOriginsRaw =
    flags.get("allowed-origins") ?? env.CARTHING_ALLOWED_ORIGINS ??
    "null,http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8080";
  const allowedOrigins = allowedOriginsRaw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    if (origin === "null") continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid allowed origin: ${origin}`);
    }
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Allowed origin must be an exact http(s) origin: ${origin}`);
    }
  }
  const hostName = flags.get("host-name") || os.hostname();
  const peerHostName = flags.get("peer-host") || env.CARTHING_PEER_HOST || null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(hostName)) throw new Error("Invalid --host-name.");
  if (peerHostName && !/^[A-Za-z0-9._-]{1,64}$/.test(peerHostName)) {
    throw new Error("Invalid --peer-host.");
  }
  const bindHost =
    flags.get("bind") || env.CARTHING_BIND || (mockRaw !== null ? "127.0.0.1" : "0.0.0.0");
  if (!/^[A-Za-z0-9.:-]{1,255}$/.test(bindHost)) throw new Error("Invalid --bind address.");
  const dataDir = flags.get("data-dir") || path.join(home, ".carthing-collector");
  const dashboardConfigPath =
    flags.get("dashboard-config") ||
    env.CARTHING_DASHBOARD_CONFIG ||
    path.join(dataDir, "dashboard-config.jsonc");

  return {
    port,
    bindHost,
    token,
    tokenSource,
    hostName,
    peerUrl: peerRaw ? peerRaw.replace(/\/+$/, "") : null,
    peerHostName,
    allowedOrigins,
    uiDir: flags.get("ui-dir") || env.CARTHING_UI_DIR || null,
    adbEnabled: !flags.has("no-adb") && env.CARTHING_ADB_ENABLED !== "0",
    adbCommand: flags.get("adb-command") || env.CARTHING_ADB || "adb",
    adbSerial: flags.get("adb-serial") || env.CARTHING_ADB_SERIAL || null,
    codexAppServerEnabled:
      !flags.has("no-codex-appserver") && env.CARTHING_CODEX_APPSERVER_ENABLED !== "0",
    claudeOauthEnabled:
      !flags.has("no-claude-oauth") && env.CARTHING_CLAUDE_OAUTH_ENABLED !== "0",
    mock: mockRaw as FixtureName | null,
    claudeDir: flags.get("claude-dir") || path.join(home, ".claude", "projects"),
    codexDir: flags.get("codex-dir") || path.join(home, ".codex", "sessions"),
    dataDir,
    dashboardConfigPath,
    providerDirectory:
      flags.get("provider-dir") ||
      env.CLAUDETHING_PROVIDER_DIR ||
      path.join(path.dirname(dashboardConfigPath), "providers"),
    codexCommand: flags.get("codex-command") || env.CARTHING_CODEX_COMMAND || "codex app-server",
  };
}
