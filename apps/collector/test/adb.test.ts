import { describe, expect, it } from "vitest";
import { AdbTunnelSupervisor, type AdbRunner } from "../src/adb";

describe("AdbTunnelSupervisor", () => {
  it("re-establishes adb reverse for a ready docked device", async () => {
    const calls: string[][] = [];
    const runner: AdbRunner = async (_command, args) => {
      calls.push(args);
      return args.includes("get-state")
        ? { code: 0, stdout: "device\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const supervisor = new AdbTunnelSupervisor({
      enabled: true,
      port: 8790,
      serial: "CARTHING",
      runner,
      now: () => Date.parse("2026-08-08T12:00:00Z"),
    });
    expect(await supervisor.tick()).toBe(true);
    expect(calls).toEqual([
      ["-s", "CARTHING", "get-state"],
      ["-s", "CARTHING", "reverse", "tcp:8790", "tcp:8790"],
    ]);
    expect(supervisor.status()).toMatchObject({ connected: true, consecutiveFailures: 0, lastError: null });
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
