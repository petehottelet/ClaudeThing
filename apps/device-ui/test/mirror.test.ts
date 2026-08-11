import { describe, expect, it } from "vitest";
import type { Snapshot } from "@carthing/contracts";
import { makeFixture } from "@carthing/contracts/fixtures";
import { isFreshMirror } from "../src/data/useSnapshotSource";

describe("USB snapshot mirror freshness", () => {
  it("accepts advancing local snapshots and rejects an abandoned file", () => {
    const now = Date.parse("2026-08-11T18:00:00Z");
    const fresh: Snapshot = {
      ...makeFixture("normal", now),
      serverTime: new Date(now - 30_000).toISOString(),
    };
    const old: Snapshot = {
      ...fresh,
      serverTime: new Date(now - 91_000).toISOString(),
    };
    expect(isFreshMirror(fresh, now)).toBe(true);
    expect(isFreshMirror(old, now)).toBe(false);
  });
});
