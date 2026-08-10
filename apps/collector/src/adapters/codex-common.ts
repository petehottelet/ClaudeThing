/**
 * Shared defensive parsing for Codex rate-limit shapes. Used by both the
 * app-server adapter (account/rateLimits/read + updated notifications) and
 * the rollout reader (rate_limits payloads on token_count events). The
 * protocol is experimental, so both snake_case and camelCase spellings are
 * accepted and every field is validated.
 */

import { normalizeInstant, normalizePercent, type QuotaWindow } from "@carthing/contracts";
import { isObject, pickField, pickNumber } from "../util";

const WINDOW_DEFS: { key: string; id: string; label: string }[] = [
  { key: "primary", id: "primary", label: "Current" },
  { key: "secondary", id: "secondary", label: "Weekly" },
];

function safeBucketLabel(raw: unknown, fallbackId: string): string | null {
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 48);
  if (fallbackId === "codex") return null;
  const cleaned = fallbackId.replace(/[_-]+/g, " ").trim();
  return cleaned ? cleaned.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 48) : null;
}

/**
 * The label follows the window's actual duration when the provider reports
 * one — real telemetry has shown `primary` carrying a 7-day window, and a
 * 7-day window labeled "Current" is a lie at a glance. Position is only a
 * fallback for unknown durations.
 */
export function labelForWindow(windowSeconds: number | null, fallback: string): string {
  if (windowSeconds === null) return fallback;
  if (windowSeconds <= 12 * 3600) return "Current";
  if (windowSeconds >= 3 * 86400) return "Weekly";
  return fallback;
}

/**
 * Parse a Codex rate-limits container ({ primary, secondary } directly, or
 * wrapped as { rateLimits: ... } / { rate_limits: ... }) into QuotaWindows.
 * `nowMs` anchors relative "resets in N seconds" fields.
 */
function parseBucket(
  container: Record<string, unknown>,
  nowMs: number,
  idPrefix: string | null,
  bucketLabel: string | null,
): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const def of WINDOW_DEFS) {
    const w = container[def.key];
    if (!isObject(w)) continue;
    const pct = normalizePercent(
      pickField(w, ["usedPercent", "used_percent", "used_percentage", "utilization"]) ?? null,
    );

    let resetsAt: string | null = null;
    const direct = pickField(w, ["resetsAt", "resets_at"]);
    if (direct !== undefined) {
      resetsAt = normalizeInstant(direct).value;
    }
    if (resetsAt === null) {
      const inSeconds = pickNumber(w, ["resetsInSeconds", "resets_in_seconds"]);
      if (inSeconds !== null) resetsAt = new Date(nowMs + inSeconds * 1000).toISOString();
    }

    let windowSeconds = pickNumber(w, ["windowSeconds", "window_seconds"]);
    if (windowSeconds === null) {
      const minutes = pickNumber(w, [
        "windowDurationMins",
        "window_duration_mins",
        "windowMinutes",
        "window_minutes",
      ]);
      if (minutes !== null) windowSeconds = minutes * 60;
    }

    if (pct.value === null && resetsAt === null) continue;
    const durationLabel = labelForWindow(windowSeconds, def.label);
    out.push({
      id: idPrefix ? `${idPrefix}:${def.id}` : def.id,
      label: bucketLabel ? `${bucketLabel} · ${durationLabel}` : durationLabel,
      usedPercent: pct.value,
      resetsAt,
      windowSeconds,
    });
  }
  return out;
}

export function parseCodexRateLimits(raw: unknown, nowMs: number): QuotaWindow[] {
  if (!isObject(raw)) return [];

  const multi = pickField(raw, ["rateLimitsByLimitId", "rate_limits_by_limit_id"]);
  if (isObject(multi)) {
    const windows: QuotaWindow[] = [];
    for (const [mapId, value] of Object.entries(multi)) {
      if (!isObject(value)) continue;
      const limitIdRaw = pickField(value, ["limitId", "limit_id"]);
      const limitId =
        typeof limitIdRaw === "string" && limitIdRaw.trim()
          ? limitIdRaw.trim().slice(0, 64)
          : mapId.slice(0, 64);
      const label = safeBucketLabel(pickField(value, ["limitName", "limit_name"]), limitId);
      windows.push(...parseBucket(value, nowMs, limitId, label));
    }
    if (windows.length > 0) return windows;
  }

  const wrapped = pickField(raw, ["rateLimits", "rate_limits"]);
  const container = isObject(wrapped) ? wrapped : raw;
  const limitIdRaw = pickField(container, ["limitId", "limit_id"]);
  const limitId =
    typeof limitIdRaw === "string" && limitIdRaw.trim()
      ? limitIdRaw.trim().slice(0, 64)
      : null;
  const label = limitId
    ? safeBucketLabel(pickField(container, ["limitName", "limit_name"]), limitId)
    : null;
  return parseBucket(container, nowMs, limitId, label);
}
