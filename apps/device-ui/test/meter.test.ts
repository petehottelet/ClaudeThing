/**
 * Card-state honesty: a provider whose only telemetry is token counts must
 * surface that data (state follows freshness), while a provider with nothing
 * at all stays "unavailable". Guards the desktop-only Claude case — JSONL
 * tokens, no status-line quota — from reading as a blank NO DATA card.
 */

import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaWindow, TokenSummary } from "@carthing/contracts";
import {
  cardState,
  cardWindows,
  currentPeriodWindow,
  displayQuotaWindows,
  formatTokens,
  padWindows,
  tokenPeriodLabel,
  usageFactsPageCount,
} from "../src/components/Meter";

function win(over: Partial<QuotaWindow>): QuotaWindow {
  return { id: "w", label: "Weekly", usedPercent: 10, resetsAt: null, windowSeconds: 604800, ...over };
}

const DAY = "2026-08-09";

function tokens(over: Partial<TokenSummary> = {}): TokenSummary {
  return {
    input: 4_517,
    cachedInput: 54_708_440,
    reasoning: null,
    output: 280_474,
    total: 54_993_431,
    period: "today",
    periodStart: DAY,
    ...over,
  };
}

function provider(over: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: "claude",
    displayName: "Claude",
    state: "live",
    observedAt: new Date().toISOString(),
    source: "jsonl",
    host: "mac",
    quotaWindows: [],
    tokens: null,
    cost: null,
    diagnostic: null,
    ...over,
  };
}

describe("cardState", () => {
  it("keeps a tokens-only provider live instead of downgrading to unavailable", () => {
    expect(cardState(provider({ tokens: tokens() }), "live")).toBe("live");
  });

  it("downgrades to unavailable when neither quota nor tokens exist", () => {
    expect(cardState(provider(), "live")).toBe("unavailable");
    expect(cardState(provider(), "stale")).toBe("unavailable");
  });

  it("still ages tokens-only data: stale derivation passes through", () => {
    expect(cardState(provider({ tokens: tokens() }), "stale")).toBe("stale");
  });

  it("caps any live card at stale while the link is down", () => {
    expect(cardState(provider({ tokens: tokens() }), "live", true)).toBe("stale");
  });

  it("passes error and offline through untouched", () => {
    expect(cardState(provider({ tokens: tokens() }), "offline")).toBe("offline");
    expect(cardState(provider({ diagnostic: "APP_SERVER_UNREACHABLE" }), "error")).toBe("error");
  });
});

describe("tokenPeriodLabel", () => {
  const nowMs = Date.parse(`${DAY}T12:00:00.000Z`);

  it("labels a matching calendar bucket Today in the display time zone", () => {
    expect(tokenPeriodLabel(tokens(), nowMs, "UTC")).toBe("Today");
  });

  it("shows the bucket's own date when it is not today", () => {
    expect(tokenPeriodLabel(tokens({ periodStart: "2026-08-08" }), nowMs, "UTC")).toBe("2026-08-08");
  });

  it("falls back to the raw period for non-daily summaries", () => {
    expect(tokenPeriodLabel(tokens({ period: "session", periodStart: null }), nowMs, "UTC")).toBe(
      "session",
    );
  });
});

describe("formatTokens", () => {
  it("renders magnitudes and the unknown dash", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(4_517)).toBe("5K");
    expect(formatTokens(54_993_431)).toBe("55.0M");
  });
});

describe("cardWindows", () => {
  it("uses one all-model Current period and never duplicates it into a fake second window", () => {
    const slots = cardWindows([
      win({ id: "codex:primary", label: "Weekly", usedPercent: 5 }),
      win({ id: "codex_model:primary", label: "Model · Weekly", usedPercent: 0 }),
    ]);
    expect(slots.map((entry) => entry.id)).toEqual(["codex:primary"]);
    expect(slots.map((entry) => entry.label)).toEqual(["Current period"]);
    expect(slots.map((entry) => entry.usedPercent)).toEqual([5]);
  });

  it("prefers the default limit before a named limit of the same kind", () => {
    const slots = cardWindows([
      win({ id: "spark:primary", label: "Spark · Weekly" }),
      win({ id: "codex:primary", label: "Weekly" }),
    ]);
    expect(slots.map((entry) => entry.id)).toEqual(["codex:primary"]);
    expect(slots[0]?.label).toBe("Current period");
  });

  it("keeps the Weekly slot when Codex reports only its account window", () => {
    const slots = cardWindows([win({ id: "codex:primary", label: "Weekly" })]);
    expect(slots.map((entry) => entry.label)).toEqual(["Current period"]);
    expect(slots[0]?.usedPercent).toBe(10);
  });

  it("selects the account-wide Codex window for the Current period headline", () => {
    expect(
      currentPeriodWindow([
        win({ id: "model", label: "Preview · Weekly", usedPercent: 1 }),
        win({ id: "account", label: "Weekly", usedPercent: 6 }),
      ]),
    ).toMatchObject({ id: "account", label: "Current period", usedPercent: 6 });
  });

  it("keeps the classic five-hour + seven-day pair in Current/Weekly order", () => {
    const slots = cardWindows([
      win({ id: "seven_day", label: "Weekly" }),
      win({ id: "five_hour", label: "Current", windowSeconds: 18000, usedPercent: 8 }),
    ]);
    expect(slots.map((w) => w.id)).toEqual(["five_hour", "seven_day"]);
  });
});

describe("displayQuotaWindows", () => {
  it("shows only the account-wide all-model Codex period", () => {
    expect(
      displayQuotaWindows("codex", [
        win({ id: "codex:primary", label: "Weekly", usedPercent: 7 }),
        win({ id: "codex_model:primary", label: "Model Preview · Weekly", usedPercent: 0 }),
      ]),
    ).toEqual([expect.objectContaining({ id: "codex:primary", label: "Current period", usedPercent: 7 })]);
  });

  it("deduplicates Claude's overlapping weekly observations", () => {
    expect(
      displayQuotaWindows("claude", [
        win({ id: "five_hour", label: "Current", windowSeconds: 18_000, usedPercent: 12 }),
        win({ id: "seven_day", label: "Weekly", usedPercent: 62 }),
        win({ id: "oauth_weekly_all", label: "Weekly all", usedPercent: 62 }),
      ]).map((window) => window.id),
    ).toEqual(["five_hour", "seven_day"]);
  });
});

describe("padWindows", () => {
  it("pads a single window without claiming an unreported Current limit", () => {
    const padded = padWindows([
      { id: "seven_day", label: "Weekly", usedPercent: 4, resetsAt: null, windowSeconds: 604800 },
    ]);
    expect(padded).toHaveLength(2);
    expect(padded[1]?.label).toBe("Additional limit");
    expect(padded[1]?.usedPercent).toBeNull();
  });
});

describe("rich provider facts", () => {
  it("adds dial pages instead of clipping provider-specific metrics", () => {
    const supplementalMetrics = Array.from({ length: 13 }, (_, index) => ({
      id: `metric${index}`,
      label: `Metric ${index}`,
      value: index,
      unit: "count" as const,
      periodLabel: "Current",
    }));
    expect(usageFactsPageCount({
      facts: null,
      window: win({}),
      tokens: null,
      show: ["metrics"],
      supplementalMetrics,
      now: Date.now(),
    })).toBe(3);
  });
});
