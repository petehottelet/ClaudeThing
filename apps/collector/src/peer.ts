/**
 * Peer sync: when --peer is configured, poll the peer collector's
 * /v1/peer/observations every 10s with the pairing token and feed the results
 * through the merge via the observation store. A peer that is unreachable
 * keeps its last synced data in the store (it ages out naturally via
 * freshness states) — sync failures never crash the collector.
 */

import { isProviderSnapshot, SCHEMA_VERSION, type ProviderSnapshot } from "@carthing/contracts";
import { isObject } from "./util";
import type { ObservationStore } from "./state";

export interface PeerStatus {
  url: string;
  peerHost: string | null;
  ok: boolean;
  lastSyncAt: string | null;
  /** Display-safe failure code, e.g. "HTTP_401" or "FETCH_FAILED". */
  lastError: string | null;
  consecutiveFailures: number;
}

export interface PeerSyncOptions {
  url: string;
  token: string;
  store: ObservationStore;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  expectedHost?: string | null;
  onPeerIdentified?: (host: string) => void | Promise<void>;
}

const MAX_PEER_BODY_BYTES = 1024 * 1024;
const MAX_PEER_OBSERVATIONS = 128;

export class PeerSync {
  private readonly opts: PeerSyncOptions;
  private timer: NodeJS.Timeout | null = null;
  private st: PeerStatus;

  constructor(opts: PeerSyncOptions) {
    this.opts = opts;
    this.st = {
      url: opts.url,
      peerHost: opts.expectedHost ?? null,
      ok: false,
      lastSyncAt: null,
      lastError: null,
      consecutiveFailures: 0,
    };
  }

  start(): void {
    void this.syncOnce();
    this.timer = setInterval(() => void this.syncOnce(), this.opts.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): PeerStatus {
    return { ...this.st };
  }

  async syncOnce(): Promise<boolean> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5000);
    timeout.unref?.();
    try {
      const res = await fetchImpl(`${this.opts.url}/v1/peer/observations`, {
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: controller.signal,
      });
      if (!res.ok) return this.fail(`HTTP_${res.status}`);
      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_PEER_BODY_BYTES) {
        return this.fail("PAYLOAD_TOO_LARGE");
      }
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > MAX_PEER_BODY_BYTES) {
        return this.fail("PAYLOAD_TOO_LARGE");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return this.fail("BAD_PAYLOAD");
      }
      if (
        !isObject(payload) ||
        payload.schemaVersion !== SCHEMA_VERSION ||
        !Array.isArray(payload.observations)
      ) return this.fail("BAD_PAYLOAD");
      if (payload.observations.length > MAX_PEER_OBSERVATIONS) return this.fail("PAYLOAD_TOO_LARGE");
      const peerHost =
        typeof payload.host === "string" && payload.host.length > 0 && payload.host.length <= 128
          ? payload.host
          : null;
      if (!peerHost) return this.fail("BAD_PAYLOAD");
      if (this.opts.expectedHost && peerHost !== this.opts.expectedHost) {
        return this.fail("PEER_HOST_MISMATCH");
      }
      if (peerHost === this.opts.store.localHost) return this.fail("PEER_HOST_COLLISION");

      const providers: ProviderSnapshot[] = [];
      for (const item of payload.observations) {
        if (!isObject(item)) continue;
        const provider = item.provider;
        if (!isProviderSnapshot(provider)) continue;
        if (provider.host !== peerHost) continue;
        providers.push(provider);
      }
      const previousHost = this.st.peerHost;
      if (previousHost && previousHost !== peerHost) this.opts.store.removePeerHost(previousHost);
      this.opts.store.replacePeerHost(peerHost, providers);
      const nowMs = this.opts.now?.() ?? Date.now();
      this.st = {
        ...this.st,
        peerHost: peerHost ?? this.st.peerHost,
        ok: true,
        lastSyncAt: new Date(nowMs).toISOString(),
        lastError: null,
        consecutiveFailures: 0,
      };
      try {
        await this.opts.onPeerIdentified?.(peerHost);
      } catch {
        // Identity persistence is best-effort; a valid sync still succeeds.
      }
      return true;
    } catch {
      return this.fail("FETCH_FAILED");
    } finally {
      clearTimeout(timeout);
    }
  }

  private fail(code: string): false {
    this.st = {
      ...this.st,
      ok: false,
      lastError: code,
      consecutiveFailures: this.st.consecutiveFailures + 1,
    };
    return false;
  }
}
