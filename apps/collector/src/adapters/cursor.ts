import type {
  CostEstimate,
  ProviderMetricSeries,
  ProviderSnapshot,
  QuotaWindow,
  SupplementalUsageMetric,
} from "@carthing/contracts";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  bool,
  clampPercent,
  fetchJson,
  finite,
  iso,
  ratioPercent,
  record,
  safeHeaderValue,
  text,
  type JsonRecord,
} from "./provider-http";
import { ProviderAdapterError } from "./provider-poller";

const execFile = promisify(execFileCallback);

interface CursorEnrichment {
  cost: CostEstimate | null;
  supplementalMetrics: SupplementalUsageMetric[];
  metricSeries: ProviderMetricSeries[];
}

function metric(
  id: string,
  label: string,
  value: number | null,
  unit: SupplementalUsageMetric["unit"],
  periodLabel: string | null,
  limit?: number | null,
  remaining?: number | null,
  resetsAt?: string | null,
): SupplementalUsageMetric {
  return { id, label, value, unit, periodLabel, limit, remaining, resetsAt };
}

function cents(value: unknown): number | null {
  const number = finite(value);
  return number === null ? null : number / 100;
}

function percentage(item: JsonRecord | null, explicit: unknown): number | null {
  const direct = clampPercent(explicit);
  if (direct !== null) return direct;
  return ratioPercent(finite(item?.used), finite(item?.limit));
}

function cycleSeconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function parseCursorUsage(
  summaryRaw: unknown,
  userRaw: unknown,
  legacyRaw: unknown,
  host: string,
  observedAt = new Date().toISOString(),
  enrichment: CursorEnrichment | null = null,
): ProviderSnapshot {
  const summary = record(summaryRaw);
  if (!summary) throw new ProviderAdapterError("CURSOR_INVALID_RESPONSE");
  const individual = record(summary.individualUsage);
  const plan = record(individual?.plan);
  const overall = record(individual?.overall);
  const team = record(summary.teamUsage);
  const pooled = record(team?.pooled);
  const onDemand = record(individual?.onDemand);
  const teamOnDemand = record(team?.onDemand);
  const user = record(userRaw);
  const legacy = record(record(legacyRaw)?.gpt4);
  const billingStart = iso(summary.billingCycleStart);
  const billingEnd = iso(summary.billingCycleEnd);
  const windowSeconds = cycleSeconds(billingStart, billingEnd);

  const requestsUsed = finite(legacy?.numRequestsTotal) ?? finite(legacy?.numRequests);
  const requestsLimit = finite(legacy?.maxRequestUsage);
  const requestPercent = ratioPercent(requestsUsed, requestsLimit);
  const planPercent =
    requestPercent ??
    percentage(plan, plan?.totalPercentUsed) ??
    percentage(overall, null) ??
    percentage(pooled, null);

  const quotaWindows: QuotaWindow[] = [
    {
      id: "included",
      label: requestPercent !== null ? "Request quota" : "Included plan",
      usedPercent: planPercent,
      resetsAt: billingEnd,
      windowSeconds,
    },
  ];
  if (requestPercent === null) {
    const auto = clampPercent(plan?.autoPercentUsed);
    const api = clampPercent(plan?.apiPercentUsed);
    if (auto !== null) quotaWindows.push({ id: "auto", label: "Auto + Composer", usedPercent: auto, resetsAt: billingEnd, windowSeconds });
    if (api !== null) quotaWindows.push({ id: "api", label: "Named-model API", usedPercent: api, resetsAt: billingEnd, windowSeconds });
  }
  const onDemandUsed = cents(onDemand?.used);
  const onDemandLimit = cents(onDemand?.limit);
  if (onDemandLimit !== null && onDemandLimit > 0) {
    quotaWindows.push({
      id: "on_demand",
      label: "On-demand",
      usedPercent: ratioPercent(onDemandUsed, onDemandLimit),
      resetsAt: billingEnd,
      windowSeconds,
    });
  }

  const planSource =
    finite(plan?.limit) !== null || finite(plan?.used) !== null ? plan :
      finite(overall?.limit) !== null || finite(overall?.used) !== null ? overall : pooled;
  const planUsed = cents(planSource?.used);
  const planLimit = cents(planSource?.limit);
  const teamUsed = cents(teamOnDemand?.used);
  const teamLimit = cents(teamOnDemand?.limit);
  const supplementalMetrics: SupplementalUsageMetric[] = [
    planUsed !== null || planLimit !== null
      ? metric("includedSpend", "Included usage", planUsed, "usd", "Billing cycle", planLimit, planLimit !== null && planUsed !== null ? Math.max(0, planLimit - planUsed) : cents(planSource?.remaining), billingEnd)
      : null,
    onDemandUsed !== null || onDemandLimit !== null
      ? metric("onDemandSpend", "Extra usage", onDemandUsed, "usd", "Billing cycle", onDemandLimit, onDemandLimit !== null && onDemandUsed !== null ? Math.max(0, onDemandLimit - onDemandUsed) : cents(onDemand?.remaining), billingEnd)
      : null,
    teamUsed !== null || teamLimit !== null
      ? metric("teamSpend", "Team extra usage", teamUsed, "usd", "Billing cycle", teamLimit, teamLimit !== null && teamUsed !== null ? Math.max(0, teamLimit - teamUsed) : cents(teamOnDemand?.remaining), billingEnd)
      : null,
    requestsUsed !== null || requestsLimit !== null
      ? metric("requests", "Requests", requestsUsed, "requests", "Billing cycle", requestsLimit, requestsLimit !== null && requestsUsed !== null ? Math.max(0, requestsLimit - requestsUsed) : null, billingEnd)
      : null,
    ...(enrichment?.supplementalMetrics ?? []),
  ].filter((value): value is SupplementalUsageMetric => value !== null);

  if (quotaWindows.every((window) => window.usedPercent === null) && supplementalMetrics.length === 0) {
    throw new ProviderAdapterError("CURSOR_USAGE_MISSING");
  }
  return {
    id: "cursor",
    displayName: "Cursor",
    state: "live",
    observedAt,
    source: "cursor-app",
    host,
    quotaWindows,
    tokens: null,
    cost: enrichment?.cost ?? null,
    identity: {
      accountLabel: text(user?.email) ?? text(user?.name),
      plan: text(summary.membershipType),
      organization: null,
    },
    supplementalMetrics,
    metricSeries: enrichment?.metricSeries ?? null,
    diagnostic: null,
  };
}

