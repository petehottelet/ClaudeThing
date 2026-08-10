/**
 * Regression tests for the two integration-critique HIGH defects:
 * 1. observedAt must reflect ingested telemetry, never the poll time —
 *    otherwise hours-old data reads "just now"/LIVE forever.
 * 2. Codex window labels must follow the window's actual duration —
 *    real telemetry has carried a 7-day window under the `primary` key.
 */

import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import { ClaudeJsonlReader } from "../src/adapters/claude-jsonl";
import { labelForWindow, parseCodexRateLimits } from "../src/adapters/codex-common";
import { mergeProvider } from "../src/merge";

let tmp: string;
let claudeDir: string;
let dataDir: string;
let sessionFile: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "carthing-fresh-"));
  claudeDir = path.join(tmp, "projects");
  dataDir = path.join(tmp, "data");
  await mkdir(path.join(claudeDir, "proj-a"), { recursive: true });
  sessionFile = path.join(claudeDir, "proj-a", "session.jsonl");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function usageLine(id: string, timestampIso: string): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: `uuid-${id}`,
    requestId: `req-${id}`,
    timestamp: timestampIso,
    message: { id: `msg-${id}`, usage: { input_tokens: 10, output_tokens: 1 } },
  })}\n`;
}

describe("observedAt honesty (claude-jsonl)", () => {
  it("stamps observedAt from the ingested event, and does not advance it on idle polls", async () => {
    const eventIso = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeFile(sessionFile, usageLine("a", eventIso), "utf8");
    const r = new ClaudeJsonlReader({ claudeDir, dataDir, host: "pc" });

    const first = await r.poll();
    expect(first?.observedAt).toBe(new Date(Date.parse(eventIso)).toISOString());

    // Idle poll: no new events, observedAt must NOT move to "now".
    const second = await r.poll();
    expect(second?.observedAt).toBe(first?.observedAt);

    // New event advances it.
    const laterIso = new Date().toISOString();
    await appendFile(sessionFile, usageLine("b", laterIso), "utf8");
    const third = await r.poll();
    expect(third?.observedAt).toBe(new Date(Date.parse(laterIso)).toISOString());
  });

  it("reports unavailable with null observedAt before any event was ever seen", async () => {
    const r = new ClaudeJsonlReader({ claudeDir, dataDir, host: "pc" });
    const obs = await r.poll();
    expect(obs?.observedAt).toBeNull();
    expect(obs?.state).toBe("unavailable");
  });
});

describe("window labels follow duration (codex)", () => {
  it("labels a 7-day primary window Weekly, not Current", () => {
    const windows = parseCodexRateLimits(
      {
        primary: { used_percent: 2, resets_in_seconds: 6 * 86400, window_minutes: 7 * 24 * 60 },
      },
      Date.now(),
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.label).toBe("Weekly");
  });

  it("labels a 5-hour secondary window Current, and falls back to position when unknown", () => {
    expect(labelForWindow(5 * 3600, "Weekly")).toBe("Current");
    expect(labelForWindow(7 * 86400, "Current")).toBe("Weekly");
    expect(labelForWindow(null, "Current")).toBe("Current");
    expect(labelForWindow(null, "Weekly")).toBe("Weekly");
  });
});

describe("merged provider age follows the quota winner", () => {
  function obs(over: Partial<ProviderSnapshot>, receivedAtMs: number) {
    const base: ProviderSnapshot = {
      id: "claude",
      displayName: "Claude",
      state: "live",
      observedAt: null,
      source: null,
      host: "pc",
      quotaWindows: [],
      tokens: null,
      cost: null,
      diagnostic: null,
    };
    return { provider: { ...base, ...over }, receivedAtMs };
  }

  it("a fresher token-only surface must not rejuvenate stale quota data", () => {
    const now = Date.now();
    const quotaAge = new Date(now - 2 * 3600_000).toISOString();
    const tokenAge = new Date(now - 30_000).toISOString();
    const merged = mergeProvider(
      [
        obs(
          {
            source: "statusline",
            observedAt: quotaAge,
            quotaWindows: [
              { id: "five_hour", label: "Current", usedPercent: 40, resetsAt: null, windowSeconds: 18000 },
            ],
          },
          now,
        ),
        obs(
          {
            source: "jsonl",
            observedAt: tokenAge,
            tokens: { input: 1, cachedInput: 0, reasoning: null, output: 1, total: 2, period: "today", periodStart: "2026-08-08" },
          },
          now,
        ),
      ],
      { nowMs: now },
    );
    expect(merged.snapshot.observedAt).toBe(quotaAge);
    expect(merged.snapshot.state).toBe("stale");
  });

  it("unions diagnostics from every surface, not just the winner", () => {
    const now = Date.now();
    const merged = mergeProvider(
      [
        obs(
          {
            source: "statusline",
            observedAt: new Date(now).toISOString(),
            quotaWindows: [
              { id: "five_hour", label: "Current", usedPercent: 10, resetsAt: null, windowSeconds: 18000 },
            ],
          },
          now,
        ),
        obs({ source: "app-server", state: "error", diagnostic: "APP_SERVER_UNREACHABLE" }, now),
      ],
      { nowMs: now },
    );
    expect(merged.snapshot.diagnostic).toContain("APP_SERVER_UNREACHABLE");
  });
});
