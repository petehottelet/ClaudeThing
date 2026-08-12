import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardConfig, Snapshot } from "@carthing/contracts";
import { DEFAULT_DASHBOARD_CONFIG, isSnapshot, isTimeZone } from "@carthing/contracts";
import type { FixtureName } from "@carthing/contracts/fixtures";
import { FIXTURE_NAMES, makeFixture } from "@carthing/contracts/fixtures";

export type LinkState = "connecting" | "connected" | "disconnected";
export type PairingState = "paired" | "missing" | "rejected";

export interface SnapshotSource {
  snapshot: Snapshot | null;
  /** Local ms timestamp when the snapshot arrived (for cache aging). */
  receivedAt: number | null;
  /** collector serverTime − local clock, ms. */
  skewMs: number;
  link: LinkState;
  pairing: PairingState;
  /** Endpoint currently serving us, e.g. "192.168.1.20:8790" or "mock:normal". */
  activeEndpoint: string | null;
  endpoints: string[];
  /** IANA time zone supplied when the device was provisioned. */
  timeZone: string;
  /** Channel name used by the YouTube analytics dashboard. */
  youtubeChannel: string;
  /** GA4 property display name used by the analytics dashboard. */
  ga4Property: string;
  /** Validated, hot-reloaded, non-secret display preferences. */
  dashboardConfig: DashboardConfig;
  mockName: FixtureName | null;
  cycleMock: () => void;
}

const CACHE_KEY = "carthing.lastSnapshot.v2";
const TOKEN_KEY = "carthing.pairingToken";
const ENDPOINTS_KEY = "carthing.endpoints";

interface CacheEntry {
  snapshot: Snapshot;
  receivedAt: number;
}

function isEndpoint(value: string): boolean {
  const match = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/.exec(value);
  if (!match) return false;
  const port = Number(match[2]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isPairingToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function readCache(): CacheEntry | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || !isSnapshot(parsed.snapshot)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* storage full or unavailable — cache is best-effort */
  }
}

