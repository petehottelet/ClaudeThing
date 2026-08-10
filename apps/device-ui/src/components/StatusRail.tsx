import type { ProviderState } from "@carthing/contracts";

interface StatusRailProps {
  state: ProviderState | "disconnected";
  detail: string;
  right: string;
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
export function StatusRail({ state, detail, right }: StatusRailProps) {
  const sparked = detail.startsWith("✳ ");
  return (
    <div className={`rail ${STATE_CLASS[state] ?? "state-offline"}`}>
      <span className="dot" />
      <span className="rail-state">{STATE_WORD[state] ?? "—"}</span>
      <span className="rail-detail">
        {sparked && <span className="spark">✳ </span>}
        {sparked ? detail.slice(2) : detail}
      </span>
      <span className="rail-right">{right}</span>
    </div>
  );
}

export function StatePill({ state }: { state: ProviderState }) {
  return (
    <span className={`pill ${STATE_CLASS[state] ?? "state-offline"}`}>
      <span className="dot" />
      {STATE_WORD[state] ?? "—"}
    </span>
  );
}
