#!/usr/bin/env node
/**
 * Claude Code status line command for the Car Thing collector.
 *
 * Reads the statusline JSON from stdin, fire-and-forgets it to the local
 * collector's ingest endpoint (500ms timeout), and prints a single short
 * passthrough status line (model display name + five-hour used % when
 * present, e.g. "Opus · 5h 42%"). Never throws, never blocks, always
 * exits 0.
 *
 * Configuration via environment: CARTHING_TOKEN (pairing token),
 * CARTHING_PORT (default 8790).
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INSTALL_DIR =
  platform() === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "CarThingCollector")
    : join(homedir(), "Library", "Application Support", "CarThingCollector");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const installed = readJson(join(HERE, "collector-config.json")) || {};
const PORT = Number(process.env.CARTHING_PORT || installed.port || 8790) || 8790;
const tokenFile =
  process.env.CARTHING_TOKEN_FILE || installed.tokenFile || join(DEFAULT_INSTALL_DIR, "pairing.token");
let TOKEN = process.env.CARTHING_TOKEN || "";
if (!TOKEN) {
  try {
    TOKEN = readFileSync(tokenFile, "utf8").trim();
  } catch {
    TOKEN = "";
  }
}
const chained = readJson(join(HERE, "statusline-chain.json"));

let printed = false;
function printLine(line) {
  if (printed) return;
  printed = true;
  try {
    process.stdout.write(line + "\n");
  } catch {
    // stdout gone; nothing to do.
  }
}

// Absolute safety nets: bounded lifetime, exit 0 on any surprise.
const hardStop = setTimeout(() => {
  printLine("Claude");
  process.exit(0);
}, 900);
hardStop.unref();
process.on("uncaughtException", () => {
  printLine("Claude");
  process.exit(0);
});
process.on("unhandledRejection", () => {});

function statusLine(data) {
  try {
    const model =
      data && data.model && (data.model.display_name || data.model.id);
    const name = typeof model === "string" && model !== "" ? model : "Claude";
    const rl = data && (data.rate_limits || data.rateLimits);
    const fiveHour = rl && (rl.five_hour || rl.fiveHour);
    const pctRaw = fiveHour
      ? (fiveHour.used_percentage ?? fiveHour.utilization ?? fiveHour.used_percent)
      : undefined;
    // Guard: Number(null) is 0 — never fabricate a 0% from missing data.
    const pct =
      typeof pctRaw === "number" || typeof pctRaw === "string" ? Number(pctRaw) : NaN;
    return Number.isFinite(pct) ? `${name} · 5h ${Math.round(pct)}%` : name;
  } catch {
    return "Claude";
  }
}

/**
 * Privacy boundary lives HERE, before anything crosses the wire: only the
 * numeric/enum surfaces the collector actually uses are forwarded. Paths,
 * session ids, workspace info, and anything unrecognized never leave this
 * process, even though the collector would also strip them server-side.
 */
const FORWARD_KEYS = [
  "rate_limits",
  "rateLimits",
  "context_window",
  "contextWindow",
  "context",
  "usage",
  "cost",
  "exceeds_200k_tokens",
];

function sanitize(data) {
  if (!data || typeof data !== "object") return null;
  const out = {};
  for (const key of FORWARD_KEYS) {
    if (key in data) out[key] = data[key];
  }
  if (data.model && typeof data.model === "object") {
    out.model = {
      display_name: data.model.display_name,
      id: data.model.id,
    };
  }
  return out;
}

function post(data) {
  try {
    const body = Buffer.from(JSON.stringify(data), "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method: "POST",
        path: "/v1/ingest/claude-statusline",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": body.length,
        },
        timeout: 500,
      },
      (res) => {
        res.resume();
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {});
    req.end(body);
  } catch {
    // Fire-and-forget: delivery failure is invisible to Claude Code.
  }
}

function printChainedOrFallback(raw, data) {
  const command = chained && typeof chained.command === "string" ? chained.command.trim() : "";
  if (!command) {
    printLine(statusLine(data));
    return;
  }
  try {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      printLine(statusLine(data));
    }, 700);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (output.length < 16_384) output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      printLine(statusLine(data));
    });
    child.on("close", () => {
      clearTimeout(timeout);
      const line = output.trimEnd();
      printLine(line || statusLine(data));
    });
    child.stdin.end(raw);
  } catch {
    printLine(statusLine(data));
  }
}

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("error", () => printLine("Claude"));
process.stdin.on("end", () => {
  let data = null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    data = JSON.parse(raw);
  } catch {
    // Not JSON; still print something useful.
  }
  const safe = sanitize(data);
  if (safe) post(safe);
  printChainedOrFallback(raw, data);
});
