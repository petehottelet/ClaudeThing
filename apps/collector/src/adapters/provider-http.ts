import { ProviderAdapterError } from "./provider-poller";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function integer(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function clampPercent(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.min(100, Math.max(0, parsed));
}

export function ratioPercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return clampPercent((used / limit) * 100);
}

export async function boundedResponseText(response: Response, diagnosticPrefix: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderAdapterError(`${diagnosticPrefix}_RESPONSE_TOO_LARGE`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  diagnosticPrefix: string,
  allowedStatuses: number[] = [200],
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ProviderAdapterError(`${diagnosticPrefix}_NETWORK_ERROR`);
  }
  if (!allowedStatuses.includes(response.status)) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAdapterError(`${diagnosticPrefix}_AUTH_REQUIRED`);
    }
    throw new ProviderAdapterError(`${diagnosticPrefix}_HTTP_${response.status}`);
  }
  const body = await boundedResponseText(response, diagnosticPrefix);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProviderAdapterError(`${diagnosticPrefix}_INVALID_RESPONSE`);
  }
}

export function safeHeaderValue(value: string, code: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 32_768 || /[\r\n\0]/.test(trimmed)) {
    throw new ProviderAdapterError(code);
  }
  return trimmed;
}
