import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGeminiFetcher } from "../src/adapters/gemini";

const temporary: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Gemini OAuth refresh", () => {
  it("refreshes an expired disk token and later refreshes its memory token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00.000Z"));
    const home = await mkdtemp(path.join(os.tmpdir(), "gemini-fetcher-"));
    temporary.push(home);
    await mkdir(path.join(home, ".gemini"));
    await writeFile(path.join(home, ".gemini", "oauth_creds.json"), JSON.stringify({
      access_token: "expired",
      refresh_token: "refresh",
      client_id: "client",
      client_secret: "secret",
      expiry_date: 0,
    }), "utf8");

    let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        refreshes += 1;
        return new Response(JSON.stringify({ access_token: `fresh-${refreshes}`, expires_in: 120 }), { status: 200 });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe(`Bearer fresh-${refreshes}`);
      if (url.includes("loadCodeAssist")) {
        return new Response(JSON.stringify({ currentTier: { id: "standard-tier" } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        buckets: [{ modelId: "gemini-model", remainingFraction: 0.75, resetTime: "2026-08-11T00:00:00Z" }],
      }), { status: 200 });
    }));

    const fetchUsage = createGeminiFetcher({ host: "mac", home, env: {} });
    expect((await fetchUsage()).quotaWindows[0]?.usedPercent).toBe(25);
    expect(refreshes).toBe(1);
    vi.setSystemTime(new Date("2026-08-10T20:02:01.000Z"));
    expect((await fetchUsage()).quotaWindows[0]?.usedPercent).toBe(25);
    expect(refreshes).toBe(2);
  });
});
