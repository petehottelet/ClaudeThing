import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
const tool = path.resolve("../../device/device-tool.mjs");

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tool, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("device deployment tool", () => {
  it("builds the guarded temporary-deploy sequence in dry-run mode", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "carthing-device-tool-"));
    temporary.push(dir);
    const backup = path.join(dir, "backup");
    const ui = path.join(dir, "ui");
    const token = path.join(dir, "pairing.token");
    await mkdir(backup);
    await mkdir(ui);
    await writeFile(
      path.join(backup, "backup.json"),
      JSON.stringify({ version: 1, source: "/usr/share/qt-superbird-app/webapp", files: [{ path: "index.html", sha256: "abc" }] }),
      "utf8",
    );
    await writeFile(path.join(ui, "index.html"), "<!doctype html>", "utf8");
    await writeFile(token, "abcdefghijklmnopqrstuvwxyz_1234567890\n", "utf8");

    const result = await run([
      "deploy-temporary",
      "--dry-run",
      "--backup-dir", backup,
      "--token-file", token,
      "--ui-dir", ui,
      "--endpoints", "127.0.0.1:8790,mac.local:8790",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"mount" "--bind"');
    expect(result.stdout).toContain('"supervisorctl" "restart" "superbird"');
    expect(result.stdout).toContain("Temporary dashboard deployed");
  });

  it("blocks deployment when the stock backup marker is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "carthing-device-tool-"));
    temporary.push(dir);
    const result = await run([
      "deploy-temporary",
      "--dry-run",
      "--backup-dir", dir,
      "--token-file", path.join(dir, "missing.token"),
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("backup.json");
  });

  it("builds a secret-safe ClaudeThing firmware provisioning sequence", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claudething-device-tool-"));
    temporary.push(dir);
    const token = path.join(dir, "pairing.token");
    const secret = "abcdefghijklmnopqrstuvwxyz_1234567890";
    await writeFile(token, `${secret}\n`, "utf8");

    const result = await run([
      "provision-firmware",
      "--dry-run",
      "--token-file", token,
      "--endpoints", "127.0.0.1:8790",
      "--time-zone", "America/Los_Angeles",
      "--youtube-channel", "My Channel",
      "--ga4-property", "My Website",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("grep -qx ID=claudething /etc/os-release");
    expect(result.stdout).toContain('"systemctl" "restart" "claudething-ui.service" "chromium-kiosk.service"');
    expect(result.stdout).toContain('"reverse" "tcp:8790" "tcp:8790"');
    expect(result.stdout).toContain("using time zone America/Los_Angeles");
    expect(result.stdout).toContain('YouTube "My Channel" and GA4 "My Website"');
    expect(result.stdout).toContain("claudething-health-index.html");
    expect(result.stdout).toContain("__CLAUDETHING_REMOTE_STATUS__");
    expect(result.stdout).not.toContain(secret);
  });

  it("rejects an invalid provisioning time zone before touching the device", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claudething-device-tool-"));
    temporary.push(dir);
    const token = path.join(dir, "pairing.token");
    await writeFile(token, "abcdefghijklmnopqrstuvwxyz_1234567890\n", "utf8");

    const result = await run([
      "provision-firmware",
      "--dry-run",
      "--token-file", token,
      "--time-zone", "PST-ish",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Invalid IANA time zone");
    expect(result.stdout).not.toContain("adb");
  });

  it("rejects invalid dashboard display names before touching the device", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claudething-device-tool-"));
    temporary.push(dir);
    const token = path.join(dir, "pairing.token");
    await writeFile(token, "abcdefghijklmnopqrstuvwxyz_1234567890\n", "utf8");

    const result = await run([
      "provision-firmware",
      "--dry-run",
      "--token-file", token,
      "--youtube-channel", "x".repeat(101),
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--youtube-channel");
    expect(result.stdout).not.toContain("adb");
  });

  it("uses firmware-specific health probes in doctor", async () => {
    const result = await run(["doctor", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("device: ClaudeThing firmware");
    expect(result.stdout).toContain("httpd applet: ok");
    expect(result.stdout).toContain("dashboard HTTP: ok");
  });
});
