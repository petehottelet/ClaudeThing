/**
 * Continuous Claude quota poller against Anthropic's OAuth usage endpoint,
 * authenticated with the credential the Claude Code CLI already stores on
 * this machine (macOS Keychain item "Claude Code-credentials", or
 * ~/.claude/.credentials.json elsewhere).
 *
 * Posture:
 * - Read-only with respect to credentials: the token is read, used against
 *   api.anthropic.com only, and never written, logged, or forwarded.
 * - No refresh flow: an expired token surfaces as a CLAUDE_AUTH_EXPIRED
 *   diagnostic and the last-known quota ages honestly. Any CLI use
 *   refreshes the stored credential, which the next poll picks up.
 * - Absent credentials (CLI never logged in) keep this adapter silent.
 * - The response schema is unofficial; every field is validated and
 *   unrecognized data is ignored, mirroring the other adapters.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeInstant,
  normalizePercent,
  type ProviderSnapshot,
  type QuotaWindow,
} from "@carthing/contracts";
import { isObject, pickField, pickNumber } from "../util";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 86400;

export interface OauthCredential {
  accessToken: string | null;
  /** Epoch ms when the token expires, when known. */
  expiresAt: number | null;
  /** True when a credential store exists at all (even if expired). */
  present: boolean;
}

export type CredentialReader = () => Promise<OauthCredential>;

