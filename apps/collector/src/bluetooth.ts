import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";

const MAGIC = Buffer.from("CTHINGB1", "ascii");
const PREFIX_BYTES = 20;
const DIGEST_BYTES = 32;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export interface BluetoothStatus {
  enabled: boolean;
  connected: boolean;
  standbyForUsb: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface BluetoothCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type BluetoothRunner = (
  command: string,
  args: string[],
  input: Buffer,
) => Promise<BluetoothCommandResult>;

function defaultRunner(command: string, args: string[], input: Buffer): Promise<BluetoothCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 256) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      // The helper never receives secrets on its command line. Limit captured
      // diagnostics anyway so a malfunction cannot grow collector memory.
      if (stderr.length < 4096) stderr += chunk;
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 20_000);
    timeout.unref?.();
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function buildBluetoothFrame(payload: string, token: string, sequence: bigint): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length === 0 || body.length > MAX_SNAPSHOT_BYTES) {
    throw new Error("Bluetooth snapshot must be 1 byte to 1 MiB.");
  }
  if (sequence <= 0n || sequence > 0xffffffffffffffffn) {
    throw new Error("Bluetooth snapshot sequence is outside uint64 range.");
  }
  const prefix = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(body.length, 8);
  prefix.writeBigUInt64BE(sequence, 12);
  const digest = createHmac("sha256", Buffer.from(token, "utf8"))
    .update(prefix)
    .update(body)
    .digest();
  if (digest.length !== DIGEST_BYTES) throw new Error("Unexpected HMAC length.");
  return Buffer.concat([prefix, digest, body]);
}

export interface BluetoothSnapshotOptions {
  enabled: boolean;
  helperCommand: string | null;
  address?: string | null;
  channel?: number;
  intervalMs?: number;
  token: string;
  snapshot: () => unknown;
  usbConnected: () => boolean;
  runner?: BluetoothRunner;
  now?: () => number;
}

export class BluetoothSnapshotSupervisor {
  private readonly opts: BluetoothSnapshotOptions;
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private running = false;
  private sequenceCounter = 0n;
  private state: BluetoothStatus;

  constructor(opts: BluetoothSnapshotOptions) {
    this.opts = opts;
    this.state = {
      enabled: opts.enabled,
      connected: false,
      standbyForUsb: false,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
    };
  }

  start(): void {
    if (!this.opts.enabled || this.timer) return;
    const delay = Math.min(2_000, this.opts.intervalMs ?? 15_000);
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.tick();
    }, delay);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.firstTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): BluetoothStatus {
    return { ...this.state };
  }

  async tick(): Promise<boolean> {
    if (!this.opts.enabled || this.running) return false;
    if (this.opts.usbConnected()) {
      this.state = { ...this.state, connected: false, standbyForUsb: true, lastError: null };
      return true;
    }
    if (!this.opts.helperCommand) return this.fail("BLUETOOTH_HELPER_UNAVAILABLE");
    this.running = true;
    try {
      let payload: string;
      try {
        payload = JSON.stringify(this.opts.snapshot());
      } catch {
        return this.fail("BLUETOOTH_SNAPSHOT_INVALID");
      }
      if (Buffer.byteLength(payload, "utf8") > MAX_SNAPSHOT_BYTES) {
        return this.fail("BLUETOOTH_SNAPSHOT_TOO_LARGE");
      }
      const now = this.opts.now?.() ?? Date.now();
      this.sequenceCounter = (this.sequenceCounter + 1n) % 1000n;
      const sequence = BigInt(now) * 1000n + this.sequenceCounter;
      const frame = buildBluetoothFrame(payload, this.opts.token, sequence);
      const args = ["--channel", String(this.opts.channel ?? 22)];
      if (this.opts.address) args.push("--address", this.opts.address);
      const result = await (this.opts.runner ?? defaultRunner)(this.opts.helperCommand, args, frame);
      if (result.code !== 0 || result.stdout.trim() !== "OK1") {
        return this.fail(result.code === 3 ? "BLUETOOTH_NOT_PAIRED" : "BLUETOOTH_SEND_FAILED");
      }
      this.state = {
        enabled: true,
        connected: true,
        standbyForUsb: false,
        lastSuccessAt: new Date(now).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
      };
      return true;
    } catch {
      return this.fail("BLUETOOTH_HELPER_NOT_FOUND");
    } finally {
      this.running = false;
    }
  }

  private fail(code: string): false {
    this.state = {
      ...this.state,
      connected: false,
      standbyForUsb: false,
      lastError: code,
      consecutiveFailures: this.state.consecutiveFailures + 1,
    };
    return false;
  }
}
