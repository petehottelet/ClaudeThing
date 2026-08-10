/**
 * Shared contracts between the host collector and the Car Thing device UI.
 *
 * Rules (from the implementation plan):
 * - Store and transmit `usedPercent`; remaining values are presentation-only.
 * - Reset timestamps are absolute UTC ISO instants; format in device timezone.
 * - Unknown values stay `null`. Missing data is "unavailable", never zero.
 * - Clamp invalid percentages only after recording a diagnostic.
 */

import providerCatalogJson from "./provider-catalog.json";

export const SCHEMA_VERSION = 2;

export type ProviderState = "live" | "stale" | "offline" | "unavailable" | "error";

export interface QuotaWindow {
  /** Stable id, e.g. "five_hour", "seven_day". */
  id: string;
  /** Short display label, e.g. "Current", "Weekly". */
  label: string;
  /** 0..100, or null when unknown. */
  usedPercent: number | null;
  /** Absolute UTC ISO instant, or null when the provider did not report one. */
  resetsAt: string | null;
  /** Window duration in seconds when known. */
  windowSeconds: number | null;
}

export type TokenPeriod = "today" | "session" | "response" | "lifetime";

export interface TokenSummary {
  input: number | null;
  cachedInput: number | null;
  reasoning: number | null;
  output: number | null;
  total: number | null;
  period: TokenPeriod;
  /** Calendar bucket for `today` totals (`YYYY-MM-DD`); null otherwise. */
  periodStart: string | null;
}

export interface CostEstimate {
  amountUsd: number;
  /** Always true: costs are estimates, never billing statements. */
  isEstimate: true;
  label: string;
}

/** Additional account facts that are useful beside (not as substitutes for)
 * quota windows. Every field is nullable because provider versions expose
 * different subsets. */
export interface ProviderUsageFacts {
  /** Number of provider-issued full-reset credits currently available. */
  resetCreditsAvailable: number | null;
  /** Expiry of the next available reset credit. */
  resetCreditExpiresAt: string | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  longestRunningTurnSeconds: number | null;
}

export type MarketInstrumentKind = "stock" | "index" | "fund";

export interface DashboardMarketInstrument {
  symbol: string;
  name: string;
  kind: MarketInstrumentKind;
}

export const PROVIDER_DISPLAY_METRICS = [
  "quota",
  "identity",
  "status",
  "metrics",
  "metricHistory",
  "resetCredits",
  "currentTokens",
  "lifetimeTokens",
  "peakDailyTokens",
  "streak",
  "history",
  "cost",
] as const;
export type BuiltinProviderDisplayMetric = (typeof PROVIDER_DISPLAY_METRICS)[number];
/** `metric:<id>` selects a provider-specific numeric metric advertised in its
 * snapshot without requiring the dashboard schema to know that provider. */
export type ProviderDisplayMetric = BuiltinProviderDisplayMetric | `metric:${string}`;

export type SupplementalMetricUnit =
  | "count"
  | "tokens"
  | "usd"
  | "seconds"
  | "percent"
  | "credits"
  | "requests"
  | "characters"
  | "points"
  | "kwh";

export interface SupplementalUsageMetric {
  id: string;
  label: string;
  value: number | null;
  unit: SupplementalMetricUnit;
  periodLabel: string | null;
  /** Optional capacity and remaining values. They stay separate so an API
   * that reports only one side never causes ClaudeThing to invent the other. */
  limit?: number | null;
  remaining?: number | null;
  resetsAt?: string | null;
}

export interface ProviderIdentitySummary {
  accountLabel: string | null;
  plan: string | null;
  organization: string | null;
}

export type ProviderServiceHealth =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "unknown";

export interface ProviderServiceStatus {
  state: ProviderServiceHealth;
  label: string;
  checkedAt: string | null;
}

export interface ProviderMetricPoint {
  /** Local calendar day (`YYYY-MM-DD`) for display aggregation. */
  date: string;
  value: number;
}

/** A bounded provider-supplied daily series. Examples include spend,
 * requests, credits, characters, and tokens. */
export interface ProviderMetricSeries {
  id: string;
  label: string;
  unit: SupplementalMetricUnit;
  periodLabel: string | null;
  points: ProviderMetricPoint[];
}

