/**
 * Incremental reader for Codex rollout files (<codexDir>/**\/rollout-*.jsonl).
 *
 * token_count events carry CUMULATIVE session totals; daily usage is computed
 * from per-file deltas. A counter that moves backwards (new session state in
 * the same file) is treated as a fresh baseline, so its value is counted once
 * rather than producing a negative delta. Rate-limit payloads on the same
 * events are kept as a separate quota observation with the event's own
 * timestamp. Cursors and dedup mirror the Claude JSONL reader; no raw
 * content is stored.
 *
 * Class mapping note: Codex `input_tokens` includes cached input, and
 * `output_tokens` includes reasoning. The contract's classes are exclusive
 * (fixtures sum all four into `total`), so deltas are re-mapped:
 *   input   = input_tokens - cached_input_tokens
 *   output  = output_tokens - reasoning_output_tokens
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_HISTORY_DAYS, MAX_HISTORY_HOURS, type ProviderSnapshot, type QuotaWindow, type TokenSummary, type UsageHistoryDay, type UsageHistoryHour } from "@carthing/contracts";
import {
  isObject,
  localDayKey,
  pickField,
  pickNumber,
  readAppendedLines,
  readJsonFile,
  tryParseJson,
  walkFiles,
  writeJsonAtomic,
} from "../util";
import { parseCodexRateLimits } from "./codex-common";

interface RawTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

interface FileState {
  offset: number;
  totals: RawTotals | null;
}

interface DayTotals {
  input: number;
  cachedInput: number;
  reasoning: number;
  output: number;
}

interface PersistedState {
  version: 3;
  cursors: Record<string, FileState>;
  seen: string[];
  /** Local-day key → token totals attributed to that day. */
  days: Record<string, DayTotals>;
  /** UTC hour-start ISO → total tokens attributed to that hour. */
  hours: Record<string, number>;
  rateLimits: { windows: QuotaWindow[]; observedAt: string } | null;
  /** Newest event actually ingested — never the poll time (see claude-jsonl). */
  lastEventAt: string | null;
}

function isDayTotals(x: unknown): x is DayTotals {
  return (
    isObject(x) &&
    typeof x.input === "number" &&
    typeof x.cachedInput === "number" &&
    typeof x.reasoning === "number" &&
    typeof x.output === "number"
  );
}

const MAX_PERSISTED_KEYS = 20_000;

export interface CodexRolloutReaderOptions {
  codexDir: string;
  dataDir: string;
  host: string;
  now?: () => number;
  stateFileName?: string;
}

export class CodexRolloutReader {
  private readonly opts: CodexRolloutReaderOptions;
  private readonly now: () => number;
  private state: PersistedState | null = null;
  private seen = new Set<string>();

  constructor(opts: CodexRolloutReaderOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  private stateFile(): string {
    return path.join(this.opts.dataDir, this.opts.stateFileName ?? "codex-rollout-state.json");
  }

  private async loadState(): Promise<PersistedState> {
    if (this.state) return this.state;
    const persisted = await readJsonFile<PersistedState>(this.stateFile());
    if (persisted && persisted.version === 3 && isObject(persisted.cursors)) {
      const days: Record<string, DayTotals> = {};
      if (isObject(persisted.days)) {
        for (const [day, totals] of Object.entries(persisted.days)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(day) && isDayTotals(totals)) days[day] = totals;
        }
      }
      const hours: Record<string, number> = {};
      if (isObject(persisted.hours)) {
        for (const [hour, total] of Object.entries(persisted.hours)) {
          if (typeof total === "number" && Number.isFinite(total) && total >= 0) hours[hour] = total;
        }
      }
      this.state = {
        version: 3,
        cursors: persisted.cursors,
        seen: Array.isArray(persisted.seen) ? persisted.seen : [],
        days,
        hours,
        rateLimits: isObject(persisted.rateLimits) ? persisted.rateLimits : null,
        lastEventAt: typeof persisted.lastEventAt === "string" ? persisted.lastEventAt : null,
      };
      this.seen = new Set(this.state.seen.filter((k): k is string => typeof k === "string"));
    } else {
      // Fresh install or a v1 state (today-only): empty cursors make the next
      // poll read every rollout from byte 0, backfilling day buckets. Reading
      // from the start makes each file's cumulative counter its own baseline,
      // so deltas — and therefore daily totals — stay correct.
      this.state = { version: 3, cursors: {}, seen: [], days: {}, hours: {}, rateLimits: null, lastEventAt: null };
      this.seen = new Set();
    }
    return this.state;
  }

