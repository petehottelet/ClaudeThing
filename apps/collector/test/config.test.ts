import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("collector config", () => {
  it("loads the pairing token from a file without requiring a CLI secret", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "carthing-config-"));
    temporary.push(dir);
    const tokenFile = path.join(dir, "pairing.token");
    await writeFile(tokenFile, "abc_123\n", "utf8");
    const config = loadConfig(["--token-file", tokenFile, "--peer-host", "mac"], {});
    expect(config.token).toBe("abc_123");
    expect(config.tokenSource).toBe("file");
    expect(config.peerHostName).toBe("mac");
  });

  it("rejects peer URLs with embedded credentials or unsafe protocols", () => {
    expect(() => loadConfig(["--peer", "ftp://mac.local"], {})).toThrow(/http/);
    expect(() => loadConfig(["--peer", "http://user:secret@mac.local"], {})).toThrow(/credentials/);
  });

  it("allows optional hardware and app-server adapters to be disabled", () => {
    const config = loadConfig(["--no-adb", "--no-bluetooth", "--no-codex-appserver"], {});
    expect(config.adbEnabled).toBe(false);
    expect(config.bluetoothEnabled).toBe(false);
    expect(config.codexAppServerEnabled).toBe(false);
  });

  it("enables the Bluetooth fallback only when a helper is configured", () => {
    expect(loadConfig([], {}).bluetoothEnabled).toBe(false);
    const config = loadConfig([
      "--bluetooth-helper", "/Applications/ClaudeThing/helper",
      "--bluetooth-address", "00-11-22-33-44-55",
      "--bluetooth-channel", "22",
    ], {});
    expect(config.bluetoothEnabled).toBe(true);
    expect(config.bluetoothAddress).toBe("00-11-22-33-44-55");
    expect(config.bluetoothChannel).toBe(22);
  });

  it("rejects invalid Bluetooth addresses and RFCOMM channels", () => {
    expect(() => loadConfig(["--bluetooth-address", "not-an-address"], {})).toThrow(/address/);
    expect(() => loadConfig(["--bluetooth-channel", "31"], {})).toThrow(/channel/);
  });

  it("binds mock mode to loopback and production to all interfaces by default", () => {
    expect(loadConfig(["--mock", "normal"], {}).bindHost).toBe("127.0.0.1");
    expect(loadConfig([], {}).bindHost).toBe("0.0.0.0");
  });

  it("allows the firmware dashboard loopback origin by default", () => {
    expect(loadConfig([], {}).allowedOrigins).toContain("http://127.0.0.1:8080");
  });

  it("keeps dashboard preferences in a separate non-secret config file", () => {
    expect(loadConfig(["--data-dir", "/tmp/collector-state"], {}).dashboardConfigPath).toBe(
      path.join("/tmp/collector-state", "dashboard-config.jsonc"),
    );
    expect(
      loadConfig(["--dashboard-config", "/tmp/display.jsonc"], {}).dashboardConfigPath,
    ).toBe("/tmp/display.jsonc");
    expect(loadConfig(["--dashboard-config", "/tmp/display.jsonc"], {}).providerDirectory).toBe(
      path.join("/tmp", "providers"),
    );
    expect(loadConfig(["--provider-dir", "/tmp/provider-data"], {}).providerDirectory).toBe(
      "/tmp/provider-data",
    );
  });
});
