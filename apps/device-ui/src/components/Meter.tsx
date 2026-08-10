import type {
  CostEstimate,
  ProviderDisplayMetric,
  ProviderIdentitySummary,
  ProviderServiceStatus,
  ProviderSnapshot,
  ProviderState,
  ProviderUsageFacts,
  QuotaWindow,
  SupplementalUsageMetric,
  TokenSummary,
} from "@carthing/contracts";
import { dayKeyInTimeZone, formatResetCountdown } from "@carthing/contracts";

/**
 * A card must not present as LIVE while showing nothing: with neither quota
 * windows nor token telemetry it degrades to "unavailable". Tokens without
 * quota stay LIVE — the card renders the token panel, so data really is on
 * screen (the desktop-only Claude reality: JSONL tokens, no status-line
 * quota). Likewise, a dead link caps every card at "stale": data can't be
 * LIVE when nothing can reach us.
 */
export function cardState(
  p: ProviderSnapshot,
  derived: ProviderState,
  linkDown = false,
): ProviderState {
  let s = derived;
  if (
    p.quotaWindows.length === 0 &&
    p.tokens === null &&
    p.cost === null &&
    !p.usageFacts &&
    !(p.supplementalMetrics?.length) &&
    !p.identity &&
    !p.serviceStatus &&
    !(p.metricSeries?.length) &&
    (s === "live" || s === "stale")
  ) {
    s = "unavailable";
  }
  if (linkDown && s === "live") s = "stale";
  return s;
}

/** Two placeholder rows keeping the Current/Weekly grid identity. */
export function placeholderWindows(): QuotaWindow[] {
  return [
    { id: "ph_current", label: "Current", usedPercent: null, resetsAt: null, windowSeconds: null },
    { id: "ph_weekly", label: "Weekly", usedPercent: null, resetsAt: null, windowSeconds: null },
  ];
}

/** Pad a one-window list without implying that an unreported quota exists. */
export function padWindows(ws: QuotaWindow[]): QuotaWindow[] {
  if (ws.length !== 1) return ws;
  return [
    ws[0]!,
    { id: "ph_additional", label: "Additional limit", usedPercent: null, resetsAt: null, windowSeconds: null },
  ];
}

/**
 * Keep the overview's primary comparison stable without duplicating a single
 * provider-reported window. Default (unnamed) limits are account-wide and
 * always beat named per-model limits. A lone window is labeled generically as
 * Current period because its actual duration remains visible in reset data.
 */
export function cardWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const isShort = (w: QuotaWindow): boolean =>
    w.windowSeconds !== null && w.windowSeconds <= 12 * 3600;
  const isLong = (w: QuotaWindow): boolean =>
    w.windowSeconds !== null && w.windowSeconds >= 3 * 86400;
  // Our labeling convention marks named-limit windows with "<name> · <kind>".
  const isDefaultLimit = (w: QuotaWindow): boolean => !w.label.includes("·");
  const pick = (pred: (w: QuotaWindow) => boolean): QuotaWindow | null =>
    windows.find((w) => pred(w) && isDefaultLimit(w)) ?? windows.find(pred) ?? null;

  const currentSource = pick(isShort) ?? windows.find(isDefaultLimit) ?? windows[0] ?? null;
  const weeklySource =
    windows.find((window) => isLong(window) && isDefaultLimit(window)) ??
    pick(isLong);
  if (currentSource && weeklySource?.id === currentSource.id) {
    return [{ ...currentSource, label: "Current period" }];
  }
  const current = currentSource
    ? {
        ...currentSource,
        label: isShort(currentSource)
          ? currentSource.label
          : currentSource.label.includes("·")
            ? currentSource.label.replace(/ · (?:Current|Weekly)$/, " · Current")
            : "Current",
      }
    : { id: "ph_current", label: "Current", usedPercent: null, resetsAt: null, windowSeconds: null };
  return [
    current,
    weeklySource
      ? { ...weeklySource, label: "Weekly" }
      : { id: "ph_weekly", label: "Weekly", usedPercent: null, resetsAt: null, windowSeconds: null },
  ];
}

/** Account-wide window to use for the Codex headline. Named/model-specific
 * limits stay on the detail dial pages. */
