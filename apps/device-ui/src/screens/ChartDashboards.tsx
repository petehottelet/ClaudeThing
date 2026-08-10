import { LineChart } from "../components/LineChart";
import type { CSSProperties, ReactNode } from "react";
import {
  ANALYTICS_RANGES,
  channelSeries,
  ga4Series,
  MARKET_INSTRUMENTS,
  type MarketInstrument,
  percentChange,
  sumPoints,
  WEEKLY_USAGE,
} from "../data/showcase";

function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

export function ChartShell({
  kicker,
  title,
  hint,
  metric,
  metricLabel,
  rangeLabel,
  accent,
  children,
  screenClassName = "",
}: {
  kicker: string;
  title: string;
  hint: string;
  metric: string;
  metricLabel: string;
  rangeLabel: string;
  accent: string;
  children: ReactNode;
  screenClassName?: string;
}) {
  return (
    <div className={`screen chart-screen ${screenClassName}`.trim()} style={{ "--chart-accent": accent } as CSSProperties}>
      <div className="hdr chart-header">
        <div>
          <div className="hdr-kicker">{kicker}</div>
          <div className="hdr-title chart-title">{title}</div>
        </div>
        <div className="hdr-spacer" />
        <div className="hdr-hint">{hint}</div>
      </div>
      <div className="chart-card">
        <div className="chart-summary">
          <div className="chart-metric">{metric}</div>
          <div className="chart-metric-label">{metricLabel}</div>
          <div className="chart-range-chip">{rangeLabel}</div>
        </div>
        <div className="chart-plot">{children}</div>
      </div>
    </div>
  );
}

export function WeeklyUsageDashboard() {
  return (
    <ChartShell
      kicker="AI USAGE"
      title="Usage by day"
      hint="7-day volume"
      metric={compact(sumPoints(WEEKLY_USAGE))}
      metricLabel="tokens this week"
      rangeLabel="MON — SUN"
      accent="#a78bfa"
    >
      <LineChart
        points={WEEKLY_USAGE}
        color="#a78bfa"
        formatValue={compact}
        ariaLabel="AI token usage by day from Monday through Sunday"
      />
    </ChartShell>
  );
}

export function YouTubeDashboard({ channelName, rangeIndex }: { channelName: string; rangeIndex: number }) {
  const range = ANALYTICS_RANGES[rangeIndex % ANALYTICS_RANGES.length] ?? ANALYTICS_RANGES[1]!;
  const series = channelSeries(channelName, range.id);
  return (
    <ChartShell
      kicker="YOUTUBE CHANNEL"
      title={channelName}
      hint={`${range.label} · ${rangeIndex + 1} / ${ANALYTICS_RANGES.length} · turn dial`}
      metric={compact(sumPoints(series))}
      metricLabel={`views ${range.periodLabel}`}
      rangeLabel={range.spanLabel}
      accent="#ff4e55"
    >
      <LineChart
        points={series}
        color="#ff4e55"
        formatValue={compact}
        ariaLabel={`${channelName} video views by day from Monday through Sunday`}
      />
    </ChartShell>
  );
}

export function Ga4Dashboard({ propertyName, rangeIndex }: { propertyName: string; rangeIndex: number }) {
  const range = ANALYTICS_RANGES[rangeIndex % ANALYTICS_RANGES.length] ?? ANALYTICS_RANGES[1]!;
  const series = ga4Series(propertyName, range.id);
  return (
    <ChartShell
      kicker="GOOGLE ANALYTICS 4"
      title={propertyName}
      hint={`${range.label} · ${rangeIndex + 1} / ${ANALYTICS_RANGES.length} · turn dial`}
      metric={compact(sumPoints(series))}
      metricLabel={`active users ${range.periodLabel}`}
      rangeLabel={range.spanLabel}
      accent="#f7c948"
    >
      <LineChart
        points={series}
        color="#f7c948"
        formatValue={compact}
        ariaLabel={`${propertyName} active users by day from Monday through Sunday`}
      />
    </ChartShell>
  );
}

export function MarketsDashboard({
  instrumentIndex,
  instruments = MARKET_INSTRUMENTS,
}: {
  instrumentIndex: number;
  instruments?: MarketInstrument[];
}) {
  const length = Math.max(1, instruments.length);
  const safeIndex = ((instrumentIndex % length) + length) % length;
  const instrument = instruments[safeIndex] ?? MARKET_INSTRUMENTS[0]!;
  const change = percentChange(instrument.points);
  const changeText = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
  return (
    <ChartShell
      key={instrument.id}
      kicker={instrument.symbol}
      title={instrument.name}
      hint={`${safeIndex + 1} / ${length} · auto · turn dial`}
      metric={changeText}
      metricLabel="7-day change"
      rangeLabel="MON — SUN"
      accent={change >= 0 ? "#54d17a" : "#e5484d"}
      screenClassName="market-wipe"
    >
      <LineChart
        points={instrument.points}
        color={change >= 0 ? "#54d17a" : "#e5484d"}
        formatValue={(value) => value.toFixed(1)}
        ariaLabel={`${instrument.name} normalized seven-day market chart`}
      />
    </ChartShell>
  );
}
