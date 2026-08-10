import type { ProviderSnapshot, QuotaWindow } from "@carthing/contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { boundedResponseText, clampPercent, finite, record, safeHeaderValue, text } from "./provider-http";
import { ProviderAdapterError } from "./provider-poller";

interface GeminiCredentials {
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  expiryMs: number | null;
  clientId: string | null;
  clientSecret: string | null;
}

function decodeJwt(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const encoded = token.split(".")[1];
  if (!encoded) return null;
  try {
    return record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function credentialsFrom(raw: unknown): GeminiCredentials {
  const root = record(raw);
  if (!root) throw new ProviderAdapterError("GEMINI_CREDENTIALS_INVALID");
  return {
    accessToken: text(root.access_token),
    refreshToken: text(root.refresh_token),
    idToken: text(root.id_token),
    expiryMs: finite(root.expiry_date),
    clientId: text(root.client_id),
    clientSecret: text(root.client_secret),
  };
}

async function readCredentials(home: string): Promise<GeminiCredentials> {
  try {
    return credentialsFrom(JSON.parse(await readFile(path.join(home, ".gemini", "oauth_creds.json"), "utf8")));
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    throw new ProviderAdapterError("GEMINI_LOGIN_REQUIRED");
  }
}

async function googleRequest(
  url: string,
  accessToken: string,
  body: unknown,
  code: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${safeHeaderValue(accessToken, "GEMINI_TOKEN_INVALID")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderAdapterError(`${code}_NETWORK_ERROR`);
  }
  const responseText = await boundedResponseText(response, code);
  const normalized = responseText.toLowerCase();
  if (
    normalized.includes("unsupported_client") ||
    normalized.includes("ineligibletiererror") ||
    (normalized.includes("no longer supported") && normalized.includes("gemini code assist"))
  ) {
    throw new ProviderAdapterError("GEMINI_CONSUMER_TIER_UNSUPPORTED");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderAdapterError("GEMINI_AUTH_REQUIRED");
  }
  if (!response.ok) throw new ProviderAdapterError(`${code}_HTTP_${response.status}`);
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new ProviderAdapterError(`${code}_INVALID_RESPONSE`);
  }
}

async function refreshAccessToken(
  credentials: GeminiCredentials,
  env: NodeJS.ProcessEnv,
): Promise<{ accessToken: string; expiresAtMs: number }> {
  const refreshToken = credentials.refreshToken;
  const clientId = env.CLAUDETHING_GEMINI_OAUTH_CLIENT_ID ?? credentials.clientId;
  const clientSecret = env.CLAUDETHING_GEMINI_OAUTH_CLIENT_SECRET ?? credentials.clientSecret;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new ProviderAdapterError("GEMINI_TOKEN_EXPIRED_RUN_CLI");
  }
  const body = new URLSearchParams({
    client_id: safeHeaderValue(clientId, "GEMINI_OAUTH_CONFIG_INVALID"),
    client_secret: safeHeaderValue(clientSecret, "GEMINI_OAUTH_CONFIG_INVALID"),
    refresh_token: safeHeaderValue(refreshToken, "GEMINI_REFRESH_TOKEN_INVALID"),
    grant_type: "refresh_token",
  });
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderAdapterError("GEMINI_REFRESH_NETWORK_ERROR");
  }
  if (!response.ok) throw new ProviderAdapterError("GEMINI_REFRESH_REJECTED");
  const refreshed = record(await response.json());
  const token = text(refreshed?.access_token);
  if (!token) throw new ProviderAdapterError("GEMINI_REFRESH_INVALID_RESPONSE");
  const expiresInSeconds = finite(refreshed?.expires_in) ?? 3600;
  return {
    accessToken: token,
    expiresAtMs: Date.now() + Math.max(60, expiresInSeconds) * 1000,
  };
}

function paidTierName(root: Record<string, unknown>): string | null {
  const direct = record(root.paidTier);
  const current = record(root.currentTier);
  const currentPaid = record(current?.paidTier);
  return text(direct?.name) ?? text(currentPaid?.name) ?? text(root.paidTierName);
}

