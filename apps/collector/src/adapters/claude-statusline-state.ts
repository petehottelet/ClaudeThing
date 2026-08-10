/**
 * Durable cache for the last Claude status-line observation that contained
 * subscription quota windows. Claude only exposes those windows after an API
 * response in an active session, so a collector restart must not erase the
 * last known account limits.
 */

import { isProviderSnapshot, type ProviderSnapshot } from "@carthing/contracts";
import { readJsonFile, writeJsonAtomic } from "../util";

interface PersistedClaudeStatuslineState {
  version: 1;
  provider: ProviderSnapshot;
}

export function hasClaudeRateLimits(provider: ProviderSnapshot): boolean {
  return provider.quotaWindows.some(
    (window) => window.id === "five_hour" || window.id === "seven_day",
  );
}

export async function readClaudeStatuslineState(
  file: string,
  host: string,
): Promise<ProviderSnapshot | null> {
  const state = await readJsonFile<PersistedClaudeStatuslineState>(file);
  const provider = state?.provider;
  if (
    state?.version !== 1 ||
    !isProviderSnapshot(provider) ||
    provider.id !== "claude" ||
    provider.source !== "statusline" ||
    provider.host !== host ||
    !hasClaudeRateLimits(provider)
  ) {
    return null;
  }
  return provider;
}

export async function writeClaudeStatuslineState(
  file: string,
  provider: ProviderSnapshot,
): Promise<void> {
  if (
    !isProviderSnapshot(provider) ||
    provider.id !== "claude" ||
    provider.source !== "statusline" ||
    !hasClaudeRateLimits(provider)
  ) {
    throw new Error("Only a valid Claude status-line quota observation can be persisted.");
  }
  await writeJsonAtomic(file, { version: 1, provider } satisfies PersistedClaudeStatuslineState);
}
