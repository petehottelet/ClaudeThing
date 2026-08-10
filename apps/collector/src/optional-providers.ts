import { providerCatalogEntry, type DashboardProviderConfig, type ProviderSnapshot } from "@carthing/contracts";
import os from "node:os";
import path from "node:path";
import { createCopilotFetcher } from "./adapters/copilot";
import { createCursorFetcher } from "./adapters/cursor";
import { createDroidFetcher } from "./adapters/droid";
import { createGeminiFetcher } from "./adapters/gemini";
import { readProviderJson } from "./adapters/provider-json";
import { ProviderPoller } from "./adapters/provider-poller";

const DIRECT_REFRESH_MS = 5 * 60_000;
const BRIDGE_REFRESH_MS = 15_000;
const BUILTIN_IDS = new Set(["claude", "codex"]);
const NATIVE_SOURCES: Record<string, string> = {
  cursor: "cursor-app",
  droid: "factory-api",
  gemini: "gemini-cli-oauth",
  copilot: "github-api",
};

/** Starts only adapters enabled in the hot-reloaded dashboard config. Native
 * collectors are explicit; every other catalog/future id uses the validated
 * JSON bridge. Disabled adapters stop making network or filesystem calls. */
export class OptionalProviderManager {
  private readonly pollers = new Map<string, ProviderPoller>();

  constructor(private readonly options: {
    host: string;
    providerDirectory: string;
    dataDirectory: string;
    onObservation: (snapshot: ProviderSnapshot) => void;
  }) {}

  sync(providers: DashboardProviderConfig[]): void {
    const enabled = new Set(
      providers.filter((provider) => provider.enabled && !BUILTIN_IDS.has(provider.id)).map((provider) => provider.id),
    );
    for (const [id, poller] of this.pollers) {
      if (!enabled.has(id)) {
        poller.stop();
        this.pollers.delete(id);
      }
    }
    for (const id of enabled) {
      if (this.pollers.has(id)) continue;
      const poller = this.create(id);
      this.pollers.set(id, poller);
      poller.start();
    }
  }

  stop(): void {
    for (const poller of this.pollers.values()) poller.stop();
    this.pollers.clear();
  }

  private create(id: string): ProviderPoller {
    const home = os.homedir();
    const directFetchers: Record<string, () => Promise<ProviderSnapshot>> = {
      cursor: createCursorFetcher({ host: this.options.host, home }),
      droid: createDroidFetcher({ host: this.options.host, home }),
      gemini: createGeminiFetcher({ host: this.options.host, home }),
      copilot: createCopilotFetcher({ host: this.options.host, home }),
    };
    const nativeFetcher = directFetchers[id];
    const catalog = providerCatalogEntry(id);
    return new ProviderPoller({
      id,
      displayName: catalog?.displayName ?? id,
      host: this.options.host,
      source: NATIVE_SOURCES[id] ?? "json-bridge",
      intervalMs: nativeFetcher ? DIRECT_REFRESH_MS : BRIDGE_REFRESH_MS,
      fetchSnapshot: nativeFetcher ?? (() => readProviderJson({
        directory: this.options.providerDirectory,
        id,
        host: this.options.host,
      })),
      stateFile: path.join(this.options.dataDirectory, "provider-state", `${id}.json`),
      onObservation: this.options.onObservation,
    });
  }
}