function cursorDb(home: string): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "linux") {
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
}

function sqliteCandidates(env: NodeJS.ProcessEnv): string[] {
  return [env.CLAUDETHING_SQLITE3_COMMAND, "sqlite3", "/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"]
    .filter((value): value is string => Boolean(value));
}

function jwtSubject(token: string): string {
  const encoded = token.split(".")[1];
  if (!encoded) throw new ProviderAdapterError("CURSOR_APP_TOKEN_INVALID");
  try {
    const payload = record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const subject = text(payload?.sub);
    const expiry = finite(payload?.exp);
    if (!subject || (expiry !== null && expiry * 1000 <= Date.now())) {
      throw new ProviderAdapterError("CURSOR_APP_LOGIN_EXPIRED");
    }
    return subject;
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    throw new ProviderAdapterError("CURSOR_APP_TOKEN_INVALID");
  }
}

async function readCursorAppCookie(home: string, env: NodeJS.ProcessEnv): Promise<string> {
  const database = cursorDb(home);
  for (const command of sqliteCandidates(env)) {
    try {
      const { stdout } = await execFile(
        command,
        ["-readonly", database, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;"],
        { timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true },
      );
      const token = safeHeaderValue(stdout, "CURSOR_APP_TOKEN_INVALID");
      const subject = jwtSubject(token);
      return `WorkosCursorSessionToken=${encodeURIComponent(`${subject}::${token}`)}`;
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
    }
  }
  throw new ProviderAdapterError("CURSOR_LOGIN_REQUIRED");
}

async function cursorCookie(home: string, env: NodeJS.ProcessEnv): Promise<string> {
  const file = env.CLAUDETHING_CURSOR_COOKIE_FILE;
  if (file) {
    try {
      return safeHeaderValue(await readFile(file, "utf8"), "CURSOR_COOKIE_INVALID");
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError("CURSOR_COOKIE_FILE_UNREADABLE");
    }
  }
  return readCursorAppCookie(home, env);
}

function cursorHeaders(cookie: string): Record<string, string> {
  return { Accept: "application/json", Cookie: safeHeaderValue(cookie, "CURSOR_COOKIE_INVALID") };
}

function localDay(timestampMs: number): string {
  const date = new Date(timestampMs - new Date(timestampMs).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 10);
}

function eventTimestamp(value: unknown): number | null {
  const numeric = finite(value);
  if (numeric !== null && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function buildCursorEnrichment(events: unknown[]): CursorEnrichment {
  const apiCost = new Map<string, number>();
  const meteredCost = new Map<string, number>();
  const tokens = new Map<string, number>();
  const requests = new Map<string, number>();
  let meteredComplete = true;
  for (const raw of events) {
    const event = record(raw);
    const timestamp = eventTimestamp(event?.timestamp);
    if (!event || timestamp === null || timestamp <= 0) continue;
    const day = localDay(timestamp);
    const usage = record(event.tokenUsage);
    const input = finite(usage?.inputTokens) ?? 0;
    const output = finite(usage?.outputTokens) ?? 0;
    const cacheWrite = finite(usage?.cacheWriteTokens) ?? 0;
    const cacheRead = finite(usage?.cacheReadTokens) ?? 0;
    const totalTokens = input + output + cacheWrite + cacheRead;
    const apiCents = finite(usage?.totalCents);
    const charged = finite(event.chargedCents);
    if (apiCents !== null) apiCost.set(day, (apiCost.get(day) ?? 0) + apiCents / 100);
    if (charged === null) meteredComplete = false;
    else meteredCost.set(day, (meteredCost.get(day) ?? 0) + charged / 100);
    if (totalTokens > 0) tokens.set(day, (tokens.get(day) ?? 0) + totalTokens);
    requests.set(day, (requests.get(day) ?? 0) + 1);
  }
  const series = (
    id: string,
    label: string,
    unit: ProviderMetricSeries["unit"],
    values: Map<string, number>,
  ): ProviderMetricSeries => ({
    id,
    label,
    unit,
    periodLabel: "Last 30 days",
    points: [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value })),
  });
  const metricSeries = [
    apiCost.size ? series("apiCost", "API-rate cost", "usd", apiCost) : null,
    meteredComplete && meteredCost.size ? series("meteredCost", "Cursor-metered cost", "usd", meteredCost) : null,
    tokens.size ? series("tokens", "Tokens", "tokens", tokens) : null,
    requests.size ? series("requests", "Requests", "requests", requests) : null,
  ].filter((value): value is ProviderMetricSeries => value !== null);
  const apiTotal = [...apiCost.values()].reduce((sum, value) => sum + value, 0);
  const meteredTotal = meteredComplete ? [...meteredCost.values()].reduce((sum, value) => sum + value, 0) : null;
  return {
    cost: apiCost.size ? { amountUsd: apiTotal, isEstimate: true, label: "API-rate · 30d" } : null,
    supplementalMetrics: meteredTotal !== null
      ? [metric("meteredCost30d", "Cursor-metered", meteredTotal, "usd", "Last 30 days")]
      : [],
    metricSeries,
  };
}

async function fetchCursorEvents(cookie: string): Promise<CursorEnrichment> {
  const pageSize = 1000;
  const maxPages = 50;
  const end = Date.now();
  const start = end - 30 * 86400_000;
  const events: unknown[] = [];
  let expected: number | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchJson(
      "https://cursor.com/api/dashboard/get-filtered-usage-events",
      {
        method: "POST",
        headers: { ...cursorHeaders(cookie), "Content-Type": "application/json", Origin: "https://cursor.com" },
        body: JSON.stringify({ page, pageSize, startDate: String(start), endDate: String(end) }),
      },
      "CURSOR_HISTORY",
    );
    const root = record(raw);
    const pageEvents = Array.isArray(root?.usageEventsDisplay) ? root.usageEventsDisplay : null;
    if (!pageEvents) throw new ProviderAdapterError("CURSOR_HISTORY_INVALID_RESPONSE");
    const count = finite(root?.totalUsageEventsCount);
    if (count !== null) expected = count;
    events.push(...pageEvents);
    if (pageEvents.length < pageSize || (expected !== null && events.length >= expected)) break;
    if (page === maxPages) throw new ProviderAdapterError("CURSOR_HISTORY_TOO_LARGE");
  }
  if (expected !== null && events.length < expected) throw new ProviderAdapterError("CURSOR_HISTORY_INCOMPLETE");
  return buildCursorEnrichment(expected !== null ? events.slice(0, expected) : events);
}

