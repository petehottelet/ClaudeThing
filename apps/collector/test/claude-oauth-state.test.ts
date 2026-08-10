import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import { readClaudeOauthState, writeClaudeOauthState } from "../src/adapters/claude-oauth-state";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function observation(host = "mac"): ProviderSnapshot {
  return {
    id: "claude",
    displayName: "Claude",
    state: "live",
    observedAt: "2026-08-10T03:00:00.000Z",
    source: "oauth",
    host,
    quotaWindows: [
      {
        id: "five_hour",
        label: "Current",
        usedPercent: 42,
        resetsAt: "2026-08-10T05:00:00.000Z",
        windowSeconds: 18_000,
      },
    ],
    tokens: null,
    cost: null,
    diagnostic: null,
  };
}

describe("Claude OAuth state", () => {
  it("round-trips only a live quota observation for the same host", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-oauth-state-"));
    temporary.push(dir);
    const file = path.join(dir, "state.json");
    await writeClaudeOauthState(file, observation());
    expect(await readClaudeOauthState(file, "mac")).toEqual(observation());
    expect(await readClaudeOauthState(file, "pc")).toBeNull();
    await expect(
      writeClaudeOauthState(file, { ...observation(), state: "unavailable" }),
    ).rejects.toThrow(/live Claude OAuth/);
    await writeFile(file, "not-json", "utf8");
    expect(await readClaudeOauthState(file, "mac")).toBeNull();
  });
});
