import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCliCredential, refreshCliCredential } from "../src/adapters/claude-oauth-credential";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Claude OAuth credential cache", () => {
  it("reads an explicit file without consulting the platform credential store", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-credential-"));
    temporary.push(dir);
    const file = path.join(dir, "credential.json");
    await writeFile(file, JSON.stringify({ claudeAiOauth: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 123,
      scopes: ["user:inference"],
    } }), { mode: 0o600 });
    await expect(readCliCredential(file)).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      present: true,
    });
  });

  it("rotates an explicit cache atomically with owner-only permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-credential-"));
    temporary.push(dir);
    const file = path.join(dir, "credential.json");
    await writeFile(file, JSON.stringify({ claudeAiOauth: {
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: 1,
      scopes: ["user:inference"],
    } }), { mode: 0o600 });
    const result = await refreshCliCredential(
      await readCliCredential(file),
      (async () => new Response(JSON.stringify({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "new-refresh",
      }), { status: 200 })) as typeof fetch,
      10_000,
      false,
      file,
    );
    expect(result.kind).toBe("refreshed");
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.claudeAiOauth).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect((await stat(file)).mode & 0o077).toBe(0);
  });
});
