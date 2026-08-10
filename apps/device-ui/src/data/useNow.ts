import { useEffect, useState } from "react";

/**
 * Ticking clock. `skewMs` is (collector serverTime − local receive time);
 * adding it lets countdowns follow the collector's clock, not the device's.
 */
export function useNow(skewMs: number, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() + skewMs);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + skewMs), intervalMs);
    setNow(Date.now() + skewMs);
    return () => window.clearInterval(id);
  }, [skewMs, intervalMs]);
  return now;
}
