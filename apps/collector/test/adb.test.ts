import { describe, expect, it } from "vitest";
import { AdbTunnelSupervisor, type AdbRunner, type AdbWriter } from "../src/adb";

describe("AdbTunnelSupervisor", () => {
  it("atomically mirrors snapshots without configuring a reverse socket", async () => {
    const calls: string[][] = [];
    const writes: { args: string[]; input: string }[] = [];
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      if (args.includes("grep")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const writer: AdbWriter = async (_command, args, input) => {
      writes.push({ args, input });
      return { code: 0, stdout: "", stderr: "" };
    };
    const snapshot = { schemaVersion: 1, serverTime: "2026-08-08T12:00:00.000Z" };
    const supervisor = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      runner,
      writer,
      snapshot: () => snapshot,
    });

    expect(await supervisor.tick()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.input)).toEqual(snapshot);
    expect(writes[0]!.args).toEqual([]);
    expect([...calls, ...writes.map((write) => write.args)].some((args) => args.includes("reverse"))).toBe(false);
  });

  it("re-establishes adb reverse for a ready docked device", async () => {
    const calls: string[][] = [];
    const now = Date.parse("2026-08-08T12:00:00Z");
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      if (args.includes("+%s")) return { code: 0, stdout: `${Math.floor(now / 1000)}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      serial: "CARTHING",
      runner,
      now: () => now,
    });
    expect(await supervisor.tick()).toBe(true);
    expect(calls).toEqual([
      ["-s", "CARTHING", "get-state"],
      ["-s", "CARTHING", "shell", "grep", "-qx", "ID=claudething", "/etc/os-release"],
      ["-s", "CARTHING", "shell", "date", "+%s"],
      ["-s", "CARTHING", "reverse", "tcp:8790", "tcp:8790"],
    ]);
    expect(supervisor.status()).toMatchObject({ connected: true, consecutiveFailures: 0, lastError: null });
  });

  it("probes a healthy tunnel without resetting its reverse mapping", async () => {
    const calls: string[][] = [];
    let now = Date.parse("2026-08-08T12:00:00Z");
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      runner,
      now: () => now,
    });

    expect(await supervisor.tick()).toBe(true);
    calls.length = 0;
    now += 31_000;
    expect(await supervisor.tick()).toBe(true);
    expect(calls).toEqual([
      ["get-state"],
      [
        "shell", "wget", "-q", "-T", "4", "-O", "/dev/null",
        "http://127.0.0.1:8790/v1/transport-probe",
      ],
    ]);
    expect(calls.some((args) => args.includes("reverse"))).toBe(false);
  });

  it("runs no ADB command while an authenticated display stream is active", async () => {
    const calls: string[][] = [];
    let now = Date.parse("2026-08-08T12:00:00Z");
    let lastClientActivity: number | null = null;
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      runner,
      now: () => now,
      lastClientActivityAt: () => lastClientActivity,
    });

    expect(await supervisor.tick()).toBe(true);
    calls.length = 0;
    now += 35_000;
    lastClientActivity = now - 1_000;
    expect(await supervisor.tick()).toBe(true);
    expect(calls).toEqual([]);
  });

  it("repairs the reverse mapping when the non-disruptive probe fails", async () => {
    const calls: string[][] = [];
    let now = Date.parse("2026-08-08T12:00:00Z");
    let probes = 0;
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      if (args.includes("wget")) {
        probes += 1;
        return { code: 1, stdout: "", stderr: "connection refused" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      runner,
      now: () => now,
    });

    expect(await supervisor.tick()).toBe(true);
    calls.length = 0;
    now += 31_000;
    expect(await supervisor.tick()).toBe(true);
    expect(probes).toBe(1);
    expect(calls.at(-1)).toEqual(["reverse", "tcp:8790", "tcp:8790"]);
  });

  it("repairs a stale ClaudeThing clock before restoring the tunnel", async () => {
    const calls: string[][] = [];
    const now = Date.parse("2026-08-08T12:00:00Z");
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      if (args.includes("+%s")) return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({ enabled: true, port: 8790, runner, now: () => now });

    expect(await supervisor.tick()).toBe(true);
    expect(calls).toContainEqual(["shell", "date", "-u", "-s", `@${Math.floor(now / 1000)}`]);
    expect(calls.at(-1)).toEqual(["reverse", "tcp:8790", "tcp:8790"]);
  });

  it("never changes the clock of a non-ClaudeThing ADB device", async () => {
    const calls: string[][] = [];
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("get-state")) return { code: 0, stdout: "device\n", stderr: "" };
      if (args.includes("grep")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({ enabled: true, port: 8790, runner });

    expect(await supervisor.tick()).toBe(true);
    expect(calls.some((args) => args.includes("date"))).toBe(false);
  });

  it("reports missing adb and unavailable devices without throwing", async () => {
    const missing = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      runner: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await missing.tick()).toBe(false);
    expect(missing.status().lastError).toBe("ADB_NOT_FOUND");

    const unavailable = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      runner: async () => ({ code: 1, stdout: "", stderr: "no devices" }),
    });
    expect(await unavailable.tick()).toBe(false);
    expect(unavailable.status().lastError).toBe("ADB_DEVICE_UNAVAILABLE");
  });
});
