import type { DashboardMarketInstrument } from "@carthing/contracts";

export interface ChartPoint {
  label: string;
  value: number;
}

export interface MarketInstrument {
  id: string;
  symbol: string;
  name: string;
  points: ChartPoint[];
}

export type AnalyticsRangeId = "daily" | "weekly" | "monthly" | "year";

export interface AnalyticsRange {
  id: AnalyticsRangeId;
  label: string;
  spanLabel: string;
  periodLabel: string;
  labels: string[];
}

export const ANALYTICS_RANGES: AnalyticsRange[] = [
  {
    id: "daily",
    label: "Daily",
    spanLabel: "TODAY",
    periodLabel: "today",
    labels: ["12A", "4A", "8A", "12P", "4P", "8P"],
  },
  {
    id: "weekly",
    label: "Weekly",
    spanLabel: "MON — SUN",
    periodLabel: "this week",
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  },
  {
    id: "monthly",
    label: "Monthly",
    spanLabel: "4 WEEKS",
    periodLabel: "this month",
    labels: ["W1", "W2", "W3", "W4"],
  },
  {
    id: "year",
    label: "Year",
    spanLabel: "JAN — DEC",
    periodLabel: "this year",
    labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
];

const LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function points(values: number[]): ChartPoint[] {
  return values.map((value, index) => ({ label: LABELS[index] ?? "", value }));
}

function stringHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededWeek(seed: string, base: number, spread: number): ChartPoint[] {
  let state = stringHash(seed) || 1;
  const values: number[] = [];
  for (let index = 0; index < 7; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const centered = state / 0xffffffff - 0.5;
    const weeklyShape = [0.82, 0.96, 0.89, 1.08, 1.22, 1.04, 0.93][index] ?? 1;
    values.push(Math.round((base * weeklyShape + centered * spread) / 1000) * 1000);
  }
  return points(values);
}

function seededSeries(seed: string, labels: string[], base: number, spread: number): ChartPoint[] {
  let state = stringHash(seed) || 1;
  return labels.map((label, index) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const centered = state / 0xffffffff - 0.5;
    const pulse = [0.82, 0.96, 0.89, 1.08, 1.22, 1.04, 0.93][index % 7] ?? 1;
    return {
      label,
      value: Math.max(0, Math.round((base * pulse + centered * spread) / 100) * 100),
    };
  });
}

export const WEEKLY_USAGE = points([
  18_400_000,
  24_800_000,
  21_300_000,
  31_700_000,
  28_900_000,
  42_600_000,
  37_200_000,
]);

export const GA4_WEEK = points([8_420, 10_280, 9_740, 13_610, 15_940, 12_880, 17_260]);

/** Stable seven-day channel preview keyed to the configured display name. */
export function channelWeek(channelName: string): ChartPoint[] {
  return seededWeek(channelName, 720_000, 260_000);
}

export function channelSeries(channelName: string, range: AnalyticsRangeId): ChartPoint[] {
  const config = ANALYTICS_RANGES.find((candidate) => candidate.id === range) ?? ANALYTICS_RANGES[1]!;
  const base = { daily: 165_000, weekly: 720_000, monthly: 3_900_000, year: 14_500_000 }[range];
  const spread = { daily: 70_000, weekly: 260_000, monthly: 1_200_000, year: 5_000_000 }[range];
  return seededSeries(`${channelName}:${range}`, config.labels, base, spread);
}

export function ga4Series(propertyName: string, range: AnalyticsRangeId): ChartPoint[] {
  const config = ANALYTICS_RANGES.find((candidate) => candidate.id === range) ?? ANALYTICS_RANGES[1]!;
  const base = { daily: 1_950, weekly: 12_600, monthly: 58_000, year: 510_000 }[range];
  const spread = { daily: 800, weekly: 4_800, monthly: 21_000, year: 180_000 }[range];
  return seededSeries(`${propertyName}:${range}`, config.labels, base, spread);
}

export const MARKET_INSTRUMENTS: MarketInstrument[] = [
  {
    id: "nvda",
    symbol: "NVDA",
    name: "NVIDIA",
    points: points([100, 102.4, 101.1, 105.8, 108.2, 107.4, 111.6]),
  },
  {
    id: "sp500",
    symbol: "S&P 500",
    name: "Large-cap index",
    points: points([100, 100.7, 99.9, 101.4, 102.1, 101.8, 103.2]),
  },
  {
    id: "dow",
    symbol: "DOW",
    name: "Industrial index",
    points: points([100, 99.6, 100.3, 100.9, 101.7, 101.2, 102.4]),
  },
  {
    id: "total-market",
    symbol: "TOTAL",
    name: "Total stock market",
    points: points([100, 100.5, 99.7, 101.2, 102.4, 102.0, 103.8]),
  },
];

function instrumentKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** Resolve human-edited selections against the built-in preview catalog;
 * unknown symbols receive a stable normalized seven-day series. */
export function marketInstrumentsFromConfig(
  configured: DashboardMarketInstrument[],
): MarketInstrument[] {
  return configured.map((entry, index) => {
    const known = MARKET_INSTRUMENTS.find(
      (candidate) => instrumentKey(candidate.symbol) === instrumentKey(entry.symbol),
    );
    if (known) return { ...known, symbol: entry.symbol, name: entry.name };
    let state = stringHash(`${entry.symbol}:${entry.name}:${entry.kind}`) || 1;
    const values = [100];
    for (let day = 1; day < 7; day++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const move = (state / 0xffffffff - 0.48) * 3.2;
      values.push(Math.max(88, Math.min(114, values[day - 1]! + move)));
    }
    return {
      id: `${instrumentKey(entry.symbol).toLowerCase() || "market"}-${index}`,
      symbol: entry.symbol,
      name: entry.name,
      points: points(values),
    };
  });
}

export function sumPoints(series: ChartPoint[]): number {
  return series.reduce((total, point) => total + point.value, 0);
}

export function percentChange(series: ChartPoint[]): number {
  const first = series[0]?.value ?? 0;
  const last = series[series.length - 1]?.value ?? first;
  return first === 0 ? 0 : ((last - first) / first) * 100;
}
