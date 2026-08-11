import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BluetoothSnapshotSupervisor,
  buildBluetoothFrame,
  type BluetoothRunner,
} from "../src/bluetooth";

describe("Bluetooth snapshot transport", () => {
  it("builds a deterministic bounded HMAC-SHA256 frame", () => {
    const payload = '{"schemaVersion":1}';
    const frame = buildBluetoothFrame(payload, "test_token_abcdefghijklmnopqrstuvwxyz", 42n);
    expect(frame.subarray(0, 8).toString("ascii")).toBe("CTHINGB1");
    expect(frame.readUInt32BE(8)).toBe(Buffer.byteLength(payload));
    expect(frame.readBigUInt64BE(12)).toBe(42n);
    const expected = createHmac("sha256", "test_token_abcdefghijklmnopqrstuvwxyz")
      .update(frame.subarray(0, 20))
      .update(payload)
      .digest("hex");
    expect(frame.subarray(20, 52).toString("hex")).toBe(expected);
    expect(frame.subarray(52).toString("utf8")).toBe(payload);
  });

  it("sends over Bluetooth only when USB is unavailable", async () => {
    let usbConnected = true;
    const frames: Buffer[] = [];
    const runner: BluetoothRunner = async (_command, args, input) => {
      expect(args).toEqual(["--channel", "22", "--address", "00-11-22-33-44-55"]);
      frames.push(input);
      return { code: 0, stdout: "OK1\n", stderr: "" };
    };
    const supervisor = new BluetoothSnapshotSupervisor({
      enabled: true,
      helperCommand: "/helper",
      address: "00-11-22-33-44-55",
      token: "test_token_abcdefghijklmnopqrstuvwxyz",
      snapshot: () => ({ schemaVersion: 1 }),
      usbConnected: () => usbConnected,
      runner,
      now: () => Date.parse("2026-08-11T20:00:00Z"),
    });

    expect(await supervisor.tick()).toBe(true);
    expect(frames).toHaveLength(0);
    expect(supervisor.status()).toMatchObject({ standbyForUsb: true, connected: false });

    usbConnected = false;
    expect(await supervisor.tick()).toBe(true);
    expect(frames).toHaveLength(1);
    expect(supervisor.status()).toMatchObject({ standbyForUsb: false, connected: true });
  });

  it("reports unpaired devices without exposing helper diagnostics", async () => {
    const supervisor = new BluetoothSnapshotSupervisor({
      enabled: true,
      helperCommand: "/helper",
      token: "test_token_abcdefghijklmnopqrstuvwxyz",
      snapshot: () => ({ schemaVersion: 1 }),
      usbConnected: () => false,
      runner: async () => ({ code: 3, stdout: "", stderr: "private system details" }),
    });
    expect(await supervisor.tick()).toBe(false);
    expect(supervisor.status().lastError).toBe("BLUETOOTH_NOT_PAIRED");
  });

  it("rejects snapshots larger than one MiB before invoking the helper", async () => {
    let called = false;
    const supervisor = new BluetoothSnapshotSupervisor({
      enabled: true,
      helperCommand: "/helper",
      token: "test_token_abcdefghijklmnopqrstuvwxyz",
      snapshot: () => ({ body: "x".repeat(1024 * 1024) }),
      usbConnected: () => false,
      runner: async () => {
        called = true;
        return { code: 0, stdout: "OK1\n", stderr: "" };
      },
    });
    expect(await supervisor.tick()).toBe(false);
    expect(called).toBe(false);
    expect(supervisor.status().lastError).toBe("BLUETOOTH_SNAPSHOT_TOO_LARGE");
  });
});