export type ProviderIntegration = "native" | "bridge";

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  accent: string;
  integration: ProviderIntegration;
  /** Original, user-facing explanation of the data surface. */
  description: string;
}

/** Supported provider catalog. Native entries are collected directly by the
 * host service. Bridge entries use the same validated snapshot contract via a
 * local, owner-controlled JSON file and therefore require no device changes. */
export const PROVIDER_CATALOG = providerCatalogJson as readonly ProviderCatalogEntry[];

export function providerCatalogEntry(id: string): ProviderCatalogEntry | null {
  return PROVIDER_CATALOG.find((entry) => entry.id === id) ?? null;
}

export interface DashboardProviderConfig {
  /** Stable telemetry provider id. Unknown ids are allowed so a future or
   * peer-supplied provider can be selected without a schema change. */
  id: string;
  enabled: boolean;
  /** Data lanes to present when that provider actually reports them. */
  show: ProviderDisplayMetric[];
}

/** Non-secret, human-editable dashboard preferences distributed with every
 * snapshot so the device can update without being reprovisioned. */
export interface DashboardConfig {
  version: 1;
  providers: DashboardProviderConfig[];
  youtube: {
    channelName: string;
    channelHandle: string;
  };
  ga4: {
    propertyName: string;
    propertyId: string;
  };
  markets: {
    rotationSeconds: number;
    instruments: DashboardMarketInstrument[];
  };
}

export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  version: 1,
  providers: [
    {
      id: "claude",
      enabled: true,
      show: ["quota", "currentTokens", "history"],
    },
    {
      id: "codex",
      enabled: true,
      show: [
        "quota",
        "resetCredits",
        "currentTokens",
        "lifetimeTokens",
        "peakDailyTokens",
        "streak",
        "history",
      ],
    },
  ],
  youtube: { channelName: "YouTube Channel", channelHandle: "" },
  ga4: { propertyName: "Website Analytics", propertyId: "" },
  markets: {
    rotationSeconds: 10,
    instruments: [
      { symbol: "NVDA", name: "NVIDIA", kind: "stock" },
      { symbol: "S&P 500", name: "Large-cap index", kind: "index" },
      { symbol: "DOW", name: "Industrial index", kind: "index" },
      { symbol: "TOTAL", name: "Total stock market", kind: "fund" },
    ],
  },
};

/** One local calendar day of observed token usage. */
export interface UsageHistoryDay {
  /** Day key (YYYY-MM-DD) in the observing host's local time zone. */
  date: string;
  /** Tokens attributed to that day, all classes summed. Zero is a real
   * observed zero (logs covered the day and recorded nothing); days before
   * log coverage are simply absent, never fabricated. */
  total: number;
}

/** Ascending-by-date daily usage series; bounded to about a year. */
export const MAX_HISTORY_DAYS = 400;

/** One clock hour of observed token usage. */
export interface UsageHistoryHour {
  /** UTC instant of the hour start (ISO, minutes/seconds zero). */
  hour: string;
  /** Tokens attributed to that hour; a real observed zero, never fabricated. */
  total: number;
}

/** Ascending hourly series; bounded to two days. */
export const MAX_HISTORY_HOURS = 48;

export interface ProviderSnapshot {
  id: string;
  displayName: string;
  state: ProviderState;
  /** When the underlying telemetry was last observed (UTC ISO), null if never. */
  observedAt: string | null;
  /** Which surface produced the observation, e.g. "statusline", "app-server". */
  source: string | null;
  /** Which host machine observed it, e.g. "pc", "mac". */
  host: string | null;
  quotaWindows: QuotaWindow[];
  tokens: TokenSummary | null;
  cost: CostEstimate | null;
  /** Daily usage series when the source can reconstruct one from local logs.
   * Optional for wire/persistence compatibility with older peers. */
  history?: UsageHistoryDay[] | null;
  /** Hourly usage series for the rolling last-day view; optional as above. */
  hourly?: UsageHistoryHour[] | null;
  /** Provider-supplied account facts; optional for peer compatibility. */
  usageFacts?: ProviderUsageFacts | null;
  /** Provider-specific bounded numeric facts selected through `metric:<id>`
   * config entries. Optional for compatibility with older peers. */
  supplementalMetrics?: SupplementalUsageMetric[] | null;
  /** Optional identity, provider health, and chartable metric surfaces. */
  identity?: ProviderIdentitySummary | null;
  serviceStatus?: ProviderServiceStatus | null;
  metricSeries?: ProviderMetricSeries[] | null;
  /** Display-safe diagnostic code; never raw error text with paths/content. */
  diagnostic: string | null;
}