export function createCursorFetcher(options: {
  host: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}): () => Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  let cachedEnrichment: CursorEnrichment | null = null;
  let enrichmentAt = 0;
  return async () => {
    const cookie = await cursorCookie(options.home, env);
    const requestHeaders = cursorHeaders(cookie);
    const [summary, userResult] = await Promise.all([
      fetchJson("https://cursor.com/api/usage-summary", { headers: requestHeaders }, "CURSOR"),
      fetchJson("https://cursor.com/api/auth/me", { headers: requestHeaders }, "CURSOR").catch(() => null),
    ]);
    const user = record(userResult);
    const userId = text(user?.sub);
    const legacy = userId
      ? await fetchJson(
          `https://cursor.com/api/usage?user=${encodeURIComponent(userId)}`,
          { headers: requestHeaders },
          "CURSOR",
        ).catch(() => null)
      : null;
    if (!cachedEnrichment || Date.now() - enrichmentAt > 3600_000) {
      try {
        cachedEnrichment = await fetchCursorEvents(cookie);
        enrichmentAt = Date.now();
      } catch {
        // Quotas and current spend remain useful when the optional 30-day
        // history endpoint is unavailable or too large for the safety cap.
      }
    }
    return parseCursorUsage(summary, userResult, legacy, options.host, new Date().toISOString(), cachedEnrichment);
  };
}
