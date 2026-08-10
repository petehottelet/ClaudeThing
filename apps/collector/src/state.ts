/**
 * Observation store: the collector's in-memory truth. Observations are keyed
 * per (providerId, host, source) so multiple telemetry surfaces coexist, and
 * `assembleSnapshot` produces the merged contracts Snapshot for serving.
 */

import { SCHEMA_VERSION, type ProviderSnapshot, type Snapshot } from "@carthing/contracts";
import { mergeProviders, type MergedProvider } from "./merge";

export interface StoredObservation {
  provider: ProviderSnapshot;
  /** Local wall-clock ms when this collector received the observation. */
  receivedAtMs: number;
  origin: "local" | "peer";
}

export interface ObservationStoreOptions {
  localHost: string;
  collectorVersion: string;
  now?: () => number;
}

export class ObservationStore {
  readonly localHost: string;
  private readonly collectorVersion: string;
  private readonly now: () => number;
  private readonly byKey = new Map<string, StoredObservation>();
  private readonly listeners = new Set<() => void>();

  constructor(opts: ObservationStoreOptions) {
    this.localHost = opts.localHost;
    this.collectorVersion = opts.collectorVersion;
    this.now = opts.now ?? (() => Date.now());
  }

  private key(p: ProviderSnapshot): string {
    return `${p.id}|${p.host ?? ""}|${p.source ?? ""}`;
  }

  upsertLocal(provider: ProviderSnapshot): void {
    this.byKey.set(this.key(provider), { provider, receivedAtMs: this.now(), origin: "local" });
    this.notify();
  }

  upsertPeer(provider: ProviderSnapshot): void {
    this.byKey.set(this.key(provider), { provider, receivedAtMs: this.now(), origin: "peer" });
    this.notify();
  }

  /**
   * Atomically replace one peer host's published set. Observations removed by
   * the peer (or left behind after an adapter/hostname change) cannot linger
   * forever and masquerade as a second machine.
   */
  replacePeerHost(peerHost: string, providers: ProviderSnapshot[]): void {
    const incoming = new Map(
      providers
        .filter((provider) => provider.host === peerHost)
        .map((provider) => [this.key(provider), provider]),
    );
    let changed = false;
    for (const [key, stored] of this.byKey) {
      if (
        stored.origin === "peer" &&
        stored.provider.host === peerHost &&
        !incoming.has(key)
      ) {
        this.byKey.delete(key);
        changed = true;
      }
    }
    const receivedAtMs = this.now();
    for (const [key, provider] of incoming) {
      this.byKey.set(key, { provider, receivedAtMs, origin: "peer" });
      changed = true;
    }
    if (changed) this.notify();
  }

  removePeerHost(peerHost: string): void {
    let changed = false;
    for (const [key, stored] of this.byKey) {
      if (stored.origin === "peer" && stored.provider.host === peerHost) {
        this.byKey.delete(key);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  list(): StoredObservation[] {
    return [...this.byKey.values()];
  }

  /** Local-origin observations only — what we publish to a syncing peer. */
  localObservations(): StoredObservation[] {
    return this.list().filter((o) => o.origin === "local");
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listeners must never break the store.
      }
    }
  }

  merged(opts: { nowMs?: number; expectedHosts?: string[] } = {}): MergedProvider[] {
    const nowMs = opts.nowMs ?? this.now();
    return mergeProviders(
      this.list().map((o) => ({ provider: o.provider, receivedAtMs: o.receivedAtMs })),
      { nowMs, expectedHosts: opts.expectedHosts ?? [] },
    );
  }

  assembleSnapshot(opts: { nowMs?: number; expectedHosts?: string[] } = {}): Snapshot {
    const nowMs = opts.nowMs ?? this.now();
    const iso = new Date(nowMs).toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      collectorVersion: this.collectorVersion,
      host: this.localHost,
      generatedAt: iso,
      serverTime: iso,
      providers: this.merged({ nowMs, expectedHosts: opts.expectedHosts }).map((m) => m.snapshot),
    };
  }
}
