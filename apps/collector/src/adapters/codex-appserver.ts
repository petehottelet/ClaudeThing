/**
 * JSON-RPC 2.0 client for `codex app-server` over stdio.
 *
 * - Injectable transport (tests mock it; production spawns the configured
 *   command and speaks newline-delimited JSON).
 * - Flow: initialize handshake → account/rateLimits/read (primary→"Current",
 *   secondary→"Weekly") → account/usage/read for token summaries → subscribe
 *   to account/rateLimits/updated notifications.
 * - The poll cadence re-reads rate limits as well as usage: notifications
 *   only fire on changes, and a quota observation frozen at connect time
 *   loses freshest-wins in the merge to poorer-but-fresher surfaces (the
 *   rollout reader), hiding windows only this surface knows about (e.g.
 *   per-model limits from rateLimitsByLimitId).
 * - Exponential-backoff reconnect; on failure emits an observation with
 *   state "error" and diagnostic "APP_SERVER_UNREACHABLE".
 * - The protocol is experimental: every shape is validated defensively.
 */

import { spawn } from "node:child_process";
import {
  MAX_HISTORY_DAYS,
  normalizeInstant,
  type ProviderSnapshot,
  type ProviderState,
  type ProviderUsageFacts,
  type QuotaWindow,
  type TokenSummary,
  type UsageHistoryDay,
} from "@carthing/contracts";
import { isObject, pickField, pickNumber, toFiniteNumber } from "../util";
import { parseCodexRateLimits } from "./codex-common";

export interface JsonRpcTransport {
  send(message: Record<string, unknown>): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

export type TransportFactory = () => JsonRpcTransport | Promise<JsonRpcTransport>;

/** Production transport: spawn the command, newline-delimited JSON on stdio. */
export function createStdioTransport(command: string): JsonRpcTransport {
  const argv = splitCommand(command);
  const executable = argv.shift();
  if (!executable) throw new Error("CODEX_COMMAND_EMPTY");
  const child = spawn(executable, argv, {
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let messageHandler: ((m: unknown) => void) | null = null;
  let closeHandler: ((e?: Error) => void) | null = null;
  let closed = false;
  let buffer = "";

  const emitClose = (e?: Error): void => {
    if (closed) return;
    closed = true;
    closeHandler?.(e);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) {
      emitClose(new Error("CODEX_STDOUT_FRAME_TOO_LARGE"));
      child.kill();
      return;
    }
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        messageHandler?.(JSON.parse(line));
      } catch {
        // Non-JSON stdout noise: ignore.
      }
    }
  });
  child.on("error", (e) => emitClose(e));
  child.on("exit", () => emitClose());

  return {
    send(message) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (e) {
        emitClose(e as Error);
      }
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    close() {
      closed = true;
      try {
        child.kill();
      } catch {
        // Already dead.
      }
    },
  };
}

