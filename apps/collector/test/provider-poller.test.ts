import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderAdapterError, ProviderPoller } from "../src/adapters/provider-poller";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function snapshot(): ProviderSnapshot {
  return {
    id: "openrouter",
    displayName: "OpenRouter",
    state: "live",
    observedAt: "2026-08-10T20:00:00.000Z",
    source: "json-bridge",
    host: "mac",
    quotaWindows: [],
    tokens: null,
    cost: { amountUsd: 2, isEstimate: true, label: "Estimate" },
    diagnostic: null,
  };
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > 2_000) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("provider poller persistence", () => {
  it("writes and restores display-only last-good data across restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "provider-poller-"));
    temporary.push(directory);
    const stateFile = path.join(directory, "state", "openrouter.json");
    const first: ProviderSnapshot[] = [];
    const writer = new ProviderPoller({
      id: "openrouter",
      displayName: "OpenRouter",
      host: "mac",
      source: "json-bridge",
      intervalMs: 60_000,
      stateFile,
      fetchSnapshot: async () => snapshot(),
      onObservation: (observation) => first.push(observation),
    });
    writer.start();
    await until(() => first.length === 1);
    await until(async () => {
      try {
        return Boolean(await readFile(stateFile, "utf8"));
      } catch {
        return false;
      }
    });
    writer.stop();

    const restored: ProviderSnapshot[] = [];
    const reader = new ProviderPoller({
      id: "openrouter",
      displayName: "OpenRouter",
      host: "mac",
      source: "json-bridge",
      intervalMs: 60_000,
      stateFile,
      fetchSnapshot: async () => { throw new ProviderAdapterError("OPENROUTER_OFFLINE"); },
      onObservation: (observation) => restored.push(observation),
    });
    reader.start();
    await until(() => restored.length >= 2);
    reader.stop();
    expect(restored[0]).toMatchObject({ state: "live", cost: { amountUsd: 2 } });
    expect(restored[1]).toMatchObject({ state: "error", diagnostic: "OPENROUTER_OFFLINE", cost: { amountUsd: 2 } });
  });
});
