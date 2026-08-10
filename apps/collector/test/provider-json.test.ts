import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProviderJson } from "../src/adapters/provider-json";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "provider-json-"));
  temporary.push(value);
  return value;
}

function snapshot(id = "openrouter") {
  return {
    id,
    displayName: "OpenRouter",
    state: "live",
    observedAt: "2026-08-10T20:00:00.000Z",
    source: "untrusted",
    host: "untrusted",
    quotaWindows: [],
    tokens: null,
    cost: { amountUsd: 3.25, isEstimate: true, label: "Month-to-date estimate" },
    supplementalMetrics: [
      { id: "credits", label: "Credits", value: 12, unit: "usd", periodLabel: "Balance" },
    ],
    diagnostic: null,
  };
}

describe("provider JSON bridge", () => {
  it("validates the contract and stamps trusted origin fields", async () => {
    const root = await directory();
    await writeFile(path.join(root, "openrouter.json"), JSON.stringify(snapshot()), "utf8");
    await expect(readProviderJson({ directory: root, id: "openrouter", host: "mac" })).resolves.toMatchObject({
      id: "openrouter",
      host: "mac",
      source: "json-bridge",
      cost: { amountUsd: 3.25 },
    });
  });

  it("rejects mismatched ids and malformed documents", async () => {
    const root = await directory();
    await writeFile(path.join(root, "openrouter.json"), JSON.stringify(snapshot("another")), "utf8");
    await expect(readProviderJson({ directory: root, id: "openrouter", host: "mac" })).rejects.toThrow(
      "OPENROUTER_BRIDGE_SCHEMA_INVALID",
    );
    await writeFile(path.join(root, "openrouter.json"), "{", "utf8");
    await expect(readProviderJson({ directory: root, id: "openrouter", host: "mac" })).rejects.toThrow(
      "OPENROUTER_BRIDGE_JSON_INVALID",
    );
  });
});
