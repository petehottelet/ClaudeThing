/**
 * Claude OAuth quota poller: maps the usage endpoint's five_hour/seven_day
 * plus named scoped limits into quota windows, degrades honestly on expired
 * or rejected credentials, and stays completely silent when no CLI login
 * exists on the host.
 */

import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import {
  ClaudeOauthAdapter,
  parseOauthUsage,
  type OauthCredential,
} from "../src/adapters/claude-oauth";

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
  it("keeps current, all-model, and named scoped allowances as distinct bars", () => {
    const windows = parseOauthUsage(USAGE_BODY);
    expect(windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "oauth_weekly_scoped_scoped_limit"]);
    expect(windows[0]).toMatchObject({ label: "Current session", usedPercent: 4, windowSeconds: 18000 });
    expect(windows[1]).toMatchObject({ label: "All models", usedPercent: 61, windowSeconds: 604800 });
    expect(windows[2]).toMatchObject({ label: "Scoped limit", usedPercent: 99, windowSeconds: 604800 });
    expect(windows[1]?.resetsAt).toBe("2026-08-11T06:00:00.443Z");
  });

  it("uses the provider's model display name for a scoped weekly allowance", () => {
    const windows = parseOauthUsage({
      five_hour: { utilization: 100 },
      seven_day: { utilization: 30 },
      limits: [{
        kind: "weekly_scoped",
        group: "weekly",
        percent: 58,
        scope: { model: { id: null, display_name: "Fable" } },
        is_active: true,
      }],
    });
    expect(windows).toMatchObject([
      { id: "five_hour", label: "Current session", usedPercent: 100 },
      { id: "seven_day", label: "All models", usedPercent: 30 },
      { id: "oauth_weekly_scoped_fable", label: "Fable", usedPercent: 58 },
    ]);
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

function credential(overrides: Partial<OauthCredential> = {}): OauthCredential {
  return {
    accessToken: "tok",
    expiresAt: null,
    refreshToken: "refresh",
    refreshTokenExpiresAt: null,
    scopes: ["user:inference"],
    present: true,
    ...overrides,
  };
}

describe("ClaudeOauthAdapter", () => {
  it("emits a live observation with windows on a successful poll", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      now: () => Date.parse("2026-08-10T12:00:00Z"),
      readCredential: async () => credential({ expiresAt: Date.parse("2026-08-10T13:00:00Z") }),
      fetchImpl: (async () => new Response(JSON.stringify(USAGE_BODY), { status: 200 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ state: "live", source: "oauth", diagnostic: null });
    expect(obs[0]?.observedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(obs[0]?.quotaWindows).toHaveLength(3);
  });

  it("refreshes an expired credential before polling usage", async () => {
    const { obs, push } = collect();
    let refreshes = 0;
    let usageToken = "";
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      now: () => Date.parse("2026-08-10T12:00:00Z"),
      readCredential: async () => credential({ expiresAt: Date.parse("2026-08-10T11:00:00Z") }),
      refreshCredential: async () => {
        refreshes += 1;
        return {
          kind: "refreshed",
          credential: credential({
            accessToken: "rotated",
            expiresAt: Date.parse("2026-08-10T13:00:00Z"),
          }),
        };
      },
      fetchImpl: (async (_url, init) => {
        usageToken = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
      }) as typeof fetch,
    });
    await adapter.tick();
    expect(refreshes).toBe(1);
    expect(usageToken).toBe("Bearer rotated");
    expect(obs[0]).toMatchObject({ state: "live", diagnostic: null });
  });

  it("reports expiry when the refresh credential is rejected", async () => {
    const { obs, push } = collect();
    let usageFetches = 0;
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      now: () => Date.parse("2026-08-10T12:00:00Z"),
      readCredential: async () => credential({ expiresAt: Date.parse("2026-08-10T11:00:00Z") }),
      refreshCredential: async () => ({ kind: "expired" }),
      fetchImpl: (async () => {
        usageFetches += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await adapter.tick();
    expect(usageFetches).toBe(0);
    expect(obs[0]).toMatchObject({ state: "unavailable", diagnostic: "CLAUDE_AUTH_EXPIRED" });
  });

  it("keeps restored quota during a transient refresh failure", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      hasInitialObservation: true,
      onObservation: push,
      now: () => Date.parse("2026-08-10T12:00:00Z"),
      readCredential: async () => credential({ expiresAt: Date.parse("2026-08-10T11:00:00Z") }),
      refreshCredential: async () => ({ kind: "transient", retryAfter: "600" }),
    });
    await adapter.tick();
    expect(obs).toHaveLength(0);
  });

  it("treats 401 as expired credentials", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      readCredential: async () => credential(),
      refreshCredential: async () => ({ kind: "expired" }),
      fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs[0]?.diagnostic).toBe("CLAUDE_AUTH_EXPIRED");
  });

  it("forces one refresh and retries when usage rejects a nominally fresh token", async () => {
    const { obs, push } = collect();
    let usageFetches = 0;
    let forceRefresh = false;
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      readCredential: async () => credential(),
      refreshCredential: async (_cred, _fetch, _now, force) => {
        forceRefresh = force === true;
        return { kind: "refreshed", credential: credential({ accessToken: "rotated" }) };
      },
      fetchImpl: (async (_url, init) => {
        usageFetches += 1;
        const auth = new Headers(init?.headers).get("authorization");
        return auth === "Bearer rotated"
          ? new Response(JSON.stringify(USAGE_BODY), { status: 200 })
          : new Response("{}", { status: 401 });
      }) as typeof fetch,
    });
    await adapter.tick();
    expect(forceRefresh).toBe(true);
    expect(usageFetches).toBe(2);
    expect(obs[0]).toMatchObject({ state: "live", diagnostic: null });
  });

  it("stays silent when the host has no CLI credential store", async () => {
    const { obs, push } = collect();
    const adapter = new ClaudeOauthAdapter({
      host: "mac",
      onObservation: push,
      readCredential: async () => credential({
        accessToken: null,
        refreshToken: null,
        present: false,
      }),
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
      readCredential: async () => credential(),
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
      readCredential: async () => credential(),
      fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch,
    });
    await adapter.tick();
    expect(obs[0]).toMatchObject({
      state: "unavailable",
      diagnostic: "CLAUDE_USAGE_UNAVAILABLE",
    });
  });
});
