/**
 * Synthetic snapshot fixtures covering every display state the UI must render.
 * Timestamps are generated relative to `now` so countdowns and ages stay alive
 * in previews and tests.
 */

import type { ProviderSnapshot, Snapshot, UsageHistoryDay, UsageHistoryHour } from "./index";
import { SCHEMA_VERSION } from "./index";

function iso(nowMs: number, offsetSeconds: number): string {
  return new Date(nowMs + offsetSeconds * 1000).toISOString();
}

/**
 * Local calendar day, matching how collectors bucket "today" token summaries.
 * A UTC slice would flip the fixture's bucket to "yesterday" every evening
 * west of Greenwich, making previews render a date chip instead of "Today".
 */
function localDay(nowMs: number): string {
  return new Date(nowMs - new Date(nowMs).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Deterministic daily-usage series ending today: a weekly rhythm plus a
 * slow trend, so daily/weekly/monthly/yearly aggregations all show shape
 * without any randomness (previews and tests stay reproducible).
 */
function historyDays(nowMs: number, days: number, base: number, swing: number): UsageHistoryDay[] {
  const out: UsageHistoryDay[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const dayMs = nowMs - back * 86_400_000;
    const weekly = Math.sin(((days - back) / 7) * Math.PI * 2);
    const trend = (days - back) / days;
    const total = Math.max(0, Math.round(base * (0.55 + 0.45 * trend) + swing * weekly));
    out.push({ date: localDay(dayMs), total });
  }
  // De-duplicate any DST-fold day collisions while preserving ascending order.
  return out.filter((day, i) => i === 0 || day.date > out[i - 1]!.date);
}

/** Deterministic hourly series ending at the current hour (a work-day wave). */
function hourlySeries(nowMs: number, hoursBack: number, peak: number): UsageHistoryHour[] {
  const out: UsageHistoryHour[] = [];
  const currentHourMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  for (let back = hoursBack - 1; back >= 0; back--) {
    const hourMs = currentHourMs - back * 3_600_000;
    const hourOfDay = new Date(hourMs).getUTCHours();
    const wave = Math.max(0, Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2));
    out.push({ hour: new Date(hourMs).toISOString(), total: Math.round(peak * wave) });
  }
  return out;
}

function baseSnapshot(nowMs: number, providers: ProviderSnapshot[]): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: "1.1.0-fixture",
    host: "pc",
    generatedAt: iso(nowMs, 0),
    serverTime: iso(nowMs, 0),
    providers,
  };
}

function claude(nowMs: number, over: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: "claude",
    displayName: "Claude",
    state: "live",
    observedAt: iso(nowMs, -35),
    source: "oauth",
    host: "pc",
    quotaWindows: [
      {
        id: "five_hour",
        label: "Current session",
        usedPercent: 100,
        resetsAt: iso(nowMs, 2 * 3600 + 14 * 60),
        windowSeconds: 5 * 3600,
      },
      {
        id: "seven_day",
        label: "All models",
        usedPercent: 30,
        resetsAt: iso(nowMs, 4 * 86400 + 6 * 3600),
        windowSeconds: 7 * 86400,
      },
      {
        id: "oauth_weekly_scoped_fable",
        label: "Fable",
        usedPercent: 58,
        resetsAt: iso(nowMs, 4 * 86400 + 6 * 3600),
        windowSeconds: 7 * 86400,
      },
    ],
    tokens: {
      input: 1_284_331,
      cachedInput: 9_411_202,
      reasoning: null,
      output: 202_118,
      total: 10_897_651,
      period: "today",
      periodStart: localDay(nowMs),
    },
    cost: null,
    history: historyDays(nowMs, 210, 52_000_000, 21_000_000),
    hourly: hourlySeries(nowMs, 30, 6_500_000),
    diagnostic: null,
    ...over,
  };
}

function codex(nowMs: number, over: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: "codex",
    displayName: "Codex",
    state: "live",
    observedAt: iso(nowMs, -12),
    source: "app-server",
    host: "mac",
    quotaWindows: [
      {
        id: "primary",
        label: "Current",
        usedPercent: 27,
        resetsAt: iso(nowMs, 3 * 3600 + 41 * 60),
        windowSeconds: 5 * 3600,
      },
      {
        id: "secondary",
        label: "Weekly",
        usedPercent: 64,
        resetsAt: iso(nowMs, 2 * 86400 + 14 * 3600),
        windowSeconds: 7 * 86400,
      },
    ],
    tokens: {
      input: 2_204_998,
      cachedInput: 12_090_112,
      reasoning: 501_770,
      output: 310_226,
      total: 15_107_106,
      period: "today",
      periodStart: localDay(nowMs),
    },
    cost: null,
    history: historyDays(nowMs, 210, 88_000_000, 30_000_000),
    hourly: hourlySeries(nowMs, 30, 9_800_000),
    usageFacts: {
      resetCreditsAvailable: 1,
      resetCreditExpiresAt: iso(nowMs, 2 * 86400),
      lifetimeTokens: 1_284_000_000,
      peakDailyTokens: 118_000_000,
      currentStreakDays: 12,
      longestStreakDays: 29,
      longestRunningTurnSeconds: 2_842,
    },
    diagnostic: null,
    ...over,
  };
}

