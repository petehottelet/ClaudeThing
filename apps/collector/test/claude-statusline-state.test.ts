import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "@carthing/contracts";
import {
  readClaudeStatuslineState,
  writeClaudeStatuslineState,
} from "../src/adapters/claude-statusline-state";

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
    source: "statusline",
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

describe("Claude status-line state", () => {
  it("round-trips the last valid quota observation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-statusline-state-"));
    temporary.push(dir);
    const file = path.join(dir, "state.json");
    const provider = observation();

    await writeClaudeStatuslineState(file, provider);

    expect(await readClaudeStatuslineState(file, "mac")).toEqual(provider);
  });

  it("does not restore another host's observation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-statusline-state-"));
    temporary.push(dir);
    const file = path.join(dir, "state.json");
    await writeClaudeStatuslineState(file, observation("pc"));

    expect(await readClaudeStatuslineState(file, "mac")).toBeNull();
  });

  it("rejects missing quota windows and ignores corrupt state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-statusline-state-"));
    temporary.push(dir);
    const file = path.join(dir, "state.json");
    await expect(
      writeClaudeStatuslineState(file, { ...observation(), quotaWindows: [] }),
    ).rejects.toThrow(/quota observation/);
    await writeFile(file, "{not-json", "utf8");
    expect(await readClaudeStatuslineState(file, "mac")).toBeNull();
  });
});
