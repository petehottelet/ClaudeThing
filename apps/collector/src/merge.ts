/**
 * Multi-host merge (implementation plan, "Multi-host model"):
 *
 * - Quota windows are account-wide → freshest-observation-wins per window.
 *   Unique windows from another live surface are retained while that surface
 *   is within two minutes of the freshest quota observation, so a fast but
 *   narrow rollout update cannot erase richer app-server limits. A clock-skew
 *   guard clamps observations more than 2 minutes in the future to receive
 *   time and adds a "CLOCK_SKEW" diagnostic.
 * - Token summaries are per-machine facts → summed across hosts per period,
 *   with per-host provenance retained. Within one host, one source is chosen
 *   per provider (authority order) so e.g. app-server and rollout "today"
 *   summaries are never double-counted.
 * - A missing expected host yields a labeled-partial ("TOKENS_PARTIAL")
 *   diagnostic — never zeros. No tokens at all → tokens stays null.
 */

import {
  deriveState,
  MAX_HISTORY_DAYS,
  MAX_HISTORY_HOURS,
  normalizePercent,
  type ProviderSnapshot,
  type QuotaWindow,
  type TokenPeriod,
  type TokenSummary,
  type UsageHistoryDay,
  type UsageHistoryHour,
} from "@carthing/contracts";

export const FUTURE_SKEW_LIMIT_MS = 2 * 60 * 1000;
export const QUOTA_UNION_MAX_LAG_MS = 2 * 60 * 1000;

export interface ObservationInput {
  provider: ProviderSnapshot;
  /** Local wall-clock time when this collector received the observation. */
  receivedAtMs: number;
}

export interface MergeOptions {
  nowMs: number;
  /** Hosts expected to contribute token summaries (local + known peer). */
  expectedHosts?: string[];
}

export interface TokenProvenance {
  host: string | null;
  source: string | null;
  observedAt: string | null;
  tokens: TokenSummary;
}

export interface MergedProvider {
  snapshot: ProviderSnapshot;
  /** Per-host provenance for the summed token summary. */
  tokenSources: TokenProvenance[];
}

/** Token authority order within a single host (higher wins). */
const TOKEN_SOURCE_PRIORITY: Record<string, number> = {
  jsonl: 4,
  "app-server": 3,
  rollout: 4,
  statusline: 1,
};

const PROVIDER_ORDER = ["claude", "codex"];

interface EffectiveObservation {
  provider: ProviderSnapshot;
  receivedAtMs: number;
  observedAtMs: number | null;
  observedAtIso: string | null;
  skewed: boolean;
}

function toEffective(obs: ObservationInput): EffectiveObservation {
  const iso = obs.provider.observedAt;
  let observedAtMs: number | null = null;
  let observedAtIso: string | null = null;
  let skewed = false;
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) {
      if (t > obs.receivedAtMs + FUTURE_SKEW_LIMIT_MS) {
        // Far-future observation: distrust the remote clock, clamp to receive time.
        observedAtMs = obs.receivedAtMs;
        observedAtIso = new Date(obs.receivedAtMs).toISOString();
        skewed = true;
      } else {
        observedAtMs = t;
        observedAtIso = iso;
      }
    }
  }
  return { provider: obs.provider, receivedAtMs: obs.receivedAtMs, observedAtMs, observedAtIso, skewed };
}

function tokenPriority(source: string | null): number {
  return (source !== null ? TOKEN_SOURCE_PRIORITY[source] : undefined) ?? 1;
}

function sumField(summaries: TokenSummary[], get: (t: TokenSummary) => number | null): number | null {
  let acc: number | null = null;
  for (const t of summaries) {
    const v = get(t);
    if (v !== null) acc = (acc ?? 0) + v;
  }
  return acc;
}

