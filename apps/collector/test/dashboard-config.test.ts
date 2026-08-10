import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardConfigStore, parseDashboardConfig, stripJsonComments } from "../src/dashboard-config";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const valid = `{
  // Provider rows can be uncommented by hand.
  "version": 1,
  "providers": [
    { "id": "Claude", "enabled": true, "show": ["quota", "history"] },
    // { "id": "future", "enabled": true, "show": ["quota"] }
  ],
  "youtube": { "channelName": "Channel // Name", "channelHandle": "@channel" },
  "ga4": { "propertyName": "Website", "propertyId": "123" },
  "markets": {
    "rotationSeconds": 12,
    "instruments": [{ "symbol": "NVDA", "name": "NVIDIA", "kind": "stock" }]
  }
}`;

describe("dashboard config", () => {
  it("supports comments without corrupting comment-like text inside strings", () => {
    expect(stripJsonComments('/* x */ {"url":"https://example.test"} // y')).toContain(
      '"https://example.test"',
    );
    const parsed = parseDashboardConfig(valid);
    expect(parsed.providers[0]?.id).toBe("claude");
    expect(parsed.youtube.channelName).toBe("Channel // Name");
    expect(parsed.markets.rotationSeconds).toBe(12);
  });

  it("rejects duplicate providers, duplicate markets, and unknown data lanes", () => {
    expect(() => parseDashboardConfig(valid.replace('"history"', '"notReal"'))).toThrow(
      /INVALID/,
    );
    expect(() =>
      parseDashboardConfig(
        valid.replace(
          '// { "id": "future", "enabled": true, "show": ["quota"] }',
          '{ "id": "claude", "enabled": true, "show": ["quota"] }',
        ),
      ),
    ).toThrow(/DUPLICATE_PROVIDER/);
  });

  it("retains the last valid config when a live edit is invalid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-config-"));
    temporary.push(dir);
    const file = path.join(dir, "dashboard-config.jsonc");
    await writeFile(file, valid, "utf8");
    const store = new DashboardConfigStore(file);
    expect(await store.refresh()).toBe(true);
    expect(store.current().markets.rotationSeconds).toBe(12);

    await writeFile(file, "{ broken", "utf8");
    expect(await store.refresh()).toBe(true);
    expect(store.warning()).toBe("DASHBOARD_CONFIG_INVALID");
    expect(store.current().markets.rotationSeconds).toBe(12);
  });
});
