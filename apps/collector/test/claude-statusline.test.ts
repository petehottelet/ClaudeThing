import { describe, expect, it } from "vitest";
import { parseClaudeStatusline } from "../src/adapters/claude-statusline";

const OPTS = { host: "pc", nowMs: Date.parse("2026-08-08T12:00:00.000Z") };

describe("parseClaudeStatusline", () => {
  it("extracts used_percentage windows with epoch-seconds and ISO resets_at", () => {
    const result = parseClaudeStatusline(
      {
        model: { id: "claude-opus-4-1", display_name: "Opus" },
        rate_limits: {
          five_hour: { used_percentage: 42, resets_at: 1765200000 },
          seven_day: { used_percentage: 11.5, resets_at: "2026-08-10T00:00:00Z" },
        },
      },
      OPTS,
    );
    expect(result.id).toBe("claude");
    expect(result.source).toBe("statusline");
    expect(result.state).toBe("live");
    const five = result.quotaWindows.find((w) => w.id === "five_hour");
    const seven = result.quotaWindows.find((w) => w.id === "seven_day");
    expect(five?.usedPercent).toBe(42);
    expect(five?.resetsAt).toBe(new Date(1765200000 * 1000).toISOString());
    expect(five?.windowSeconds).toBe(5 * 3600);
    expect(seven?.usedPercent).toBe(11.5);
    expect(seven?.resetsAt).toBe("2026-08-10T00:00:00.000Z");
  });

  it("accepts the utilization spelling", () => {
    const result = parseClaudeStatusline(
      { rate_limits: { five_hour: { utilization: 88 }, seven_day: { utilization: 31 } } },
      OPTS,
    );
    expect(result.quotaWindows.find((w) => w.id === "five_hour")?.usedPercent).toBe(88);
    expect(result.quotaWindows.find((w) => w.id === "seven_day")?.usedPercent).toBe(31);
  });

  it("flags missing rate_limits without throwing", () => {
    const result = parseClaudeStatusline({ model: { display_name: "Opus" } }, OPTS);
    expect(result.diagnostic).toContain("RATE_LIMITS_MISSING");
    expect(result.quotaWindows).toEqual([]);
  });

  it("survives garbage input of every shape", () => {
    for (const garbage of [null, undefined, 42, "junk", [], { rate_limits: "nope" }, { rate_limits: { five_hour: "x" } }, { rate_limits: { five_hour: { used_percentage: "wat", resets_at: {} } } }]) {
      const result = parseClaudeStatusline(garbage, OPTS);
      expect(result.id).toBe("claude");
      expect(Array.isArray(result.quotaWindows)).toBe(true);
    }
  });

  it("clamps out-of-range percentages with a diagnostic", () => {
    const result = parseClaudeStatusline(
      { rate_limits: { five_hour: { used_percentage: 250 } } },
      OPTS,
    );
    expect(result.quotaWindows[0]?.usedPercent).toBe(100);
    expect(result.diagnostic).toContain("percent_above_range");
  });

  it("extracts per-response token counts and cost totals", () => {
    const result = parseClaudeStatusline(
      {
        rate_limits: { five_hour: { used_percentage: 10 } },
        usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 3 },
        cost: { total_cost_usd: 1.25 },
      },
      OPTS,
    );
    expect(result.tokens).toMatchObject({ input: 10, cachedInput: 7, output: 3, total: 20, period: "response" });
    expect(result.cost).toMatchObject({ amountUsd: 1.25, isEstimate: true });
  });

  it("reads the current official context_window.current_usage token shape", () => {
    const result = parseClaudeStatusline(
      {
        rate_limits: { five_hour: { used_percentage: 10 } },
        context_window: {
          used_percentage: 8,
          current_usage: {
            input_tokens: 8500,
            output_tokens: 1200,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 2000,
          },
        },
      },
      OPTS,
    );
    expect(result.tokens).toEqual({
      input: 8500,
      cachedInput: 7000,
      reasoning: null,
      output: 1200,
      total: 16_700,
      period: "response",
      periodStart: null,
    });
  });

  it("extracts context window usage when present", () => {
    const result = parseClaudeStatusline(
      { rate_limits: {}, context_window: { used_percentage: 61 } },
      OPTS,
    );
    const context = result.quotaWindows.find((w) => w.id === "context");
    expect(context?.usedPercent).toBe(61);
  });

  it("never retains prompts, transcript paths, cwd, or command text", () => {
    const result = parseClaudeStatusline(
      {
        rate_limits: { five_hour: { used_percentage: 42 } },
        transcript_path: "C:\\SECRET-DIR\\transcript.jsonl",
        cwd: "C:\\SECRET-DIR\\project",
        workspace: { current_dir: "C:\\SECRET-DIR" },
        session_id: "SECRET-SESSION",
        command: "SECRET-COMMAND",
      },
      OPTS,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET");
  });
});
