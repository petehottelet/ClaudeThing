import type { ProviderSnapshot, QuotaWindow, SupplementalUsageMetric } from "@carthing/contracts";
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

interface DroidCredential {
  kind: "bearer" | "cookie";
  value: string;
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

function headers(credential: DroidCredential): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://app.factory.ai",
    Referer: "https://app.factory.ai/",
    "x-factory-client": "web-app",
    ...(credential.kind === "bearer"
      ? { Authorization: `Bearer ${credential.value}` }
      : { Cookie: credential.value }),
  };
}

function windowReset(item: JsonRecord, nowMs: number): string | null {
  const remaining = finite(item.secondsRemaining);
  if (remaining !== null && remaining > 0) return new Date(nowMs + remaining * 1000).toISOString();
  const direct = iso(item.windowEnd);
  if (direct) return direct;
  const nested = record(item.windowEnd);
  return iso(nested?.date) ?? iso(nested?.value);
}

function rateWindows(pool: unknown, prefix: string, nowMs: number): QuotaWindow[] {
  const source = record(pool);
  if (!source) return [];
  const definitions: Array<[string, string, number | null]> = [
    ["fiveHour", "5-hour", 5 * 3600],
    ["weekly", "Weekly", 7 * 86400],
    ["monthly", "Monthly", null],
  ];
  const out: QuotaWindow[] = [];
  for (const [key, label, seconds] of definitions) {
    const item = record(source[key]);
    if (!item) continue;
    out.push({
      id: `${prefix}.${key}`,
      label: prefix === "standard" ? label : `Core · ${label}`,
      usedPercent: clampPercent(item.usedPercent),
      resetsAt: windowReset(item, nowMs),
      windowSeconds: seconds,
    });
  }
  return out;
}

function accountFromAuth(raw: unknown) {
  const root = record(raw);
  const organization = record(root?.organization);
  const subscription = record(organization?.subscription);
  const orb = record(subscription?.orbSubscription);
  const plan = record(orb?.plan);
  const profile = record(root?.userProfile);
  return {
    identity: {
      accountLabel: text(profile?.email),
      plan: text(plan?.name) ?? text(subscription?.factoryTier),
      organization: text(organization?.name),
    },
    userId: text(profile?.id),
  };
}

function legacyPercent(item: JsonRecord | null): number | null {
  if (!item) return null;
  const used = finite(item.userTokens);
  const allowance = finite(item.totalAllowance);
  const ratio = finite(item.usedRatio);
  if (ratio !== null && ratio >= 0 && ratio <= 1.001) return clampPercent(ratio * 100);
  if (ratio !== null && ratio > 1.001 && ratio <= 100 && (allowance === null || allowance <= 0)) {
    return clampPercent(ratio);
  }
  return ratioPercent(used, allowance);
}

function legacyMetrics(
  id: string,
  label: string,
  item: JsonRecord | null,
  resetsAt: string | null,
): SupplementalUsageMetric[] {
  if (!item) return [];
  const used = finite(item.userTokens);
  const allowance = finite(item.totalAllowance);
  const orgUsed = finite(item.orgTotalTokensUsed);
  const overageUsed = finite(item.orgOverageUsed);
  const overageLimit = finite(item.orgOverageLimit);
  return [
    metric(`${id}.tokens`, `${label} tokens`, used, "tokens", "Billing cycle", allowance, allowance !== null && used !== null ? Math.max(0, allowance - used) : null, resetsAt),
    orgUsed !== null ? metric(`${id}.orgTokens`, `${label} org tokens`, orgUsed, "tokens", "Billing cycle") : null,
    overageUsed !== null || overageLimit !== null
      ? metric(`${id}.overage`, `${label} overage`, overageUsed, "tokens", "Billing cycle", overageLimit, overageLimit !== null && overageUsed !== null ? Math.max(0, overageLimit - overageUsed) : null, resetsAt)
      : null,
  ].filter((value): value is SupplementalUsageMetric => value !== null);
}

