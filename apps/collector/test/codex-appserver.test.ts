import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import {
  CodexAppServerAdapter,
  parseResetCreditFacts,
  parseUsage,
  parseUsageSummaryFacts,
  splitCommand,
  type JsonRpcTransport,
} from "../src/adapters/codex-appserver";
import { parseCodexRateLimits } from "../src/adapters/codex-common";
import { isObject } from "../src/util";

class MockTransport implements JsonRpcTransport {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private messageHandler: ((m: unknown) => void) | null = null;
  private closeHandler: ((e?: Error) => void) | null = null;

  constructor(private readonly responder?: (msg: Record<string, unknown>, t: MockTransport) => void) {}

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
    this.responder?.(message, this);
  }
  onMessage(handler: (m: unknown) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (e?: Error) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }
  receive(message: unknown): void {
    this.messageHandler?.(message);
  }
  triggerClose(): void {
    this.closeHandler?.();
  }
}

function respondingTransport(): MockTransport {
  return new MockTransport((msg, t) => {
    if (typeof msg.id !== "number") return; // notifications need no response
    const id = msg.id;
    setImmediate(() => {
      if (msg.method === "initialize") {
        t.receive({ jsonrpc: "2.0", id, result: {} });
      } else if (msg.method === "account/rateLimits/read") {
        t.receive({
          jsonrpc: "2.0",
          id,
          result: {
            rateLimits: {
              primary: { usedPercent: 33, resetsAt: "2026-08-08T15:00:00Z", windowMinutes: 300 },
              secondary: { usedPercent: 64, resetsAt: 1765200000 },
            },
            rateLimitResetCredits: {
              availableCount: 1,
              credits: [{ expiresAt: 1_786_555_918 }],
            },
          },
        });
      } else if (msg.method === "account/usage/read") {
        t.receive({
          jsonrpc: "2.0",
          id,
          result: {
            usage: { today: { inputTokens: 10, cachedInputTokens: 5, reasoningOutputTokens: 2, outputTokens: 3, totalTokens: 20 } },
            summary: { lifetimeTokens: 1_000, currentStreakDays: 3 },
          },
        });
      } else {
        t.receive({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
      }
    });
  });
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("CodexAppServerAdapter", () => {
  it("splits a quoted executable without invoking a command shell", () => {
    expect(splitCommand('"C:\\Program Files\\Codex\\codex.exe" app-server')).toEqual([
      "C:\\Program Files\\Codex\\codex.exe",
      "app-server",
    ]);
  });
  it("initializes, reads rate limits and usage, and emits a live observation", async () => {
    const transport = respondingTransport();
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => transport,
      onObservation: (o) => observations.push(o),
      usagePollMs: 0,
    });
    adapter.start();
    await until(() => observations.some((o) => o.state === "live"));
    adapter.stop();

    // Handshake ordering: initialize request, then initialized notification.
    expect(transport.sent[0]?.method).toBe("initialize");
    expect(transport.sent[1]?.method).toBe("initialized");
    expect("id" in (transport.sent[1] ?? {})).toBe(false);

    const live = observations.find((o) => o.state === "live")!;
    const primary = live.quotaWindows.find((w) => w.id === "primary");
    const secondary = live.quotaWindows.find((w) => w.id === "secondary");
    expect(primary).toMatchObject({ label: "Current", usedPercent: 33, windowSeconds: 18000 });
    expect(primary?.resetsAt).toBe("2026-08-08T15:00:00.000Z");
    expect(secondary).toMatchObject({ label: "Weekly", usedPercent: 64 });
    expect(secondary?.resetsAt).toBe(new Date(1765200000 * 1000).toISOString());
    expect(live.tokens).toMatchObject({ input: 10, cachedInput: 5, reasoning: 2, output: 3, total: 20, period: "today" });
    expect(live.usageFacts).toMatchObject({
      resetCreditsAvailable: 1,
      lifetimeTokens: 1_000,
      currentStreakDays: 3,
    });
    expect(live.source).toBe("app-server");
  });

  it("re-reads rate limits on the poll cadence so late-appearing limits surface", async () => {
    // First read: one plain limit. Later reads: a per-limit-id map with an
    // extra named model limit — only a periodic re-read can discover it,
    // and a connect-frozen observation would lose freshest-wins anyway.
    let reads = 0;
    const transport = new MockTransport((msg, t) => {
      if (typeof msg.id !== "number") return;
      const id = msg.id;
      setImmediate(() => {
        if (msg.method === "initialize") {
          t.receive({ jsonrpc: "2.0", id, result: {} });
        } else if (msg.method === "account/rateLimits/read") {
          reads += 1;
          t.receive({
            jsonrpc: "2.0",
            id,
            result:
              reads === 1
                ? { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080 } } }
                : {
                    rateLimits: { primary: { usedPercent: 6, windowDurationMins: 10080 } },
                    rateLimitsByLimitId: {
                      codex: { limitId: "codex", primary: { usedPercent: 6, windowDurationMins: 10080 } },
                      codex_model: {
                        limitId: "codex_model",
                        limitName: "Model Preview",
                        primary: { usedPercent: 0, windowDurationMins: 10080 },
                      },
                    },
                  },
          });
        } else {
          t.receive({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown" } });
        }
      });
    });
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => transport,
      onObservation: (o) => observations.push(o),
      usagePollMs: 20,
    });
    adapter.start();
    await until(() =>
      observations.some((o) => o.quotaWindows.some((w) => w.id === "codex_model:primary")),
    );
    adapter.stop();

    expect(reads).toBeGreaterThanOrEqual(2);
    const rich = observations.find((o) =>
      o.quotaWindows.some((w) => w.id === "codex_model:primary"),
    )!;
    const model = rich.quotaWindows.find((w) => w.id === "codex_model:primary");
    expect(model).toMatchObject({ label: "Model Preview · Weekly", usedPercent: 0 });
    expect(rich.quotaWindows.some((w) => w.id === "codex:primary")).toBe(true);
  });

  it("applies account/rateLimits/updated notifications", async () => {
    const transport = respondingTransport();
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => transport,
      onObservation: (o) => observations.push(o),
      usagePollMs: 0,
    });
    adapter.start();
    await until(() => observations.length >= 1);

    transport.receive({
      jsonrpc: "2.0",
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { used_percent: 90, resets_in_seconds: 60 } } },
    });
    await until(() => observations.some((o) => o.quotaWindows.some((w) => w.usedPercent === 90)));
    adapter.stop();

    const updated = observations.at(-1)!;
    expect(updated.quotaWindows.find((w) => w.id === "primary")?.usedPercent).toBe(90);
    expect(updated.quotaWindows.find((w) => w.id === "secondary")?.usedPercent).toBe(64);
    expect(updated.state).toBe("live");
  });

  it("parses the official multi-bucket and daily-usage schemas", () => {
    const now = Date.parse("2026-08-08T12:00:00.000Z");
    const windows = parseCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1786194000 },
          },
          codex_other: {
            limitId: "codex_other",
            limitName: "Reviews",
            primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: 1786197600 },
          },
        },
      },
      now,
    );
    expect(windows.map((window) => window.id)).toEqual(["codex:primary", "codex_other:primary"]);
    expect(windows[0]).toMatchObject({ label: "Current", windowSeconds: 900, usedPercent: 25 });
    expect(windows[1]).toMatchObject({ label: "Reviews · Current", windowSeconds: 3600, usedPercent: 42 });
    expect(
      parseCodexRateLimits(
        { rateLimits: { limitId: "codex", primary: { usedPercent: 31, windowDurationMins: 15 } } },
        now,
      )[0],
    ).toMatchObject({ id: "codex:primary", usedPercent: 31 });

    expect(
      parseUsage(
        {
          summary: { lifetimeTokens: 1_234_567 },
          dailyUsageBuckets: [{ startDate: "2026-08-08", tokens: 12_345 }],
        },
        now,
      ),
    ).toEqual({
      input: null,
      cachedInput: null,
      reasoning: null,
      output: null,
      total: 12_345,
      period: "today",
      periodStart: "2026-08-08",
    });
  });

  it("parses reset credits and account summary facts without inventing missing fields", () => {
    expect(
      parseResetCreditFacts({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [{ resetType: "codexRateLimits", expiresAt: 1_786_555_918 }],
        },
      }),
    ).toMatchObject({
      resetCreditsAvailable: 1,
      resetCreditExpiresAt: new Date(1_786_555_918_000).toISOString(),
    });
    expect(
      parseUsageSummaryFacts({
        summary: {
          lifetimeTokens: 123_456,
          peakDailyTokens: 25_000,
          currentStreakDays: 4,
          longestStreakDays: 9,
          longestRunningTurnSec: 312,
        },
      }),
    ).toMatchObject({
      lifetimeTokens: 123_456,
      peakDailyTokens: 25_000,
      currentStreakDays: 4,
      longestStreakDays: 9,
      longestRunningTurnSeconds: 312,
    });
    expect(parseResetCreditFacts({ rateLimits: {} })).toBeNull();
  });

  it("does not let a later usage read refresh retained quota age", async () => {
    let now = Date.parse("2026-08-08T12:00:00.000Z");
    const limitObservedAt = new Date(now).toISOString();
    const transport = new MockTransport((msg, t) => {
      if (typeof msg.id !== "number") return;
      const id = msg.id;
      setImmediate(() => {
        if (msg.method === "initialize") t.receive({ id, result: {} });
        else if (msg.method === "account/rateLimits/read") {
          t.receive({ id, result: { rateLimits: { primary: { usedPercent: 20 } } } });
        } else if (msg.method === "account/usage/read") {
          now += 10 * 60_000;
          t.receive({ id, result: { dailyUsageBuckets: [{ startDate: "2026-08-08", tokens: 99 }] } });
        }
      });
    });
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => transport,
      onObservation: (observation) => observations.push(observation),
      usagePollMs: 0,
      now: () => now,
    });
    adapter.start();
    await until(() => observations.some((observation) => observation.state === "live"));
    adapter.stop();
    expect(observations.at(-1)?.observedAt).toBe(limitObservedAt);
  });

  it("emits an error observation with APP_SERVER_UNREACHABLE and reconnects with backoff", async () => {
    let attempts = 0;
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => {
        attempts++;
        throw new Error("spawn failed");
      },
      onObservation: (o) => observations.push(o),
      backoff: { initialMs: 10, maxMs: 40 },
      usagePollMs: 0,
    });
    adapter.start();
    await until(() => attempts >= 3);
    adapter.stop();

    const error = observations.find((o) => o.state === "error");
    expect(error?.diagnostic).toBe("APP_SERVER_UNREACHABLE");
    expect(error?.quotaWindows).toEqual([]);
    expect(error?.tokens).toBeNull();
  });

  it("emits an error observation when the transport closes mid-session", async () => {
    const transport = respondingTransport();
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => transport,
      onObservation: (o) => observations.push(o),
      backoff: { initialMs: 10_000, maxMs: 10_000 }, // no visible reconnect during the test
      usagePollMs: 0,
    });
    adapter.start();
    await until(() => observations.some((o) => o.state === "live"));

    transport.triggerClose();
    await until(() => observations.some((o) => o.state === "error"));
    adapter.stop();

    const error = observations.find((o) => o.state === "error")!;
    expect(error.diagnostic).toBe("APP_SERVER_UNREACHABLE");
    // Last known telemetry is retained on the error observation (aged, not zeroed).
    expect(error.quotaWindows.length).toBeGreaterThan(0);
  });

  it("validates malformed rate-limit shapes without emitting bogus windows", async () => {
    const transport = new MockTransport((msg, t) => {
      if (typeof msg.id !== "number") return;
      const id = msg.id;
      setImmediate(() => {
        if (msg.method === "initialize") t.receive({ jsonrpc: "2.0", id, result: {} });
        else if (msg.method === "account/rateLimits/read")
          t.receive({ jsonrpc: "2.0", id, result: { rateLimits: "totally wrong" } });
        else t.receive({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
      });
    });
    const observations: ProviderSnapshot[] = [];
    const adapter = new CodexAppServerAdapter({
      host: "pc",
      createTransport: () => transport,
      onObservation: (o) => observations.push(o),
      usagePollMs: 0,
    });
    adapter.start();
    await until(() => observations.length >= 1);
    adapter.stop();

    const first = observations[0]!;
    expect(first.quotaWindows).toEqual([]);
    expect(first.diagnostic).toBe("RATE_LIMITS_MISSING");
    expect(isObject(first)).toBe(true);
  });
});
