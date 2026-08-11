import { describe, expect, it } from "vitest";
import {
  deriveState,
  dayKeyInTimeZone,
  formatAge,
  formatClock,
  formatResetCountdown,
  isTimeZone,
  isSnapshot,
  DEFAULT_DASHBOARD_CONFIG,
  normalizeInstant,
  normalizePercent,
  isProviderSnapshot,
  PROVIDER_CATALOG,
} from "../src/index";
import { FIXTURE_NAMES, makeFixture } from "../src/fixtures";

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

describe("normalizePercent", () => {
  it("passes valid values through", () => {
    expect(normalizePercent(50)).toEqual({ value: 50, diagnostic: null });
    expect(normalizePercent(0)).toEqual({ value: 0, diagnostic: null });
    expect(normalizePercent(100)).toEqual({ value: 100, diagnostic: null });
  });
  it("keeps null as null without diagnostics", () => {
    expect(normalizePercent(null)).toEqual({ value: null, diagnostic: null });
    expect(normalizePercent(undefined)).toEqual({ value: null, diagnostic: null });
  });
  it("clamps out-of-range values and records a diagnostic", () => {
    expect(normalizePercent(250)).toEqual({ value: 100, diagnostic: "percent_above_range" });
    expect(normalizePercent(-3)).toEqual({ value: 0, diagnostic: "percent_below_range" });
  });
  it("rejects non-numeric input", () => {
    expect(normalizePercent("abc")).toEqual({ value: null, diagnostic: "percent_not_numeric" });
    expect(normalizePercent(NaN)).toEqual({ value: null, diagnostic: "percent_not_numeric" });
  });
});

describe("normalizeInstant", () => {
  it("accepts epoch seconds and milliseconds", () => {
    const sec = normalizeInstant(1_754_654_400);
    const ms = normalizeInstant(1_754_654_400_000);
    expect(sec.value).toBe(ms.value);
    expect(sec.diagnostic).toBeNull();
  });
  it("accepts ISO strings", () => {
    expect(normalizeInstant("2026-08-08T12:00:00Z").value).toBe("2026-08-08T12:00:00.000Z");
  });
  it("rejects garbage", () => {
    expect(normalizeInstant("not-a-date").diagnostic).toBe("instant_invalid");
    expect(normalizeInstant({}).diagnostic).toBe("instant_invalid");
  });
});

describe("deriveState", () => {
  const t = { staleAfterSeconds: 1800, offlineAfterSeconds: 14400 };
  it("keeps fresh live data live", () => {
    expect(deriveState({ state: "live", observedAt: new Date(NOW - 60_000).toISOString() }, NOW, t)).toBe("live");
  });
  it("degrades by age", () => {
    expect(deriveState({ state: "live", observedAt: new Date(NOW - 45 * 60_000).toISOString() }, NOW, t)).toBe("stale");
    expect(deriveState({ state: "live", observedAt: new Date(NOW - 5 * 3600_000).toISOString() }, NOW, t)).toBe("offline");
  });
  it("never resurrects errors or unavailable", () => {
    expect(deriveState({ state: "error", observedAt: new Date(NOW).toISOString() }, NOW, t)).toBe("error");
    expect(deriveState({ state: "unavailable", observedAt: null }, NOW, t)).toBe("unavailable");
  });
  it("treats missing observations as unavailable", () => {
    expect(deriveState({ state: "live", observedAt: null }, NOW, t)).toBe("unavailable");
  });
});

describe("formatResetCountdown", () => {
  it("matches the reference presentation", () => {
    expect(formatResetCountdown(new Date(NOW + (82 * 60 + 30) * 1000).toISOString(), NOW)).toBe("Resets in 1h 23m");
    expect(formatResetCountdown(new Date(NOW + (6 * 86400 + 8 * 3600) * 1000).toISOString(), NOW)).toBe("Resets in 6d 8h");
  });
  it("handles the reset boundary and null", () => {
    expect(formatResetCountdown(new Date(NOW - 1000).toISOString(), NOW)).toBe("Resetting…");
    expect(formatResetCountdown(null, NOW)).toBeNull();
  });
});