export function mergeProvider(observations: ObservationInput[], opts: MergeOptions): MergedProvider {
  if (observations.length === 0) {
    throw new Error("mergeProvider requires at least one observation");
  }
  const eff = observations.map(toEffective);
  const sorted = [...eff].sort((a, b) => (b.observedAtMs ?? -1) - (a.observedAtMs ?? -1));
  const quotaWinner = sorted.find((e) => e.provider.quotaWindows.length > 0) ?? null;
  const base = quotaWinner ?? sorted[0]!;

  // Diagnostics are unioned across every surface — a failing adapter's code
  // must survive the merge, not vanish behind a healthier sibling.
  const diagnostics = new Set<string>();
  for (const e of eff) {
    if (e.provider.diagnostic) {
      for (const d of e.provider.diagnostic.split(",")) if (d) diagnostics.add(d);
    }
  }
  if (quotaWinner?.skewed) diagnostics.add("CLOCK_SKEW");

  // Merge by stable window id. Iterating newest-first makes the first value
  // authoritative for duplicate ids, while the lag bound retains additional
  // limits from a slightly older richer surface (normally app-server).
  const windowsById = new Map<string, QuotaWindow>();
  const newestQuotaMs = quotaWinner?.observedAtMs ?? null;
  for (const observation of sorted) {
    if (observation.provider.quotaWindows.length === 0) continue;
    if (
      newestQuotaMs !== null &&
      (observation.observedAtMs === null || observation.observedAtMs < newestQuotaMs - QUOTA_UNION_MAX_LAG_MS)
    ) {
      continue;
    }
    for (const window of observation.provider.quotaWindows) {
      if (windowsById.has(window.id)) continue;
      const pct = normalizePercent(window.usedPercent);
      if (pct.diagnostic) diagnostics.add(pct.diagnostic);
      windowsById.set(window.id, { ...window, usedPercent: pct.value });
    }
  }
  const quotaWindows = [...windowsById.values()];

  // ---- Token summaries: one source per host, summed across hosts ----------
  const withTokens = eff.filter((e) => e.provider.tokens !== null);
  const periods: TokenPeriod[] = ["today", "session", "response", "lifetime"];
  const period = periods.find((p) => withTokens.some((e) => e.provider.tokens!.period === p)) ?? null;

  let tokens: TokenSummary | null = null;
  const tokenSources: TokenProvenance[] = [];
  if (period !== null) {
    let activePeriodStart: string | null = null;
    let periodCandidates = withTokens.filter((e) => e.provider.tokens!.period === period);
    if (period === "today") {
      const dated = periodCandidates
        .map((e) => e.provider.tokens!.periodStart)
        .filter((date): date is string => date !== null)
        .sort((a, b) => b.localeCompare(a));
      const localDate = new Date(
        opts.nowMs - new Date(opts.nowMs).getTimezoneOffset() * 60_000,
      ).toISOString().slice(0, 10);
      activePeriodStart = dated.includes(localDate) ? localDate : (dated[0] ?? null);
      if (activePeriodStart !== null) {
        if (periodCandidates.some((e) => e.provider.tokens!.periodStart !== activePeriodStart)) {
          diagnostics.add("TOKENS_PERIOD_MISMATCH");
        }
        periodCandidates = periodCandidates.filter(
          (e) => e.provider.tokens!.periodStart === activePeriodStart,
        );
      } else if (periodCandidates.length > 0) {
        diagnostics.add("TOKENS_PERIOD_UNKNOWN");
      }
    }

    const byHost = new Map<string, EffectiveObservation>();
    for (const e of periodCandidates) {
      const hostKey = e.provider.host ?? "";
      const current = byHost.get(hostKey);
      if (!current) {
        byHost.set(hostKey, e);
        continue;
      }
      const better =
        tokenPriority(e.provider.source) - tokenPriority(current.provider.source) ||
        (e.observedAtMs ?? -1) - (current.observedAtMs ?? -1);
      if (better > 0) byHost.set(hostKey, e);
    }
    const contributors = [...byHost.values()];
    for (const c of contributors) {
      if (c.skewed) diagnostics.add("CLOCK_SKEW");
      tokenSources.push({
        host: c.provider.host,
        source: c.provider.source,
        observedAt: c.observedAtIso,
        tokens: c.provider.tokens!,
      });
    }
    const summaries = contributors.map((c) => c.provider.tokens!);
    const input = sumField(summaries, (t) => t.input);
    const cachedInput = sumField(summaries, (t) => t.cachedInput);
    const reasoning = sumField(summaries, (t) => t.reasoning);
    const output = sumField(summaries, (t) => t.output);
    let total = sumField(summaries, (t) => t.total);
    if (total === null && (input !== null || cachedInput !== null || reasoning !== null || output !== null)) {
      total = (input ?? 0) + (cachedInput ?? 0) + (reasoning ?? 0) + (output ?? 0);
    }
    tokens = { input, cachedInput, reasoning, output, total, period, periodStart: activePeriodStart };

    const contributingHosts = new Set(
      contributors.map((c) => c.provider.host).filter((h): h is string => h !== null),
    );
    for (const expected of opts.expectedHosts ?? []) {
      if (!contributingHosts.has(expected)) diagnostics.add("TOKENS_PARTIAL");
    }
  }

  // ---- Daily history: one source per host, summed across hosts per date ---
  // Same authority order as tokens so a host's history never flaps between
  // sources; dates are local to each observing host, which is exactly the
  // "my usage that day" a person means.
  const withHistory = eff.filter((e) => (e.provider.history?.length ?? 0) > 0);
  const historyByHost = new Map<string, EffectiveObservation>();
  for (const e of withHistory) {
    const hostKey = e.provider.host ?? "";
    const current = historyByHost.get(hostKey);
    if (!current) {
      historyByHost.set(hostKey, e);
      continue;
    }
    const better =
      tokenPriority(e.provider.source) - tokenPriority(current.provider.source) ||
      (e.observedAtMs ?? -1) - (current.observedAtMs ?? -1);
    if (better > 0) historyByHost.set(hostKey, e);
  }
  let history: UsageHistoryDay[] | null = null;
  if (historyByHost.size > 0) {
    const byDate = new Map<string, number>();
    for (const contributor of historyByHost.values()) {
      for (const day of contributor.provider.history!) {
        byDate.set(day.date, (byDate.get(day.date) ?? 0) + day.total);
      }
    }
    history = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_HISTORY_DAYS)
      .map(([date, total]) => ({ date, total }));
  }

  // ---- Hourly series: identical host-winner + summing rules ---------------
  const withHourly = eff.filter((e) => (e.provider.hourly?.length ?? 0) > 0);
  const hourlyByHost = new Map<string, EffectiveObservation>();
  for (const e of withHourly) {
    const hostKey = e.provider.host ?? "";
    const current = hourlyByHost.get(hostKey);
    if (!current) {
      hourlyByHost.set(hostKey, e);
      continue;
    }
    const better =
      tokenPriority(e.provider.source) - tokenPriority(current.provider.source) ||
      (e.observedAtMs ?? -1) - (current.observedAtMs ?? -1);
    if (better > 0) hourlyByHost.set(hostKey, e);
  }
  let hourly: UsageHistoryHour[] | null = null;
  if (hourlyByHost.size > 0) {
    const byHour = new Map<string, number>();
    for (const contributor of hourlyByHost.values()) {
      for (const entry of contributor.provider.hourly!) {
        byHour.set(entry.hour, (byHour.get(entry.hour) ?? 0) + entry.total);
      }
    }
    hourly = [...byHour.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_HISTORY_HOURS)
      .map(([hour, total]) => ({ hour, total }));
  }

  // ---- Freshness & state ---------------------------------------------------
  // The provider's headline age follows the QUOTA winner: quota percentages
  // are what the device displays, so a fresh token-file scan must not make
  // hours-old quota data read as "just now". Only when no surface has quota
  // does the freshest surface of any kind set the age.
  let observedAtIso: string | null;
  if (quotaWinner) {
    observedAtIso = quotaWinner.observedAtIso;
  } else {
    let observedAtMs: number | null = null;
    observedAtIso = null;
    for (const e of eff) {
      if (e.observedAtMs !== null && (observedAtMs === null || e.observedAtMs > observedAtMs)) {
        observedAtMs = e.observedAtMs;
        observedAtIso = e.observedAtIso;
      }
    }
  }
  const state = deriveState({ state: base.provider.state, observedAt: observedAtIso }, opts.nowMs);
  const factsContributor = sorted.find((entry) => entry.provider.usageFacts != null) ?? null;
  const supplementalContributor =
    sorted.find((entry) => (entry.provider.supplementalMetrics?.length ?? 0) > 0) ?? null;
  const identityContributor = sorted.find((entry) => entry.provider.identity != null) ?? null;
  const statusContributor = sorted.find((entry) => entry.provider.serviceStatus != null) ?? null;
  const seriesContributor =
    sorted.find((entry) => (entry.provider.metricSeries?.length ?? 0) > 0) ?? null;

  const snapshot: ProviderSnapshot = {
    id: base.provider.id,
    displayName: base.provider.displayName,
    state,
    observedAt: observedAtIso,
    source: base.provider.source,
    host: base.provider.host,
    quotaWindows,
    tokens,
    cost: quotaWinner?.provider.cost ?? base.provider.cost,
    history,
    hourly,
    usageFacts: factsContributor?.provider.usageFacts ?? null,
    supplementalMetrics: supplementalContributor?.provider.supplementalMetrics ?? null,
    identity: identityContributor?.provider.identity ?? null,
    serviceStatus: statusContributor?.provider.serviceStatus ?? null,
    metricSeries: seriesContributor?.provider.metricSeries ?? null,
    diagnostic: diagnostics.size > 0 ? [...diagnostics].join(",") : null,
  };
  return { snapshot, tokenSources };
}

export function mergeProviders(observations: ObservationInput[], opts: MergeOptions): MergedProvider[] {
  const byId = new Map<string, ObservationInput[]>();
  for (const obs of observations) {
    const list = byId.get(obs.provider.id);
    if (list) list.push(obs);
    else byId.set(obs.provider.id, [obs]);
  }
  const rank = (id: string): number => {
    const i = PROVIDER_ORDER.indexOf(id);
    return i === -1 ? PROVIDER_ORDER.length : i;
  };
  const ids = [...byId.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return ids.map((id) => mergeProvider(byId.get(id)!, opts));
}
