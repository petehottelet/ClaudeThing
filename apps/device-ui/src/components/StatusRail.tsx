import {
  formatClock,
  type ProviderSnapshot,
  type ProviderState,
  type SnapshotTransportStatus,
} from "@carthing/contracts";
import type { LinkState } from "../data/useSnapshotSource";

interface StatusRailProps {
  state: RailState;
  detail: string;
  right: string;
  transport?: SnapshotTransportStatus;
  link: LinkState;
}

export type RailState = ProviderState | "disconnected" | "reconnecting";

const STATE_WORD: Record<string, string> = {
  live: "LIVE",
  stale: "STALE",
  offline: "OFFLINE",
  unavailable: "NO DATA",
  error: "ERROR",
  disconnected: "OFFLINE",
  reconnecting: "Reconnecting",
};

const STATE_CLASS: Record<string, string> = {
  live: "state-live",
  stale: "state-stale",
  offline: "state-offline",
  unavailable: "state-offline",
  error: "state-error",
  disconnected: "state-offline",
  reconnecting: "state-reconnecting",
};

export function railPresentation(state: RailState): {
  className: string;
  word: string;
  refreshing: boolean;
} {
  return {
    className: STATE_CLASS[state] ?? "state-offline",
    word: STATE_WORD[state] ?? "—",
    refreshing: state === "reconnecting",
  };
}

export function formatReconnectDetail(
  providers: Array<Pick<ProviderSnapshot, "displayName" | "observedAt">>,
  timeZone: string,
): string {
  if (providers.length === 0) return "Waiting for fresh data";
  const updates = providers.map((provider) => {
    if (!provider.observedAt) return `${provider.displayName} never`;
    const observedAtMs = Date.parse(provider.observedAt);
    if (!Number.isFinite(observedAtMs)) return `${provider.displayName} unknown`;
    return `${provider.displayName} ${formatClock(observedAtMs, timeZone)}`;
  });
  return `Last data · ${updates.join(" · ")}`;
}

/**
 * Bottom rail: connection state word + observation age + source.
 * Color is reinforced by the state word — never color alone.
 */
export function StatusRail({
  state,
  detail,
  right,
  transport: transportState,
  link,
}: StatusRailProps) {
  const sparked = detail.startsWith("✳ ");
  const transport = formatTransportStatus(transportState, link);
  const presentation = railPresentation(state);
  return (
    <div className={`rail ${presentation.className}`}>
      {presentation.refreshing ? (
        <span className="rail-refresh-icon" aria-hidden="true" />
      ) : (
        <span className="dot" />
      )}
      <span className="rail-state">{presentation.word}</span>
      <span className="rail-detail">
        {sparked && <span className="spark">✳ </span>}
        {sparked ? detail.slice(2) : detail}
      </span>
      {transport && <span className="rail-transport">{transport}</span>}
      <span className="rail-right">{right}</span>
    </div>
  );
}

export function formatTransportStatus(
  transport: SnapshotTransportStatus | undefined,
  link: LinkState,
): string | null {
  if (!transport) return null;
  if (link === "disconnected") {
    const usb = transport.usb.enabled ? "USB OFF" : "USB —";
    const bluetooth = transport.bluetooth.enabled ? "BT OFF" : "BT —";
    return `${usb} · ${bluetooth}`;
  }
  const usb = !transport.usb.enabled
    ? "USB —"
    : transport.active === "usb"
      ? "USB ACTIVE"
      : transport.usb.connected
        ? "USB ON"
        : "USB OFF";
  const bluetooth = !transport.bluetooth.enabled
    ? "BT —"
    : transport.active === "bluetooth"
      ? "BT ACTIVE"
      : transport.bluetooth.standbyForUsb
        ? "BT STBY"
        : transport.bluetooth.connected
          ? "BT ON"
          : "BT OFF";
  return `${usb} · ${bluetooth}`;
}

export function StatePill({ state }: { state: ProviderState }) {
  return (
    <span className={`pill ${STATE_CLASS[state] ?? "state-offline"}`}>
      <span className="dot" />
      {STATE_WORD[state] ?? "—"}
    </span>
  );
}
