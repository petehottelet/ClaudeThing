import type { ProviderDisplayMetric, ProviderMetricSeries, ProviderSnapshot, SupplementalMetricUnit } from "@carthing/contracts";
import { deriveState, providerCatalogEntry } from "@carthing/contracts";
import {
  cardState,
  currentPeriodWindow,
  displayQuotaWindows,
  formatTokens,
  Meter,
  padWindows,
  placeholderWindows,
  tokenPeriodLabel,
  UsageFactsPanel,
  usageFactsPageCount,
} from "../components/Meter";
import { LineChart } from "../components/LineChart";
import { ProviderGlyph } from "../components/ProviderGlyph";
import { StatePill } from "../components/StatusRail";
import { humanizeDiagnostic } from "../data/diagnostics";
import { HISTORY_RANGES, historyView } from "../data/history";
import { ChartShell } from "./ChartDashboards";

interface ProviderDetailProps {
  provider: ProviderSnapshot;
  now: number;
  linkDown: boolean;
  windowPage: number;
  timeZone: string;
  metrics: ProviderDisplayMetric[];
}

const PROVIDER_ACCENT: Record<string, string> = {
  claude: "#d97757",
  codex: "#8fb6e8",
};

function providerAccent(id: string): string {
  return PROVIDER_ACCENT[id] ?? providerCatalogEntry(id)?.accent ?? "#a78bfa";
}

function formatSeriesValue(value: number, unit: SupplementalMetricUnit): string {
  if (unit === "usd") return `$${value.toFixed(2)}`;
  if (unit === "percent") return `${Math.round(value)}%`;
  if (unit === "kwh") return `${value.toFixed(1)} kWh`;
  if (unit === "seconds") return value >= 3600 ? `${(value / 3600).toFixed(1)}h` : `${Math.round(value / 60)}m`;
  return formatTokens(value);
}

function seriesPoints(series: ProviderMetricSeries) {
  return series.points.map((point) => ({
    label: `${Number(point.date.slice(5, 7))}/${Number(point.date.slice(8, 10))}`,
    value: point.value,
  }));
}

/** Meter pages ahead of the history views in the dial rotation. */
function hasFactsPage(metrics: ProviderDisplayMetric[]): boolean {
  return metrics.some((metric) =>
    metric.startsWith("metric:") ||
    ["identity", "status", "metrics"].includes(metric) ||
    ["resetCredits", "lifetimeTokens", "peakDailyTokens", "streak", "cost"].includes(metric),
  );
}

export function meterPageCount(p: ProviderSnapshot, metrics: ProviderDisplayMetric[] = ["quota"]): number {
  const quotaWindows = displayQuotaWindows(p.id, p.quotaWindows);
  const headline = currentPeriodWindow(quotaWindows);
  const factsPages = hasFactsPage(metrics)
    ? usageFactsPageCount({
        facts: p.usageFacts,
        window: headline,
        tokens: p.tokens,
        cost: p.cost,
        show: metrics,
        supplementalMetrics: p.supplementalMetrics,
        identity: p.identity,
        serviceStatus: p.serviceStatus,
        now: Date.now(),
      })
    : 0;
  if (!metrics.includes("quota")) return factsPages;
  if (factsPages > 0) return factsPages + Math.ceil(Math.max(0, quotaWindows.length - 1) / 2);
  return Math.max(1, Math.ceil(quotaWindows.length / 2));
}

/** Total dial pages: meter pages plus one view per history range. */
export function detailPageCount(p: ProviderSnapshot, metrics: ProviderDisplayMetric[] = ["quota", "history"]): number {
  const metricSeries = metrics.includes("metricHistory")
    ? (p.metricSeries ?? []).filter((series) => series.points.length > 0).length
    : 0;
  return Math.max(
    1,
    meterPageCount(p, metrics) +
      (metrics.includes("history") && (p.history?.length ?? 0) > 0 ? HISTORY_RANGES.length : 0) +
      metricSeries,
  );
}

/**
 * The provider's dedicated instrument screen:
 * provider header, two large stacked quota meters, compact token strip.
 */