export function currentPeriodWindow(windows: QuotaWindow[]): QuotaWindow {
  const accountWide = windows.find((window) => !window.label.includes("·"));
  const source = accountWide ?? windows[0] ?? null;
  return source
    ? { ...source, label: "Current period" }
    : {
        id: "ph_current_period",
        label: "Current period",
        usedPercent: null,
        resetsAt: null,
        windowSeconds: null,
      };
}

/** Provider headline quotas deliberately exclude duplicate telemetry scopes.
 * Claude keeps its current, all-model, and named model allowances distinct;
 * Codex keeps its account-wide all-model period only. */
export function displayQuotaWindows(providerId: string, windows: QuotaWindow[]): QuotaWindow[] {
  if (windows.length === 0) return [];
  if (providerId === "claude") {
    const byId = new Map(windows.map((window) => [window.id, window]));
    const ordered = [byId.get("five_hour"), byId.get("seven_day")]
      .filter((window): window is QuotaWindow => window !== undefined);
    for (const window of windows) {
      if (window.id === "five_hour" || window.id === "seven_day" || window.id === "oauth_weekly_all") continue;
      ordered.push(window);
    }
    return ordered;
  }
  if (providerId === "codex") return [currentPeriodWindow(windows)];
  return windows;
}

/**
 * One quota meter card, the product's core instrument:
 * big percentage · label chip · progress bar · reset countdown.
 * Bar color is a status encoding (ok → warn → hot → crit) and is never
 * the only signal: the numeral and countdown always carry the value.
 */

export function usageTone(usedPercent: number | null): "ok" | "warn" | "hot" | "crit" {
  if (usedPercent === null) return "ok";
  if (usedPercent >= 100) return "crit";
  if (usedPercent >= 80) return "hot";
  if (usedPercent >= 50) return "warn";
  return "ok";
}

/** Compact display form for token counts: 54993431 → "55.0M". */
export function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Period chip text for a token summary. "Today" only when the summary's
 * calendar bucket matches today in the displayed time zone — a stale bucket
 * shows its own date rather than masquerading as current.
 */
export function tokenPeriodLabel(tokens: TokenSummary, now: number, timeZone: string): string {
  if (tokens.period === "today") {
    return tokens.periodStart === dayKeyInTimeZone(now, timeZone)
      ? "Today"
      : (tokens.periodStart ?? "Daily");
  }
  return tokens.period;
}

interface MeterProps {
  window: QuotaWindow;
  now: number;
  degraded?: boolean;
  compact?: boolean;
}

