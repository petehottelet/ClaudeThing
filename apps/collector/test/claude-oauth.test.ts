/**
 * Claude OAuth quota poller: maps the usage endpoint's five_hour/seven_day
 * plus named scoped limits into quota windows, degrades honestly on expired
 * or rejected credentials, and stays completely silent when no CLI login
 * exists on the host.
 */

import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import { ClaudeOauthAdapter, parseOauthUsage } from "../src/adapters/claude-oauth";

const USAGE_BODY = {
  five_hour: { utilization: 4, resets_at: "2026-08-10T18:10:00.443546+00:00" },
  seven_day: { utilization: 61, resets_at: "2026-08-11T06:00:00.443566+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 4, resets_at: "2026-08-10T18:10:00Z" },
    { kind: "weekly_all", group: "weekly", percent: 61, resets_at: "2026-08-11T06:00:00Z" },
    {
      kind: "weekly_scoped",
      group: "weekly",
      utilization: 99,
      resets_at: "2026-08-11T06:00:00Z",
      is_active: true,
    },
    { kind: "mystery_null", group: "weekly", percent: null },
  ],
};

describe("parseOauthUsage", () => {
  it("promotes the active scoped cap to Weekly and retains the all-model aggregate", () => {
    const windows = parseOauthUsage(USAGE_BODY);
    expect(windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "oauth_weekly_all"]);
    expect(windows[0]).toMatchObject({ label: "Current", usedPercent: 4, windowSeconds: 18000 });
    expect(windows[1]).toMatchObject({ label: "Weekly", usedPercent: 99, windowSeconds: 604800 });
    expect(windows[2]).toMatchObject({ label: "Weekly all", usedPercent: 61, windowSeconds: 604800 });
    expect(windows[2]?.resetsAt).toBe("2026-08-11T06:00:00.443Z");
  });

  it("yields nothing for garbage", () => {
    expect(parseOauthUsage(null)).toEqual([]);
    expect(parseOauthUsage({ limits: "nope" })).toEqual([]);
  });
});

function collect(): { obs: ProviderSnapshot[]; push: (o: ProviderSnapshot) => void } {
  const obs: ProviderSnapshot[] = [];
  return { obs, push: (o) => obs.push(o) };
}

describe("ClaudeOauthAdapter", () => {
  it("emits a live observation with windows on a successful poll", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      now: () => Date.parse("2026-08-10T12:00:00Z"),
      readCredential: async () => ({ accessToken: "tok", expiresAt: Date.parse("2026-08-10T13:00:00Z"), present: true }),
      fetchImpl: (async () => new Response(JSON.stringify(USAGE_BODY), { status: 200 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ state: "live", source: "oauth", diagnostic: null });
    expect(obs[0]?.observedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(obs[0]?.quotaWindows).toHaveLength(3);
  });

  it("reports expiry without touching the quota headline age", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      now: () => Date.parse("2026-08-10T12:00:00Z"),
      readCredential: async () => ({ accessToken: "tok", expiresAt: Date.parse("2026-08-10T11:00:00Z"), present: true }),
      fetchImpl: (async () => {
        throw new Error("must not fetch with an expired token");
      }) as typeof fetch,
    });
    await adapter.tick();
    expect(obs[0]).toMatchObject({
      state: "unavailable",
      observedAt: null,
      diagnostic: "CLAUDE_AUTH_EXPIRED",
    });
  });

  it("treats 401 as expired credentials", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      readCredential: async () => ({ accessToken: "tok", expiresAt: null, present: true }),
      fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs[0]?.diagnostic).toBe("CLAUDE_AUTH_EXPIRED");
  });

  it("stays silent when the host has no CLI credential store", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      readCredential: async () => ({ accessToken: null, expiresAt: null, present: false }),
      fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs).toHaveLength(0);
  });

  it("retains restored live quota on 429 and honors Retry-After backoff", async () => {
    const { obs, push } = collect();
    let now = Date.parse("2026-08-10T12:00:00Z");
    let fetches = 0;
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      hasInitialObservation: true,
      onObservation: push,
      now: () => now,
      readCredential: async () => ({ accessToken: "tok", expiresAt: null, present: true }),
      fetchImpl: (async () => {
        fetches += 1;
        return new Response("{}", { status: 429, headers: { "retry-after": "600" } });
      }) as typeof fetch,
    });
    await adapter.tick();
    expect(fetches).toBe(1);
    expect(obs).toHaveLength(0);

    now += 9 * 60_000;
    await adapter.tick();
    expect(fetches).toBe(1);
    now += 2 * 60_000;
    await adapter.tick();
    expect(fetches).toBe(2);
  });

  it("reports transient unavailability only when no last-good OAuth quota exists", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      readCredential: async () => ({ accessToken: "tok", expiresAt: null, present: true }),
      fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs[0]).toMatchObject({
      state: "unavailable",
      diagnostic: "CLAUDE_USAGE_UNAVAILABLE",
    });
  });
});
