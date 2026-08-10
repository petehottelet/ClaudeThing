/**
 * History aggregation honesty under the range semantics:
 * daily = rolling 24 hourly buckets, weekly = last 7 days, monthly = last 30
 * days, yearly = last 12 months. Zeros only inside log coverage; buckets
 * before coverage are omitted, never faked.
 */

import { describe, expect, it } from "vitest";
import type { UsageHistoryDay, UsageHistoryHour } from "@carthing/contracts";
import { addDays, historyView } from "../src/data/history";

const NOW = Date.parse("2026-08-09T19:30:00.000-07:00"); // 02:30Z Aug 10
const TZ = "America/Los_Angeles";

function daySeries(from: string, days: number, value: (i: number) => number): UsageHistoryDay[] {
  const out: UsageHistoryDay[] = [];
  for (let i = 0; i < days; i++) out.push({ date: addDays(from, i), total: value(i) });
  return out;
}

function hourSeries(endMs: number, hours: number, value: (i: number) => number): UsageHistoryHour[] {
  const out: UsageHistoryHour[] = [];
  const endHour = Math.floor(endMs / 3_600_000) * 3_600_000;
  for (let i = hours - 1; i >= 0; i--) {
    out.push({ hour: new Date(endHour - i * 3_600_000).toISOString(), total: value(hours - 1 - i) });
  }
  return out;
}

describe("daily (rolling 24 hours)", () => {
  it("shows 24 hourly buckets ending at the current hour with local labels", () => {
    const hourly = hourSeries(NOW, 30, () => 5);
    const view = historyView(null, hourly, NOW, TZ, "daily");
    expect(view.points).toHaveLength(24);
    expect(view.metric).toBe(24 * 5);
    // 02:30Z floors to 02:00Z = 19:00 PDT; the last visible tick is "19".
    expect(view.points[view.points.length - 1]?.label).toBe("19");
    expect(view.rangeLabel).toBe("LAST 24 HOURS");
  });

  it("omits hours before coverage instead of zero-filling them", () => {
    const hourly = hourSeries(NOW, 6, () => 3);
    const view = historyView(null, hourly, NOW, TZ, "daily");
    expect(view.points).toHaveLength(6);
    expect(view.metric).toBe(18);
  });

  it("zero-fills gaps inside hourly coverage", () => {
    const hourly = hourSeries(NOW, 10, (i) => (i === 4 ? 0 : 2)).filter((entry) => entry.total > 0);
    const view = historyView(null, hourly, NOW, TZ, "daily");
    expect(view.points.filter((p) => p.value === 0)).toHaveLength(1);
  });
});

describe("weekly (last 7 days)", () => {
  it("shows exactly the trailing week with zero-fill inside coverage", () => {
    const history: UsageHistoryDay[] = [
      { date: "2026-08-03", total: 10 },
      { date: "2026-08-06", total: 20 },
      { date: "2026-08-09", total: 30 },
    ];
    const view = historyView(history, null, NOW, TZ, "weekly");
    expect(view.points).toHaveLength(7); // Aug 3 → Aug 9
    expect(view.metric).toBe(60);
    expect(view.points[0]).toEqual({ label: "3", value: 10 });
    expect(view.points[1]).toEqual({ label: "4", value: 0 });
  });
});

describe("monthly (last 30 days)", () => {
  it("spans 30 days with thinned labels and a window total", () => {
    const history = daySeries(addDays("2026-08-09", -40), 41, () => 2);
    const view = historyView(history, null, NOW, TZ, "monthly");
    expect(view.points).toHaveLength(30);
    expect(view.metric).toBe(60);
    const labeled = view.points.filter((p) => p.label !== "");
    expect(labeled.length).toBeLessThanOrEqual(11);
    expect(view.points[view.points.length - 1]?.label).toBe("9");
  });
});

describe("yearly (last 12 months)", () => {
  it("groups the trailing year by calendar month", () => {
    const history = daySeries("2026-06-15", 56, () => 2); // Jun 15 → Aug 9
    const view = historyView(history, null, NOW, TZ, "yearly");
    expect(view.points.map((p) => p.label)).toEqual(["Jun", "Jul", "Aug"]);
    expect(view.points[1]?.value).toBe(62);
    expect(view.metric).toBe(32 + 62 + 18);
  });
});
