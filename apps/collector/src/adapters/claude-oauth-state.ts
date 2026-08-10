/** Durable cache for the last successful Claude OAuth quota observation. */

import { isProviderSnapshot, type ProviderSnapshot } from "@carthing/contracts";
import { readJsonFile, writeJsonAtomic } from "../util";

interface PersistedClaudeOauthState {
  version: 1;
  provider: ProviderSnapshot;
}

function valid(provider: unknown, host?: string): provider is ProviderSnapshot {
  return (
    isProviderSnapshot(provider) &&
    provider.id === "claude" &&
    provider.source === "oauth" &&
    provider.state === "live" &&
    provider.observedAt !== null &&
    provider.quotaWindows.length > 0 &&
    (host === undefined || provider.host === host)
  );
}

export async function readClaudeOauthState(
  file: string,
  host: string,
): Promise<ProviderSnapshot | null> {
  const state = await readJsonFile<PersistedClaudeOauthState>(file);
  return state?.version === 1 && valid(state.provider, host) ? state.provider : null;
}

export async function writeClaudeOauthState(
  file: string,
  provider: ProviderSnapshot,
): Promise<void> {
  if (!valid(provider)) throw new Error("Only a live Claude OAuth quota observation can be persisted.");
  await writeJsonAtomic(file, { version: 1, provider } satisfies PersistedClaudeOauthState);
}