describe("formatAge", () => {
  it("buckets ages honestly", () => {
    expect(formatAge(null, NOW)).toBe("never");
    expect(formatAge(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(formatAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    expect(formatAge(new Date(NOW - 26 * 3600_000).toISOString(), NOW)).toBe("1d 2h ago");
  });
});

describe("time-zone presentation", () => {
  const instant = Date.UTC(2026, 7, 10, 3, 47, 0);

  it("formats the same instant in the provisioned zone", () => {
    expect(formatClock(instant, "UTC")).toBe("03:47");
    expect(formatClock(instant, "America/Los_Angeles")).toBe("20:47");
    expect(dayKeyInTimeZone(instant, "America/Los_Angeles")).toBe("2026-08-09");
  });

  it("validates zones and safely falls back to UTC", () => {
    expect(isTimeZone("America/Los_Angeles")).toBe(true);
    expect(isTimeZone("PST-ish")).toBe(false);
    expect(formatClock(instant, "PST-ish")).toBe("03:47");
  });
});

describe("fixtures", () => {
  it("every fixture is a valid snapshot", () => {
    for (const name of FIXTURE_NAMES) {
      const snap = makeFixture(name, NOW);
      expect(isSnapshot(snap), name).toBe(true);
      for (const p of snap.providers) {
        for (const w of p.quotaWindows) {
          if (w.usedPercent !== null) {
            expect(w.usedPercent).toBeGreaterThanOrEqual(0);
            expect(w.usedPercent).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it("rejects unsupported schemas and malformed nested telemetry", () => {
    const valid = makeFixture("normal", NOW);
    expect(isSnapshot({ ...valid, schemaVersion: 1 })).toBe(false);
    expect(
      isSnapshot({
        ...valid,
        providers: [{ ...valid.providers[0], state: "definitely_live" }],
      }),
    ).toBe(false);
    expect(isSnapshot({ ...valid, dashboardConfig: DEFAULT_DASHBOARD_CONFIG })).toBe(true);
    expect(
      isSnapshot({
        ...valid,
        transport: {
          active: "usb",
          usb: { enabled: true, connected: true },
          bluetooth: { enabled: true, connected: false, standbyForUsb: true },
        },
      }),
    ).toBe(true);
    expect(
      isSnapshot({
        ...valid,
        transport: {
          active: "wifi",
          usb: { enabled: true, connected: true },
          bluetooth: { enabled: true, connected: false, standbyForUsb: true },
        },
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        ...valid,
        dashboardConfig: {
          ...DEFAULT_DASHBOARD_CONFIG,
          markets: { ...DEFAULT_DASHBOARD_CONFIG.markets, rotationSeconds: 0 },
        },
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        ...valid,
        providers: [
          {
            ...valid.providers[0],
            quotaWindows: [{ ...valid.providers[0]!.quotaWindows[0], usedPercent: 900 }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isSnapshot({
        ...valid,
        providers: [{ ...valid.providers[0], tokens: { ...valid.providers[0]!.tokens, periodStart: null } }],
      }),
    ).toBe(false);
  });
  it("tokensOnly carries live token telemetry with no quota windows", () => {
    const snap = makeFixture("tokensOnly", NOW);
    const claude = snap.providers.find((p) => p.id === "claude");
    expect(claude?.state).toBe("live");
    expect(claude?.quotaWindows).toHaveLength(0);
    expect(claude?.tokens?.total).toBeGreaterThan(0);
    expect(claude?.diagnostic).toBeNull();
  });
  it("firstConnect has no data pretending to be current", () => {
    const snap = makeFixture("firstConnect", NOW);
    for (const p of snap.providers) {
      expect(p.state).toBe("unavailable");
      expect(p.observedAt).toBeNull();
    }
  });
});

describe("provider platform contract", () => {
  it("ships the complete 65-provider catalog with unique safe ids", () => {
    expect(PROVIDER_CATALOG).toHaveLength(65);
    expect(new Set(PROVIDER_CATALOG.map((provider) => provider.id)).size).toBe(65);
    expect(PROVIDER_CATALOG.every((provider) => /^[a-z0-9._-]+$/.test(provider.id))).toBe(true);
    expect(PROVIDER_CATALOG.every((provider) => provider.description.length >= 60)).toBe(true);
    expect(new Set(PROVIDER_CATALOG.map((provider) => provider.description)).size).toBe(65);
    expect(PROVIDER_CATALOG.filter((provider) => provider.integration === "native").map((provider) => provider.id).sort()).toEqual(
      ["claude", "codex", "copilot", "cursor", "droid", "gemini"],
    );
  });

  it("validates rich cost, identity, health, capacity, and metric history", () => {
    expect(isProviderSnapshot({
      id: "openrouter",
      displayName: "OpenRouter",
      state: "live",
      observedAt: "2026-08-10T20:00:00.000Z",
      source: "json-bridge",
      host: "mac",
      quotaWindows: [],
      tokens: null,
      cost: { amountUsd: 2.5, isEstimate: true, label: "Estimate" },
      identity: { accountLabel: "Personal", plan: "PAYG", organization: null },
      serviceStatus: { state: "operational", label: "Operational", checkedAt: "2026-08-10T20:00:00.000Z" },
      supplementalMetrics: [{
        id: "requests",
        label: "Requests",
        value: 10,
        unit: "requests",
        periodLabel: "Month",
        limit: 100,
        remaining: 90,
        resetsAt: "2026-09-01T00:00:00.000Z",
      }],
      metricSeries: [{
        id: "spend",
        label: "Daily spend",
        unit: "usd",
        periodLabel: "Week",
        points: [{ date: "2026-08-09", value: 1 }, { date: "2026-08-10", value: 1.5 }],
      }],
      diagnostic: null,
    })).toBe(true);
  });
});
