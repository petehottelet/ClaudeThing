import { describe, expect, it } from "vitest";
import { AdbTunnelSupervisor, type AdbRunner } from "../src/adb";

describe("AdbTunnelSupervisor", () => {
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
