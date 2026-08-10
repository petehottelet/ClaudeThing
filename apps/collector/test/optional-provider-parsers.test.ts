import { describe, expect, it } from "vitest";
import { isProviderSnapshot } from "@carthing/contracts";
import { parseCopilotUsage } from "../src/adapters/copilot";
import { buildCursorEnrichment, parseCursorUsage } from "../src/adapters/cursor";
import { parseDroidUsage } from "../src/adapters/droid";
import { parseGeminiUsage } from "../src/adapters/gemini";

const observedAt = "2026-08-10T20:00:00.000Z";

describe("optional native provider parsers", () => {
  it("retains Cursor plan, on-demand, request, and identity data", () => {
    const snapshot = parseCursorUsage(
      {
        membershipType: "pro",
        billingCycleStart: "2026-08-01T00:00:00Z",
        billingCycleEnd: "2026-09-01T00:00:00Z",
        individualUsage: {
          plan: { used: 4250, limit: 10000, totalPercentUsed: 42.5 },
          onDemand: { used: 875, limit: 2500 },
        },
      },
      { email: "owner@example.test" },
      { gpt4: { numRequestsTotal: 120, maxRequestUsage: 500 } },
      "mac",
      observedAt,
    );
    expect(isProviderSnapshot(snapshot)).toBe(true);
    expect(snapshot.quotaWindows.map((window) => window.usedPercent)).toEqual([24, 35]);
    expect(snapshot.supplementalMetrics?.find((metric) => metric.id === "onDemandSpend")).toMatchObject({
      value: 8.75,
      limit: 25,
      remaining: 16.25,
    });
    expect(snapshot.identity).toMatchObject({ accountLabel: "owner@example.test", plan: "pro" });
  });

  it("aggregates Cursor cost, tokens, requests, and both timestamp forms", () => {
    const enrichment = buildCursorEnrichment([
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        chargedCents: 25,
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalCents: 40 },
      },
      {
        timestamp: Date.parse("2026-08-10T12:00:00.000Z") / 1000,
        chargedCents: 35,
        tokenUsage: { inputTokens: 200, outputTokens: 75, cacheReadTokens: 25, totalCents: 60 },
      },
    ]);
    expect(enrichment.cost).toMatchObject({ amountUsd: 1, isEstimate: true });
    expect(enrichment.supplementalMetrics).toEqual([
      expect.objectContaining({ id: "meteredCost30d", value: 0.6 }),
    ]);
    expect(enrichment.metricSeries.map((series) => series.id)).toEqual([
      "apiCost", "meteredCost", "tokens", "requests",
    ]);
    expect(enrichment.metricSeries.find((series) => series.id === "requests")?.points).toHaveLength(2);
  });

  it("retains all Droid rate-limit pools and extra-usage balance", () => {
    const snapshot = parseDroidUsage(
      {
        usesTokenRateLimitsBilling: true,
        extraUsageAllowed: true,
        extraUsageBalanceCents: 1234,
        limits: {
          standard: {
            fiveHour: { usedPercent: 22, secondsRemaining: 3600 },
            weekly: { usedPercent: 47, secondsRemaining: 86400 },
          },
          core: { monthly: { usedPercent: 61, windowEnd: "2026-09-01T00:00:00Z" } },
        },
      },
      {
        userProfile: { id: "u1", email: "owner@example.test" },
        organization: {
          name: "Example Org",
          subscription: { orbSubscription: { plan: { name: "Enterprise" } } },
        },
      },
      {},
      "mac",
      observedAt,
    );
    expect(isProviderSnapshot(snapshot)).toBe(true);
    expect(snapshot.quotaWindows.map((window) => window.label)).toEqual(["5-hour", "Weekly", "Core · Monthly"]);
    expect(snapshot.supplementalMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "extraUsageBalance", value: 12.34, unit: "usd" }),
      expect.objectContaining({ id: "extraUsageEnabled", value: 1 }),
    ]));
  });

  it("keeps every Gemini model bucket and the signed-in identity", () => {
    const payload = Buffer.from(JSON.stringify({ email: "owner@example.test", hd: "example.test" })).toString("base64url");
    const snapshot = parseGeminiUsage(
      {
        buckets: [
          { modelId: "gemini-2.5-pro", remainingFraction: 0.7, resetTime: "2026-08-11T00:00:00Z" },
          { modelId: "gemini-2.5-flash", remainingFraction: 0.2, resetTime: "2026-08-11T00:00:00Z" },
        ],
      },
      { currentTier: { id: "free-tier" } },
      `x.${payload}.x`,
      "mac",
      observedAt,
    );
    expect(isProviderSnapshot(snapshot)).toBe(true);
    expect(snapshot.quotaWindows).toHaveLength(2);
    expect(snapshot.quotaWindows.find((window) => window.id === "gemini-2.5-flash")?.usedPercent).toBe(80);
    expect(snapshot.identity).toEqual({
      accountLabel: "owner@example.test",
      plan: "Workspace",
      organization: "example.test",
    });
  });

  it("keeps Copilot quota, entitlement, remaining, and overage data", () => {
    const snapshot = parseCopilotUsage(
      {
        login: "owner",
        copilot_plan: "business",
        quota_reset_date_utc: "2026-09-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            percent_remaining: 74,
            credits_used: 26,
            entitlement: 100,
            quota_remaining: 74,
            overage_count: 3,
          },
          chat: { unlimited: true },
        },
      },
      "mac",
      observedAt,
    );
    expect(isProviderSnapshot(snapshot)).toBe(true);
    expect(snapshot.quotaWindows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "premium_interactions", usedPercent: 26 }),
      expect.objectContaining({ id: "chat", usedPercent: null, label: "Chat · Unlimited" }),
    ]));
    expect(snapshot.supplementalMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "premium_interactions.credits", value: 26, limit: 100, remaining: 74 }),
      expect.objectContaining({ id: "premium_interactions.overage", value: 3 }),
    ]));
  });
});
