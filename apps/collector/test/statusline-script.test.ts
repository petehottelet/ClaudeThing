import { createServer } from "node:http";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function prepare(): Promise<{ dir: string; hook: string; tokenFile: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "carthing-statusline-"));
  temporary.push(dir);
  const hook = path.join(dir, "claude-statusline.mjs");
  const tokenFile = path.join(dir, "pairing.token");
  await copyFile(path.resolve("statusline/claude-statusline.mjs"), hook);
  await writeFile(tokenFile, "statusline_secret_token\n", "utf8");
  return { dir, hook, tokenFile };
}

function runHook(hook: string, input: unknown): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("Claude statusline forwarder", () => {
  it("uses bearer auth, strips private fields, and never puts the token in the URL", async () => {
    const { dir, hook, tokenFile } = await prepare();
    let captured:
      | { url: string; authorization: string | undefined; body: string }
      | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        captured = {
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await writeFile(
      path.join(dir, "collector-config.json"),
      JSON.stringify({ port, tokenFile }),
      "utf8",
    );
    try {
      const result = await runHook(hook, {
        model: { display_name: "Opus" },
        rate_limits: { five_hour: { used_percentage: 42 } },
        context_window: { current_usage: { input_tokens: 5, output_tokens: 2 } },
        transcript_path: "SECRET/PATH",
        workspace: { current_dir: "SECRET/WORKSPACE" },
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("Opus · 5h 42%");
      expect(captured?.url).toBe("/v1/ingest/claude-statusline");
      expect(captured?.authorization).toBe("Bearer statusline_secret_token");
      expect(captured?.body).not.toContain("SECRET");
      expect(captured?.body).toContain("current_usage");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves the output of an existing command-based statusline", async () => {
    const { dir, hook, tokenFile } = await prepare();
    const prior = path.join(dir, "prior.mjs");
    await writeFile(
      prior,
      "process.stdin.resume(); process.stdin.on('end', () => console.log('Existing status'));",
      "utf8",
    );
    await writeFile(
      path.join(dir, "collector-config.json"),
      JSON.stringify({ port: 1, tokenFile }),
      "utf8",
    );
    await writeFile(
      path.join(dir, "statusline-chain.json"),
      JSON.stringify({ command: `\"${process.execPath}\" \"${prior}\"` }),
      "utf8",
    );
    const result = await runHook(hook, { model: { display_name: "Opus" } });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("Existing status");
  });
});
