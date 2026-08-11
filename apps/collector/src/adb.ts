import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AdbTunnelStatus {
  enabled: boolean;
  connected: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type AdbRunner = (command: string, args: string[]) => Promise<CommandResult>;
export type AdbWriter = (command: string, args: string[], input: string) => Promise<CommandResult>;

function defaultRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function defaultWriter(command: string, prefix: string[], input: string): Promise<CommandResult> {
  const localTmp = path.join(os.tmpdir(), `claudething-snapshot-${process.pid}.json`);
  const remoteTmp = "/run/claudething-ui/snapshot.json.tmp";
  const remoteFinal = "/run/claudething-ui/snapshot.json";
  const bytes = Buffer.byteLength(input, "utf8");
  try {
    await writeFile(localTmp, input, { encoding: "utf8", mode: 0o600 });
    const identity = await defaultRunner(command, [
      ...prefix, "shell", "grep", "-qx", "ID=claudething", "/etc/os-release",
    ]);
    if (identity.code !== 0) return identity;
    const pushed = await defaultRunner(command, [...prefix, "push", localTmp, remoteTmp]);
    if (pushed.code !== 0) return pushed;
    const temporaryStat = await defaultRunner(command, [
      ...prefix, "shell", "stat", "-c", "%s", remoteTmp,
    ]);
    if (temporaryStat.code !== 0 || Number(temporaryStat.stdout.trim()) !== bytes) {
      return { code: 1, stdout: temporaryStat.stdout, stderr: "snapshot size mismatch" };
    }
    const promoted = await defaultRunner(command, [
      ...prefix, "shell", "mv", remoteTmp, remoteFinal,
    ]);
    if (promoted.code !== 0) return promoted;
    const finalStat = await defaultRunner(command, [
      ...prefix, "shell", "stat", "-c", "%s", remoteFinal,
    ]);
    if (finalStat.code !== 0 || Number(finalStat.stdout.trim()) !== bytes) {
      return { code: 1, stdout: finalStat.stdout, stderr: "snapshot promotion failed" };
    }
    return { code: 0, stdout: finalStat.stdout, stderr: "" };
  } finally {
    await rm(localTmp, { force: true }).catch(() => {});
  }
}

export interface AdbTunnelOptions {
  enabled: boolean;
  command?: string;
  serial?: string | null;
  port: number;
  intervalMs?: number;
  runner?: AdbRunner;
  writer?: AdbWriter;
  now?: () => number;
  /** When supplied, USB uses an atomic host-push mirror instead of depending
   * on a long-lived reverse socket. The kiosk reads the local mirrored file. */
  snapshot?: () => unknown;
  /** Authenticated dashboard stream activity, used to avoid disruptive ADB
   * traffic while the reverse tunnel is demonstrably carrying data. */
  lastClientActivityAt?: () => number | null;
}

const ACTIVE_STREAM_GRACE_MS = 40_000;
const NEW_TUNNEL_GRACE_MS = 30_000;

export class AdbTunnelSupervisor {
  private readonly opts: AdbTunnelOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastConfiguredAtMs: number | null = null;
  private state: AdbTunnelStatus;

  constructor(opts: AdbTunnelOptions) {
    this.opts = opts;
    this.state = {
      enabled: opts.enabled,
      connected: false,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
    };
  }

  start(): void {
    if (!this.opts.enabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): AdbTunnelStatus {
    return { ...this.state };
  }

  async tick(): Promise<boolean> {
    if (!this.opts.enabled || this.running) return false;
    this.running = true;
    const runner = this.opts.runner ?? defaultRunner;
    const prefix = this.opts.serial ? ["-s", this.opts.serial] : [];
    try {
      const now = this.opts.now?.() ?? Date.now();
      if (this.opts.snapshot) {
        if (!this.state.connected) {
          const state = await runner(this.opts.command ?? "adb", [...prefix, "get-state"]);
          if (state.code !== 0 || state.stdout.trim() !== "device") {
            return this.fail("ADB_DEVICE_UNAVAILABLE");
          }
          const clockReady = await this.syncClaudeThingClock(runner, prefix, now);
          if (!clockReady) return this.fail("ADB_TIME_SYNC_FAILED");
        }
        let payload: string;
        try {
          payload = JSON.stringify(this.opts.snapshot());
        } catch {
          return this.fail("ADB_SNAPSHOT_INVALID");
        }
        if (Buffer.byteLength(payload, "utf8") > 1024 * 1024) {
          return this.fail("ADB_SNAPSHOT_TOO_LARGE");
        }
        const writer = this.opts.writer ?? defaultWriter;
        const pushed = await writer(this.opts.command ?? "adb", prefix, payload);
        if (pushed.code !== 0) return this.fail("ADB_SNAPSHOT_PUSH_FAILED");
        this.succeed(now);
        return true;
      }
      const lastClientActivity = this.opts.lastClientActivityAt?.() ?? null;
      const activeStream =
        lastClientActivity !== null && now - lastClientActivity <= ACTIVE_STREAM_GRACE_MS;
      const newlyConfigured =
        this.lastConfiguredAtMs !== null && now - this.lastConfiguredAtMs <= NEW_TUNNEL_GRACE_MS;
      if (this.state.connected && (activeStream || newlyConfigured)) {
        this.succeed(now);
        return true;
      }
      const state = await runner(this.opts.command ?? "adb", [...prefix, "get-state"]);
      if (state.code !== 0 || state.stdout.trim() !== "device") return this.fail("ADB_DEVICE_UNAVAILABLE");
      if (this.state.connected) {
        const probe = await runner(this.opts.command ?? "adb", [
          ...prefix,
          "shell",
          "wget",
          "-q",
          "-T",
          "4",
          "-O",
          "/dev/null",
          `http://127.0.0.1:${this.opts.port}/v1/transport-probe`,
        ]);
        if (probe.code === 0) {
          this.succeed(now);
          return true;
        }
      }
      if (!this.state.connected) {
        const clockReady = await this.syncClaudeThingClock(runner, prefix, now);
        if (!clockReady) return this.fail("ADB_TIME_SYNC_FAILED");
      }
      const endpoint = `tcp:${this.opts.port}`;
      const reverse = await runner(this.opts.command ?? "adb", [...prefix, "reverse", endpoint, endpoint]);
      if (reverse.code !== 0) return this.fail("ADB_REVERSE_FAILED");
      this.lastConfiguredAtMs = now;
      this.succeed(now);
      return true;
    } catch {
      return this.fail("ADB_NOT_FOUND");
    } finally {
      this.running = false;
    }
  }

  /** Keep the kiosk's wall clock honest after a cold boot. Car Thing has no
   * reliable battery-backed clock, so a disconnected device can resume with
   * stale UTC even though its configured IANA time zone is correct. The
   * identity check is intentionally mandatory before changing device time. */
  private async syncClaudeThingClock(runner: AdbRunner, prefix: string[], nowMs: number): Promise<boolean> {
    const command = this.opts.command ?? "adb";
    const identity = await runner(command, [
      ...prefix, "shell", "grep", "-qx", "ID=claudething", "/etc/os-release",
    ]);
    if (identity.code !== 0) return true;

    const hostSeconds = Math.floor(nowMs / 1000);
    const remote = await runner(command, [...prefix, "shell", "date", "+%s"]);
    const deviceSeconds = Number.parseInt(remote.stdout.trim(), 10);
    if (remote.code === 0 && Number.isSafeInteger(deviceSeconds) && Math.abs(deviceSeconds - hostSeconds) <= 2) {
      return true;
    }
    const synced = await runner(command, [
      ...prefix, "shell", "date", "-u", "-s", `@${hostSeconds}`,
    ]);
    return synced.code === 0;
  }

  private fail(code: string): false {
    this.state = {
      ...this.state,
      connected: false,
      lastError: code,
      consecutiveFailures: this.state.consecutiveFailures + 1,
    };
    return false;
  }

  private succeed(nowMs: number): void {
    this.state = {
      ...this.state,
      connected: true,
      lastSuccessAt: new Date(nowMs).toISOString(),
      lastError: null,
      consecutiveFailures: 0,
    };
  }
}
