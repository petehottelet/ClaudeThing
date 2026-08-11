/**
 * Collector entry point: wires config, store, adapters, peer sync, and the
 * HTTP/WS server.
 *
 * `--mock <fixtureName>` skips every real adapter and serves
 * makeFixture(name) from @carthing/contracts/fixtures, regenerated with
 * fresh timestamps (and re-broadcast on the WS stream every 5 seconds), so
 * the device UI sees a live-looking stream without real telemetry.
 */

import { SCHEMA_VERSION, type ProviderSnapshot, type Snapshot } from "@carthing/contracts";
import { makeFixture } from "@carthing/contracts/fixtures";
import { COLLECTOR_VERSION, loadConfig, type CollectorConfig } from "./config";
import { ObservationStore } from "./state";
import { createCollectorServer } from "./server";
import { PeerSync } from "./peer";
import { parseClaudeStatusline } from "./adapters/claude-statusline";
import {
  hasClaudeRateLimits,
  readClaudeStatuslineState,
  writeClaudeStatuslineState,
} from "./adapters/claude-statusline-state";
import { ClaudeJsonlReader } from "./adapters/claude-jsonl";
import { ClaudeOauthAdapter } from "./adapters/claude-oauth";
import {
  readClaudeOauthState,
  writeClaudeOauthState,
} from "./adapters/claude-oauth-state";
import { CodexRolloutReader } from "./adapters/codex-rollout";
import { CodexAppServerAdapter } from "./adapters/codex-appserver";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./util";
import { AdbTunnelSupervisor } from "./adb";
import { BluetoothSnapshotSupervisor } from "./bluetooth";
import { DashboardConfigStore } from "./dashboard-config";
import { OptionalProviderManager } from "./optional-providers";

const READER_POLL_MS = 15_000;
const MOCK_REFRESH_MS = 5_000;

function placeholder(id: string, displayName: string, host: string): ProviderSnapshot {
  return {
    id,
    displayName,
    state: "unavailable",
    observedAt: null,
    source: null,
    host,
    quotaWindows: [],
    tokens: null,
    cost: null,
    diagnostic: null,
  };
}

