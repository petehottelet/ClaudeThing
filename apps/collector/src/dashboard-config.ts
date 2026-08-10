/**
 * Hot-reloaded, non-secret dashboard configuration.
 *
 * The file is JSON with comments (JSONC) so people can enable optional rows
 * by uncommenting them. Invalid edits never replace the last valid config.
 */

import { readFile } from "node:fs/promises";
import {
  DEFAULT_DASHBOARD_CONFIG,
  isDashboardConfig,
  type DashboardConfig,
} from "@carthing/contracts";

function cloneDefault(): DashboardConfig {
  return JSON.parse(JSON.stringify(DEFAULT_DASHBOARD_CONFIG)) as DashboardConfig;
}

/** Remove JavaScript-style comments while preserving comment-like text inside
 * quoted JSON strings. This is intentionally only a JSONC lexer, not eval. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    const next = input[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        out += char;
      } else {
        out += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        out += "  ";
        index++;
        blockComment = false;
      } else {
        out += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      out += "  ";
      index++;
      lineComment = true;
    } else if (char === "/" && next === "*") {
      out += "  ";
      index++;
      blockComment = true;
    } else {
      out += char;
    }
  }
  if (inString || blockComment) throw new Error("DASHBOARD_CONFIG_INVALID");
  return out;
}

function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] ?? "")) lookahead++;
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        out += " ";
        continue;
      }
    }
    out += char;
  }
  return out;
}

function trimmedText(value: string): string {
  return value.trim();
}

export function parseDashboardConfig(text: string): DashboardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
  } catch {
    throw new Error("DASHBOARD_CONFIG_INVALID");
  }
  if (!isDashboardConfig(raw)) throw new Error("DASHBOARD_CONFIG_INVALID");
  const config: DashboardConfig = {
    ...raw,
    providers: raw.providers.map((provider) => ({
      ...provider,
      id: trimmedText(provider.id).toLowerCase(),
      show: [...provider.show],
    })),
    youtube: {
      channelName: trimmedText(raw.youtube.channelName),
      channelHandle: trimmedText(raw.youtube.channelHandle),
    },
    ga4: {
      propertyName: trimmedText(raw.ga4.propertyName),
      propertyId: trimmedText(raw.ga4.propertyId),
    },
    markets: {
      rotationSeconds: raw.markets.rotationSeconds,
      instruments: raw.markets.instruments.map((instrument) => ({
        ...instrument,
        symbol: trimmedText(instrument.symbol),
        name: trimmedText(instrument.name),
      })),
    },
  };
  if (!isDashboardConfig(config)) throw new Error("DASHBOARD_CONFIG_INVALID");
  if (new Set(config.providers.map((provider) => provider.id)).size !== config.providers.length) {
    throw new Error("DASHBOARD_CONFIG_DUPLICATE_PROVIDER");
  }
  const symbols = config.markets.instruments.map((instrument) => instrument.symbol.toUpperCase());
  if (new Set(symbols).size !== symbols.length) {
    throw new Error("DASHBOARD_CONFIG_DUPLICATE_MARKET");
  }
  return config;
}

export class DashboardConfigStore {
  private config = cloneDefault();
  private lastText: string | null = null;
  private diagnostic: string | null = null;

  constructor(private readonly file: string) {}

  current(): DashboardConfig {
    return this.config;
  }

  warning(): string | null {
    return this.diagnostic;
  }

  /** Returns true when either the accepted config or warning state changed. */
  async refresh(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      const changed = this.diagnostic !== "DASHBOARD_CONFIG_MISSING";
      this.diagnostic = "DASHBOARD_CONFIG_MISSING";
      return changed;
    }
    if (text === this.lastText && this.diagnostic === null) return false;
    try {
      const next = parseDashboardConfig(text);
      const changed = JSON.stringify(next) !== JSON.stringify(this.config) || this.diagnostic !== null;
      this.config = next;
      this.lastText = text;
      this.diagnostic = null;
      return changed;
    } catch (error) {
      const code = error instanceof Error ? error.message : "DASHBOARD_CONFIG_INVALID";
      const changed = this.diagnostic !== code;
      this.lastText = text;
      this.diagnostic = code;
      return changed;
    }
  }
}
