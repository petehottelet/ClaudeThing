import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, TokenSummary } from "@carthing/contracts";
import {
  FUTURE_SKEW_LIMIT_MS,
  QUOTA_UNION_MAX_LAG_MS,
  mergeProvider,
  mergeProviders,
} from "../src/merge";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const iso = (offsetSec: number): string => new Date(NOW + offsetSec * 1000).toISOString();

function obs(over: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: "claude",
    displayName: "Claude",
    state: "live",
    observedAt: iso(-30),
    source: "statusline",
    host: "pc",
    quotaWindows: [],
    tokens: null,
    cost: null,
    diagnostic: null,
    ...over,
  };
}

function window(usedPercent: number) {
  return { id: "five_hour", label: "Current", usedPercent, resetsAt: iso(3600), windowSeconds: 18000 };
}

function tokens(over: Partial<TokenSummary> = {}): TokenSummary {
  return {
    input: 100,
    cachedInput: 200,
    reasoning: null,
    output: 50,
    total: 350,
    period: "today",
    periodStart: "2026-08-08",
    ...over,
  };
}

describe("quota merge", () => {
  it("freshest observation wins per provider", () => {
    const merged = mergeProvider(
      [
        { provider: obs({ observedAt: iso(-600), quotaWindows: [window(10)], host: "mac" }), receivedAtMs: NOW },
        { provider: obs({ observedAt: iso(-30), quotaWindows: [window(55)], host: "pc" }), receivedAtMs: NOW },
      ],
      { nowMs: NOW },
    );
    expect(merged.snapshot.quotaWindows[0]?.usedPercent).toBe(55);
    expect(merged.snapshot.host).toBe("pc");
  });

  it("keeps richer app-server windows while a fresher rollout updates their shared limit", () => {
    const weekly = (id: string, label: string, usedPercent: number) => ({
      id,
      label,
      usedPercent,
      resetsAt: iso(6 * 86400),
      windowSeconds: 604800,
    });
    const merged = mergeProvider(
      [
        {
          provider: obs({
            id: "codex",
            source: "rollout-limits",
            observedAt: iso(-5),
            quotaWindows: [weekly("codex:primary", "Weekly", 6)],
          }),
          receivedAtMs: NOW,
        },
        {
          provider: obs({
            id: "codex",
            source: "app-server",
            observedAt: iso(-45),
            quotaWindows: [
              weekly("codex:primary", "Weekly", 5),
              weekly("codex_model:primary", "Model · Weekly", 1),
            ],
          }),
          receivedAtMs: NOW,
        },
      ],
      { nowMs: NOW },
    );

    expect(merged.snapshot.quotaWindows).toMatchObject([
      { id: "codex:primary", usedPercent: 6 },
      { id: "codex_model:primary", usedPercent: 1 },
    ]);
  });

  it("drops unique quota windows from a surface outside the live union lag", () => {
    const merged = mergeProvider(
      [
        {
          provider: obs({ id: "codex", observedAt: iso(-5), quotaWindows: [window(20)] }),
          receivedAtMs: NOW,
        },
        {
          provider: obs({
            id: "codex",
            observedAt: new Date(NOW - QUOTA_UNION_MAX_LAG_MS - 10_000).toISOString(),
            quotaWindows: [{ ...window(80), id: "old_model", label: "Old model · Current" }],
          }),
          receivedAtMs: NOW,
        },
      ],
      { nowMs: NOW },
    );

    expect(merged.snapshot.quotaWindows.map((entry) => entry.id)).toEqual(["five_hour"]);
  });

  it("clamps far-future observedAt to receive time and flags CLOCK_SKEW", () => {
    const merged = mergeProvider(
      [{ provider: obs({ observedAt: iso(10 * 60), quotaWindows: [window(40)] }), receivedAtMs: NOW }],
      { nowMs: NOW },
    );
    expect(merged.snapshot.observedAt).toBe(iso(0));
    expect(merged.snapshot.diagnostic).toContain("CLOCK_SKEW");
  });

  it("skewed observation does not beat a genuinely fresher one", () => {
    // Future-stamped observation was received 5 minutes ago -> clamped to then.
    const merged = mergeProvider(
      [
        {
          provider: obs({ observedAt: iso(30 * 60), quotaWindows: [window(99)], host: "mac" }),
          receivedAtMs: NOW - 5 * 60 * 1000,
        },
        { provider: obs({ observedAt: iso(-10), quotaWindows: [window(42)], host: "pc" }), receivedAtMs: NOW },
      ],
      { nowMs: NOW },
    );
    expect(merged.snapshot.quotaWindows[0]?.usedPercent).toBe(42);
  });

  it("tolerates observedAt just inside the skew limit", () => {
    const justInside = new Date(NOW + FUTURE_SKEW_LIMIT_MS - 1000).toISOString();
    const merged = mergeProvider(
      [{ provider: obs({ observedAt: justInside, quotaWindows: [window(12)] }), receivedAtMs: NOW }],
      { nowMs: NOW },
    );
    expect(merged.snapshot.diagnostic).toBeNull();
    expect(merged.snapshot.observedAt).toBe(justInside);
  });

  it("degrades live state by age", () => {
    const merged = mergeProvider(
      [{ provider: obs({ observedAt: iso(-40 * 60), quotaWindows: [window(20)] }), receivedAtMs: NOW - 40 * 60 * 1000 }],
      { nowMs: NOW },
    );
    expect(merged.snapshot.state).toBe("stale");
  });
});