export type FixtureName =
  | "normal"
  | "warning"
  | "exhausted"
  | "justReset"
  | "stale"
  | "offline"
  | "partialError"
  | "missingWindows"
  | "tokensOnly"
  | "multiWindow"
  | "providerShowcase"
  | "firstConnect";

export function makeFixture(name: FixtureName, nowMs: number = Date.now()): Snapshot {
  switch (name) {
    case "normal":
      return baseSnapshot(nowMs, [claude(nowMs), codex(nowMs)]);

    case "providerShowcase": {
      const provider = (
        id: string,
        displayName: string,
        current: number,
        weekly: number,
        plan: string,
        metrics: ProviderSnapshot["supplementalMetrics"],
      ): ProviderSnapshot => ({
        id,
        displayName,
        state: "live",
        observedAt: iso(nowMs, -18),
        source: `${id}-preview`,
        host: "mac",
        quotaWindows: [
          { id: "current", label: "Current", usedPercent: current, resetsAt: iso(nowMs, 3 * 3600), windowSeconds: 5 * 3600 },
          { id: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: iso(nowMs, 4 * 86400), windowSeconds: 7 * 86400 },
        ],
        tokens: null,
        cost: id === "cursor" ? { amountUsd: 18.42, isEstimate: true, label: "API-rate · 30d" } : null,
        identity: { accountLabel: "Personal", plan, organization: null },
        supplementalMetrics: metrics,
        metricSeries: [{
          id: "dailyActivity",
          label: id === "cursor" ? "Daily spend" : "Daily requests",
          unit: id === "cursor" ? "usd" : "requests",
          periodLabel: "Last 7 days",
          points: historyDays(nowMs, 7, id === "cursor" ? 3 : 420, id === "cursor" ? 1 : 120)
            .map((point) => ({ date: point.date, value: point.total })),
        }],
        diagnostic: null,
      });
      return baseSnapshot(nowMs, [
        provider("cursor", "Cursor", 38, 57, "Pro", [
          { id: "includedSpend", label: "Included usage", value: 42.5, unit: "usd", periodLabel: "Billing cycle", limit: 100, remaining: 57.5 },
          { id: "onDemandSpend", label: "Extra usage", value: 8.75, unit: "usd", periodLabel: "Billing cycle", limit: 25, remaining: 16.25 },
          { id: "requests", label: "Requests", value: 1820, unit: "requests", periodLabel: "Billing cycle", limit: 5000, remaining: 3180 },
        ]),
        provider("droid", "Droid", 22, 47, "Enterprise", [
          { id: "extraUsageBalance", label: "Extra usage balance", value: 12.34, unit: "usd", periodLabel: "Available" },
          { id: "coreTokens", label: "Core tokens", value: 8_400_000, unit: "tokens", periodLabel: "This month", limit: 20_000_000, remaining: 11_600_000 },
        ]),
        provider("gemini", "Gemini", 30, 64, "Workspace", [
          { id: "modelBuckets", label: "Model buckets", value: 4, unit: "count", periodLabel: "Available" },
        ]),
        provider("copilot", "Copilot", 26, 41, "Business", [
          { id: "premiumCredits", label: "Premium credits", value: 26, unit: "requests", periodLabel: "Current cycle", limit: 100, remaining: 74 },
          { id: "overage", label: "Overage", value: 3, unit: "requests", periodLabel: "Current cycle" },
        ]),
      ]);
    }

    case "warning":
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          quotaWindows: [
            { id: "five_hour", label: "Current", usedPercent: 82, resetsAt: iso(nowMs, 47 * 60), windowSeconds: 18000 },
            { id: "seven_day", label: "Weekly", usedPercent: 68, resetsAt: iso(nowMs, 3 * 86400 + 2 * 3600), windowSeconds: 604800 },
          ],
        }),
        codex(nowMs, {
          quotaWindows: [
            { id: "primary", label: "Current", usedPercent: 91, resetsAt: iso(nowMs, 22 * 60), windowSeconds: 18000 },
            { id: "secondary", label: "Weekly", usedPercent: 74, resetsAt: iso(nowMs, 86400 + 9 * 3600), windowSeconds: 604800 },
          ],
        }),
      ]);

    case "exhausted":
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          quotaWindows: [
            { id: "five_hour", label: "Current", usedPercent: 100, resetsAt: iso(nowMs, 96 * 60), windowSeconds: 18000 },
            { id: "seven_day", label: "Weekly", usedPercent: 88, resetsAt: iso(nowMs, 2 * 86400), windowSeconds: 604800 },
          ],
        }),
        codex(nowMs),
      ]);

    case "justReset":
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          quotaWindows: [
            { id: "five_hour", label: "Current", usedPercent: 0, resetsAt: iso(nowMs, 5 * 3600), windowSeconds: 18000 },
            { id: "seven_day", label: "Weekly", usedPercent: 12, resetsAt: iso(nowMs, 5 * 86400), windowSeconds: 604800 },
          ],
        }),
        codex(nowMs),
      ]);

    case "stale":
      // The five-hour reset has already passed while the data aged — the UI
      // must not show a live-looking countdown for it.
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          state: "stale",
          observedAt: iso(nowMs, -52 * 60),
          quotaWindows: [
            { id: "five_hour", label: "Current", usedPercent: 50, resetsAt: iso(nowMs, -12 * 60), windowSeconds: 18000 },
            { id: "seven_day", label: "Weekly", usedPercent: 11, resetsAt: iso(nowMs, 6 * 86400 + 8 * 3600), windowSeconds: 604800 },
          ],
        }),
        codex(nowMs, { state: "stale", observedAt: iso(nowMs, -41 * 60) }),
      ]);

    case "offline":
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          state: "offline",
          observedAt: iso(nowMs, -7 * 3600),
          quotaWindows: [
            { id: "five_hour", label: "Current", usedPercent: 50, resetsAt: iso(nowMs, -6 * 3600), windowSeconds: 18000 },
            { id: "seven_day", label: "Weekly", usedPercent: 11, resetsAt: iso(nowMs, 6 * 86400), windowSeconds: 604800 },
          ],
        }),
        codex(nowMs, { state: "offline", observedAt: iso(nowMs, -6 * 3600) }),
      ]);

    case "partialError":
      return baseSnapshot(nowMs, [
        claude(nowMs),
        codex(nowMs, {
          state: "error",
          observedAt: iso(nowMs, -6 * 60),
          quotaWindows: [],
          tokens: null,
          diagnostic: "APP_SERVER_UNREACHABLE",
        }),
      ]);

    case "missingWindows":
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          quotaWindows: [
            { id: "five_hour", label: "Current", usedPercent: 37, resetsAt: null, windowSeconds: null },
            { id: "seven_day", label: "Weekly", usedPercent: null, resetsAt: iso(nowMs, 4 * 86400), windowSeconds: 604800 },
          ],
        }),
        codex(nowMs, { quotaWindows: [], diagnostic: "RATE_LIMITS_MISSING" }),
      ]);

    case "tokensOnly":
      // The desktop-only Claude reality: JSONL transcripts supply token
      // telemetry but no status line ever runs, so quota windows never
      // arrive. The card must show the tokens, not "NO DATA".
      return baseSnapshot(nowMs, [
        claude(nowMs, {
          source: "jsonl",
          observedAt: iso(nowMs, -25),
          quotaWindows: [],
          tokens: {
            input: 4_517,
            cachedInput: 54_708_440,
            reasoning: null,
            output: 280_474,
            total: 54_993_431,
            period: "today",
            periodStart: localDay(nowMs),
          },
        }),
        codex(nowMs),
      ]);

    case "multiWindow":
      return baseSnapshot(nowMs, [
        claude(nowMs),
        codex(nowMs, {
          quotaWindows: [
            { id: "codex:primary", label: "Current", usedPercent: 27, resetsAt: iso(nowMs, 3 * 3600), windowSeconds: 18000 },
            { id: "codex:secondary", label: "Weekly", usedPercent: 64, resetsAt: iso(nowMs, 2 * 86400), windowSeconds: 604800 },
            { id: "reviews:primary", label: "Code reviews · Current", usedPercent: 42, resetsAt: iso(nowMs, 55 * 60), windowSeconds: 3600 },
            { id: "cloud:primary", label: "Cloud tasks with an unusually long translated label · Current", usedPercent: 18, resetsAt: iso(nowMs, 2 * 3600), windowSeconds: 7200 },
          ],
        }),
      ]);

    case "firstConnect":
      return baseSnapshot(nowMs, [
        claude(nowMs, { state: "unavailable", observedAt: null, quotaWindows: [], tokens: null, source: null }),
        codex(nowMs, { state: "unavailable", observedAt: null, quotaWindows: [], tokens: null, source: null }),
      ]);
  }
}

export const FIXTURE_NAMES: FixtureName[] = [
  "normal",
  "warning",
  "exhausted",
  "justReset",
  "stale",
  "offline",
  "partialError",
  "missingWindows",
  "tokensOnly",
  "multiWindow",
  "providerShowcase",
  "firstConnect",
];
