import type { ProviderState, SnapshotTransportStatus } from "@carthing/contracts";
import type { LinkState } from "../data/useSnapshotSource";

interface StatusRailProps {
  state: ProviderState | "disconnected";
  detail: string;
  right: string;
  transport?: SnapshotTransportStatus;
  link: LinkState;
}

const STATE_WORD: Record<string, string> = {
  live: "LIVE",
  stale: "STALE",
  offline: "OFFLINE",
  unavailable: "NO DATA",
  error: "ERROR",
  disconnected: "OFFLINE",
};

const STATE_CLASS: Record<string, string> = {
  live: "state-live",
  stale: "state-stale",
  offline: "state-offline",
  unavailable: "state-offline",
  error: "state-error",
  disconnected: "state-offline",
};

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
  return (
    <div className={`rail ${STATE_CLASS[state] ?? "state-offline"}`}>
      <span className="dot" />
      <span className="rail-state">{STATE_WORD[state] ?? "—"}</span>
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
