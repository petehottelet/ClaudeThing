import { describe, expect, it } from "vitest";
import { formatTransportStatus } from "../src/components/StatusRail";

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