export function Meter({ window: w, now, degraded = false, compact = false }: MeterProps) {
  const pct = w.usedPercent;
  const known = pct !== null;
  const tone = usageTone(pct);
  const countdown = formatResetCountdown(w.resetsAt, now);
  // A reset instant in the past means the stored percentage is definitely
  // obsolete. Live data momentarily shows "Resetting…" (a refresh is due);
  // degraded data must say plainly that the window already rolled over.
  const expired = countdown === "Resetting…";
  const resetLine = known
    ? degraded && expired
      ? "Reset passed · awaiting fresh data"
      : (countdown ?? "No reset time reported")
    : "No data";

  const className = [
    "meter",
    compact ? "compact" : "",
    degraded ? "is-degraded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <div className="meter-top">
        <div className={known ? "meter-pct" : "meter-pct is-unknown"}>
          {known ? (
            <>
              {Math.round(pct)}
              <span className="pct-sign">%</span>
            </>
          ) : (
            "—"
          )}
        </div>
        <div className="chip" title={w.label}>{w.label}</div>
      </div>
      <div
        className={known ? "bar" : "bar is-unknown"}
        role="progressbar"
        aria-label={`${w.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(pct) : undefined}
        aria-valuetext={known ? `${Math.round(pct)}% used` : "Usage unavailable"}
      >
        {known && (
          <div
            className={`bar-fill tone-${tone}`}
            style={{ transform: `scaleX(${Math.max(pct > 0 ? 2 : 0, pct) / 100})` }}
          />
        )}
      </div>
      <div className="meter-reset">{resetLine}</div>
    </div>
  );
}

interface TokenPanelProps {
  tokens: TokenSummary;
  now: number;
  timeZone: string;
  degraded?: boolean;
  compact?: boolean;
}

/**
 * Token instrument for a provider whose only telemetry is token counts —
 * quota meters would be empty, but the card still has real data to show:
 * big total · period chip · input/cached/output breakdown line. Reuses the
 * meter's visual classes so compact sizing and degraded dimming match.
 */
export function TokenPanel({ tokens, now, timeZone, degraded = false, compact = false }: TokenPanelProps) {
  const breakdown = [
    tokens.input !== null ? `In ${formatTokens(tokens.input)}` : null,
    tokens.cachedInput !== null ? `Cached ${formatTokens(tokens.cachedInput)}` : null,
    tokens.reasoning !== null ? `Reasoning ${formatTokens(tokens.reasoning)}` : null,
    tokens.output !== null ? `Out ${formatTokens(tokens.output)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const className = [
    "meter",
    "token-panel",
    compact ? "compact" : "",
    degraded ? "is-degraded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <div className="meter-top">
        <div className="meter-pct token-total">{formatTokens(tokens.total)}</div>
        <div className="chip">Tokens · {tokenPeriodLabel(tokens, now, timeZone)}</div>
      </div>
      {breakdown && <div className="meter-reset">{breakdown}</div>}
    </div>
  );
}

function shortCountdown(instant: string | null, now: number): string | null {
  const text = formatResetCountdown(instant, now);
  if (!text) return null;
  if (text === "Resetting…") return "Now";
  return text.replace(/^Resets /, "");
}

function formatSupplementalMetric(metric: SupplementalUsageMetric): string {
  if (metric.value === null) return "—";
  if (metric.unit === "tokens") return formatTokens(metric.value);
  if (metric.unit === "usd") return `$${metric.value.toFixed(2)}`;
  if (metric.unit === "percent") return `${Math.round(metric.value)}%`;
  if (metric.unit === "seconds") {
    const minutes = Math.round(metric.value / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  }
  if (metric.unit === "kwh") return `${metric.value.toFixed(1)} kWh`;
  return formatTokens(metric.value);
}

function formatSupplementalCapacity(metric: SupplementalUsageMetric): string {
  const value = formatSupplementalMetric(metric);
  if (metric.limit === null || metric.limit === undefined) {
    if (metric.value === null && metric.remaining !== null && metric.remaining !== undefined) {
      return `${formatSupplementalMetric({ ...metric, value: metric.remaining })} left`;
    }
    return value;
  }
  const limit = formatSupplementalMetric({ ...metric, value: metric.limit });
  return `${value} / ${limit}`;
}

interface UsageFactRow {
  label: string;
  value: string;
}

function usageFactRows(options: {
  facts: ProviderUsageFacts | null | undefined;
  window: QuotaWindow;
  tokens: TokenSummary | null;
  cost?: CostEstimate | null;
  show?: ProviderDisplayMetric[];
  supplementalMetrics?: SupplementalUsageMetric[] | null;
  identity?: ProviderIdentitySummary | null;
  serviceStatus?: ProviderServiceStatus | null;
  now: number;
}): UsageFactRow[] {
  const { facts, window, tokens, cost, supplementalMetrics, identity, serviceStatus, now } = options;
  const selected = new Set<ProviderDisplayMetric>(
    options.show ?? [
      "quota",
      "identity",
      "status",
      "metrics",
      "resetCredits",
      "currentTokens",
      "lifetimeTokens",
      "peakDailyTokens",
      "streak",
      "cost",
    ],
  );
  return [
    selected.has("identity") && identity?.plan
      ? { label: "Plan", value: identity.plan }
      : null,
    selected.has("identity") && identity?.accountLabel
      ? { label: "Account", value: identity.accountLabel }
      : null,
    selected.has("identity") && identity?.organization
      ? { label: "Organization", value: identity.organization }
      : null,
    selected.has("status") && serviceStatus
      ? { label: "Service", value: serviceStatus.label }
      : null,
    selected.has("resetCredits") && shortCountdown(facts?.resetCreditExpiresAt ?? null, now)
      ? { label: "Credit expires", value: shortCountdown(facts?.resetCreditExpiresAt ?? null, now)! }
      : null,
    selected.has("quota") && shortCountdown(window.resetsAt, now)
      ? { label: "Period reset", value: shortCountdown(window.resetsAt, now)! }
      : null,
    selected.has("currentTokens") && tokens?.total !== null && tokens?.total !== undefined
      ? { label: "Current tokens", value: formatTokens(tokens.total) }
      : null,
    selected.has("streak") && facts?.currentStreakDays !== null && facts?.currentStreakDays !== undefined
      ? { label: "Current streak", value: `${facts.currentStreakDays}d` }
      : null,
    selected.has("lifetimeTokens") && facts?.lifetimeTokens !== null && facts?.lifetimeTokens !== undefined
      ? { label: "Lifetime", value: formatTokens(facts.lifetimeTokens) }
      : null,
    selected.has("peakDailyTokens") && facts?.peakDailyTokens !== null && facts?.peakDailyTokens !== undefined
      ? { label: "Peak day", value: formatTokens(facts.peakDailyTokens) }
      : null,
    selected.has("cost") && cost
      ? { label: cost.label, value: `$${cost.amountUsd.toFixed(2)}` }
      : null,
    ...(supplementalMetrics ?? []).map((metric) =>
      selected.has("metrics") || selected.has(`metric:${metric.id}`)
        ? {
            label: metric.periodLabel ? `${metric.label} · ${metric.periodLabel}` : metric.label,
            value: formatSupplementalCapacity(metric),
          }
        : null,
    ),
  ].filter((row): row is UsageFactRow => row !== null);
}

/** Dial-page count for rich facts. It is derived from reported rows, so no
 * provider data is silently clipped when an account exposes many quotas,
 * balances, overage counters, or costs. */
export function usageFactsPageCount(options: Parameters<typeof usageFactRows>[0], pageSize = 6): number {
  return Math.max(1, Math.ceil(usageFactRows(options).length / pageSize));
}

export function UsageFactsPanel({
  facts,
  window,
  tokens,
  cost,
  show,
  supplementalMetrics,
  identity,
  serviceStatus,
  now,
  page = 0,
  compact = false,
  degraded = false,
}: {
  facts: ProviderUsageFacts | null | undefined;
  window: QuotaWindow;
  tokens: TokenSummary | null;
  cost?: CostEstimate | null;
  show?: ProviderDisplayMetric[];
  supplementalMetrics?: SupplementalUsageMetric[] | null;
  identity?: ProviderIdentitySummary | null;
  serviceStatus?: ProviderServiceStatus | null;
  now: number;
  page?: number;
  compact?: boolean;
  degraded?: boolean;
}) {
  const selected = new Set<ProviderDisplayMetric>(
    show ?? [
      "quota",
      "identity",
      "status",
      "metrics",
      "resetCredits",
      "currentTokens",
      "lifetimeTokens",
      "peakDailyTokens",
      "streak",
      "cost",
    ],
  );
  const resetCount = facts?.resetCreditsAvailable ?? null;
  const rows = usageFactRows({
    facts,
    window,
    tokens,
    cost,
    show,
    supplementalMetrics,
    identity,
    serviceStatus,
    now,
  });
  const pageSize = compact ? 4 : 6;
  const visible = rows.slice(page * pageSize, page * pageSize + pageSize);
  const className = [
    "usage-facts",
    compact ? "compact" : "",
    degraded ? "is-degraded" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <div className="usage-facts-hdr">
        <span>{selected.has("resetCredits") ? "Usage limit resets" : "Usage details"}</span>
        {selected.has("resetCredits") && (
          <span className="usage-facts-badge">
            {resetCount === null ? "Not reported" : `${resetCount} available`}
          </span>
        )}
      </div>
      {visible.length > 0 ? (
        <div className="usage-facts-grid">
          {visible.map((row) => (
            <div className="usage-fact" key={row.label}>
              <div className="usage-fact-label">{row.label}</div>
              <div className="usage-fact-value">{row.value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="usage-facts-empty">No additional usage facts reported</div>
      )}
    </div>
  );
}
