import { describe, expect, it } from "vitest";
import {
  formatReconnectDetail,
  formatTransportStatus,
  railPresentation,
} from "../src/components/StatusRail";

describe("reconnecting status rail", () => {
  it("uses the refreshing treatment and requested label", () => {
    expect(railPresentation("reconnecting")).toEqual({
      className: "state-reconnecting",
      word: "Reconnecting",
      refreshing: true,
    });
  });

  it("keeps live status on the static-dot treatment", () => {
    expect(railPresentation("live")).toEqual({
      className: "state-live",
      word: "LIVE",
      refreshing: false,
    });
  });

  it("shows exact provider observation times instead of saying just now", () => {
    expect(
      formatReconnectDetail(
        [
          { displayName: "Claude", observedAt: "2026-08-11T22:17:18.964Z" },
          { displayName: "Codex", observedAt: "2026-08-11T22:19:20.452Z" },
        ],
        "UTC",
      ),
    ).toBe("Last data · Claude 22:17 · Codex 22:19");
  });

  it("uses an honest fallback before any provider has reported", () => {
    expect(formatReconnectDetail([], "UTC")).toBe("Waiting for fresh data");
  });
});

describe("transport status rail", () => {
  it("shows USB as active and Bluetooth as ready standby", () => {
    expect(
      formatTransportStatus(
        {
          active: "usb",
          usb: { enabled: true, connected: true },
          bluetooth: { enabled: true, connected: false, standbyForUsb: true },
        },
        "connected",
      ),
    ).toBe("USB ACTIVE · BT STBY");
  });

  it("shows Bluetooth as active after USB failover", () => {
    expect(
      formatTransportStatus(
        {
          active: "bluetooth",
          usb: { enabled: true, connected: false },
          bluetooth: { enabled: true, connected: true, standbyForUsb: false },
        },
        "connected",
      ),
    ).toBe("USB OFF · BT ACTIVE");
  });

  it("does not present the cached delivery path as live after link loss", () => {
    expect(
      formatTransportStatus(
        {
          active: "bluetooth",
          usb: { enabled: true, connected: false },
          bluetooth: { enabled: true, connected: true, standbyForUsb: false },
        },
        "disconnected",
      ),
    ).toBe("USB OFF · BT OFF");
  });

  it("keeps older snapshots compatible", () => {
    expect(formatTransportStatus(undefined, "connected")).toBeNull();
  });
});