function readParams(): { mock: FixtureName | null; endpoints: string[]; token: string | null; timeZone: string; youtubeChannel: string; ga4Property: string } {
  const params = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const runtime = (
    window as Window & {
      __CARTHING_CONFIG__?: { endpoints?: unknown; pairingToken?: unknown; timeZone?: unknown; youtubeChannel?: unknown; ga4Property?: unknown };
    }
  ).__CARTHING_CONFIG__;
  const mockRaw = params.get("mock");
  const mock =
    mockRaw && (FIXTURE_NAMES as string[]).indexOf(mockRaw) >= 0 ? (mockRaw as FixtureName) : null;
  const endpointsRaw = params.get("endpoints");
  const stored = (() => {
    try {
      return window.localStorage.getItem(ENDPOINTS_KEY) || "";
    } catch {
      return "";
    }
  })();
  const fragmentEndpoints = fragment.get("endpoints");
  const runtimeEndpoints = Array.isArray(runtime?.endpoints)
    ? runtime.endpoints.filter((value): value is string => typeof value === "string").join(",")
    : "";
  const sameOriginEndpoint =
    /^https?:$/.test(window.location.protocol) && window.location.port !== "5173"
      ? window.location.host
      : "127.0.0.1:8790";
  const endpoints = (fragmentEndpoints || endpointsRaw || runtimeEndpoints || stored || sameOriginEndpoint)
    .split(",")
    .map((e) => e.trim())
    .filter(isEndpoint);

  let token: string | null = null;
  try {
    const bootstrapToken = fragment.get("token");
    if (isPairingToken(bootstrapToken)) window.localStorage.setItem(TOKEN_KEY, bootstrapToken);
    else if (isPairingToken(runtime?.pairingToken)) {
      window.localStorage.setItem(TOKEN_KEY, runtime.pairingToken);
    }
    if (fragmentEndpoints) window.localStorage.setItem(ENDPOINTS_KEY, endpoints.join(","));
    const storedToken = window.localStorage.getItem(TOKEN_KEY);
    token = isPairingToken(storedToken) ? storedToken : null;
  } catch {
    token =
      (isPairingToken(fragment.get("token")) ? fragment.get("token") : null) ||
      (isPairingToken(runtime?.pairingToken) ? runtime.pairingToken : null);
  }
  if (window.location.hash) {
    // Fragments are not sent over HTTP; scrub the one-time pairing material
    // immediately so it also disappears from copy/paste and browser history.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone = isTimeZone(runtime?.timeZone)
    ? runtime.timeZone
    : isTimeZone(browserTimeZone)
      ? browserTimeZone
      : "UTC";
  const requestedChannel = params.get("youtube") ?? runtime?.youtubeChannel;
  const youtubeChannel =
    typeof requestedChannel === "string" &&
    requestedChannel.trim().length > 0 &&
    requestedChannel.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(requestedChannel)
      ? requestedChannel.trim()
      : "YouTube Channel";
  const requestedProperty = params.get("ga4") ?? runtime?.ga4Property;
  const ga4Property =
    typeof requestedProperty === "string" &&
    requestedProperty.trim().length > 0 &&
    requestedProperty.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(requestedProperty)
      ? requestedProperty.trim()
      : "Website Analytics";
  return { mock, endpoints, token, timeZone, youtubeChannel, ga4Property };
}

const POLL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const MIRROR_ENDPOINT = "usb-mirror";
const MIRROR_MAX_AGE_MS = 90_000;

/** A pushed snapshot must keep advancing; an old local file is an offline
 * cache, not evidence that the host is still attached. */
export function isFreshMirror(snapshot: Snapshot, nowMs: number): boolean {
  const serverMs = Date.parse(snapshot.serverTime);
  return Number.isFinite(serverMs) && Math.abs(nowMs - serverMs) <= MIRROR_MAX_AGE_MS;
}

export function useSnapshotSource(): SnapshotSource {
  const params = useMemo(readParams, []);
  const [mockName, setMockName] = useState<FixtureName | null>(params.mock);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [skewMs, setSkewMs] = useState(0);
  const [link, setLink] = useState<LinkState>("connecting");
  const [pairing, setPairing] = useState<PairingState>(params.token ? "paired" : "missing");
  const [activeEndpoint, setActiveEndpoint] = useState<string | null>(null);
  const lastMessageAt = useRef<number>(0);
  // Refs mirror state for interval closures (state reads inside setInterval
  // callbacks would be frozen at mount).
  const activeEndpointRef = useRef<string | null>(null);
  const lastCacheWriteAt = useRef<number>(0);

  const accept = useCallback((snap: Snapshot, endpoint: string) => {
    const now = Date.now();
    lastMessageAt.current = now;
    setSnapshot(snap);
    setReceivedAt(now);
    const server = new Date(snap.serverTime).getTime();
    setSkewMs(Number.isNaN(server) ? 0 : server - now);
    setLink("connected");
    setActiveEndpoint(endpoint);
    activeEndpointRef.current = endpoint;
    // Throttle persistence: the device's eMMC does not need a write every
    // stream frame; once a minute keeps the offline cache fresh enough.
    if (now - lastCacheWriteAt.current > 60_000) {
      lastCacheWriteAt.current = now;
      writeCache({ snapshot: snap, receivedAt: now });
    }
  }, []);

  const cycleMock = useCallback(() => {
    setMockName((current) => {
      if (!current) return current;
      const idx = FIXTURE_NAMES.indexOf(current);
      return FIXTURE_NAMES[(idx + 1) % FIXTURE_NAMES.length] ?? current;
    });
  }, []);

  // Mock mode: regenerate the fixture periodically so ages/countdowns move.
  useEffect(() => {
    if (!mockName) return;
    const emit = () => accept(makeFixture(mockName), `mock:${mockName}`);
    emit();
    const id = window.setInterval(emit, 5000);
    return () => window.clearInterval(id);
  }, [mockName, accept]);

  // Live mode: boot from cache, then probe endpoints; WS + poll fallback.
  useEffect(() => {
    if (mockName) return;

    if (!params.token) {
      const cached = readCache();
      if (cached) {
        setSnapshot(cached.snapshot);
        setReceivedAt(cached.receivedAt);
      }
      setPairing("missing");
      setLink("disconnected");
      return;
    }

    const cached = readCache();
    if (cached) {
      setSnapshot(cached.snapshot);
      setReceivedAt(cached.receivedAt);
    }
    setLink("connecting");

    let disposed = false;
    let ws: WebSocket | null = null;
    let pollId = 0;
    let probeId = 0;
    let probing = false;
    const mirrorEnabled = window.location.hostname === "127.0.0.1" && window.location.port === "8080";

    // A hung request must fail fast instead of wedging the bootstrap: the
    // USB tunnel can silently eat a connection, and a browser fetch has no
    // default timeout — one unlucky probe would otherwise never resolve and
    // never reschedule, leaving the page on its cache forever.
    const fetchSnapshot = async (endpoint: string): Promise<Response> => {
      const control = new AbortController();
      const timer = window.setTimeout(() => control.abort(), 4000);
      try {
        return await fetch(`http://${endpoint}/v1/snapshot`, {
          cache: "no-store",
          headers: { authorization: `Bearer ${params.token}` },
          signal: control.signal,
        });
      } finally {
        window.clearTimeout(timer);
      }
    };

    const fetchMirror = async (): Promise<boolean> => {
      if (!mirrorEnabled) return false;
      try {
        const res = await fetch("/snapshot.json", { cache: "no-store" });
        if (!res.ok) return false;
        const body: unknown = await res.json();
        if (!isSnapshot(body) || !isFreshMirror(body, Date.now())) return false;
        if (disposed) return false;
        accept(body, MIRROR_ENDPOINT);
        setPairing("paired");
        return true;
      } catch {
        return false;
      }
    };

    const probe = async () => {
      if (probing) return;
      probing = true;
      try {
        for (const endpoint of params.endpoints) {
          try {
            const res = await fetchSnapshot(endpoint);
            if (res.status === 401) {
              setPairing("rejected");
              continue;
            }
            if (!res.ok) continue;
            const body: unknown = await res.json();
            if (!isSnapshot(body)) continue;
            if (disposed) return;
            accept(body, endpoint);
            setPairing("paired");
            openWs(endpoint);
            return;
          } catch {
            /* try the next endpoint */
          }
        }
        if (!disposed) {
          if (Date.now() - lastMessageAt.current > HEARTBEAT_TIMEOUT_MS) {
            setLink("disconnected");
          }
          probeId = window.setTimeout(probe, 8000);
        }
      } finally {
        probing = false;
      }
    };

    const openWs = (endpoint: string) => {
      try {
        ws = new WebSocket(`ws://${endpoint}/v1/stream`, [
          "carthing.v1",
          `auth.${params.token}`,
        ]);
        ws.onmessage = (ev) => {
          try {
            const body: unknown = JSON.parse(String(ev.data));
            if (isSnapshot(body)) accept(body, endpoint);
          } catch {
            /* ignore malformed frames */
          }
        };
        ws.onclose = () => {
          if (!disposed) {
            setLink("disconnected");
            probeId = window.setTimeout(probe, 3000);
          }
        };
        ws.onerror = () => {
          if (ws) ws.close();
        };
      } catch {
        setLink("disconnected");
        probeId = window.setTimeout(probe, 8000);
      }
    };

    // Poll as a belt-and-braces fallback and heartbeat watchdog.
    pollId = window.setInterval(async () => {
      if (disposed) return;
      const silentFor = Date.now() - lastMessageAt.current;
      const endpoint = activeEndpointRef.current;
      if (endpoint !== MIRROR_ENDPOINT && silentFor < POLL_MS) return;
      if (await fetchMirror()) return;
      if (endpoint && endpoint !== MIRROR_ENDPOINT && !endpoint.startsWith("mock:")) {
        try {
          const res = await fetchSnapshot(endpoint);
          if (res.ok) {
            const body: unknown = await res.json();
            if (isSnapshot(body)) {
              accept(body, endpoint);
              return;
            }
          }
        } catch {
          /* fall through to disconnect check */
        }
      } else if ((!endpoint || endpoint === MIRROR_ENDPOINT) && !probing) {
        // Never connected this session (a wedged or unlucky first probe):
        // keep kicking the bootstrap until an endpoint answers.
        void probe();
      }
      if (silentFor > HEARTBEAT_TIMEOUT_MS) setLink("disconnected");
    }, POLL_MS);

    if (mirrorEnabled) {
      void fetchMirror().then((mirrored) => {
        if (!mirrored) void probe();
      });
    } else {
      void probe();
    }

    return () => {
      disposed = true;
      if (ws) ws.close();
      window.clearInterval(pollId);
      window.clearTimeout(probeId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockName, params.endpoints.join(","), params.token]);

  const dashboardConfig: DashboardConfig = snapshot?.dashboardConfig ?? {
    ...DEFAULT_DASHBOARD_CONFIG,
    providers: DEFAULT_DASHBOARD_CONFIG.providers.map((provider) => ({
      ...provider,
      show: [...provider.show],
    })),
    youtube: {
      ...DEFAULT_DASHBOARD_CONFIG.youtube,
      channelName: params.youtubeChannel,
    },
    ga4: {
      ...DEFAULT_DASHBOARD_CONFIG.ga4,
      propertyName: params.ga4Property,
    },
    markets: {
      ...DEFAULT_DASHBOARD_CONFIG.markets,
      instruments: DEFAULT_DASHBOARD_CONFIG.markets.instruments.map((instrument) => ({
        ...instrument,
      })),
    },
  };

  return {
    snapshot,
    receivedAt,
    skewMs,
    link,
    pairing,
    activeEndpoint,
    endpoints: params.endpoints,
    timeZone: params.timeZone,
    youtubeChannel: dashboardConfig.youtube.channelName,
    ga4Property: dashboardConfig.ga4.propertyName,
    dashboardConfig,
    mockName,
    cycleMock,
  };
}
