import { ProductMark } from "../components/ProviderGlyph";
import type { PairingState } from "../data/useSnapshotSource";

export function FirstConnect({
  endpoints,
  pairing,
}: {
  endpoints: string[];
  pairing: PairingState;
}) {
  const missing = pairing === "missing";
  const rejected = pairing === "rejected";
  return (
    <div className="screen">
      <div className="msg-screen">
        <div className="msg-glyph">
          <ProductMark size={76} />
        </div>
        <div className="msg-title">
          {missing ? "Pair this display" : rejected ? "Pairing was rejected" : "Waiting for a collector…"}
        </div>
        <div className="msg-body">
          {missing
            ? "Open the one-time pairing link from the installation guide. The secret is stored locally and removed from the address immediately."
            : rejected
              ? "The collector did not accept this display’s saved token. Pair it again with the token file used by the collector."
              : "No usage data has been received yet. Check that a collector is running at " +
                (endpoints.join(", ") || "a configured endpoint") +
                "."}{" "}
          Long-press preset 4 for system status.
        </div>
      </div>
    </div>
  );
}

export function AdsStub() {
  return (
    <div className="screen">
      <div className="msg-screen">
        <div className="msg-title">Ads</div>
        <div className="msg-body">
          This preset is reserved for the Ads dashboard module. It is not installed yet.
        </div>
      </div>
    </div>
  );
}