/** Minimal quoted-argument parser; avoids invoking a command shell. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return args;
}

export interface CodexAppServerOptions {
  host: string;
  command?: string;
  createTransport?: TransportFactory;
  onObservation: (obs: ProviderSnapshot) => void;
  backoff?: { initialMs?: number; maxMs?: number };
  requestTimeoutMs?: number;
  /** Periodic account/usage/read cadence; 0 disables. */
  usagePollMs?: number;
  now?: () => number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerAdapter {
  private readonly opts: CodexAppServerOptions;
  private transport: JsonRpcTransport | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private windows: QuotaWindow[] = [];
  private tokens: TokenSummary | null = null;
  private history: UsageHistoryDay[] | null = null;
  private usageFacts: ProviderUsageFacts | null = null;
  private limitsObservedAt: string | null = null;
  private usageObservedAt: string | null = null;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private usageTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private generation = 0;

  constructor(opts: CodexAppServerOptions) {
    this.opts = opts;
    this.backoffMs = opts.backoff?.initialMs ?? 1000;
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    try {
      const factory =
        this.opts.createTransport ?? (() => createStdioTransport(this.opts.command ?? "codex app-server"));
      const transport = await factory();
      if (this.stopped || generation !== this.generation) {
        transport.close();
        return;
      }
      this.transport = transport;
      transport.onMessage((m) => this.handleMessage(m, generation));
      transport.onClose(() => this.handleFailure(generation));

      await this.request("initialize", {
        clientInfo: { name: "carthing-collector", title: "Car Thing Collector", version: "1.1.0" },
      });
      this.sendNotification("initialized", {});
      this.backoffMs = this.opts.backoff?.initialMs ?? 1000;

      const rateLimits = await this.request("account/rateLimits/read", {});
      this.applyRateLimits(rateLimits, true);
      await this.readUsage();
      this.emit("live");

      const pollMs = this.opts.usagePollMs ?? 60_000;
      if (pollMs > 0) {
        this.usageTimer = setInterval(() => void this.pollUsage(generation), pollMs);
        this.usageTimer.unref?.();
      }
    } catch {
      this.handleFailure(generation);
    }
  }

  private handleMessage(message: unknown, generation: number): void {
    if (generation !== this.generation || !isObject(message)) return;
    if ("id" in message && ("result" in message || "error" in message)) {
      const id = toFiniteNumber(message.id);
      if (id === null) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error !== undefined && message.error !== null) {
        pending.reject(new Error("JSON_RPC_ERROR"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "account/rateLimits/updated") {
        this.applyRateLimits(message.params, false);
        this.emit("live");
      }
      // Other notifications are ignored.
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error("NOT_CONNECTED"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("REQUEST_TIMEOUT"));
      }, this.opts.requestTimeoutMs ?? 10_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.transport?.send({ jsonrpc: "2.0", method, params });
  }

  private applyRateLimits(raw: unknown, replace: boolean): void {
    const nowMs = this.now();
    const windows = parseCodexRateLimits(raw, nowMs);
    if (windows.length > 0) {
      if (replace) {
        this.windows = windows;
      } else {
        const merged = new Map(this.windows.map((window) => [window.id, window]));
        for (const window of windows) merged.set(window.id, window);
        this.windows = [...merged.values()];
      }
      this.limitsObservedAt = new Date(nowMs).toISOString();
    } else if (replace) {
      this.windows = [];
    }
    const resetFacts = parseResetCreditFacts(raw);
    if (resetFacts || replace) {
      this.usageFacts = combineUsageFacts(this.usageFacts, resetFacts, "reset");
    }
  }

  private async readUsage(): Promise<void> {
    try {
      const result = await this.request("account/usage/read", {});
      const tokens = parseUsage(result, this.now());
      if (tokens) {
        this.tokens = tokens;
        this.usageObservedAt = new Date(this.now()).toISOString();
      }
      const history = parseUsageHistory(result);
      if (history) this.history = history;
      const summaryFacts = parseUsageSummaryFacts(result);
      this.usageFacts = combineUsageFacts(this.usageFacts, summaryFacts, "summary");
    } catch {
      // Usage surface may be missing in this Codex version; rate limits still work.
    }
  }

  private async pollUsage(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation || !this.transport) return;
    try {
      const rateLimits = await this.request("account/rateLimits/read", {});
      if (generation !== this.generation) return;
      this.applyRateLimits(rateLimits, true);
    } catch {
      // Change notifications still apply; the next poll retries the read.
    }
    await this.readUsage();
    if (generation === this.generation) this.emit("live");
  }

  private emit(state: ProviderState, diagnostic: string | null = null): void {
    const noData = this.windows.length === 0 && this.tokens === null;
    this.opts.onObservation({
      id: "codex",
      displayName: "Codex",
      state,
      // Headline freshness follows quota telemetry. A successful usage poll
      // must never make retained rate limits look newly observed.
      observedAt: this.windows.length > 0 ? this.limitsObservedAt : this.usageObservedAt,
      source: "app-server",
      host: this.opts.host,
      quotaWindows: this.windows,
      tokens: this.tokens,
      cost: null,
      history: this.history,
      usageFacts: this.usageFacts,
      diagnostic:
        diagnostic ?? (state === "live" && noData ? "RATE_LIMITS_MISSING" : null),
    });
  }

  private teardown(): void {
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("DISCONNECTED"));
    }
    this.pending.clear();
    this.transport?.close();
    this.transport = null;
  }

  private handleFailure(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.generation++; // Invalidate handlers bound to the failed transport.
    this.teardown();
    this.emit("error", "APP_SERVER_UNREACHABLE");
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.backoff?.maxMs ?? 60_000);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref?.();
  }
}

