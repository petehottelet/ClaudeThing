import type { Snapshot } from "@carthing/contracts";
import { formatAge } from "@carthing/contracts";
import type { LinkState, PairingState } from "../data/useSnapshotSource";

interface SystemStatusProps {
  snapshot: Snapshot | null;
  link: LinkState;
  activeEndpoint: string | null;
  endpoints: string[];
  mockName: string | null;
  now: number;
  receivedAt: number | null;
  skewMs: number;
  pairing: PairingState;
  timeZone: string;
  youtubeChannel: string;
  ga4Property: string;
}

export function SystemStatus({
  snapshot,
  link,
  activeEndpoint,
  endpoints,
  mockName,
  now,
  receivedAt,
  skewMs,
  pairing,
  timeZone,
  youtubeChannel,
  ga4Property,
}: SystemStatusProps) {
  return (
    <div className="screen">
      <div className="hdr">
        <div className="hdr-title">System</div>
        <div className="hdr-spacer" />
      </div>
      <div className="sys-list">
        <div className="sys-row">
          <span className="sys-key">Pairing</span>
          <span className="sys-val">{mockName ? "mock bypass" : pairing}</span>
        </div>
        <div className="sys-row">
          <span className="sys-key">Link</span>
          <span className="sys-val">
            {mockName ? `mock fixture: ${mockName}` : link}
            {activeEndpoint ? ` · ${activeEndpoint}` : ""}
          </span>
        </div>
        <div className="sys-row">
          <span className="sys-key">Endpoints</span>
          <span className="sys-val">{endpoints.join(", ") || "none configured"}</span>
        </div>
        <div className="sys-row">
          <span className="sys-key">Snapshot received</span>
          <span className="sys-val">
            {receivedAt ? formatAge(new Date(receivedAt).toISOString(), Date.now()) : "never"}
          </span>
        </div>
        <div className="sys-row">
          <span className="sys-key">Clock skew</span>
          <span className="sys-val">{Math.round(skewMs / 1000)}s vs collector</span>
        </div>
        <div className="sys-row">
          <span className="sys-key">Time zone</span>
          <span className="sys-val">{timeZone}</span>
        </div>
        <div className="sys-row">
          <span className="sys-key">YouTube channel</span>
          <span className="sys-val">{youtubeChannel}</span>
        </div>
        <div className="sys-row">
          <span className="sys-key">GA4 property</span>
          <span className="sys-val">{ga4Property}</span>
        </div>
        <div className="sys-row">
          <span className="sys-key">Collector</span>
          <span className="sys-val">
            {snapshot ? `${snapshot.host} · v${snapshot.collectorVersion} · schema ${snapshot.schemaVersion}` : "—"}
          </span>
        </div>
        {mockName && (
          <div className="sys-row">
            <span className="sys-key">Mock controls</span>
            <span className="sys-val">M cycles fixtures · 1/2/3/4 presets · dial = arrows</span>
          </div>
        )}
        {snapshot?.providers.map((p) => (
          <div className="sys-row" key={p.id}>
            <span className="sys-key">{p.displayName}</span>
            <span className="sys-val">
              {p.state} · observed {formatAge(p.observedAt, now)}
              {p.source ? ` · ${p.source}` : ""}
              {p.host ? ` · on ${p.host}` : ""}
              {p.quotaWindows.length > 2 ? ` · ${p.quotaWindows.length} limits` : ""}
              {p.diagnostic ? ` · ${p.diagnostic}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
