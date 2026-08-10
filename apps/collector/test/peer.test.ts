import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ProviderSnapshot } from "@carthing/contracts";
import { PeerSync } from "../src/peer";
import { ObservationStore } from "../src/state";
import { createCollectorServer } from "../src/server";

const observedAt = "2026-08-08T12:00:00.000Z";

function provider(source: string, host = "mac"): ProviderSnapshot {
  return {
    id: "claude",
    displayName: "Claude",
    state: "live",
    observedAt,
    source,
    host,
    quotaWindows: [],
    tokens: {
      input: 1,
      cachedInput: 0,
      reasoning: null,
      output: 1,
      total: 2,
      period: "today",
      periodStart: "2026-08-08",
    },
    cost: null,
    diagnostic: null,
  };
}

function response(host: string, providers: ProviderSnapshot[]): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      host,
      observations: providers.map((item) => ({ provider: item, receivedAt: observedAt })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("PeerSync", () => {
  it("replaces a peer host atomically so removed sources cannot linger", async () => {
    const store = new ObservationStore({ localHost: "pc", collectorVersion: "test" });
    const payloads = [response("mac", [provider("statusline"), provider("jsonl")]), response("mac", [provider("jsonl")])];
    const sync = new PeerSync({
      url: "http://mac.local:8790",
      token: "secret",
      store,
      expectedHost: "mac",
      fetchImpl: (async () => payloads.shift()!) as typeof fetch,
    });

    expect(await sync.syncOnce()).toBe(true);
    expect(store.list().filter((item) => item.origin === "peer")).toHaveLength(2);
    expect(await sync.syncOnce()).toBe(true);
    const remaining = store.list().filter((item) => item.origin === "peer");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.provider.source).toBe("jsonl");
  });

  it("rejects an unexpected peer identity before accepting observations", async () => {
    const store = new ObservationStore({ localHost: "pc", collectorVersion: "test" });
    const sync = new PeerSync({
      url: "http://mac.local:8790",
      token: "secret",
      store,
      expectedHost: "trusted-mac",
      fetchImpl: (async () => response("impostor", [provider("jsonl")])) as typeof fetch,
    });

    expect(await sync.syncOnce()).toBe(false);
    expect(sync.status().lastError).toBe("PEER_HOST_MISMATCH");
    expect(store.list()).toEqual([]);
  });

  it("rejects provider rows whose host does not match the peer envelope", async () => {
    const store = new ObservationStore({ localHost: "pc", collectorVersion: "test" });
    const wrongHost = { ...provider("jsonl"), host: "someone-else" };
    const sync = new PeerSync({
      url: "http://mac.local:8790",
      token: "secret",
      store,
      expectedHost: "mac",
      fetchImpl: (async () => response("mac", [wrongHost])) as typeof fetch,
    });

    expect(await sync.syncOnce()).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("syncs numeric observations through the real authenticated peer endpoint", async () => {
    const source = new ObservationStore({ localHost: "pc", collectorVersion: "test" });
    source.upsertLocal(provider("jsonl", "pc"));
    const server = createCollectorServer({
      token: "shared-secret",
      getSnapshot: () => source.assembleSnapshot(),
      getHealth: () => ({ ok: true }),
      getPeerObservations: () => ({
        schemaVersion: SCHEMA_VERSION,
        host: "pc",
        observations: source.localObservations().map((item) => ({ provider: item.provider })),
      }),
      ingestStatusline: () => {},
    });
    const target = new ObservationStore({ localHost: "mac", collectorVersion: "test" });
    try {
      const port = await server.listen(0, "127.0.0.1");
      const sync = new PeerSync({
        url: `http://127.0.0.1:${port}`,
        token: "shared-secret",
        store: target,
        expectedHost: "pc",
      });
      expect(await sync.syncOnce()).toBe(true);
      expect(target.list()).toHaveLength(1);
      expect(target.list()[0]?.provider).toMatchObject({ host: "pc", source: "jsonl" });
    } finally {
      await server.close();
    }
  });
});