  /**
   * Scan for appended events. Returns up to two observations: a "today"
   * token summary (source "rollout") and, when rate-limit payloads have been
   * seen, a quota observation (source "rollout-limits") timestamped at the
   * originating event. Empty array when the Codex directory does not exist.
   */
  async poll(): Promise<ProviderSnapshot[]> {
    const nowMs = this.now();
    const today = localDayKey(nowMs);
    const state = await this.loadState();

    try {
      const dirStat = await stat(this.opts.codexDir);
      if (!dirStat.isDirectory()) return [];
    } catch {
      return []; // No Codex installation on this host: unavailable, not zero.
    }

    const files = await walkFiles(
      this.opts.codexDir,
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    );
    for (const file of files) {
      let fileState = state.cursors[file];
      if (!fileState) {
        // Every new file is read from byte 0: the cumulative counter is its
        // own baseline and history buckets need the full session.
        fileState = { offset: 0, totals: null };
        state.cursors[file] = fileState;
      }
      try {
        await this.consumeFile(file, fileState, nowMs);
      } catch {
        // Unreadable/locked file: try again next poll.
      }
    }

    const present = new Set(files);
    for (const known of Object.keys(state.cursors)) {
      if (!present.has(known)) delete state.cursors[known];
    }

    // Bound both maps to the contract's horizons.
    const sortedDays = Object.keys(state.days).sort();
    for (const day of sortedDays.slice(0, Math.max(0, sortedDays.length - MAX_HISTORY_DAYS))) {
      delete state.days[day];
    }
    const sortedHours = Object.keys(state.hours).sort();
    for (const hour of sortedHours.slice(0, Math.max(0, sortedHours.length - MAX_HISTORY_HOURS))) {
      delete state.hours[hour];
    }

    state.seen = [...this.seen].slice(-MAX_PERSISTED_KEYS);
    try {
      await writeJsonAtomic(this.stateFile(), state);
    } catch {
      // Persistence failure must not break telemetry.
    }

    const totals = state.days[today] ?? { input: 0, cachedInput: 0, reasoning: 0, output: 0 };
    const tokens: TokenSummary = {
      input: totals.input,
      cachedInput: totals.cachedInput,
      reasoning: totals.reasoning,
      output: totals.output,
      total: totals.input + totals.cachedInput + totals.reasoning + totals.output,
      period: "today",
      periodStart: today,
    };
    const history: UsageHistoryDay[] = Object.entries(state.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({
        date,
        total: day.input + day.cachedInput + day.reasoning + day.output,
      }));
    const hourly: UsageHistoryHour[] = Object.entries(state.hours)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, total]) => ({ hour, total }));
    const observations: ProviderSnapshot[] = [
      {
        id: "codex",
        displayName: "Codex",
        state: state.lastEventAt ? "live" : "unavailable",
        observedAt: state.lastEventAt,
        source: "rollout",
        host: this.opts.host,
        quotaWindows: [],
        tokens,
        cost: null,
        history: history.length > 0 ? history : null,
        hourly: hourly.length > 0 ? hourly : null,
        diagnostic: null,
      },
    ];
    if (state.rateLimits && Array.isArray(state.rateLimits.windows) && state.rateLimits.windows.length > 0) {
      observations.push({
        id: "codex",
        displayName: "Codex",
        state: "live",
        observedAt: state.rateLimits.observedAt,
        source: "rollout-limits",
        host: this.opts.host,
        quotaWindows: state.rateLimits.windows,
        tokens: null,
        cost: null,
        diagnostic: null,
      });
    }
    return observations;
  }

  private async consumeFile(file: string, fileState: FileState, nowMs: number): Promise<void> {
    const res = await readAppendedLines(file, fileState.offset);
    const readFromStart = res.start === 0;
    for (const line of res.lines) {
      this.processLine(line.text, file, line.offset, fileState, readFromStart, nowMs);
    }
    let next = res.remainder ? res.remainder.offset : res.size;
    if (res.remainder && tryParseJson(res.remainder.text) !== undefined) {
      this.processLine(res.remainder.text, file, res.remainder.offset, fileState, readFromStart, nowMs);
      next = res.size;
    }
    fileState.offset = next;
  }

  private processLine(
    text: string,
    file: string,
    offset: number,
    fileState: FileState,
    readFromStart: boolean,
    nowMs: number,
  ): void {
    const state = this.state!;
    const obj = tryParseJson(text);
    if (!isObject(obj)) return;
    const payload = isObject(obj.payload) ? obj.payload : obj;
    if (payload.type !== "token_count") return;

    const tsRaw = typeof obj.timestamp === "string" ? obj.timestamp : typeof payload.timestamp === "string" ? payload.timestamp : null;
    const parsedTs = tsRaw !== null ? Date.parse(tsRaw) : NaN;
    const eventMs = Number.isNaN(parsedTs) ? nowMs : parsedTs;

    const key = `${path.basename(file)}@${offset}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const prevEvent = state.lastEventAt ? Date.parse(state.lastEventAt) : Number.NEGATIVE_INFINITY;
    if (eventMs > prevEvent) state.lastEventAt = new Date(eventMs).toISOString();

    const info = isObject(payload.info) ? payload.info : payload;
    const totalUsage = pickField(info, ["total_token_usage", "totalTokenUsage"]);
    const lastUsage = pickField(info, ["last_token_usage", "lastTokenUsage"]);

    if (isObject(totalUsage)) {
      const cur = readRawTotals(totalUsage);
      let delta: RawTotals | null = null;
      const prev = fileState.totals;
      if (prev) {
        delta =
          cur.total < prev.total
            ? cur // Counter went backwards: fresh session state, count it once.
            : {
                input: Math.max(0, cur.input - prev.input),
                cached: Math.max(0, cur.cached - prev.cached),
                output: Math.max(0, cur.output - prev.output),
                reasoning: Math.max(0, cur.reasoning - prev.reasoning),
                total: Math.max(0, cur.total - prev.total),
              };
      } else if (readFromStart) {
        // Reading the file from its beginning: the cumulative value IS the delta.
        delta = cur;
      } else if (isObject(lastUsage)) {
        // Unknown baseline mid-file: fall back to the per-turn usage.
        delta = readRawTotals(lastUsage);
      }
      fileState.totals = cur;

      if (delta) {
        const day = localDayKey(eventMs);
        const bucket = (state.days[day] ??= { input: 0, cachedInput: 0, reasoning: 0, output: 0 });
        const input = Math.max(0, delta.input - delta.cached);
        const output = Math.max(0, delta.output - delta.reasoning);
        bucket.input += input;
        bucket.cachedInput += delta.cached;
        bucket.reasoning += delta.reasoning;
        bucket.output += output;
        const hourKey = new Date(Math.floor(eventMs / 3_600_000) * 3_600_000).toISOString();
        state.hours[hourKey] = (state.hours[hourKey] ?? 0) + input + delta.cached + delta.reasoning + output;
      }
    }

    const rateLimitsRaw = pickField(payload, ["rate_limits", "rateLimits"]) ?? pickField(info, ["rate_limits", "rateLimits"]);
    if (rateLimitsRaw !== undefined) {
      const windows = parseCodexRateLimits(rateLimitsRaw, eventMs);
      if (windows.length > 0) {
        const currentMs = state.rateLimits ? Date.parse(state.rateLimits.observedAt) : Number.NEGATIVE_INFINITY;
        if (!Number.isFinite(currentMs) || eventMs >= currentMs) {
          state.rateLimits = { windows, observedAt: new Date(eventMs).toISOString() };
        }
      }
    }
  }
}

function readRawTotals(raw: Record<string, unknown>): RawTotals {
  const input = pickNumber(raw, ["input_tokens", "inputTokens"]) ?? 0;
  const cached = pickNumber(raw, ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens"]) ?? 0;
  const output = pickNumber(raw, ["output_tokens", "outputTokens"]) ?? 0;
  const reasoning = pickNumber(raw, ["reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens"]) ?? 0;
  const total = pickNumber(raw, ["total_tokens", "totalTokens"]) ?? input + output;
  return { input, cached, output, reasoning, total };
}
