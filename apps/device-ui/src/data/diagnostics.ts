/**
 * Diagnostic codes are wire-safe enums (possibly comma-joined by the merge);
 * glance surfaces show short human labels. Raw codes stay on the System screen.
 */
const LABELS: Record<string, string> = {
  APP_SERVER_UNREACHABLE: "Server unreachable",
  RATE_LIMITS_MISSING: "No quota reported",
  STATUSLINE_UNPARSEABLE: "Bad status-line data",
  CLOCK_SKEW: "Host clocks disagree",
  TOKENS_PARTIAL: "Partial token totals",
  PEER_UNREACHABLE: "Other machine unreachable",
  CLAUDE_AUTH_EXPIRED: "Claude login expired",
  CLAUDE_USAGE_UNAVAILABLE: "Usage API unreachable",
};

function humanizeOne(code: string): string {
  const known = LABELS[code];
  if (known) return known;
  const words = code.toLowerCase().split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function humanizeDiagnostic(code: string | null): string | null {
  if (!code) return null;
  return code
    .split(",")
    .filter(Boolean)
    .map(humanizeOne)
    .join(" · ");
}