describe("token merge", () => {
  it("sums token summaries across hosts and keeps per-host provenance", () => {
    const merged = mergeProvider(
      [
        {
          provider: obs({ source: "jsonl", host: "pc", tokens: tokens({ input: 100, cachedInput: 200, output: 50, total: 350 }) }),
          receivedAtMs: NOW,
        },
        {
          provider: obs({ source: "jsonl", host: "mac", tokens: tokens({ input: 40, cachedInput: 10, output: 5, total: 55 }) }),
          receivedAtMs: NOW,
        },
      ],
      { nowMs: NOW, expectedHosts: ["pc", "mac"] },
    );
    expect(merged.snapshot.tokens).toMatchObject({ input: 140, cachedInput: 210, output: 55, total: 405, period: "today" });
    expect(merged.snapshot.diagnostic).toBeNull();
    expect(merged.tokenSources).toHaveLength(2);
    expect(new Set(merged.tokenSources.map((s) => s.host))).toEqual(new Set(["pc", "mac"]));
  });

  it("never double-counts two sources on the same host (authority order)", () => {
    const merged = mergeProvider(
      [
        {
          provider: obs({ id: "codex", source: "app-server", host: "pc", tokens: tokens({ input: 100, total: 350 }) }),
          receivedAtMs: NOW,
        },
        {
          provider: obs({ id: "codex", source: "rollout", host: "pc", tokens: tokens({ input: 999, total: 9999 }) }),
          receivedAtMs: NOW,
        },
      ],
      { nowMs: NOW },
    );
    expect(merged.snapshot.tokens?.input).toBe(999); // detailed rollout beats total-only app-server usage
    expect(merged.tokenSources).toHaveLength(1);
  });

  it("never sums different calendar days across hosts", () => {
    const merged = mergeProvider(
      [
        { provider: obs({ source: "jsonl", host: "pc", tokens: tokens({ input: 100, periodStart: "2026-08-08" }) }), receivedAtMs: NOW },
        { provider: obs({ source: "jsonl", host: "mac", tokens: tokens({ input: 900, periodStart: "2026-08-07" }) }), receivedAtMs: NOW },
      ],
      { nowMs: NOW, expectedHosts: ["pc", "mac"] },
    );
    expect(merged.snapshot.tokens?.input).toBe(100);
    expect(merged.snapshot.tokens?.periodStart).toBe("2026-08-08");
    expect(merged.snapshot.diagnostic).toContain("TOKENS_PERIOD_MISMATCH");
    expect(merged.snapshot.diagnostic).toContain("TOKENS_PARTIAL");
  });

  it("ignores session-period summaries when a today summary exists", () => {
    const merged = mergeProvider(
      [
        { provider: obs({ source: "jsonl", host: "pc", tokens: tokens({ input: 100 }) }), receivedAtMs: NOW },
        {
          provider: obs({ source: "statusline", host: "pc", tokens: tokens({ input: 7, period: "session", periodStart: null }) }),
          receivedAtMs: NOW,
        },
      ],
      { nowMs: NOW },
    );
    expect(merged.snapshot.tokens?.period).toBe("today");
    expect(merged.snapshot.tokens?.input).toBe(100);
  });

  it("marks a missing expected host as labeled-partial, never zeros", () => {
    const merged = mergeProvider(
      [{ provider: obs({ source: "jsonl", host: "pc", tokens: tokens({ input: 100 }) }), receivedAtMs: NOW }],
      { nowMs: NOW, expectedHosts: ["pc", "mac"] },
    );
    expect(merged.snapshot.diagnostic).toContain("TOKENS_PARTIAL");
    expect(merged.snapshot.tokens?.input).toBe(100); // pc's real numbers, not zero-filled
  });

  it("yields null tokens when no host contributed (missing is not zero)", () => {
    const merged = mergeProvider(
      [{ provider: obs({ quotaWindows: [window(30)] }), receivedAtMs: NOW }],
      { nowMs: NOW, expectedHosts: ["pc", "mac"] },
    );
    expect(merged.snapshot.tokens).toBeNull();
  });
});

describe("mergeProviders", () => {
  it("groups by provider id and orders claude before codex", () => {
    const merged = mergeProviders(
      [
        { provider: obs({ id: "codex", displayName: "Codex" }), receivedAtMs: NOW },
        { provider: obs(), receivedAtMs: NOW },
      ],
      { nowMs: NOW },
    );
    expect(merged.map((m) => m.snapshot.id)).toEqual(["claude", "codex"]);
  });
});