export interface Snapshot {
  schemaVersion: number;
  collectorVersion: string;
  /** Host that generated this snapshot. */
  host: string;
  /** When this snapshot was assembled (UTC ISO). */
  generatedAt: string;
  /** Collector wall clock at send time — device uses it to cancel clock skew. */
  serverTime: string;
  providers: ProviderSnapshot[];
  /** Validated display preferences. Optional for compatibility with cached
   * snapshots and older peers. */
  dashboardConfig?: DashboardConfig;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export interface Normalized<T> {
  value: T;
  diagnostic: string | null;
}

/** Clamp a percentage into 0..100, recording a diagnostic when out of range. */
export function normalizePercent(raw: unknown): Normalized<number | null> {
  if (raw === null || raw === undefined) return { value: null, diagnostic: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return { value: null, diagnostic: "percent_not_numeric" };
  if (n < 0) return { value: 0, diagnostic: "percent_below_range" };
  if (n > 100) return { value: 100, diagnostic: "percent_above_range" };
  return { value: n, diagnostic: null };
}

/** Parse an epoch (seconds or ms) or ISO string into a UTC ISO instant. */
export function normalizeInstant(raw: unknown): Normalized<string | null> {
  if (raw === null || raw === undefined) return { value: null, diagnostic: null };
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: epoch seconds vs milliseconds.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { value: null, diagnostic: "instant_invalid" };
    return { value: d.toISOString(), diagnostic: null };
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { value: null, diagnostic: "instant_invalid" };
    return { value: d.toISOString(), diagnostic: null };
  }
  return { value: null, diagnostic: "instant_invalid" };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export interface FreshnessThresholds {
  /** Older than this (seconds) is "stale". */
  staleAfterSeconds: number;
  /** Older than this (seconds) is "offline". */
  offlineAfterSeconds: number;
}

export const DEFAULT_FRESHNESS: FreshnessThresholds = {
  staleAfterSeconds: 30 * 60,
  offlineAfterSeconds: 4 * 60 * 60,
};

/**
 * Derive a display state from the observation age. `error`/`unavailable`
 * pass through untouched — age only degrades `live`.
 */
export function deriveState(
  provider: Pick<ProviderSnapshot, "state" | "observedAt">,
  nowMs: number,
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS,
): ProviderState {
  if (provider.state === "error" || provider.state === "unavailable") return provider.state;
  if (!provider.observedAt) return "unavailable";
  const observed = new Date(provider.observedAt).getTime();
  if (Number.isNaN(observed)) return "unavailable";
  const ageSec = (nowMs - observed) / 1000;
  if (ageSec > thresholds.offlineAfterSeconds) return "offline";
  if (ageSec > thresholds.staleAfterSeconds) return "stale";
  return provider.state === "offline" ? "offline" : "live";
}

/** Human-oriented age bucket used by the UI status rail. */
export function formatAge(observedAtIso: string | null, nowMs: number): string {
  if (!observedAtIso) return "never";
  const observed = new Date(observedAtIso).getTime();
  if (Number.isNaN(observed)) return "unknown";
  const sec = Math.max(0, Math.floor((nowMs - observed) / 1000));
  if (sec < 45) return "just now";
  if (sec < 90) return "1m ago";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 === 0 ? `${hr}h ago` : `${hr}h ${min % 60}m ago`;
  const day = Math.floor(hr / 24);
  return hr % 24 === 0 ? `${day}d ago` : `${day}d ${hr % 24}h ago`;
}

/** True when the runtime accepts an IANA time-zone identifier. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Format the dashboard clock in the provisioned host time zone. */
export function formatClock(nowMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: isTimeZone(timeZone) ? timeZone : "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(nowMs));
}

/** Calendar key for same-day telemetry comparisons in the displayed time zone. */
export function dayKeyInTimeZone(nowMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: isTimeZone(timeZone) ? timeZone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Countdown text for a reset instant, e.g. "Resets in 1h 22m". */
export function formatResetCountdown(
  resetsAtIso: string | null,
  nowMs: number,
): string | null {
  if (!resetsAtIso) return null;
  const t = new Date(resetsAtIso).getTime();
  if (Number.isNaN(t)) return null;
  const sec = Math.floor((t - nowMs) / 1000);
  if (sec <= 0) return "Resetting…";
  const min = Math.ceil(sec / 60);
  if (min < 60) return `Resets in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Resets in ${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `Resets in ${day}d ${hr % 24}h`;
}

// ---------------------------------------------------------------------------
// Runtime guards (light — the wire is trusted-local, but shapes evolve)
// ---------------------------------------------------------------------------

const PROVIDER_STATES = new Set<ProviderState>([
  "live",
  "stale",
  "offline",
  "unavailable",
  "error",
]);
const PROVIDER_SERVICE_STATES = new Set<ProviderServiceHealth>([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "unknown",
]);
const TOKEN_PERIODS = new Set<TokenPeriod>(["today", "session", "response", "lifetime"]);

function isObjectRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown, max = 512): x is string {
  return typeof x === "string" && x.length <= max;
}

function isNullableString(x: unknown, max = 512): x is string | null {
  return x === null || isString(x, max);
}

function isIsoInstant(x: unknown): x is string {
  return isString(x, 64) && !Number.isNaN(Date.parse(x));
}

function isNullableInstant(x: unknown): x is string | null {
  return x === null || isIsoInstant(x);
}

function isNullableMetric(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
}

function isDayKey(x: unknown): x is string {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const parsed = new Date(`${x}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === x;
}

function isQuotaWindow(x: unknown): x is QuotaWindow {
  if (!isObjectRecord(x)) return false;
  return (
    isString(x.id, 128) &&
    x.id.length > 0 &&
    isString(x.label, 128) &&
    x.label.length > 0 &&
    (x.usedPercent === null ||
      (typeof x.usedPercent === "number" &&
        Number.isFinite(x.usedPercent) &&
        x.usedPercent >= 0 &&
        x.usedPercent <= 100)) &&
    isNullableInstant(x.resetsAt) &&
    (x.windowSeconds === null ||
      (typeof x.windowSeconds === "number" &&
        Number.isFinite(x.windowSeconds) &&
        x.windowSeconds >= 0))
  );
}

function isTokenSummary(x: unknown): x is TokenSummary {
  if (!isObjectRecord(x)) return false;
  const period = x.period;
  const periodStart = x.periodStart;
  return (
    isNullableMetric(x.input) &&
    isNullableMetric(x.cachedInput) &&
    isNullableMetric(x.reasoning) &&
    isNullableMetric(x.output) &&
    isNullableMetric(x.total) &&
    typeof period === "string" &&
    TOKEN_PERIODS.has(period as TokenPeriod) &&
    (periodStart === null || isDayKey(periodStart)) &&
    (period !== "today" || periodStart !== null)
  );
}

function isUsageHistory(x: unknown): x is UsageHistoryDay[] {
  if (!Array.isArray(x) || x.length > MAX_HISTORY_DAYS) return false;
  let prev = "";
  for (const day of x) {
    if (!isObjectRecord(day)) return false;
    if (!isDayKey(day.date)) return false;
    if (typeof day.total !== "number" || !Number.isFinite(day.total) || day.total < 0) return false;
    // Strictly ascending: no duplicates, no reordering surprises downstream.
    if ((day.date as string) <= prev) return false;
    prev = day.date as string;
  }
  return true;
}

function isUsageHourly(x: unknown): x is UsageHistoryHour[] {
  if (!Array.isArray(x) || x.length > MAX_HISTORY_HOURS) return false;
  let prev = "";
  for (const entry of x) {
    if (!isObjectRecord(entry)) return false;
    if (!isIsoInstant(entry.hour)) return false;
    if (typeof entry.total !== "number" || !Number.isFinite(entry.total) || entry.total < 0) return false;
    if ((entry.hour as string) <= prev) return false;
    prev = entry.hour as string;
  }
  return true;
}

function isCostEstimate(x: unknown): x is CostEstimate {
  if (!isObjectRecord(x)) return false;
  return (
    typeof x.amountUsd === "number" &&
    Number.isFinite(x.amountUsd) &&
    x.amountUsd >= 0 &&
    x.isEstimate === true &&
    isString(x.label, 128)
  );
}

function isNullableCount(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
}

function isProviderUsageFacts(x: unknown): x is ProviderUsageFacts {
  if (!isObjectRecord(x)) return false;
  return (
    isNullableCount(x.resetCreditsAvailable) &&
    isNullableInstant(x.resetCreditExpiresAt) &&
    isNullableCount(x.lifetimeTokens) &&
    isNullableCount(x.peakDailyTokens) &&
    isNullableCount(x.currentStreakDays) &&
    isNullableCount(x.longestStreakDays) &&
    isNullableCount(x.longestRunningTurnSeconds)
  );
}

function isSupplementalUsageMetric(x: unknown): x is SupplementalUsageMetric {
  if (!isObjectRecord(x)) return false;
  return (
    isString(x.id, 64) &&
    x.id.length > 0 &&
    /^[A-Za-z0-9._-]+$/.test(x.id) &&
    isString(x.label, 80) &&
    x.label.length > 0 &&
    isNullableCount(x.value) &&
    isSupplementalMetricUnit(x.unit) &&
    isNullableString(x.periodLabel, 48) &&
    (x.limit === undefined || isNullableCount(x.limit)) &&
    (x.remaining === undefined || isNullableCount(x.remaining)) &&
    (x.resetsAt === undefined || isNullableInstant(x.resetsAt))
  );
}

function isSupplementalMetricUnit(x: unknown): x is SupplementalMetricUnit {
  return (
    x === "count" ||
    x === "tokens" ||
    x === "usd" ||
    x === "seconds" ||
    x === "percent" ||
    x === "credits" ||
    x === "requests" ||
    x === "characters" ||
    x === "points" ||
    x === "kwh"
  );
}

function isProviderIdentitySummary(x: unknown): x is ProviderIdentitySummary {
  return (
    isObjectRecord(x) &&
    isNullableString(x.accountLabel, 160) &&
    isNullableString(x.plan, 128) &&
    isNullableString(x.organization, 160)
  );
}

function isProviderServiceStatus(x: unknown): x is ProviderServiceStatus {
  return (
    isObjectRecord(x) &&
    typeof x.state === "string" &&
    PROVIDER_SERVICE_STATES.has(x.state as ProviderServiceHealth) &&
    isString(x.label, 128) &&
    x.label.length > 0 &&
    isNullableInstant(x.checkedAt)
  );
}

function isProviderMetricSeries(x: unknown): x is ProviderMetricSeries {
  if (!isObjectRecord(x)) return false;
  if (
    !isString(x.id, 64) ||
    !/^[A-Za-z0-9._-]+$/.test(x.id) ||
    !isString(x.label, 80) ||
    x.label.length === 0 ||
    !isSupplementalMetricUnit(x.unit) ||
    !isNullableString(x.periodLabel, 48) ||
    !Array.isArray(x.points) ||
    x.points.length > MAX_HISTORY_DAYS
  ) {
    return false;
  }
  let previous = "";
  for (const point of x.points) {
    if (
      !isObjectRecord(point) ||
      !isDayKey(point.date) ||
      typeof point.value !== "number" ||
      !Number.isFinite(point.value) ||
      point.value < 0 ||
      point.date <= previous
    ) {
      return false;
    }
    previous = point.date;
  }
  return true;
}

function isProviderDisplayMetric(x: unknown): x is ProviderDisplayMetric {
  return (
    typeof x === "string" &&
    ((PROVIDER_DISPLAY_METRICS as readonly string[]).includes(x) ||
      /^metric:[A-Za-z0-9._-]{1,64}$/.test(x))
  );
}

export function isDashboardConfig(x: unknown): x is DashboardConfig {
  if (!isObjectRecord(x) || x.version !== 1) return false;
  if (!isObjectRecord(x.youtube) || !isObjectRecord(x.ga4) || !isObjectRecord(x.markets)) {
    return false;
  }
  const validText = (value: unknown, max: number, allowEmpty = false): value is string =>
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
  const instruments = x.markets.instruments;
  const providers = x.providers;
  return (
    Array.isArray(providers) &&
    providers.length >= 1 &&
    providers.length <= 128 &&
    providers.every(
      (provider) =>
        isObjectRecord(provider) &&
        validText(provider.id, 64) &&
        /^[A-Za-z0-9._-]+$/.test(provider.id as string) &&
        typeof provider.enabled === "boolean" &&
        Array.isArray(provider.show) &&
        provider.show.length <= 64 &&
        provider.show.every(isProviderDisplayMetric) &&
        new Set(provider.show).size === provider.show.length,
    ) &&
    validText(x.youtube.channelName, 100) &&
    validText(x.youtube.channelHandle, 100, true) &&
    validText(x.ga4.propertyName, 100) &&
    validText(x.ga4.propertyId, 100, true) &&
    typeof x.markets.rotationSeconds === "number" &&
    Number.isInteger(x.markets.rotationSeconds) &&
    x.markets.rotationSeconds >= 2 &&
    x.markets.rotationSeconds <= 300 &&
    Array.isArray(instruments) &&
    instruments.length >= 1 &&
    instruments.length <= 32 &&
    instruments.every(
      (instrument) =>
        isObjectRecord(instrument) &&
        validText(instrument.symbol, 20) &&
        validText(instrument.name, 80) &&
        (instrument.kind === "stock" || instrument.kind === "index" || instrument.kind === "fund"),
    )
  );
}

export function isSnapshot(x: unknown): x is Snapshot {
  if (!isObjectRecord(x)) return false;
  const providers = x.providers;
  return (
    x.schemaVersion === SCHEMA_VERSION &&
    isString(x.collectorVersion, 64) &&
    isString(x.host, 128) &&
    isIsoInstant(x.generatedAt) &&
    isIsoInstant(x.serverTime) &&
    Array.isArray(providers) &&
    providers.length <= 128 &&
    providers.every(isProviderSnapshot) &&
    (x.dashboardConfig === undefined || isDashboardConfig(x.dashboardConfig))
  );
}

export function isProviderSnapshot(x: unknown): x is ProviderSnapshot {
  if (!isObjectRecord(x)) return false;
  const state = x.state;
  const windows = x.quotaWindows;
  return (
    isString(x.id, 128) &&
    x.id.length > 0 &&
    isString(x.displayName, 128) &&
    typeof state === "string" &&
    PROVIDER_STATES.has(state as ProviderState) &&
    isNullableInstant(x.observedAt) &&
    isNullableString(x.source, 128) &&
    isNullableString(x.host, 128) &&
    Array.isArray(windows) &&
    windows.length <= 64 &&
    windows.every(isQuotaWindow) &&
    (x.tokens === null || isTokenSummary(x.tokens)) &&
    (x.cost === null || isCostEstimate(x.cost)) &&
    (x.history === undefined || x.history === null || isUsageHistory(x.history)) &&
    (x.hourly === undefined || x.hourly === null || isUsageHourly(x.hourly)) &&
    (x.usageFacts === undefined || x.usageFacts === null || isProviderUsageFacts(x.usageFacts)) &&
    (x.supplementalMetrics === undefined ||
      x.supplementalMetrics === null ||
      (Array.isArray(x.supplementalMetrics) &&
        x.supplementalMetrics.length <= 64 &&
        x.supplementalMetrics.every(isSupplementalUsageMetric))) &&
    (x.identity === undefined || x.identity === null || isProviderIdentitySummary(x.identity)) &&
    (x.serviceStatus === undefined ||
      x.serviceStatus === null ||
      isProviderServiceStatus(x.serviceStatus)) &&
    (x.metricSeries === undefined ||
      x.metricSeries === null ||
      (Array.isArray(x.metricSeries) &&
        x.metricSeries.length <= 32 &&
        x.metricSeries.every(isProviderMetricSeries))) &&
    isNullableString(x.diagnostic, 1024)
  );
}
