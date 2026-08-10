/**
 * HTTP + WebSocket server for the collector.
 *
 * Routes (all token-gated; LAN-local trust model, the pairing token is the gate):
 *   GET  /v1/snapshot                  merged Snapshot
 *   GET  /v1/health                    versions, observation ages, peer status
 *   GET  /v1/peer/observations         raw local observations for peer sync
 *   POST /v1/ingest/claude-statusline  raw statusline JSON → statusline adapter
 *   WS   /v1/stream                    merged Snapshot on every change + 15s heartbeat
 *
 * Auth: HTTP Bearer header or WebSocket `auth.<token>` subprotocol.
 * Pairing secrets never appear in request URLs.
 * Never serves raw session records, paths, prompts, or the token itself.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Snapshot } from "@carthing/contracts";

export interface CollectorServerDeps {
  token: string;
  getSnapshot: () => Snapshot;
  getHealth: () => unknown;
  getPeerObservations: () => unknown;
  ingestStatusline: (body: unknown) => void | Promise<void>;
  allowedOrigins?: string[];
  uiDir?: string | null;
}

export interface CollectorServer {
  listen(port: number, hostname?: string): Promise<number>;
  broadcastSnapshot(): void;
  clientCount(): number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;

export function createCollectorServer(deps: CollectorServerDeps): CollectorServer {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has("carthing.v1") ? "carthing.v1" : false;
    },
  });
  const alive = new Map<WebSocket, boolean>();
  let heartbeat: NodeJS.Timeout | null = null;

  function tokenMatches(provided: string | null): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(deps.token, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function httpTokenOk(req: IncomingMessage): boolean {
    let provided: string | null = null;
    const header = req.headers.authorization;
    if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
      provided = header.slice(7).trim();
    }
    return tokenMatches(provided);
  }

  function websocketTokenOk(req: IncomingMessage): boolean {
    const raw = req.headers["sec-websocket-protocol"];
    if (typeof raw !== "string") return false;
    const authProtocol = raw
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.startsWith("auth."));
    return tokenMatches(authProtocol ? authProtocol.slice(5) : null);
  }

  function corsOrigin(req: IncomingMessage): string | null {
    const origin = req.headers.origin;
    if (typeof origin !== "string") return null;
    const allowed = deps.allowedOrigins ?? [
      "null",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:8080",
    ];
    return allowed.includes(origin) ? origin : null;
  }

  function json(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    const origin = corsOrigin(req);
    res.writeHead(status, {
      "content-type": "application/json",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", (e) => reject(e));
    });
  }

  async function serveUi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!deps.uiDir || req.method !== "GET") return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (
      pathname !== "/" &&
      pathname !== "/index.html" &&
      pathname !== "/runtime-config.js" &&
      !pathname.startsWith("/assets/")
    ) {
      return false;
    }
    const root = path.resolve(deps.uiDir);
    const relativeName = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.resolve(root, relativeName);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return false;
    }
    const ext = path.extname(file).toLowerCase();
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : ext === ".woff2"
              ? "font/woff2"
              : ext === ".woff"
                ? "font/woff"
                : ext === ".svg"
                  ? "image/svg+xml"
                  : ext === ".png"
                    ? "image/png"
                : "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; connect-src 'self' http: https: ws: wss:; font-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      const origin = corsOrigin(req);
      if (!origin) {
        json(req, res, 403, { error: "origin_forbidden" });
        return;
      }
      res.writeHead(204, {
        "access-control-allow-origin": origin,
        vary: "Origin",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    if (await serveUi(req, res, url)) return;

    if (!httpTokenOk(req)) {
      json(req, res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/snapshot") {
      json(req, res, 200, deps.getSnapshot());
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/health") {
      json(req, res, 200, deps.getHealth());
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/peer/observations") {
      json(req, res, 200, deps.getPeerObservations());
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/ingest/claude-statusline") {
      const body = await readBody(req);
      if (body === null) {
        json(req, res, 413, { error: "payload_too_large" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(req, res, 400, { error: "invalid_json" });
        return;
      }
      try {
        await deps.ingestStatusline(parsed);
      } catch {
        json(req, res, 400, { error: "ingest_failed" });
        return;
      }
      json(req, res, 200, { ok: true });
      return;
    }

    json(req, res, 404, { error: "not_found" });
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Never leak internals in error responses.
      try {
        json(req, res, 500, { error: "internal" });
      } catch {
        // Response already gone.
      }
    });
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/stream") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!websocketTokenOk(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("close", () => alive.delete(ws));
      ws.on("error", () => {
        // Client-side errors terminate that client only.
      });
      trySendSnapshot(ws);
    });
  });

  function trySendSnapshot(ws: WebSocket): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(deps.getSnapshot()));
    } catch {
      // Snapshot assembly failure must not kill the socket loop.
    }
  }

  return {
    listen(port: number, hostname = "0.0.0.0"): Promise<number> {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, hostname, () => {
          heartbeat = setInterval(() => {
            for (const ws of wss.clients) {
              if (alive.get(ws) === false) {
                ws.terminate();
                continue;
              }
              alive.set(ws, false);
              try {
                ws.ping();
              } catch {
                ws.terminate();
              }
            }
          }, HEARTBEAT_MS);
          heartbeat.unref?.();
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },

    broadcastSnapshot(): void {
      let payload: string;
      try {
        payload = JSON.stringify(deps.getSnapshot());
      } catch {
        return;
      }
      for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload, () => {
            // Send errors surface via the socket's own error/close events.
          });
        }
      }
    },

    clientCount(): number {
      return wss.clients.size;
    },

    close(): Promise<void> {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      httpServer.closeAllConnections();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
