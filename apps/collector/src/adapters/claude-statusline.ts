/**
 * Pure parser for the JSON object Claude Code pipes to status-line scripts.
 *
 * Extracts ONLY numeric/enum telemetry: rate_limits.five_hour / seven_day
 * (used_percentage or utilization spellings; resets_at as epoch seconds or
 * ISO), context-window usage when present, per-response token counts, and
 * cost totals. Prompts, transcript paths, cwd, and command text are never
 * read into the output. Tolerates missing/renamed fields and garbage input
 * without throwing.
 */

import {
  normalizeInstant,
  normalizePercent,
  type CostEstimate,
  type ProviderSnapshot,
  type QuotaWindow,
  type TokenSummary,
} from "@carthing/contracts";
import { isObject, pickField, pickNumber } from "../util";

export interface StatuslineParseOptions {
  host: string;
  nowMs?: number;
}

const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 86400;

const PERCENT_FIELDS = ["used_percentage", "utilization", "used_percent", "usedPercent"];
const RESET_FIELDS = ["resets_at", "resetsAt", "reset_at"];

function parseRateLimitWindow(
  raw: unknown,
  id: string,
  label: string,
  windowSeconds: number,
  diagnostics: Set<string>,
): QuotaWindow | null {
  if (!isObject(raw)) return null;
  const pct = normalizePercent(pickField(raw, PERCENT_FIELDS) ?? null);
  if (pct.diagnostic) diagnostics.add(pct.diagnostic);
  const resets = normalizeInstant(pickField(raw, RESET_FIELDS) ?? null);
  if (resets.diagnostic) diagnostics.add(resets.diagnostic);
  if (pct.value === null && resets.value === null) return null;
  return { id, label, usedPercent: pct.value, resetsAt: resets.value, windowSeconds };
}

function parseContextWindow(root: Record<string, unknown>, diagnostics: Set<string>): QuotaWindow | null {
  const cw = pickField(root, ["context_window", "contextWindow", "context_window_usage", "context"]);
  if (!isObject(cw)) return null;
  let pctRaw: unknown = pickField(cw, PERCENT_FIELDS);
  if (pctRaw === undefined) {
    const used = pickNumber(cw, ["used_tokens", "usedTokens", "total_tokens", "tokens_used"]);
    const max = pickNumber(cw, ["max_tokens", "maxTokens", "context_window_size", "size"]);
    if (used !== null && max !== null && max > 0) pctRaw = (used / max) * 100;
  }
  if (pctRaw === undefined) return null;
  const pct = normalizePercent(pctRaw);
  if (pct.diagnostic) diagnostics.add(pct.diagnostic);
  if (pct.value === null) return null;
  return { id: "context", label: "Context", usedPercent: pct.value, resetsAt: null, windowSeconds: null };
}

function parseTokens(root: Record<string, unknown>): TokenSummary | null {
  const message = isObject(root.message) ? root.message : undefined;
  const contextWindow = pickField(root, ["context_window", "contextWindow"]);
  const currentUsage = isObject(contextWindow)
    ? pickField(contextWindow, ["current_usage", "currentUsage"])
    : undefined;
  const usage =
    currentUsage ??
    pickField(root, ["usage", "last_usage", "response_usage"]) ??
    (message ? pickField(message, ["usage"]) : undefined);

  let input: number | null = null;
  let cacheCreation: number | null = null;
  let cacheRead: number | null = null;
  let output: number | null = null;
  let period: TokenSummary["period"] = "response";
  if (isObject(usage)) {
    input = pickNumber(usage, ["input_tokens", "inputTokens"]);
    cacheCreation = pickNumber(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens"]);
    cacheRead = pickNumber(usage, ["cache_read_input_tokens", "cacheReadInputTokens"]);
    output = pickNumber(usage, ["output_tokens", "outputTokens"]);
  }
  if (input === null && output === null && cacheCreation === null && cacheRead === null) {
    // Some versions surface running totals under `cost`.
    const cost = root.cost;
    period = "session";
    input = pickNumber(cost, ["total_input_tokens"]);
    output = pickNumber(cost, ["total_output_tokens"]);
    cacheRead = pickNumber(cost, ["total_cache_read_input_tokens"]);
    cacheCreation = pickNumber(cost, ["total_cache_creation_input_tokens"]);
  }
  const cachedInput =
    cacheCreation === null && cacheRead === null ? null : (cacheCreation ?? 0) + (cacheRead ?? 0);
  if (input === null && cachedInput === null && output === null) return null;
  const total = (input ?? 0) + (cachedInput ?? 0) + (output ?? 0);
  return {
    input,
    cachedInput,
    reasoning: null,
    output,
    total,
    period,
    periodStart: null,
  };
}

function parseCost(root: Record<string, unknown>): CostEstimate | null {
  const amount = pickNumber(root.cost, ["total_cost_usd", "totalCostUsd"]);
  if (amount === null || amount < 0) return null;
  return { amountUsd: amount, isEstimate: true, label: "Session estimate" };
}

export function parseClaudeStatusline(raw: unknown, opts: StatuslineParseOptions): ProviderSnapshot {
  const nowMs = opts.nowMs ?? Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const diagnostics = new Set<string>();
  const windows: QuotaWindow[] = [];
  let tokens: TokenSummary | null = null;
  let cost: CostEstimate | null = null;

  if (isObject(raw)) {
    const rateLimits = pickField(raw, ["rate_limits", "rateLimits"]);
    if (isObject(rateLimits)) {
      const five = parseRateLimitWindow(
        pickField(rateLimits, ["five_hour", "fiveHour"]),
        "five_hour",
        "Current",
        FIVE_HOUR_SECONDS,
        diagnostics,
      );
      const seven = parseRateLimitWindow(
        pickField(rateLimits, ["seven_day", "sevenDay"]),
        "seven_day",
        "Weekly",
        SEVEN_DAY_SECONDS,
        diagnostics,
      );
      if (five) windows.push(five);
      if (seven) windows.push(seven);
      if (!five && !seven) diagnostics.add("RATE_LIMITS_MISSING");
    } else {
      diagnostics.add("RATE_LIMITS_MISSING");
    }
    const context = parseContextWindow(raw, diagnostics);
    if (context) windows.push(context);
    tokens = parseTokens(raw);
    cost = parseCost(raw);
  } else {
    diagnostics.add("STATUSLINE_UNPARSEABLE");
  }

  const usable = windows.length > 0 || tokens !== null || cost !== null;
  return {
    id: "claude",
    displayName: "Claude",
    state: usable ? "live" : "error",
    observedAt,
    source: "statusline",
    host: opts.host,
    quotaWindows: windows,
    tokens,
    cost,
    diagnostic: diagnostics.size > 0 ? [...diagnostics].join(",") : null,
  };
}
