import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeJsonlReader } from "../src/adapters/claude-jsonl";

let tmp: string;
let claudeDir: string;
let dataDir: string;
let sessionFile: string;

function line(
  usage: Record<string, number>,
  ids: { messageId?: string; requestId?: string; uuid?: string } = {},
): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid: ids.uuid ?? `uuid-${Math.random().toString(36).slice(2)}`,
    requestId: ids.requestId ?? "req_default",
    timestamp: new Date().toISOString(),
    message: { id: ids.messageId ?? "msg_default", usage },
  })}\n`;
}

function reader(): ClaudeJsonlReader {
  return new ClaudeJsonlReader({ claudeDir, dataDir, host: "pc" });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "carthing-claude-"));
  claudeDir = path.join(tmp, "projects");
  dataDir = path.join(tmp, "data");
  await mkdir(path.join(claudeDir, "proj-a"), { recursive: true });
  sessionFile = path.join(claudeDir, "proj-a", "session.jsonl");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ClaudeJsonlReader", () => {
  it("dedups duplicate lines on message id + requestId", async () => {
    const dup = line({ input_tokens: 100, output_tokens: 10 }, { messageId: "msg_1", requestId: "req_1" });
    await writeFile(sessionFile, dup + dup, "utf8");
    const obs = await reader().poll();
    expect(obs?.tokens).toMatchObject({ input: 100, output: 10, total: 110, period: "today" });
  });

  it("resumes from the byte cursor after appends without double counting", async () => {
    await writeFile(sessionFile, line({ input_tokens: 100, output_tokens: 0 }, { messageId: "m1", requestId: "r1" }), "utf8");
    const r = reader();
    expect((await r.poll())?.tokens?.input).toBe(100);

    await appendFile(sessionFile, line({ input_tokens: 50, output_tokens: 5 }, { messageId: "m2", requestId: "r2" }), "utf8");
    const second = await r.poll();
    expect(second?.tokens?.input).toBe(150);
    expect(second?.tokens?.output).toBe(5);

    // Nothing new: totals must not move.
    expect((await r.poll())?.tokens?.input).toBe(150);
  });

  it("persists cursors and totals across reader instances", async () => {
    await writeFile(sessionFile, line({ input_tokens: 70 }, { messageId: "m1", requestId: "r1" }), "utf8");
    expect((await reader().poll())?.tokens?.input).toBe(70);
    // Fresh instance, same dataDir: state resumes, nothing recounted.
    expect((await reader().poll())?.tokens?.input).toBe(70);
  });

  it("recovers from truncation (cursor > size resets to 0, dedup holds)", async () => {
    const original = line({ input_tokens: 100 }, { messageId: "m1", requestId: "r1" });
    await writeFile(sessionFile, original, "utf8");
    const r = reader();
    expect((await r.poll())?.tokens?.input).toBe(100);

    // Rewrite shorter content: same event id must not be recounted.
    await writeFile(sessionFile, original, "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFile(sessionFile, original, "utf8");
    expect((await r.poll())?.tokens?.input).toBe(100);

    // New event after the truncation is still picked up.
    await appendFile(sessionFile, line({ input_tokens: 30 }, { messageId: "m2", requestId: "r2" }), "utf8");
    expect((await r.poll())?.tokens?.input).toBe(130);
  });

  it("counts cache token classes into cachedInput", async () => {
    await writeFile(
      sessionFile,
      line(
        { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 },
        { messageId: "m1", requestId: "r1" },
      ),
      "utf8",
    );
    const obs = await reader().poll();
    expect(obs?.tokens).toMatchObject({ input: 10, cachedInput: 50, output: 5, total: 65 });
  });

  it("returns null when the Claude directory does not exist", async () => {
    const r = new ClaudeJsonlReader({ claudeDir: path.join(tmp, "nope"), dataDir, host: "pc" });
    expect(await r.poll()).toBeNull();
  });

  it("ignores malformed lines without crashing", async () => {
    await writeFile(
      sessionFile,
      `not json at all\n{"broken": \n${line({ input_tokens: 5 }, { messageId: "m1", requestId: "r1" })}`,
      "utf8",
    );
    const obs = await reader().poll();
    expect(obs?.tokens?.input).toBe(5);
  });
});
