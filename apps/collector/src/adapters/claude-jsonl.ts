/**
 * Incremental reader for Claude Code session JSONL files
 * (<claudeDir>/**\/*.jsonl).
 *
 * - Per-file byte cursors persisted to <dataDir>/claude-jsonl-state.json.
 * - Only appended lines are parsed; a cursor beyond the file size (truncation
 *   or rotation) resets to 0 and dedup keys prevent double counting.
 * - Extracts only message.usage token classes; no message content or prompts
 *   are ever stored. The local state file holds JSONL file paths with byte
 *   cursors, counters, and opaque dedup keys — it never leaves this machine
 *   and file paths are never served or forwarded.
 * - Usage is bucketed per local calendar day (event timestamp, not poll
 *   time). The first run backfills history by reading every transcript from
 *   byte 0; afterwards only appends are read. "Today" is served from the
 *   current day's bucket and the full bucket map becomes the provider's
 *   daily history series.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_HISTORY_DAYS, MAX_HISTORY_HOURS, type ProviderSnapshot, type TokenSummary, type UsageHistoryDay, type UsageHistoryHour } from "@carthing/contracts";
import {
  isObject,
  localDayKey,
  pickNumber,
  readAppendedLines,
  readJsonFile,
  tryParseJson,
  walkFiles,
  writeJsonAtomic,
} from "../util";

interface DayTotals {
  input: number;
  cachedInput: number;
  output: number;
}

interface PersistedState {
  version: 3;
  cursors: Record<string, number>;
  seen: string[];
  /** Local-day key → token totals observed for that day. */
  days: Record<string, DayTotals>;
  /** UTC hour-start ISO → total tokens observed in that hour. */
  hours: Record<string, number>;
  /** Timestamp of the newest event actually ingested — NOT the poll time.
   * Serving poll time as observedAt would make hours-old data read "just
   * now" forever, which the product forbids. */
  lastEventAt: string | null;
}

const MAX_PERSISTED_KEYS = 20_000;

function isDayTotals(x: unknown): x is DayTotals {
  return (
    isObject(x) &&
    typeof x.input === "number" &&
    typeof x.cachedInput === "number" &&
    typeof x.output === "number"
  );
}

export interface ClaudeJsonlReaderOptions {
  claudeDir: string;
  dataDir: string;
  host: string;
  now?: () => number;
  stateFileName?: string;
}

export class ClaudeJsonlReader {
  private readonly opts: ClaudeJsonlReaderOptions;
  private readonly now: () => number;
  private state: PersistedState | null = null;
  private seen = new Set<string>();

  constructor(opts: ClaudeJsonlReaderOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  private stateFile(): string {
    return path.join(this.opts.dataDir, this.opts.stateFileName ?? "claude-jsonl-state.json");
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
        lastEventAt: typeof persisted.lastEventAt === "string" ? persisted.lastEventAt : null,
      };
      this.seen = new Set(this.state.seen.filter((k): k is string => typeof k === "string"));
    } else {
      // Fresh install or a v1 state (today-only totals, history skipped on
      // first sight): start over with empty cursors so the next poll
      // backfills day buckets from the full transcripts. Dedup keys make
      // the re-read idempotent with respect to daily totals.
      this.state = { version: 3, cursors: {}, seen: [], days: {}, hours: {}, lastEventAt: null };
      this.seen = new Set();
    }
    return this.state;
  }

  /**
   * Scan for appended usage events and return the current observation,
   * or null when the Claude directory does not exist at all.
   */
  async poll(): Promise<ProviderSnapshot | null> {
    const nowMs = this.now();
    const today = localDayKey(nowMs);
    const state = await this.loadState();

    try {
      const dirStat = await stat(this.opts.claudeDir);
      if (!dirStat.isDirectory()) return null;
    } catch {
      return null; // No Claude installation on this host: unavailable, not zero.
    }

    const files = await walkFiles(this.opts.claudeDir, (name) => name.endsWith(".jsonl"));
    for (const file of files) {
      if (!(file in state.cursors)) state.cursors[file] = 0;
      try {
        await this.consumeFile(file, nowMs);
      } catch {
        // Unreadable/locked file: try again next poll.
      }
    }

    // Drop cursors for files that disappeared.
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
      // Persistence failure must not break telemetry; cursors stay in memory.
    }

    const todayTotals = state.days[today] ?? { input: 0, cachedInput: 0, output: 0 };
    const tokens: TokenSummary = {
      input: todayTotals.input,
      cachedInput: todayTotals.cachedInput,
      reasoning: null,
      output: todayTotals.output,
      total: todayTotals.input + todayTotals.cachedInput + todayTotals.output,
      period: "today",
      periodStart: today,
    };
    const history: UsageHistoryDay[] = Object.entries(state.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totals]) => ({
        date,
        total: totals.input + totals.cachedInput + totals.output,
      }));
    const hourly: UsageHistoryHour[] = Object.entries(state.hours)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, total]) => ({ hour, total }));
    return {
      id: "claude",
      displayName: "Claude",
      state: state.lastEventAt ? "live" : "unavailable",
      observedAt: state.lastEventAt,
      source: "jsonl",
      host: this.opts.host,
      quotaWindows: [],
      tokens,
      cost: null,
      history: history.length > 0 ? history : null,
      hourly: hourly.length > 0 ? hourly : null,
      diagnostic: null,
    };
  }

  private async consumeFile(file: string, nowMs: number): Promise<void> {
    const state = this.state!;
    const cursor = state.cursors[file] ?? 0;
    const res = await readAppendedLines(file, cursor);
    for (const line of res.lines) {
      this.processLine(line.text, file, line.offset, nowMs);
    }
    let next = res.remainder ? res.remainder.offset : res.size;
    if (res.remainder && tryParseJson(res.remainder.text) !== undefined) {
      // Complete JSON without a trailing newline: consume it now.
      this.processLine(res.remainder.text, file, res.remainder.offset, nowMs);
      next = res.size;
    }
    state.cursors[file] = next;
  }

  private processLine(text: string, file: string, offset: number, nowMs: number): void {
    const state = this.state!;
    const obj = tryParseJson(text);
    if (!isObject(obj)) return;
    const message = obj.message;
    if (!isObject(message)) return;
    const usage = message.usage;
    if (!isObject(usage)) return;

    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    const eventMs = Number.isNaN(ts) ? nowMs : ts;
    const day = localDayKey(eventMs);

    const messageId = typeof message.id === "string" ? message.id : null;
    const requestId = typeof obj.requestId === "string" ? obj.requestId : null;
    const key =
      messageId && requestId
        ? `${messageId}|${requestId}`
        : typeof obj.uuid === "string"
          ? obj.uuid
          : `${path.basename(file)}@${offset}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const input = pickNumber(usage, ["input_tokens"]) ?? 0;
    const cachedInput =
      (pickNumber(usage, ["cache_creation_input_tokens"]) ?? 0) +
      (pickNumber(usage, ["cache_read_input_tokens"]) ?? 0);
    const output = pickNumber(usage, ["output_tokens"]) ?? 0;
    const bucket = (state.days[day] ??= { input: 0, cachedInput: 0, output: 0 });
    bucket.input += input;
    bucket.cachedInput += cachedInput;
    bucket.output += output;
    const hourKey = new Date(Math.floor(eventMs / 3_600_000) * 3_600_000).toISOString();
    state.hours[hourKey] = (state.hours[hourKey] ?? 0) + input + cachedInput + output;

    const prevEvent = state.lastEventAt ? Date.parse(state.lastEventAt) : Number.NEGATIVE_INFINITY;
    if (eventMs > prevEvent) state.lastEventAt = new Date(eventMs).toISOString();
  }
}
