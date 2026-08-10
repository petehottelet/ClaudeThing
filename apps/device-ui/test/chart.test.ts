import { describe, expect, it } from "vitest";
import { chartGeometry } from "../src/components/LineChart";
import {
  ANALYTICS_RANGES,
  channelSeries,
  channelWeek,
  ga4Series,
  MARKET_INSTRUMENTS,
  marketInstrumentsFromConfig,
  percentChange,
  sumPoints,
  WEEKLY_USAGE,
} from "../src/data/showcase";

describe("line-chart geometry", () => {
  it("creates finite paths and one dot per point", () => {
    const geometry = chartGeometry(WEEKLY_USAGE);
    expect(geometry.dots).toHaveLength(7);
    expect(geometry.linePath).toMatch(/^M/);
    expect(geometry.areaPath).toMatch(/Z$/);
    expect(geometry.linePath).not.toContain("NaN");
  });

  it("handles a flat series without division by zero", () => {
    const geometry = chartGeometry([
      { label: "Mon", value: 100 },
      { label: "Tue", value: 100 },
    ]);
    expect(geometry.linePath).not.toContain("NaN");
    expect(geometry.dots[0]?.y).toBe(geometry.dots[1]?.y);
  });
});

describe("dashboard series", () => {
  it("keeps channel previews stable per configured name and distinct across names", () => {
    expect(channelWeek("My Channel")).toEqual(channelWeek("My Channel"));
    expect(channelWeek("My Channel")).not.toEqual(channelWeek("Another Channel"));
    expect(channelWeek("My Channel")).toHaveLength(7);
  });

  it("provides Daily, Weekly, Monthly, and Year series for owner analytics", () => {
    expect(ANALYTICS_RANGES.map((range) => range.label)).toEqual([
      "Daily",
      "Weekly",
      "Monthly",
      "Year",
    ]);
    for (const range of ANALYTICS_RANGES) {
      expect(channelSeries("My Channel", range.id)).toHaveLength(range.labels.length);
      expect(ga4Series("My Website", range.id)).toHaveLength(range.labels.length);
    }
  });

  it("exposes individual, index, and total-market choices", () => {
    expect(MARKET_INSTRUMENTS.map((instrument) => instrument.id)).toEqual([
      "nvda",
      "sp500",
      "dow",
      "total-market",
    ]);
    for (const instrument of MARKET_INSTRUMENTS) {
      expect(instrument.points).toHaveLength(7);
      expect(Number.isFinite(percentChange(instrument.points))).toBe(true);
    }
  });

  it("resolves any configured market symbol to a stable seven-day view", () => {
    const configured = [
      { symbol: "NVDA", name: "My NVIDIA label", kind: "stock" as const },
      { symbol: "ACME", name: "Acme Corp", kind: "stock" as const },
    ];
    const first = marketInstrumentsFromConfig(configured);
    const second = marketInstrumentsFromConfig(configured);
    expect(first).toEqual(second);
    expect(first.map((instrument) => instrument.symbol)).toEqual(["NVDA", "ACME"]);
    expect(first[1]?.points).toHaveLength(7);
  });

  it("totals weekly series", () => {
    expect(sumPoints([{ label: "Mon", value: 2 }, { label: "Tue", value: 3 }])).toBe(5);
  });
});