function emptyUsageFacts(): ProviderUsageFacts {
  return {
    resetCreditsAvailable: null,
    resetCreditExpiresAt: null,
    lifetimeTokens: null,
    peakDailyTokens: null,
    currentStreakDays: null,
    longestStreakDays: null,
    longestRunningTurnSeconds: null,
  };
}

function hasUsageFact(facts: ProviderUsageFacts): boolean {
  return Object.values(facts).some((value) => value !== null);
}

function combineUsageFacts(
  current: ProviderUsageFacts | null,
  incoming: ProviderUsageFacts | null,
  section: "reset" | "summary",
): ProviderUsageFacts | null {
  const next = { ...(current ?? emptyUsageFacts()) };
  if (section === "reset") {
    next.resetCreditsAvailable = incoming?.resetCreditsAvailable ?? null;
    next.resetCreditExpiresAt = incoming?.resetCreditExpiresAt ?? null;
  } else {
    next.lifetimeTokens = incoming?.lifetimeTokens ?? null;
    next.peakDailyTokens = incoming?.peakDailyTokens ?? null;
    next.currentStreakDays = incoming?.currentStreakDays ?? null;
    next.longestStreakDays = incoming?.longestStreakDays ?? null;
    next.longestRunningTurnSeconds = incoming?.longestRunningTurnSeconds ?? null;
  }
  return hasUsageFact(next) ? next : null;
}

/** Reset-credit metadata lives beside the rate-limit container, rather than
 * inside an individual quota window. */
export function parseResetCreditFacts(raw: unknown): ProviderUsageFacts | null {
  if (!isObject(raw)) return null;
  const container = pickField(raw, ["rateLimitResetCredits", "rate_limit_reset_credits"]);
  if (!isObject(container)) return null;
  const availableRaw = pickNumber(container, ["availableCount", "available_count"]);
  const available =
    availableRaw !== null && availableRaw >= 0 ? Math.floor(availableRaw) : null;
  const credits = pickField(container, ["credits"]);
  let expiresAt: string | null = null;
  if (Array.isArray(credits)) {
    const instants = credits
      .filter(isObject)
      .map((credit) => normalizeInstant(pickField(credit, ["expiresAt", "expires_at"])).value)
      .filter((instant): instant is string => instant !== null)
      .sort();
    expiresAt = instants[0] ?? null;
  }
  const facts = emptyUsageFacts();
  facts.resetCreditsAvailable = available ?? (Array.isArray(credits) ? credits.length : null);
  facts.resetCreditExpiresAt = expiresAt;
  return hasUsageFact(facts) ? facts : null;
}

/** Stable account-usage summary fields exposed by account/usage/read. */
export function parseUsageSummaryFacts(raw: unknown): ProviderUsageFacts | null {
  if (!isObject(raw)) return null;
  const summary = pickField(raw, ["summary"]);
  if (!isObject(summary)) return null;
  const facts = emptyUsageFacts();
  facts.lifetimeTokens = nonNegativeNumber(summary, ["lifetimeTokens", "lifetime_tokens"]);
  facts.peakDailyTokens = nonNegativeNumber(summary, ["peakDailyTokens", "peak_daily_tokens"]);
  facts.currentStreakDays = nonNegativeNumber(summary, ["currentStreakDays", "current_streak_days"]);
  facts.longestStreakDays = nonNegativeNumber(summary, ["longestStreakDays", "longest_streak_days"]);
  facts.longestRunningTurnSeconds = nonNegativeNumber(summary, [
    "longestRunningTurnSec",
    "longest_running_turn_sec",
  ]);
  return hasUsageFact(facts) ? facts : null;
}

