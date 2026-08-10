import type { ProviderSnapshot, QuotaWindow, SupplementalUsageMetric } from "@carthing/contracts";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson, bool, clampPercent, finite, iso, record, safeHeaderValue, text } from "./provider-http";
import { ProviderAdapterError } from "./provider-poller";

const execFile = promisify(execFileCallback);

const LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};

function metric(
  id: string,
  label: string,
  value: number | null,
  periodLabel: string | null,
  limit?: number | null,
  remaining?: number | null,
): SupplementalUsageMetric {
  return { id, label, value, unit: "requests", periodLabel, limit, remaining };
}

export function parseCopilotUsage(
  raw: unknown,
  host: string,
  observedAt = new Date().toISOString(),
): ProviderSnapshot {
  const root = record(raw);
  const snapshots = record(root?.quota_snapshots);
  if (!root || !snapshots) throw new ProviderAdapterError("COPILOT_INVALID_RESPONSE");
  const topReset = iso(root.quota_reset_date_utc) ?? iso(root.quota_reset_date);
  const quotaWindows: QuotaWindow[] = [];
  const supplementalMetrics: SupplementalUsageMetric[] = [];

  for (const [id, value] of Object.entries(snapshots)) {
    const item = record(value);
    if (!item) continue;
    const label = LABELS[id] ?? id.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
    const unlimited = bool(item.unlimited) === true;
    const remainingPercent = clampPercent(item.percent_remaining);
    const usedPercent = unlimited || remainingPercent === null ? null : 100 - remainingPercent;
    const resetsAt = iso(item.quota_reset_at) ?? topReset;
    quotaWindows.push({
      id,
      label: unlimited ? `${label} · Unlimited` : label,
      usedPercent,
      resetsAt,
      windowSeconds: null,
    });

    const used = finite(item.credits_used);
    const entitlement = finite(item.entitlement);
    const remaining = finite(item.quota_remaining) ?? finite(item.remaining);
    if (used !== null || entitlement !== null || remaining !== null) {
      supplementalMetrics.push(metric(`${id}.credits`, `${label} credits`, used, "Current cycle", entitlement, remaining));
    }
    const overage = finite(item.overage_count);
    if (overage !== null) {
      supplementalMetrics.push(metric(`${id}.overage`, `${label} overage`, overage, "Current cycle"));
    }
  }

  if (quotaWindows.length === 0 && supplementalMetrics.length === 0) {
    throw new ProviderAdapterError("COPILOT_USAGE_MISSING");
  }
  const plan = text(root.copilot_plan) ?? text(root.access_type_sku);
  return {
    id: "copilot",
    displayName: "Copilot",
    state: "live",
    observedAt,
    source: "github-api",
    host,
    quotaWindows,
    tokens: null,
    cost: null,
    identity: {
      accountLabel: text(root.login),
      plan,
      organization: null,
    },
    supplementalMetrics,
    diagnostic: null,
  };
}

async function configuredToken(env: NodeJS.ProcessEnv): Promise<string | null> {
  const file = env.CLAUDETHING_COPILOT_TOKEN_FILE;
  if (file) {
    try {
      return safeHeaderValue(await readFile(file, "utf8"), "COPILOT_TOKEN_INVALID");
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError("COPILOT_TOKEN_FILE_UNREADABLE");
    }
  }
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  return token ? safeHeaderValue(token, "COPILOT_TOKEN_INVALID") : null;
}

function ghCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  return [
    env.CLAUDETHING_GH_COMMAND,
    "gh",
    path.join(home, ".local", "bin", "gh"),
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
  ].filter((value): value is string => Boolean(value));
}

async function fetchViaGh(home: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  for (const command of ghCandidates(home, env)) {
    try {
      const { stdout } = await execFile(command, ["api", "copilot_internal/user"], {
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
      return JSON.parse(stdout) as unknown;
    } catch {
      // Try the next known executable location. No stderr is logged because it
      // can contain account or credential diagnostics.
    }
  }
  throw new ProviderAdapterError("COPILOT_GITHUB_LOGIN_REQUIRED");
}

export function createCopilotFetcher(options: {
  host: string;
  home: string;
  env?: NodeJS.ProcessEnv;
}): () => Promise<ProviderSnapshot> {
  const env = options.env ?? process.env;
  return async () => {
    const token = await configuredToken(env);
    const raw = token
      ? await fetchJson(
          "https://api.github.com/copilot_internal/user",
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: "application/json",
              "User-Agent": "ClaudeThing/0.1",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
          "COPILOT",
        )
      : await fetchViaGh(options.home, env);
    return parseCopilotUsage(raw, options.host);
  };
}