function planLabel(loadCodeAssist: unknown, claims: Record<string, unknown> | null): string | null {
  const root = record(loadCodeAssist);
  if (!root) return null;
  const paid = paidTierName(root);
  if (paid) return paid;
  const tier = text(record(root.currentTier)?.id);
  if (tier === "standard-tier") return "Paid";
  if (tier === "legacy-tier") return "Legacy";
  if (tier === "free-tier" && text(claims?.hd)) return "Workspace";
  if (tier === "free-tier") return "Free";
  return null;
}

function quotaBuckets(raw: unknown): unknown[] {
  const root = record(raw);
  if (!root) return [];
  if (Array.isArray(root.buckets)) return root.buckets;
  const quota = record(root.quota);
  return Array.isArray(quota?.buckets) ? quota.buckets : [];
}

export function parseGeminiUsage(
  quotaRaw: unknown,
  loadCodeAssistRaw: unknown,
  idToken: string | null,
  host: string,
  observedAt = new Date().toISOString(),
): ProviderSnapshot {
  const byModel = new Map<string, { remaining: number; reset: string | null }>();
  for (const value of quotaBuckets(quotaRaw)) {
    const bucket = record(value);
    const modelId = text(bucket?.modelId);
    const remaining = finite(bucket?.remainingFraction);
    if (!modelId || remaining === null) continue;
    const normalized = Math.min(1, Math.max(0, remaining));
    const existing = byModel.get(modelId);
    if (!existing || normalized < existing.remaining) {
      const reset = bucket?.resetTime;
      byModel.set(modelId, {
        remaining: normalized,
        reset: typeof reset === "string" && !Number.isNaN(Date.parse(reset)) ? new Date(reset).toISOString() : null,
      });
    }
  }
  const quotaWindows: QuotaWindow[] = [...byModel.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([modelId, item]) => ({
      id: modelId.replace(/[^A-Za-z0-9._-]/g, "_"),
      label: modelId,
      usedPercent: clampPercent((1 - item.remaining) * 100),
      resetsAt: item.reset,
      windowSeconds: 86400,
    }));
  if (quotaWindows.length === 0) throw new ProviderAdapterError("GEMINI_QUOTA_MISSING");
  const claims = decodeJwt(idToken);
  return {
    id: "gemini",
    displayName: "Gemini",
    state: "live",
    observedAt,
    source: "gemini-cli-oauth",
    host,
    quotaWindows,
    tokens: null,
    cost: null,
    identity: {
      accountLabel: text(claims?.email),
      plan: planLabel(loadCodeAssistRaw, claims),
      organization: text(claims?.hd),
    },
    diagnostic: null,
  };
}

export function createGeminiFetcher(options: {
  host: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}): () => Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  let memoryToken: { accessToken: string; expiresAtMs: number } | null = null;
  return async () => {
    const credentials = await readCredentials(options.home);
    const diskTokenValid =
      credentials.accessToken !== null &&
      (credentials.expiryMs === null || credentials.expiryMs > Date.now() + 60_000);
    if (!memoryToken || memoryToken.expiresAtMs <= Date.now() + 60_000) {
      memoryToken = diskTokenValid
        ? { accessToken: credentials.accessToken!, expiresAtMs: credentials.expiryMs ?? Date.now() + 5 * 60_000 }
        : await refreshAccessToken(credentials, env);
    }

    const readUsage = async (accessToken: string): Promise<ProviderSnapshot> => {
      const loadCodeAssist = await googleRequest(
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        accessToken,
        { metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } },
        "GEMINI_TIER",
      );
      const loadRoot = record(loadCodeAssist);
      const projectField = loadRoot?.cloudaicompanionProject;
      const projectObject = record(projectField);
      const project =
        text(projectField) ?? text(projectObject?.id) ?? text(projectObject?.projectId);
      const quota = await googleRequest(
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
        accessToken,
        project ? { project } : {},
        "GEMINI_QUOTA",
      );
      return parseGeminiUsage(quota, loadCodeAssist, credentials.idToken, options.host);
    };

    try {
      return await readUsage(memoryToken.accessToken);
    } catch (error) {
      if (!(error instanceof ProviderAdapterError) || error.code !== "GEMINI_AUTH_REQUIRED") throw error;
      memoryToken = await refreshAccessToken(credentials, env);
      return readUsage(memoryToken.accessToken);
    }
  };
}