function nonNegativeNumber(raw: unknown, keys: string[]): number | null {
  const value = pickNumber(raw, keys);
  return value !== null && value >= 0 ? value : null;
}

/** Validated daily usage buckets, sorted newest-first. */
function readDailyBuckets(result: unknown): { startDate: string; tokens: number }[] {
  if (!isObject(result)) return [];
  const buckets = pickField(result, ["dailyUsageBuckets", "daily_usage_buckets"]);
  if (!Array.isArray(buckets)) return [];
  return buckets
    .filter(isObject)
    .map((bucket) => ({
      startDate: pickField(bucket, ["startDate", "start_date"]),
      tokens: nonNegativeNumber(bucket, ["tokens"]),
    }))
    .filter(
      (bucket): bucket is { startDate: string; tokens: number } =>
        typeof bucket.startDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate) &&
        !Number.isNaN(Date.parse(`${bucket.startDate}T00:00:00.000Z`)) &&
        new Date(`${bucket.startDate}T00:00:00.000Z`).toISOString().slice(0, 10) === bucket.startDate &&
        bucket.tokens !== null,
    )
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/** Full provider-reported daily series, ascending, deduplicated, bounded. */
export function parseUsageHistory(result: unknown): UsageHistoryDay[] | null {
  const valid = readDailyBuckets(result);
  if (valid.length === 0) return null;
  const byDate = new Map<string, number>();
  for (const bucket of valid) {
    // newest-first: keep the first (newest) value seen per date.
    if (!byDate.has(bucket.startDate)) byDate.set(bucket.startDate, bucket.tokens);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MAX_HISTORY_DAYS)
    .map(([date, total]) => ({ date, total }));
}

export function parseUsage(result: unknown, nowMs: number): TokenSummary | null {
  if (!isObject(result)) return null;

  {
    const valid = readDailyBuckets(result);
    if (valid.length > 0) {
      const localDate = new Date(
        nowMs - new Date(nowMs).getTimezoneOffset() * 60_000,
      ).toISOString().slice(0, 10);
      const utcDate = new Date(nowMs).toISOString().slice(0, 10);
      const bucket = valid.find((item) => item.startDate === localDate) ??
        valid.find((item) => item.startDate === utcDate) ?? valid[0]!;
      return {
        input: null,
        cachedInput: null,
        reasoning: null,
        output: null,
        total: bucket.tokens,
        period: "today",
        periodStart: bucket.startDate,
      };
    }
  }

  const wrapped = pickField(result, ["usage"]);
  const container = isObject(wrapped) ? wrapped : result;
  const todayRaw = pickField(container, ["today", "daily", "day"]);
  const src = isObject(todayRaw) ? todayRaw : container;

  const input = nonNegativeNumber(src, ["inputTokens", "input_tokens", "input"]);
  const cachedInput = nonNegativeNumber(src, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cachedInput",
    "cached_input",
  ]);
  const reasoning = nonNegativeNumber(src, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
    "reasoningTokens",
    "reasoning_tokens",
    "reasoning",
  ]);
  const output = nonNegativeNumber(src, ["outputTokens", "output_tokens", "output"]);
  if (input === null && cachedInput === null && reasoning === null && output === null) return null;
  const total =
    nonNegativeNumber(src, ["totalTokens", "total_tokens", "total"]) ??
    (input ?? 0) + (cachedInput ?? 0) + (reasoning ?? 0) + (output ?? 0);
  const localDate = new Date(
    nowMs - new Date(nowMs).getTimezoneOffset() * 60_000,
  ).toISOString().slice(0, 10);
  return { input, cachedInput, reasoning, output, total, period: "today", periodStart: localDate };
}
