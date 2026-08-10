import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSnapshot } from "@carthing/contracts";
import { COLLECTOR_VERSION } from "../src/config";
import { ObservationStore } from "../src/state";
import { createCollectorServer, type CollectorServer } from "../src/server";
import { parseClaudeStatusline } from "../src/adapters/claude-statusline";

const TOKEN = "test-secret";
let server: CollectorServer;
let port: number;
let store: ObservationStore;

beforeAll(async () => {
  store = new ObservationStore({ localHost: "pc", collectorVersion: COLLECTOR_VERSION });
  server = createCollectorServer({
    token: TOKEN,
    getSnapshot: () => store.assembleSnapshot(),
    getHealth: () => ({ ok: true }),
    getPeerObservations: () => ({
      host: "pc",
      observations: store.localObservations().map((o) => ({
        provider: o.provider,
        receivedAt: new Date(o.receivedAtMs).toISOString(),
      })),
    }),
    ingestStatusline: (body) => store.upsertLocal(parseClaudeStatusline(body, { host: "pc" })),
  });
  port = await server.listen(0, "127.0.0.1");
});

afterAll(async () => {
  await server.close();
});

const base = (): string => `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${TOKEN}` };

describe("collector server auth", () => {
  it("serves the packaged UI without exposing telemetry or weakening headers", async () => {
    const uiDir = await mkdtemp(path.join(os.tmpdir(), "carthing-ui-"));
    await mkdir(path.join(uiDir, "assets"));
    await writeFile(path.join(uiDir, "index.html"), "<!doctype html><title>Car Thing</title>", "utf8");
    await writeFile(path.join(uiDir, "runtime-config.js"), "window.__CARTHING_CONFIG__={};", "utf8");
    await writeFile(path.join(uiDir, "assets", "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");
    const uiServer = createCollectorServer({
      token: TOKEN,
      uiDir,
      getSnapshot: () => store.assembleSnapshot(),
      getHealth: () => ({ ok: true }),
      getPeerObservations: () => ({ host: "pc", observations: [] }),
      ingestStatusline: () => {},
    });
    try {
      const uiPort = await uiServer.listen(0, "127.0.0.1");
      const res = await fetch(`http://127.0.0.1:${uiPort}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Car Thing");
      expect(res.headers.get("content-security-policy")).toContain("object-src 'none'");
      expect((await fetch(`http://127.0.0.1:${uiPort}/runtime-config.js`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${uiPort}/assets/mark.svg`)).headers.get("content-type")).toBe("image/svg+xml");
      expect((await fetch(`http://127.0.0.1:${uiPort}/v1/snapshot`)).status).toBe(401);
    } finally {
      await uiServer.close();
      await rm(uiDir, { recursive: true, force: true });
    }
  });

  it("rejects requests without a token", async () => {
    const res = await fetch(`${base()}/v1/snapshot`);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await fetch(`${base()}/v1/snapshot?token=wrong`);
    expect(res.status).toBe(401);
    const viaHeader = await fetch(`${base()}/v1/snapshot`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(viaHeader.status).toBe(401);
  });

  it("serves a valid Snapshot with a Bearer token", async () => {
    const res = await fetch(`${base()}/v1/snapshot`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await res.json();
    expect(isSnapshot(body)).toBe(true);
  });

  it("only grants CORS to configured device/development origins", async () => {
    const development = await fetch(`${base()}/v1/snapshot`, {
      headers: { ...auth, origin: "http://localhost:5173" },
    });
    expect(development.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const firmware = await fetch(`${base()}/v1/snapshot`, {
      headers: { ...auth, origin: "http://127.0.0.1:8080" },
    });
    expect(firmware.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8080");

    const firmwarePreflight = await fetch(`${base()}/v1/snapshot`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:8080",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(firmwarePreflight.status).toBe(204);
    expect(firmwarePreflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8080");

    const denied = await fetch(`${base()}/v1/snapshot`, {
      headers: { ...auth, origin: "https://attacker.example" },
    });
    expect(denied.status).toBe(200);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${base()}/v1/snapshot`, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example" },
    });
    expect(preflight.status).toBe(403);
  });

  it("rejects query-string tokens so secrets never enter URLs", async () => {
    const res = await fetch(`${base()}/v1/snapshot?token=${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("guards health and peer endpoints too", async () => {
    expect((await fetch(`${base()}/v1/health`)).status).toBe(401);
    expect((await fetch(`${base()}/v1/peer/observations`)).status).toBe(401);
    expect((await fetch(`${base()}/v1/health`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base()}/v1/peer/observations`, { headers: auth })).status).toBe(200);
  });
});

describe("statusline ingest", () => {
  it("accepts statusline JSON and folds it into the snapshot", async () => {
    const res = await fetch(`${base()}/v1/ingest/claude-statusline`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42 } } }),
    });
    expect(res.status).toBe(200);

    const snapRes = await fetch(`${base()}/v1/snapshot`, { headers: auth });
    const snapshot = (await snapRes.json()) as { providers: { id: string; quotaWindows: { id: string; usedPercent: number | null }[] }[] };
    const claude = snapshot.providers.find((p) => p.id === "claude");
    expect(claude?.quotaWindows.find((w) => w.id === "five_hour")?.usedPercent).toBe(42);
  });

  it("rejects invalid JSON bodies", async () => {
    const res = await fetch(`${base()}/v1/ingest/claude-statusline`, {
      method: "POST",
      headers: auth,
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated ingest", async () => {
    const res = await fetch(`${base()}/v1/ingest/claude-statusline`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe("websocket stream", () => {
  it("rejects a connection without a token", async () => {
    const failed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`);
      ws.on("error", () => resolve(true));
      ws.on("open", () => {
        ws.close();
        resolve(false);
      });
    });
    expect(failed).toBe(true);
  });

  it("pushes a snapshot after WebSocket subprotocol authentication", async () => {
    const message = await new Promise<unknown>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, ["carthing.v1", `auth.${TOKEN}`]);
      const timer = setTimeout(() => reject(new Error("no message")), 2000);
      ws.on("message", (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(JSON.parse(String(data)));
      });
      ws.on("error", reject);
    });
    expect(isSnapshot(message)).toBe(true);
  });

  it("broadcasts on change", async () => {
    const messages: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, ["carthing.v1", `auth.${TOKEN}`]);
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));

    const waitFor = async (count: number): Promise<void> => {
      const start = Date.now();
      while (messages.length < count) {
        if (Date.now() - start > 2000) throw new Error(`only ${messages.length}/${count} messages`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitFor(1); // initial push on connect
    server.broadcastSnapshot();
    await waitFor(2);
    ws.close();
    expect(messages.every((m) => isSnapshot(m))).toBe(true);
  });
});
