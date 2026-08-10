import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderDisplayMetric, ProviderState } from "@carthing/contracts";
import { deriveState, formatAge, formatClock } from "@carthing/contracts";
import { useNow } from "./data/useNow";
import { useSnapshotSource } from "./data/useSnapshotSource";
import { useHardwareInput } from "./input/useHardwareInput";
import { cardState } from "./components/Meter";
import { StatusRail } from "./components/StatusRail";
import { Overview } from "./screens/Overview";
import { detailPageCount, ProviderDetail } from "./screens/ProviderDetail";
import { SystemStatus } from "./screens/SystemStatus";
import { FirstConnect } from "./screens/Messages";
import { DashboardGallery, type DashboardPage } from "./screens/DashboardGallery";
import { Ga4Dashboard, MarketsDashboard, WeeklyUsageDashboard, YouTubeDashboard } from "./screens/ChartDashboards";
import { marketInstrumentsFromConfig } from "./data/showcase";

type Page = "overview" | "provider" | "gallery" | DashboardPage | "system";

const DASHBOARD_ORDER: DashboardPage[] = ["usage-trend", "youtube", "ga4", "markets"];

const STATE_RANK: Record<ProviderState, number> = {
  live: 0,
  stale: 1,
  unavailable: 2,
  offline: 3,
  error: 4,
};

