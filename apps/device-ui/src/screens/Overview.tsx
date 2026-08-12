import type {
  DashboardProviderConfig,
  ProviderDisplayMetric,
  ProviderSnapshot,
} from "@carthing/contracts";
import { deriveState, formatClock } from "@carthing/contracts";
import {
  cardState,
  Meter,
  overviewQuotaWindows,
  placeholderWindows,
  TokenPanel,
  UsageFactsPanel,
} from "../components/Meter";
import { ProductMark, ProviderGlyph } from "../components/ProviderGlyph";
import { StatePill } from "../components/StatusRail";
import { humanizeDiagnostic } from "../data/diagnostics";

interface OverviewProps {
  providers: ProviderSnapshot[];
  now: number;
  focusedIndex: number;
  linkDown: boolean;
  timeZone: string;
  providerConfigs: DashboardProviderConfig[];
  onOpen: (id: string) => void;
}

export function Overview({ providers, now, focusedIndex, linkDown, timeZone, providerConfigs, onOpen }: OverviewProps) {
  const pageStart = Math.floor(Math.min(focusedIndex, Math.max(0, providers.length - 1)) / 2) * 2;
  const visibleProviders = providers.slice(pageStart, pageStart + 2);
  return (
    <div className="screen">
      <div className="hdr">
        <span className="hdr-glyph">
          <ProductMark size={36} />
        </span>
        <div className="hdr-title">Usage</div>
        <div className="hdr-spacer" />
        <div className="hdr-hint overview-explore-hint">
          {providers.length > 2
            ? `${pageStart + 1}–${Math.min(pageStart + 2, providers.length)} / ${providers.length} · turn dial`
            : "Preset 1 · dashboards"}
        </div>
        <div className="hdr-clock">{formatClock(now, timeZone)}</div>
      </div>
      <div className="overview-grid">
        {visibleProviders.map((p, i) => {
          const globalIndex = pageStart + i;
          const derived = deriveState(p, now);
          const shown = cardState(p, derived, linkDown);
          const degraded = shown !== "live";
          const missing = p.quotaWindows.length === 0;
          const show: ProviderDisplayMetric[] = providerConfigs.find((configured) => configured.id === p.id)?.show ?? [
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
          const quotaVisible = show.includes("quota");
          const tokensOnly = missing || !quotaVisible ? p.tokens : null;
          const factsOnly =
            missing &&
            !tokensOnly &&
            (p.cost !== null ||
              p.usageFacts != null ||
              (p.supplementalMetrics?.length ?? 0) > 0 ||
              p.identity != null ||
              p.serviceStatus != null);
          const windows = missing
            ? placeholderWindows()
            : overviewQuotaWindows(p.id, p.quotaWindows);
          const threeLimitLayout = quotaVisible && !missing && windows.length === 3;
          const extraWindows = missing || !quotaVisible
            ? 0
            : p.quotaWindows.length - windows.filter((w) => !w.id.startsWith("ph_")).length;
          const errorLabel = missing ? humanizeDiagnostic(p.diagnostic) : null;
          return (
            <button
              type="button"
              key={p.id}
              className={globalIndex === focusedIndex ? "provider-card is-focused" : "provider-card"}
              onClick={() => {
                onOpen(p.id);
              }}
              aria-label={`Open ${p.displayName} usage`}
            >
              <div className="provider-card-hdr">
                <span className="glyph">
                  <ProviderGlyph id={p.id} size={26} />
                </span>
                <span className="provider-card-name">{p.displayName}</span>
                {extraWindows > 0 && (
                  <span className="limit-count">+{extraWindows}</span>
                )}
                <StatePill state={shown} />
              </div>
              <div className={threeLimitLayout ? "card-meters three-limit-layout" : "card-meters"}>
                {p.id === "codex" ? (
                  <>
                    {quotaVisible && (
                      <Meter window={windows[0]!} now={now} degraded={degraded} compact />
                    )}
                    <UsageFactsPanel
                      facts={p.usageFacts}
                      window={windows[0]!}
                      tokens={p.tokens}
                      cost={p.cost}
                      show={show}
                      supplementalMetrics={p.supplementalMetrics}
                      identity={p.identity}
                      serviceStatus={p.serviceStatus}
                      now={now}
                      degraded={degraded}
                      compact
                    />
                    {errorLabel && <div className="card-error">{errorLabel}</div>}
                  </>
                ) : factsOnly ? (
                  <>
                    <UsageFactsPanel
                      facts={p.usageFacts}
                      window={windows[0]!}
                      tokens={p.tokens}
                      cost={p.cost}
                      show={show}
                      supplementalMetrics={p.supplementalMetrics}
                      identity={p.identity}
                      serviceStatus={p.serviceStatus}
                      now={now}
                      degraded={degraded}
                      compact
                    />
                    {errorLabel && <div className="card-error">{errorLabel}</div>}
                  </>
                ) : tokensOnly ? (
                  // Tokens without quota: show the data we have, and say
                  // plainly why the meters are absent instead of "NO DATA".
                  <>
                    <TokenPanel
                      tokens={tokensOnly}
                      now={now}
                      timeZone={timeZone}
                      degraded={degraded}
                      compact
                    />
                    {errorLabel ? (
                      <div className="card-error">{errorLabel}</div>
                    ) : (
                      <div className="card-note">No quota reported</div>
                    )}
                  </>
                ) : (
                  <>
                    {windows.map((w) => (
                      <Meter key={w.id} window={w} now={now} degraded={degraded} compact />
                    ))}
                    {errorLabel && <div className="card-error">{errorLabel}</div>}
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