/** Keychain on macOS, credentials file elsewhere. Never throws. */
export async function readCliCredential(): Promise<OauthCredential> {
  const absent: OauthCredential = { accessToken: null, expiresAt: null, present: false };
  let raw: string | null = null;
  if (process.platform === "darwin") {
    raw = await new Promise<string | null>((resolve) => {
      execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 10_000 },
        (err, stdout) => resolve(err ? null : stdout.trim()),
      );
    });
  }
  if (raw === null) {
    try {
      raw = (await readFile(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8")).trim();
    } catch {
      return absent;
    }
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return absent;
    const oauth = isObject(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed;
    const token = typeof oauth.accessToken === "string" && oauth.accessToken ? oauth.accessToken : null;
    const expiresAt = pickNumber(oauth, ["expiresAt"]);
    return { accessToken: token, expiresAt, present: true };
  } catch {
    return absent;
  }
}

function windowFrom(
  raw: unknown,
  id: string,
  label: string,
  windowSeconds: number,
): QuotaWindow | null {
  if (!isObject(raw)) return null;
  const pct = normalizePercent(pickField(raw, ["utilization", "used_percentage", "percent"]) ?? null);
  const resets = normalizeInstant(pickField(raw, ["resets_at", "resetsAt"]) ?? null);
  if (pct.value === null && resets.value === null) return null;
  return { id, label, usedPercent: pct.value, resetsAt: resets.value, windowSeconds };
}

function prettyKind(kind: string): string {
  const words = kind.toLowerCase().split(/[_-]+/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Parse the usage response into quota windows; unknown shapes yield []. */
export function parseOauthUsage(raw: unknown): QuotaWindow[] {
  if (!isObject(raw)) return [];
  const windows: QuotaWindow[] = [];
  const five = windowFrom(raw.five_hour, "five_hour", "Current", FIVE_HOUR_SECONDS);
  const seven = windowFrom(raw.seven_day, "seven_day", "Weekly", SEVEN_DAY_SECONDS);
  if (five) windows.push(five);
  if (seven) windows.push(seven);

  // Additional named limits ride along after the two card windows. When the
  // provider marks a scoped weekly cap active, that cap is the effective
  // Weekly constraint shown by the first-party app. Promote it to the
  // canonical seven_day slot and retain the aggregate as Weekly all for the
  // detail view. "session" and "weekly_all" otherwise duplicate the headline
  // fields and are skipped.
  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits.slice(0, 16)) {
      if (!isObject(entry)) continue;
      const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
      if (!kind || kind === "session" || kind === "weekly_all") continue;
      const group = typeof entry.group === "string" ? entry.group : "";
      if (kind === "weekly_scoped" && entry.is_active === true) {
        const active = windowFrom(entry, "seven_day", "Weekly", SEVEN_DAY_SECONDS);
        if (active) {
          const aggregateIndex = windows.findIndex((window) => window.id === "seven_day");
          if (aggregateIndex >= 0) {
            const aggregate = windows[aggregateIndex]!;
            windows[aggregateIndex] = active;
            windows.push({ ...aggregate, id: "oauth_weekly_all", label: "Weekly all" });
          } else {
            windows.push(active);
          }
        }
        continue;
      }
      const win = windowFrom(
        entry,
        `oauth_${kind.slice(0, 48)}`,
        prettyKind(kind).slice(0, 48),
        group === "session" ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS,
      );
      if (win && win.usedPercent !== null) windows.push(win);
    }
  }
  return windows;
}

export interface ClaudeOauthOptions {
  host: string;
  onObservation: (obs: ProviderSnapshot) => void;
  pollMs?: number;
  readCredential?: CredentialReader;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** True when a last-good OAuth observation was restored from disk. */
  hasInitialObservation?: boolean;
}

export class ClaudeOauthAdapter {
  private readonly opts: ClaudeOauthOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private hasLiveObservation: boolean;
  private transientFailures = 0;
  private backoffUntilMs = 0;

  constructor(opts: ClaudeOauthOptions) {
    this.opts = opts;
    this.hasLiveObservation = opts.hasInitialObservation ?? false;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emit(
    state: ProviderSnapshot["state"],
    windows: QuotaWindow[],
    observedAt: string | null,
    diagnostic: string | null,
  ): void {
    this.opts.onObservation({
      id: "claude",
      displayName: "Claude",
      state,
      observedAt,
      source: "oauth",
      host: this.opts.host,
      quotaWindows: windows,
      tokens: null,
      cost: null,
      history: null,
      diagnostic,
    });
  }

  async tick(): Promise<boolean> {
    if (this.running) return false;
    const tickNowMs = this.opts.now?.() ?? Date.now();
    if (tickNowMs < this.backoffUntilMs) return false;
    this.running = true;
    try {
      const nowMs = tickNowMs;
      const read = this.opts.readCredential ?? readCliCredential;
      const cred = await read();
      if (!cred.present) return false; // No CLI login on this host: stay silent.
      if (!cred.accessToken || (cred.expiresAt !== null && cred.expiresAt <= nowMs)) {
        // Expired: say why, but do not overwrite the aging quota headline.
        this.emit("unavailable", [], null, "CLAUDE_AUTH_EXPIRED");
        return false;
      }
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(USAGE_URL, {
        headers: {
          authorization: `Bearer ${cred.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) {
        this.emit("unavailable", [], null, "CLAUDE_AUTH_EXPIRED");
        return false;
      }
      if (!res.ok) {
        this.recordTransientFailure(nowMs, res.headers.get("retry-after"));
        return false;
      }
      const body: unknown = await res.json().catch(() => null);
      const windows = parseOauthUsage(body);
      if (windows.length === 0) {
        this.recordTransientFailure(nowMs, null);
        return false;
      }
      this.emit("live", windows, new Date(nowMs).toISOString(), null);
      this.hasLiveObservation = true;
      this.transientFailures = 0;
      this.backoffUntilMs = 0;
      return true;
    } catch {
      this.recordTransientFailure(tickNowMs, null);
      return false;
    } finally {
      this.running = false;
    }
  }

  private recordTransientFailure(nowMs: number, retryAfter: string | null): void {
    this.transientFailures += 1;
    const fallbackMs = Math.min(
      60 * 60_000,
      5 * 60_000 * 2 ** Math.min(4, this.transientFailures - 1),
    );
    let retryMs = 0;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) retryMs = seconds * 1000;
      else {
        const dateMs = Date.parse(retryAfter);
        if (!Number.isNaN(dateMs)) retryMs = Math.max(0, dateMs - nowMs);
      }
    }
    this.backoffUntilMs = nowMs + Math.max(5 * 60_000, fallbackMs, retryMs);
    // A transient provider/network failure must not replace a last-good quota
    // observation. Without any live value yet, surface honest unavailability.
    if (!this.hasLiveObservation) {
      this.emit("unavailable", [], null, "CLAUDE_USAGE_UNAVAILABLE");
    }
  }
}
