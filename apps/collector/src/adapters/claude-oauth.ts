/**
 * Continuous Claude quota poller against Anthropic's OAuth usage endpoint,
 * authenticated with the credential the Claude Code CLI already stores on
 * this machine (macOS Keychain item "Claude Code-credentials", or
 * ~/.claude/.credentials.json elsewhere).
 *
 * Posture:
 * - The access token is used only with Anthropic's usage endpoint.
 * - Near-expiry credentials are refreshed through Anthropic's OAuth token
 *   endpoint and written back to the CLI's own credential store without
 *   putting secret values in arguments or logs.
 * - Absent credentials (CLI never logged in) keep this adapter silent.
 * - The response schema is unofficial; every field is validated and
 *   unrecognized data is ignored, mirroring the other adapters.
 */

import {
  normalizeInstant,
  normalizePercent,
  type ProviderSnapshot,
  type QuotaWindow,
} from "@carthing/contracts";
import { isObject, pickField } from "../util";
import {
  CLAUDE_TOKEN_REFRESH_WINDOW_MS,
  readCliCredential,
  refreshCliCredential,
  type CredentialReader,
  type CredentialRefresher,
  type OauthCredential,
} from "./claude-oauth-credential";

export { readCliCredential } from "./claude-oauth-credential";
export type { CredentialReader, OauthCredential } from "./claude-oauth-credential";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 86400;

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

function scopedLimitName(entry: Record<string, unknown>): string {
  const scope = isObject(entry.scope) ? entry.scope : null;
  const model = scope && isObject(scope.model) ? scope.model : null;
  const displayName = model && typeof model.display_name === "string" ? model.display_name.trim() : "";
  const modelId = model && typeof model.id === "string" ? model.id.trim() : "";
  return (displayName || modelId || "Scoped limit").slice(0, 48);
}

function stableLimitId(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `oauth_weekly_scoped_${(slug || "limit").slice(0, 40)}`;
}

/** Parse the usage response into quota windows; unknown shapes yield []. */
export function parseOauthUsage(raw: unknown): QuotaWindow[] {
  if (!isObject(raw)) return [];
  const windows: QuotaWindow[] = [];
  const five = windowFrom(raw.five_hour, "five_hour", "Current session", FIVE_HOUR_SECONDS);
  const seven = windowFrom(raw.seven_day, "seven_day", "All models", SEVEN_DAY_SECONDS);
  if (five) windows.push(five);
  if (seven) windows.push(seven);

  // The provider repeats the first two windows in `limits`; skip those exact
  // duplicates. Scoped weekly entries are distinct model/surface allowances
  // and must remain separately labeled instead of replacing All models.
  if (Array.isArray(raw.limits)) {
    for (const entry of raw.limits.slice(0, 16)) {
      if (!isObject(entry)) continue;
      const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
      if (!kind || kind === "session" || kind === "weekly_all") continue;
      const group = typeof entry.group === "string" ? entry.group : "";
      if (kind === "weekly_scoped") {
        const label = scopedLimitName(entry);
        const scoped = windowFrom(entry, stableLimitId(label), label, SEVEN_DAY_SECONDS);
        if (scoped && scoped.usedPercent !== null) windows.push(scoped);
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
  refreshCredential?: CredentialRefresher;
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
      let cred: OauthCredential = await read();
      if (!cred.present) return false; // No CLI login on this host: stay silent.
      const needsRefresh = !cred.accessToken || (
        cred.expiresAt !== null && cred.expiresAt <= nowMs + CLAUDE_TOKEN_REFRESH_WINDOW_MS
      );
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const refresh = this.opts.refreshCredential ?? refreshCliCredential;
      if (needsRefresh) {
        const result = await refresh(cred, fetchImpl, nowMs);
        if (result.kind === "expired") {
          // Invalid/expired refresh credentials require an interactive login.
          this.emit("unavailable", [], null, "CLAUDE_AUTH_EXPIRED");
          return false;
        }
        if (result.kind === "transient") {
          this.recordTransientFailure(nowMs, result.retryAfter);
          return false;
        }
        cred = result.credential;
      }
      if (!cred.accessToken) {
        this.emit("unavailable", [], null, "CLAUDE_AUTH_EXPIRED");
        return false;
      }
      const fetchUsage = (accessToken: string): Promise<Response> => fetchImpl(USAGE_URL, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal: AbortSignal.timeout(15_000),
        });
      let res = await fetchUsage(cred.accessToken);
      if ((res.status === 401 || res.status === 403) && !needsRefresh) {
        // An access token can be invalidated before its advertised expiry.
        // Force one refresh and retry once before requiring a new login.
        const result = await refresh(cred, fetchImpl, nowMs, true);
        if (result.kind === "transient") {
          this.recordTransientFailure(nowMs, result.retryAfter);
          return false;
        }
        if (result.kind === "expired") {
          this.emit("unavailable", [], null, "CLAUDE_AUTH_EXPIRED");
          return false;
        }
        const rotatedAccessToken = result.credential.accessToken;
        if (!rotatedAccessToken) {
          this.emit("unavailable", [], null, "CLAUDE_AUTH_EXPIRED");
          return false;
        }
        cred = result.credential;
        res = await fetchUsage(rotatedAccessToken);
      }
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
