/**
 * Setup status feed — the write side of the live install dashboard.
 *
 * setup.mjs (or an agent driving the same steps manually) appends one JSON
 * event per line to ~/CarThingDeploy/setup-status.jsonl:
 *
 *   { "ts": 1754777000000, "step": "backup", "state": "start", "detail": "..." }
 *
 * States: "start" | "done" | "skip" | "error" | "info". Unknown step ids are
 * ignored by the page; the canonical list is STEPS below. status-server.mjs
 * renders the feed at http://127.0.0.1:8799 so the person watching has
 * something to look at while the Car Thing's own screen is black.
 *
 * The feed is plain local state: no tokens, no secrets, nothing device-bound.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STEPS = [
  { id: "prereqs", label: "Prerequisites (package manager, Python, adb)" },
  { id: "build", label: "Build + verify the release payload" },
  { id: "host", label: "Install the host collector" },
  { id: "burn", label: "Enter USB mode (hold presets 1+4 while replugging)" },
  { id: "backup", label: "Full firmware backup (~3.6 GB, ~3 hours)" },
  { id: "verify", label: "Verify backup (size check)" },
  { id: "burnenv", label: "Arm burn mode + plain replug (no buttons)" },
  { id: "adb", label: "Boot temporary ADB kernel (memory-only)" },
  { id: "stock", label: "Device doctor + stock app backup" },
  { id: "deploy", label: "Deploy the dashboard" },
  { id: "live", label: "Dashboard live on the Car Thing" },
];

export const STATUS_PORT = Number(process.env.CARTHING_STATUS_PORT ?? 8799);
export const STATUS_URL = `http://127.0.0.1:${STATUS_PORT}`;
export const STATUS_FILE =
  process.env.CARTHING_STATUS_FILE ?? path.join(os.homedir(), "CarThingDeploy", "setup-status.jsonl");

let activeStep = null;
let enabled = true;

export function disableStatus() {
  enabled = false;
}

/** Truncate the feed so the page shows this run, not a previous one. */
export function beginRun(detail) {
  if (!enabled) return;
  try {
    mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    writeFileSync(STATUS_FILE, "");
    statusEvent("run", "start", detail);
  } catch {
    /* status is best-effort; setup never fails because of it */
  }
}

// Details are orchestrator-authored strings, never raw child output; this is
// a belt-and-suspenders guard so a pairing token can never reach the feed.
function redact(text) {
  return String(text)
    .replace(/token=[^\s&"']+/gi, "token=[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

export function statusEvent(step, state, detail) {
  if (!enabled) return;
  if (state === "start") activeStep = step;
  if ((state === "done" || state === "skip") && activeStep === step) activeStep = null;
  try {
    const line = JSON.stringify({ v: 1, ts: Date.now(), step, state, ...(detail ? { detail: redact(detail) } : {}) });
    appendFileSync(STATUS_FILE, line + "\n");
  } catch {
    /* best-effort */
  }
}

/** Mark whichever step is mid-flight as failed; called from fail(). */
export function failStatus(detail) {
  statusEvent(activeStep ?? "run", "error", detail);
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Start status-server.mjs as a detached child unless one is already
 * listening. Returns the URL either way; never throws.
 */
export async function startStatusServer() {
  if (await probe(`${STATUS_URL}/state`)) return STATUS_URL;
  try {
    const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "status-server.mjs");
    const child = spawn(process.execPath, [server], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* the page is a nicety; setup continues without it */
  }
  return STATUS_URL;
}

/** Best-effort `open` of the page for a human at the keyboard. */
export function openInBrowser(url) {
  try {
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "win32")
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, shell: false }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort */
  }
}