export function parseDroidUsage(
  billingRaw: unknown,
  authRaw: unknown,
  usageRaw: unknown,
  host: string,
  observedAt = new Date().toISOString(),
): ProviderSnapshot {
  const nowMs = Date.parse(observedAt);
  const billing = record(billingRaw);
  const account = accountFromAuth(authRaw);
  let quotaWindows: QuotaWindow[] = [];
  let supplementalMetrics: SupplementalUsageMetric[] = [];

  if (bool(billing?.usesTokenRateLimitsBilling) === true) {
    const limits = record(billing?.limits);
    quotaWindows = [
      ...rateWindows(limits?.standard, "standard", nowMs),
      ...rateWindows(limits?.core, "core", nowMs),
    ];
    const balanceCents = finite(billing?.extraUsageBalanceCents);
    if (balanceCents !== null) {
      supplementalMetrics.push(metric("extraUsageBalance", "Extra usage balance", balanceCents / 100, "usd", "Available"));
    }
    const extraAllowed = bool(billing?.extraUsageAllowed);
    if (extraAllowed !== null) {
      supplementalMetrics.push(metric("extraUsageEnabled", "Extra usage", extraAllowed ? 1 : 0, "count", extraAllowed ? "Enabled" : "Disabled"));
    }
  } else {
    const usageRoot = record(usageRaw);
    const usage = record(usageRoot?.usage);
    const start = iso(usage?.startDate);
    const end = iso(usage?.endDate);
    const standard = record(usage?.standard);
    const premium = record(usage?.premium);
    quotaWindows = [
      { id: "standard", label: "Standard", usedPercent: legacyPercent(standard), resetsAt: end, windowSeconds: start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null },
      { id: "premium", label: "Premium", usedPercent: legacyPercent(premium), resetsAt: end, windowSeconds: start && end ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null },
    ];
    supplementalMetrics = [
      ...legacyMetrics("standard", "Standard", standard, end),
      ...legacyMetrics("premium", "Premium", premium, end),
    ];
  }

  if (quotaWindows.length === 0 && supplementalMetrics.length === 0) {
    throw new ProviderAdapterError("DROID_USAGE_MISSING");
  }
  return {
    id: "droid",
    displayName: "Droid",
    state: "live",
    observedAt,
    source: "factory-api",
    host,
    quotaWindows,
    tokens: null,
    cost: null,
    identity: account.identity,
    supplementalMetrics,
    diagnostic: null,
  };
}

async function fileCredential(file: string, kind: DroidCredential["kind"], code: string): Promise<DroidCredential> {
  try {
    return { kind, value: safeHeaderValue(await readFile(file, "utf8"), code) };
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    throw new ProviderAdapterError(`${code}_FILE_UNREADABLE`);
  }
}

async function resolveCredential(home: string, env: NodeJS.ProcessEnv): Promise<DroidCredential> {
  if (env.CLAUDETHING_DROID_TOKEN_FILE) {
    return fileCredential(env.CLAUDETHING_DROID_TOKEN_FILE, "bearer", "DROID_TOKEN_INVALID");
  }
  if (env.CLAUDETHING_DROID_COOKIE_FILE) {
    return fileCredential(env.CLAUDETHING_DROID_COOKIE_FILE, "cookie", "DROID_COOKIE_INVALID");
  }
  if (env.FACTORY_API_KEY) {
    return { kind: "bearer", value: safeHeaderValue(env.FACTORY_API_KEY, "DROID_TOKEN_INVALID") };
  }
  try {
    const contents = await readFile(path.join(home, ".factory", ".env"), "utf8");
    const line = contents.split(/\r?\n/).find((entry) => /^(?:export\s+)?FACTORY_API_KEY\s*=/.test(entry.trim()));
    const value = line?.replace(/^(?:export\s+)?FACTORY_API_KEY\s*=\s*/, "").trim().replace(/^['"]|['"]$/g, "");
    if (value) return { kind: "bearer", value: safeHeaderValue(value, "DROID_TOKEN_INVALID") };
  } catch {
    // The optional Factory CLI environment file is not installed.
  }
  throw new ProviderAdapterError("DROID_LOGIN_REQUIRED");
}

export function createDroidFetcher(options: {
  host: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}): () => Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  return async () => {
    const credential = await resolveCredential(options.home, env);
    const requestHeaders = headers(credential);
    const billing = await fetchJson(
      "https://api.factory.ai/api/billing/limits",
      { headers: requestHeaders },
      "DROID",
    );
    let auth: unknown = {};
    try {
      auth = await fetchJson(
        "https://api.factory.ai/api/app/auth/me",
        { headers: requestHeaders },
        "DROID",
      );
    } catch {
      // Billing limits remain useful without optional account metadata.
    }
    const billingRecord = record(billing);
    let usage: unknown = {};
    if (bool(billingRecord?.usesTokenRateLimitsBilling) !== true) {
      const userId = accountFromAuth(auth).userId;
      const query = new URLSearchParams({ useCache: "true" });
      if (userId) query.set("userId", userId);
      usage = await fetchJson(
        `https://api.factory.ai/api/organization/subscription/usage?${query}`,
        { headers: requestHeaders },
        "DROID",
      );
    }
    return parseDroidUsage(billing, auth, usage, options.host);
  };
}