async function main(): Promise<void> {
  let config: CollectorConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[collector] ${(err as Error).message}`);
    process.exit(1);
  }
  if (!config.token) {
    console.error("[collector] A pairing token is required: use --token-file or CARTHING_TOKEN_FILE.");
    process.exit(1);
  }
  const token = config.token;
  if (config.mock === null && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    console.error("[collector] Pairing token must be 32–256 base64url characters.");
    process.exit(1);
  }
  if (config.tokenSource === "flag") {
    console.warn("[collector] Warning: --token can be exposed in process listings; prefer --token-file.");
  }

  const store = new ObservationStore({ localHost: config.hostName, collectorVersion: COLLECTOR_VERSION });
  const dashboardConfigStore = new DashboardConfigStore(config.dashboardConfigPath);
  await dashboardConfigStore.refresh();
  const startedAtMs = Date.now();
  const timers: NodeJS.Timeout[] = [];
  let peerSync: PeerSync | null = null;
  let appServer: CodexAppServerAdapter | null = null;
  let claudeOauth: ClaudeOauthAdapter | null = null;
  let adbTunnel: AdbTunnelSupervisor | null = null;
  let bluetooth: BluetoothSnapshotSupervisor | null = null;
  let optionalProviders: OptionalProviderManager | null = null;
  const peerIdentityFile = path.join(config.dataDir, "peer-identity.json");
  const claudeStatuslineStateFile = path.join(config.dataDir, "claude-statusline-state.json");
  const claudeOauthStateFile = path.join(config.dataDir, "claude-oauth-state.json");
  const restoredClaudeStatusline = await readClaudeStatuslineState(
    claudeStatuslineStateFile,
    config.hostName,
  );
  const restoredClaudeOauth = await readClaudeOauthState(
    claudeOauthStateFile,
    config.hostName,
  );
  const savedPeerIdentity = config.peerUrl
    ? await readJsonFile<{ version?: unknown; host?: unknown; url?: unknown }>(peerIdentityFile)
    : null;
  let rememberedPeerHost =
    config.peerHostName ??
    (savedPeerIdentity?.version === 1 &&
    savedPeerIdentity.url === config.peerUrl &&
    typeof savedPeerIdentity.host === "string"
      ? savedPeerIdentity.host
      : null);

  const expectedHosts = (): string[] => {
    const hosts = [config.hostName];
    const peerHost = peerSync?.status().peerHost ?? rememberedPeerHost;
    if (peerHost && !hosts.includes(peerHost)) hosts.push(peerHost);
    return hosts;
  };

  const getSnapshot = (): Snapshot => ({
    ...(config.mock !== null
      ? makeFixture(config.mock, Date.now())
      : store.assembleSnapshot({ expectedHosts: expectedHosts() })),
    dashboardConfig: dashboardConfigStore.current(),
  });

  const getHealth = (): unknown => {
    const nowMs = Date.now();
    return {
      ok: true,
      collectorVersion: COLLECTOR_VERSION,
      schemaVersion: SCHEMA_VERSION,
      host: config.hostName,
      now: new Date(nowMs).toISOString(),
      uptimeSeconds: Math.round((nowMs - startedAtMs) / 1000),
      mock: config.mock,
      providers: store.list().map((o) => {
        const observedMs = o.provider.observedAt !== null ? Date.parse(o.provider.observedAt) : NaN;
        return {
          id: o.provider.id,
          host: o.provider.host,
          source: o.provider.source,
          state: o.provider.state,
          origin: o.origin,
          observedAt: o.provider.observedAt,
          ageSeconds: Number.isFinite(observedMs) ? Math.max(0, Math.round((nowMs - observedMs) / 1000)) : null,
        };
      }),
      peer: peerSync ? peerSync.status() : null,
      adb: adbTunnel ? adbTunnel.status() : { enabled: false },
      bluetooth: bluetooth ? bluetooth.status() : { enabled: false },
      stream: {
        clients: server.clientCount(),
        lastClientActivityAt: server.lastClientActivityAt() === null
          ? null
          : new Date(server.lastClientActivityAt()!).toISOString(),
      },
      configurationWarnings: [
        ...(config.tokenSource === "flag" ? ["TOKEN_ON_COMMAND_LINE"] : []),
        ...(config.peerUrl && !rememberedPeerHost ? ["PEER_HOST_NOT_PINNED"] : []),
        ...(!config.codexAppServerEnabled ? ["CODEX_APP_SERVER_DISABLED"] : []),
        ...(!config.claudeOauthEnabled ? ["CLAUDE_OAUTH_DISABLED"] : []),
        ...(dashboardConfigStore.warning() ? [dashboardConfigStore.warning()!] : []),
      ],
    };
  };

  const getPeerObservations = (): unknown => ({
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    host: config.hostName,
    now: new Date().toISOString(),
    observations: store.localObservations().map((o) => ({
      provider: o.provider,
      receivedAt: new Date(o.receivedAtMs).toISOString(),
    })),
  });

  const server = createCollectorServer({
    token,
    allowedOrigins: config.allowedOrigins,
    uiDir: config.uiDir,
    getSnapshot,
    getHealth,
    getPeerObservations,
    ingestStatusline: async (body) => {
      const provider = parseClaudeStatusline(body, { host: config.hostName });
      store.upsertLocal(provider);
      if (hasClaudeRateLimits(provider)) {
        await writeClaudeStatuslineState(claudeStatuslineStateFile, provider);
      }
    },
  });
  timers.push(
    setInterval(async () => {
      if (await dashboardConfigStore.refresh()) {
        optionalProviders?.sync(dashboardConfigStore.current().providers);
        server.broadcastSnapshot();
      }
    }, 5_000),
  );

  if (config.mock !== null) {
    timers.push(setInterval(() => server.broadcastSnapshot(), MOCK_REFRESH_MS));
  } else {
    // Placeholders so the very first snapshot lists both providers as
    // "unavailable" (never zeros) until real telemetry arrives.
    store.upsertLocal(placeholder("claude", "Claude", config.hostName));
    store.upsertLocal(placeholder("codex", "Codex", config.hostName));
    if (restoredClaudeStatusline) store.upsertLocal(restoredClaudeStatusline);
    if (restoredClaudeOauth) store.upsertLocal(restoredClaudeOauth);
    store.onChange(() => server.broadcastSnapshot());

    optionalProviders = new OptionalProviderManager({
      host: config.hostName,
      providerDirectory: config.providerDirectory,
      dataDirectory: config.dataDir,
      onObservation: (observation) => store.upsertLocal(observation),
    });
    optionalProviders.sync(dashboardConfigStore.current().providers);

    const claudeReader = new ClaudeJsonlReader({
      claudeDir: config.claudeDir,
      dataDir: config.dataDir,
      host: config.hostName,
    });
    const rolloutReader = new CodexRolloutReader({
      codexDir: config.codexDir,
      dataDir: config.dataDir,
      host: config.hostName,
    });
    const pollReaders = async (): Promise<void> => {
      try {
        const obs = await claudeReader.poll();
        if (obs) store.upsertLocal(obs);
      } catch {
        console.error("[collector] claude-jsonl poll failed");
      }
      try {
        for (const obs of await rolloutReader.poll()) store.upsertLocal(obs);
      } catch {
        console.error("[collector] codex-rollout poll failed");
      }
    };
    void pollReaders();
    timers.push(setInterval(() => void pollReaders(), READER_POLL_MS));

    if (config.claudeOauthEnabled) {
      claudeOauth = new ClaudeOauthAdapter({
        host: config.hostName,
        hasInitialObservation: restoredClaudeOauth !== null,
        onObservation: (obs) => {
          store.upsertLocal(obs);
          if (obs.state === "live" && obs.quotaWindows.length > 0) {
            void writeClaudeOauthState(claudeOauthStateFile, obs).catch(() => {
              console.error("[collector] unable to persist Claude OAuth quota state");
            });
          }
        },
      });
      claudeOauth.start();
    }

    if (config.codexAppServerEnabled) {
      appServer = new CodexAppServerAdapter({
        host: config.hostName,
        command: config.codexCommand,
        onObservation: (obs) => store.upsertLocal(obs),
      });
      appServer.start();
    }

    adbTunnel = new AdbTunnelSupervisor({
      enabled: config.adbEnabled,
      command: config.adbCommand,
      serial: config.adbSerial,
      port: config.port,
      intervalMs: 15_000,
      snapshot: getSnapshot,
      lastClientActivityAt: () => server.lastClientActivityAt(),
    });
    bluetooth = new BluetoothSnapshotSupervisor({
      enabled: config.bluetoothEnabled,
      helperCommand: config.bluetoothHelper,
      address: config.bluetoothAddress,
      channel: config.bluetoothChannel,
      intervalMs: 15_000,
      token,
      snapshot: getSnapshot,
      usbConnected: () => adbTunnel?.status().connected ?? false,
    });

    if (config.peerUrl) {
      peerSync = new PeerSync({
        url: config.peerUrl,
        token,
        store,
        expectedHost: config.peerHostName ?? rememberedPeerHost,
        onPeerIdentified: async (host) => {
          rememberedPeerHost = host;
          await writeJsonAtomic(peerIdentityFile, { version: 1, url: config.peerUrl, host });
        },
      });
      peerSync.start();
    }
  }

  const port = await server.listen(config.port, config.bindHost);
  // The host endpoint must be listening before the first reverse mapping is
  // configured; otherwise the kiosk can race into a connection-refused loop.
  adbTunnel?.start();
  bluetooth?.start();
  console.log(
    `[collector] v${COLLECTOR_VERSION} listening on port ${port} as host "${config.hostName}"` +
      (config.mock !== null ? ` (mock fixture: ${config.mock}, refresh ${MOCK_REFRESH_MS / 1000}s)` : ""),
  );
  if (config.peerUrl) console.log(`[collector] peer sync -> ${config.peerUrl}`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const t of timers) clearInterval(t);
    peerSync?.stop();
    appServer?.stop();
    claudeOauth?.stop();
    adbTunnel?.stop();
    bluetooth?.stop();
    optionalProviders?.stop();
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