export default function App() {
  const source = useSnapshotSource();
  const now = useNow(source.skewMs);
  const [page, setPage] = useState<Page>("overview");
  const [activeProviderId, setActiveProviderId] = useState("claude");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [windowPage, setWindowPage] = useState(0);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [marketIndex, setMarketIndex] = useState(0);
  const [youtubeRangeIndex, setYoutubeRangeIndex] = useState(1);
  const [ga4RangeIndex, setGa4RangeIndex] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);

  useEffect(() => setStage(stageRef.current), []);

  const providers = useMemo(() => {
    const byId = new Map((source.snapshot?.providers ?? []).map((provider) => [provider.id, provider]));
    return source.dashboardConfig.providers
      .filter((configured) => configured.enabled)
      .map((configured) => byId.get(configured.id))
      .filter((provider): provider is NonNullable<typeof provider> => provider !== undefined);
  }, [source.snapshot, source.dashboardConfig.providers]);
  const marketSelectionKey = JSON.stringify(source.dashboardConfig.markets.instruments);
  const marketInstruments = useMemo(
    () => marketInstrumentsFromConfig(source.dashboardConfig.markets.instruments),
    // The collector sends a fresh object on each snapshot; the serialized
    // selection prevents live telemetry from restarting market rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketSelectionKey],
  );
  const metricsForProvider = (id: string): ProviderDisplayMetric[] =>
    source.dashboardConfig.providers.find((provider) => provider.id === id)?.show ?? [
      "quota",
      "identity",
      "status",
      "metrics",
      "metricHistory",
      "resetCredits",
      "currentTokens",
      "lifetimeTokens",
      "peakDailyTokens",
      "streak",
      "history",
      "cost",
    ];

  useEffect(() => setWindowPage(0), [page]);
  useEffect(() => {
    if (providers.length === 0) return;
    setFocusedIndex((index) => Math.min(index, providers.length - 1));
  }, [providers.length]);

  useEffect(() => {
    if (marketInstruments.length === 0) return;
    setMarketIndex((index) => index % marketInstruments.length);
  }, [marketInstruments.length]);

  useEffect(() => {
    if (page !== "markets" || marketInstruments.length < 2) return;
    const id = window.setInterval(() => {
      setMarketIndex((index) => (index + 1) % marketInstruments.length);
    }, source.dashboardConfig.markets.rotationSeconds * 1000);
    return () => window.clearInterval(id);
  }, [
    page,
    marketIndex,
    marketInstruments.length,
    source.dashboardConfig.markets.rotationSeconds,
  ]);

  const rotate = (delta: 1 | -1) => {
    if (page === "overview") {
      if (providers.length > 0) {
        setFocusedIndex((i) => (i + delta + providers.length) % providers.length);
      }
      return;
    }
    if (page === "gallery") {
      setGalleryIndex((index) => (index + delta + DASHBOARD_ORDER.length) % DASHBOARD_ORDER.length);
      return;
    }
    if (page === "markets") {
      const length = Math.max(1, marketInstruments.length);
      setMarketIndex((index) => (index + delta + length) % length);
      return;
    }
    if (page === "youtube") {
      setYoutubeRangeIndex((index) => (index + delta + 4) % 4);
      return;
    }
    if (page === "ga4") {
      setGa4RangeIndex((index) => (index + delta + 4) % 4);
      return;
    }
    if (page === "usage-trend") {
      return;
    }
    if (page === "provider") {
      const provider = providers.find((candidate) => candidate.id === activeProviderId);
      // Meter pages first, then daily/weekly/monthly/yearly history views.
      const pageCount = provider ? detailPageCount(provider, metricsForProvider(provider.id)) : 1;
      if (pageCount > 1) {
        setWindowPage((current) => (current + delta + pageCount) % pageCount);
      }
      return;
    }
  };

  const press = () => {
    if (page === "overview") {
      const target = providers[focusedIndex];
      if (target) {
        setActiveProviderId(target.id);
        setPage("provider");
      }
      return;
    }
    if (page === "gallery") {
      setPage(DASHBOARD_ORDER[galleryIndex] ?? "usage-trend");
      return;
    }
    if (page === "usage-trend" || page === "youtube" || page === "ga4" || page === "markets") {
      setPage("gallery");
      return;
    }
    setPage("overview");
  };

  useHardwareInput(stage, {
    onRotate: rotate,
    onPress: press,
    onBack: () => setPage("overview"),
    // Preset layout: 1 dashboards gallery · 2 provider overview ·
    // 3 Claude detail · 4 Codex detail (long-press 4 keeps System).
    onPreset: (n) => {
      if (n === 1) setPage("gallery");
      else if (n === 2) setPage("overview");
      else {
        setActiveProviderId("claude");
        setPage("provider");
      }
    },
    onPreset4Short: () => {
      setActiveProviderId("codex");
      setPage("provider");
    },
    onPreset4Long: () => setPage("system"),
  });

  // Dev nicety: in mock mode, M cycles through fixtures for review.
  useEffect(() => {
    if (!source.mockName) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "m" || ev.key === "M") source.cycleMock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source.mockName, source.cycleMock]);

  const rail = useMemo(() => {
    const right = source.mockName
      ? `MOCK · ${source.mockName}`
      : formatClock(now, source.timeZone);

    if (!source.snapshot) {
      return {
        state: "disconnected" as const,
        detail:
          source.pairing === "missing"
            ? "Pairing required"
            : source.pairing === "rejected"
              ? "Pairing token rejected"
              : "No collector reachable",
        right,
      };
    }

    if (source.link === "disconnected" && source.receivedAt) {
      const providerAges = providers
        .map((provider) => `${provider.displayName} ${formatAge(provider.observedAt, now)}`)
        .join("   ·   ");
      return {
        state: "disconnected" as const,
        detail:
          "Link lost · " +
          (providerAges ||
            `cache ${formatAge(new Date(source.receivedAt).toISOString(), Date.now())}`),
        right,
      };
    }

    const states = providers.map((p) => cardState(p, deriveState(p, now)));
    const worst =
      states.length > 0
        ? states.reduce((a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a))
        : ("unavailable" as ProviderState);
    const mixed = states.some((s) => s !== worst);

    // When providers disagree, attribute the state per provider so the
    // aggregate word never sits next to the wrong name.
    const detail = providers
      .map((p, i) => {
        const age = formatAge(p.observedAt, now);
        const s = states[i] ?? "unavailable";
        return mixed ? `${p.displayName} ${s} · ${age}` : `${p.displayName} ${age}`;
      })
      .join("   ·   ");

    return {
      state: worst,
      detail: worst === "live" ? `✳ ${detail}` : detail,
      right,
    };
  }, [source, providers, now]);

  const showFirstConnect =
    !source.snapshot ||
    (providers.length > 0 && providers.every((p) => p.state === "unavailable" && !p.observedAt));

  let content;
  if (page === "system") {
    content = (
      <SystemStatus
        snapshot={source.snapshot}
        link={source.link}
        activeEndpoint={source.activeEndpoint}
        endpoints={source.endpoints}
        mockName={source.mockName}
        now={now}
        receivedAt={source.receivedAt}
        skewMs={source.skewMs}
        pairing={source.pairing}
        timeZone={source.timeZone}
        youtubeChannel={source.youtubeChannel}
        ga4Property={source.ga4Property}
      />
    );
  } else if (page === "gallery") {
    content = <DashboardGallery focusedIndex={galleryIndex} onOpen={setPage} />;
  } else if (page === "usage-trend") {
    content = <WeeklyUsageDashboard />;
  } else if (page === "youtube") {
    content = <YouTubeDashboard channelName={source.youtubeChannel} rangeIndex={youtubeRangeIndex} />;
  } else if (page === "ga4") {
    content = <Ga4Dashboard propertyName={source.ga4Property} rangeIndex={ga4RangeIndex} />;
  } else if (page === "markets") {
    content = <MarketsDashboard instrumentIndex={marketIndex} instruments={marketInstruments} />;
  } else if (showFirstConnect) {
    content = <FirstConnect endpoints={source.endpoints} pairing={source.pairing} />;
  } else if (page === "provider") {
    const provider = providers.find((p) => p.id === activeProviderId);
    content = provider ? (
      <ProviderDetail
        provider={provider}
        now={now}
        linkDown={source.link === "disconnected"}
        windowPage={windowPage}
        timeZone={source.timeZone}
        metrics={metricsForProvider(provider.id)}
      />
    ) : (
      <FirstConnect endpoints={source.endpoints} pairing={source.pairing} />
    );
  } else {
    content = (
      <Overview
        providers={providers}
        now={now}
        focusedIndex={focusedIndex}
        linkDown={source.link === "disconnected"}
        timeZone={source.timeZone}
        providerConfigs={source.dashboardConfig.providers}
        onOpen={(id) => {
          setActiveProviderId(id);
          setPage("provider");
        }}
      />
    );
  }

  return (
    <div className="stage" ref={stageRef}>
      {content}
      <StatusRail state={rail.state} detail={rail.detail} right={rail.right} />
    </div>
  );
}