export function ProviderDetail({ provider: p, now, linkDown, windowPage, timeZone, metrics }: ProviderDetailProps) {
  const derived = deriveState(p, now);
  const state = cardState(p, derived, linkDown);
  const degraded = state !== "live";
  const quotaWindows = displayQuotaWindows(p.id, p.quotaWindows);
  const missing = quotaWindows.length === 0;
  const meterPages = meterPageCount(p, metrics);
  const historyPages = metrics.includes("history") && (p.history?.length ?? 0) > 0 ? HISTORY_RANGES.length : 0;
  const providerSeries = metrics.includes("metricHistory")
    ? (p.metricSeries ?? []).filter((series) => series.points.length > 0)
    : [];
  const totalPages = detailPageCount(p, metrics);
  const page = windowPage % totalPages;

  // History views live after the meter pages in the dial rotation.
  if (page >= meterPages && page < meterPages + historyPages && p.history && p.history.length > 0) {
    const range = HISTORY_RANGES[(page - meterPages) % HISTORY_RANGES.length] ?? "daily";
    const view = historyView(p.history, p.hourly ?? null, now, timeZone, range);
    return (
      <ChartShell
        kicker={`${p.displayName.toUpperCase()} USAGE`}
        title={view.title}
        hint={`view ${page + 1} / ${totalPages} · turn dial`}
        metric={formatTokens(view.metric)}
        metricLabel={view.metricLabel}
        rangeLabel={view.rangeLabel}
        accent={providerAccent(p.id)}
      >
        <LineChart
          points={view.points}
          color={providerAccent(p.id)}
          formatValue={formatTokens}
          ariaLabel={`${p.displayName} ${view.title.toLowerCase()} from local logs`}
        />
      </ChartShell>
    );
  }

  if (page >= meterPages + historyPages && providerSeries.length > 0) {
    const series = providerSeries[(page - meterPages - historyPages) % providerSeries.length]!;
    const points = seriesPoints(series);
    const total = points.reduce((sum, point) => sum + point.value, 0);
    return (
      <ChartShell
        kicker={`${p.displayName.toUpperCase()} · ${series.periodLabel ?? "HISTORY"}`}
        title={series.label}
        hint={`view ${page + 1} / ${totalPages} · turn dial`}
        metric={formatSeriesValue(total, series.unit)}
        metricLabel={`${series.label.toLowerCase()} total`}
        rangeLabel={`${series.points[0]!.date} — ${series.points[series.points.length - 1]!.date}`}
        accent={providerAccent(p.id)}
      >
        <LineChart
          points={points}
          color={providerAccent(p.id)}
          formatValue={(value) => formatSeriesValue(value, series.unit)}
          ariaLabel={`${p.displayName} ${series.label.toLowerCase()} history`}
        />
      </ChartShell>
    );
  }

  const pageCount = Math.max(1, meterPages);
  const safePage = page % pageCount;
  const quotaVisible = metrics.includes("quota");
  const factsVisible = hasFactsPage(metrics);
  const headline = currentPeriodWindow(quotaWindows);
  const factsPages = factsVisible
    ? usageFactsPageCount({
        facts: p.usageFacts,
        window: headline,
        tokens: p.tokens,
        cost: p.cost,
        show: metrics,
        supplementalMetrics: p.supplementalMetrics,
        identity: p.identity,
        serviceStatus: p.serviceStatus,
        now,
      })
    : 0;
  const additionalWindows = quotaWindows.filter((window) => window.id !== headline.id);
  const windows =
    factsVisible && safePage < factsPages
      ? [headline]
      : missing
        ? placeholderWindows()
        : padWindows(
            factsVisible
              ? additionalWindows.slice((safePage - factsPages) * 2, (safePage - factsPages) * 2 + 2)
              : quotaWindows.slice(safePage * 2, safePage * 2 + 2),
          );
  const errorLabel = missing ? humanizeDiagnostic(p.diagnostic) : null;

  return (
    <div className="screen">
      <div className="hdr">
        <span className="hdr-glyph">
          <ProviderGlyph id={p.id} size={34} />
        </span>
        <span className="hdr-title">{p.displayName}</span>
        <div className="hdr-spacer" />
        {totalPages > 1 && (
          <span className="limit-page">view {page + 1} / {totalPages} · turn dial</span>
        )}
        {missing && !errorLabel && p.tokens && (
          // Quota absent but the token strip below is real — annotate the
          // empty meters here, where it costs no vertical space.
          <span className="limit-page">No quota reported</span>
        )}
        <span className="hdr-pill">
          <StatePill state={state} />
        </span>
      </div>

      <div className={factsVisible && safePage < factsPages ? "detail-meters codex-facts-layout" : "detail-meters"}>
        {quotaVisible && windows.map((w) => (
          <Meter key={w.id} window={w} now={now} degraded={degraded} />
        ))}
        {factsVisible && safePage < factsPages && (
          <UsageFactsPanel
            facts={p.usageFacts}
            window={windows[0]!}
            tokens={p.tokens}
            cost={p.cost}
            show={metrics}
            supplementalMetrics={p.supplementalMetrics}
            identity={p.identity}
            serviceStatus={p.serviceStatus}
            now={now}
            page={safePage}
            degraded={degraded}
          />
        )}
        {errorLabel && <div className="card-error detail-error">{errorLabel}</div>}
      </div>

      {p.tokens && metrics.includes("currentTokens") && (!factsVisible || safePage >= factsPages) && (
        <div className="token-strip">
          {p.tokens.input !== null && (
            <div className="token-cell">
              <div className="tk-label">Input</div>
              <div className="tk-value">{formatTokens(p.tokens.input)}</div>
            </div>
          )}
          {p.tokens.cachedInput !== null && (
            <div className="token-cell">
              <div className="tk-label">Cached</div>
              <div className="tk-value">{formatTokens(p.tokens.cachedInput)}</div>
            </div>
          )}
          {p.tokens.reasoning !== null && (
            <div className="token-cell">
              <div className="tk-label">Reasoning</div>
              <div className="tk-value">{formatTokens(p.tokens.reasoning)}</div>
            </div>
          )}
          {p.tokens.output !== null && (
            <div className="token-cell">
              <div className="tk-label">Output</div>
              <div className="tk-value">{formatTokens(p.tokens.output)}</div>
            </div>
          )}
          <div className="token-cell">
            <div className="tk-label">{tokenPeriodLabel(p.tokens, now, timeZone)}</div>
            <div className="tk-value">{formatTokens(p.tokens.total)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
