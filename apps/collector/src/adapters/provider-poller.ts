import { isProviderSnapshot, type ProviderSnapshot } from "@carthing/contracts";
import { readJsonFile, writeJsonAtomic } from "../util";

export class ProviderAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderAdapterError";
  }
}

export interface ProviderPollerOptions {
  id: string;
  displayName: string;
  host: string;
  source: string;
  intervalMs: number;
  fetchSnapshot: () => Promise<ProviderSnapshot>;
  onObservation: (snapshot: ProviderSnapshot) => void;
  /** Display-only last-good cache. It never contains provider credentials. */
  stateFile?: string;
}

/** Timeout-bounded provider refresh loop. It preserves the last complete
 * snapshot when a refresh fails and changes only its state/diagnostic, so a
 * transient network error never turns known usage into fabricated zeroes. */
export class ProviderPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;
  private lastGood: ProviderSnapshot | null = null;

  constructor(private readonly options: ProviderPollerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.restoreThenRefresh();
    this.timer = setInterval(() => void this.refresh(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  private async restoreThenRefresh(): Promise<void> {
    if (this.options.stateFile) {
      const restored = await readJsonFile<unknown>(this.options.stateFile);
      if (
        isProviderSnapshot(restored) &&
        restored.id === this.options.id &&
        restored.host === this.options.host &&
        restored.source === this.options.source
      ) {
        this.lastGood = restored;
        this.options.onObservation(restored);
      }
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = await this.options.fetchSnapshot();
      this.lastGood = snapshot;
      this.options.onObservation(snapshot);
      if (this.options.stateFile) {
        void writeJsonAtomic(this.options.stateFile, snapshot).catch(() => undefined);
      }
    } catch (error) {
      const code = error instanceof ProviderAdapterError ? error.code : `${this.options.id.toUpperCase()}_UNAVAILABLE`;
      const fallback: ProviderSnapshot = this.lastGood
        ? { ...this.lastGood, state: "error", diagnostic: code }
        : {
            id: this.options.id,
            displayName: this.options.displayName,
            state: "unavailable",
            observedAt: null,
            source: this.options.source,
            host: this.options.host,
            quotaWindows: [],
            tokens: null,
            cost: null,
            diagnostic: code,
          };
      this.options.onObservation(fallback);
    } finally {
      this.running = false;
    }
  }
}
