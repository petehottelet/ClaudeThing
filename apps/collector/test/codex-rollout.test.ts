import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import { CodexRolloutReader } from "../src/adapters/codex-rollout";

let tmp: string;
let codexDir: string;
let dataDir: string;
let rolloutFile: string;

interface Cumulative {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

function event(cum: Cumulative, extra: { rateLimits?: unknown; ts?: string } = {}): string {
  return `${JSON.stringify({
    timestamp: extra.ts ?? new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: cum.input,
          cached_input_tokens: cum.cached,
          output_tokens: cum.output,
          reasoning_output_tokens: cum.reasoning,
          total_tokens: cum.input + cum.output,
        },
      },
      ...(extra.rateLimits !== undefined ? { rate_limits: extra.rateLimits } : {}),
    },
  })}\n`;
}

function reader(): CodexRolloutReader {
  return new CodexRolloutReader({ codexDir, dataDir, host: "pc" });
}

function tokensOf(observations: ProviderSnapshot[]): ProviderSnapshot | undefined {
  return observations.find((o) => o.source === "rollout");
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "carthing-codex-"));
  codexDir = path.join(tmp, "sessions");
  dataDir = path.join(tmp, "data");
  await mkdir(path.join(codexDir, "2026", "08", "08"), { recursive: true });
  rolloutFile = path.join(codexDir, "2026", "08", "08", "rollout-2026-08-08-abc.jsonl");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("CodexRolloutReader", () => {
  it("computes daily deltas from cumulative counters with exclusive class mapping", async () => {
    await writeFile(
      rolloutFile,
      event({ input: 100, cached: 40, output: 20, reasoning: 5 }) +
        event({ input: 300, cached: 100, output: 80, reasoning: 20 }),
      "utf8",
    );
    const obs = tokensOf(await reader().poll());
    // input excludes cached, output excludes reasoning; totals are cumulative 300/100/80/20.
    expect(obs?.tokens).toMatchObject({
      input: 200,
      cachedInput: 100,
      reasoning: 20,
      output: 60,
      total: 380,
      period: "today",
    });
  });

  it("treats a backwards counter as a new session baseline, not a negative delta", async () => {
    await writeFile(rolloutFile, event({ input: 300, cached: 100, output: 80, reasoning: 20 }), "utf8");
    const r = reader();
    expect(tokensOf(await r.poll())?.tokens?.total).toBe(380);

    // Counter reset: much smaller cumulative appears in the same file.
    await appendFile(rolloutFile, event({ input: 50, cached: 10, output: 5, reasoning: 1 }), "utf8");
    const obs = tokensOf(await r.poll());
    expect(obs?.tokens).toMatchObject({
      input: 200 + 40, // prior 200 + fresh (50-10)
      cachedInput: 100 + 10,
      reasoning: 20 + 1,
      output: 60 + 4,
      total: 380 + 55,
    });
  });

  it("does not double count on re-poll or duplicated cumulative lines", async () => {
    await writeFile(rolloutFile, event({ input: 100, cached: 0, output: 10, reasoning: 0 }), "utf8");
    const r = reader();
    expect(tokensOf(await r.poll())?.tokens?.total).toBe(110);
    expect(tokensOf(await r.poll())?.tokens?.total).toBe(110);

    // Identical cumulative appended again: delta is zero.
    await appendFile(rolloutFile, event({ input: 100, cached: 0, output: 10, reasoning: 0 }), "utf8");
    expect(tokensOf(await r.poll())?.tokens?.total).toBe(110);
  });

  it("extracts rate-limit observations with the event timestamp", async () => {
    const ts = new Date().toISOString();
    await writeFile(
      rolloutFile,
      event(
        { input: 10, cached: 0, output: 5, reasoning: 0 },
        {
          ts,
          rateLimits: {
            primary: { used_percent: 27.5, window_minutes: 300, resets_in_seconds: 3600 },
            secondary: { used_percent: 64, window_minutes: 10080 },
          },
        },
      ),
      "utf8",
    );
    const observations = await reader().poll();
    const limits = observations.find((o) => o.source === "rollout-limits");
    expect(limits?.observedAt).toBe(new Date(Date.parse(ts)).toISOString());
    const primary = limits?.quotaWindows.find((w) => w.id === "primary");
    const secondary = limits?.quotaWindows.find((w) => w.id === "secondary");
    expect(primary).toMatchObject({ label: "Current", usedPercent: 27.5, windowSeconds: 300 * 60 });
    expect(primary?.resetsAt).toBe(new Date(Date.parse(ts) + 3600 * 1000).toISOString());
    expect(secondary).toMatchObject({ label: "Weekly", usedPercent: 64 });
  });

  it("survives truncation and malformed lines", async () => {
    await writeFile(rolloutFile, event({ input: 100, cached: 0, output: 10, reasoning: 0 }), "utf8");
    const r = reader();
    expect(tokensOf(await r.poll())?.tokens?.total).toBe(110);
    await writeFile(rolloutFile, "garbage\n", "utf8");
    await expect(r.poll()).resolves.toBeDefined();
  });

  it("returns [] when the Codex directory does not exist", async () => {
    const r = new CodexRolloutReader({ codexDir: path.join(tmp, "nope"), dataDir, host: "pc" });
    expect(await r.poll()).toEqual([]);
  });
});
