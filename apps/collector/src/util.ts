/**
 * Small shared helpers: defensive JSON/number access, local-day math, and
 * append-safe incremental file reading used by the JSONL adapters.
 */

import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function toFiniteNumber(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First finite number among the named fields, else null. */
export function pickNumber(obj: unknown, names: string[]): number | null {
  if (!isObject(obj)) return null;
  for (const name of names) {
    if (name in obj) {
      const v = toFiniteNumber(obj[name]);
      if (v !== null) return v;
    }
  }
  return null;
}

/** First present (non-null/undefined) field among the named fields. */
export function pickField(obj: unknown, names: string[]): unknown {
  if (!isObject(obj)) return undefined;
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Local-timezone day key, e.g. "2026-08-08". */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Recursively list files under `dir` whose basename matches. Missing dir → []. */
export async function walkFiles(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, match)));
    } else if (entry.isFile() && match(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write JSON via tmp file + rename so a crash never leaves a torn state file. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, filePath);
}

export interface AppendedLine {
  text: string;
  /** Byte offset of the line start within the file. */
  offset: number;
}

export interface AppendReadResult {
  /** Complete (newline-terminated) lines appended since the cursor. */
  lines: AppendedLine[];
  /** Trailing bytes without a terminating newline, if any. */
  remainder: AppendedLine | null;
  /** Effective read start (0 when the cursor was beyond the file size). */
  start: number;
  /** Byte position just past the data that was read. */
  size: number;
  /** True when the cursor was beyond the file size (truncation/rotation). */
  reset: boolean;
}

/**
 * Read bytes appended after `cursor`. A cursor beyond the current size means
 * the file was truncated or rotated: reading restarts from 0 (callers dedup).
 */
export async function readAppendedLines(filePath: string, cursor: number): Promise<AppendReadResult> {
  const st = await stat(filePath);
  let start = cursor;
  let reset = false;
  if (start > st.size || start < 0) {
    start = 0;
    reset = true;
  }
  if (start === st.size) {
    return { lines: [], remainder: null, start, size: st.size, reset };
  }

  const fh = await open(filePath, "r");
  let buf: Buffer;
  try {
    const length = st.size - start;
    buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const r = await fh.read(buf, read, length - read, start + read);
      if (r.bytesRead === 0) break;
      read += r.bytesRead;
    }
    if (read < length) buf = buf.subarray(0, read);
  } finally {
    await fh.close();
  }

  const lines: AppendedLine[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push({ text: buf.subarray(lineStart, i).toString("utf8"), offset: start + lineStart });
      lineStart = i + 1;
    }
  }
  const remainder =
    lineStart < buf.length
      ? { text: buf.subarray(lineStart).toString("utf8"), offset: start + lineStart }
      : null;
  return { lines, remainder, start, size: start + buf.length, reset };
}
