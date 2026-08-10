/**
 * Aggregations over a provider's usage history for the detail-screen chart
 * views. Range semantics:
 *   daily   — the rolling last 24 hours, hourly resolution
 *   weekly  — the last 7 days, daily resolution
 *   monthly — the last 30 days, daily resolution
 *   yearly  — the last 12 calendar months, monthly resolution
 *
 * Daily buckets carry the observing host's local-day keys; hourly buckets
 * are UTC hour instants rendered in the display time zone.
 *
 * Honesty rule: a bucket inside log coverage with no entry is a real zero
 * (logs were there, nothing ran); buckets before coverage began are unknown
 * and are omitted entirely, never drawn as zero.
 */

import { dayKeyInTimeZone, isTimeZone, type UsageHistoryDay, type UsageHistoryHour } from "@carthing/contracts";
import type { ChartPoint } from "./showcase";

export type HistoryRange = "daily" | "weekly" | "monthly" | "yearly";
export const HISTORY_RANGES: HistoryRange[] = ["daily", "weekly", "monthly", "yearly"];

export interface HistoryView {
  title: string;
  points: ChartPoint[];
  /** Total across the visible window. */
  metric: number;
  metricLabel: string;
  rangeLabel: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Noon-UTC parse keeps day arithmetic immune to DST length changes. */
function dateToMs(date: string): number {
  return Date.parse(`${date}T12:00:00.000Z`);
}

function msToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return msToDate(dateToMs(date) + days * DAY_MS);
}

export function monthLabel(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1] ?? key;
}

function localHourLabel(hourIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: isTimeZone(timeZone) ? timeZone : "UTC",
    hour: "2-digit",
    hour12: false,
  }).format(new Date(hourIso));
}

/** Blank out labels so at most `maxLabels` ticks render on a crowded axis. */
function thinLabels(points: ChartPoint[], maxLabels: number): ChartPoint[] {
  if (points.length <= maxLabels) return points;
  const step = Math.ceil(points.length / maxLabels);
  return points.map((point, index) =>
    index % step === 0 || index === points.length - 1 ? point : { ...point, label: "" },
  );
}

function sum(points: ChartPoint[]): number {
  return points.reduce((acc, point) => acc + point.value, 0);
}

/** Trailing daily window of `days` ending today, zero-filled inside coverage. */
function trailingDays(
  history: UsageHistoryDay[],
  today: string,
  days: number,
): ChartPoint[] {
  const byDate = new Map(history.map((day) => [day.date, day.total]));
  const oldest = history[0]?.date ?? today;
  const windowStart = addDays(today, -(days - 1));
  const from = windowStart < oldest ? oldest : windowStart;
  const points: ChartPoint[] = [];
  for (let date = from; date <= today; date = addDays(date, 1)) {
    points.push({ label: String(Number(date.slice(8, 10))), value: byDate.get(date) ?? 0 });
  }
  return points;
}

export function historyView(
  history: UsageHistoryDay[] | null,
  hourly: UsageHistoryHour[] | null,
  nowMs: number,
  timeZone: string,
  range: HistoryRange,
): HistoryView {
  const today = dayKeyInTimeZone(nowMs, timeZone);
  const days = history ?? [];

  if (range === "daily") {
    const entries = hourly ?? [];
    const byHour = new Map(entries.map((entry) => [entry.hour, entry.total]));
    const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const oldestMs = entries.length > 0 ? Date.parse(entries[0]!.hour) : currentHourMs;
    const windowStartMs = currentHourMs - 23 * HOUR_MS;
    const fromMs = Math.max(windowStartMs, oldestMs);
    const points: ChartPoint[] = [];
    for (let ms = fromMs; ms <= currentHourMs; ms += HOUR_MS) {
      const iso = new Date(ms).toISOString();
      points.push({ label: localHourLabel(iso, timeZone), value: byHour.get(iso) ?? 0 });
    }
    return {
      title: "Daily usage",
      points: thinLabels(points, 8),
      metric: sum(points),
      metricLabel: "tokens · last 24h",
      rangeLabel: `LAST ${points.length} HOURS`,
    };
  }

  if (range === "weekly") {
    const points = trailingDays(days, today, 7);
    return {
      title: "Weekly usage",
      points,
      metric: sum(points),
      metricLabel: "tokens · last 7 days",
      rangeLabel: `LAST ${points.length} DAYS`,
    };
  }

  if (range === "monthly") {
    const points = trailingDays(days, today, 30);
    return {
      title: "Monthly usage",
      points: thinLabels(points, 10),
      metric: sum(points),
      metricLabel: "tokens · last 30 days",
      rangeLabel: `LAST ${points.length} DAYS`,
    };
  }

  const totals = new Map<string, number>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    totals.set(key, (totals.get(key) ?? 0) + day.total);
  }
  const currentMonth = today.slice(0, 7);
  const oldestMonth = (days[0]?.date ?? today).slice(0, 7);
  const keys: string[] = [];
  let [year, month] = [Number(currentMonth.slice(0, 4)), Number(currentMonth.slice(5, 7))];
  for (let i = 0; i < 12; i++) {
    keys.unshift(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const points = keys
    .filter((key) => key >= oldestMonth)
    .map((key) => ({ label: monthLabel(key), value: totals.get(key) ?? 0 }));
  return {
    title: "Yearly usage",
    points,
    metric: sum(points),
    metricLabel: "tokens · last 12 months",
    rangeLabel: `LAST ${points.length} MONTHS`,
  };
}
