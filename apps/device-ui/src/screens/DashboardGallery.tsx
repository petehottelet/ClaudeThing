import type { ReactNode } from "react";

export type DashboardPage = "usage-trend" | "youtube" | "ga4" | "markets";

interface DashboardGalleryProps {
  focusedIndex: number;
  onOpen: (page: DashboardPage) => void;
}

/**
 * Tile icon rendered as an inline Google Material Symbols path (Apache
 * License 2.0 — see THIRD_PARTY_NOTICES.md). Inlined because the kiosk is
 * offline and the device font set has no coverage for pictographic
 * codepoints — glyph-font icons render as tofu boxes there.
 */
function MaterialIcon({ d, size = 34 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 -960 960 960" width={size} height={size} aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

// Material Symbols (outlined, 24px): bar_chart, smart_display, monitoring, trending_up.
const ICON_BAR_CHART = "M640-160v-280h160v280H640Zm-240 0v-640h160v640H400Zm-240 0v-440h160v440H160Z";
const ICON_SMART_DISPLAY =
  "m380-300 280-180-280-180v360ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm0 0v-480 480Z";
const ICON_MONITORING =
  "M120-120v-80l80-80v160h-80Zm160 0v-240l80-80v320h-80Zm160 0v-320l80 81v239h-80Zm160 0v-239l80-80v319h-80Zm160 0v-400l80-80v480h-80ZM120-327v-113l280-280 160 160 280-280v113L560-447 400-607 120-327Z";
const ICON_TRENDING_UP =
  "m136-240-56-56 296-298 160 160 208-206H640v-80h240v240h-80v-104L536-320 376-480 136-240Z";

const MODULES: { id: DashboardPage; eyebrow: string; title: string; detail: string; icon: ReactNode }[] = [
  { id: "usage-trend", eyebrow: "7 DAYS", title: "Usage", detail: "Daily AI volume", icon: <MaterialIcon d={ICON_BAR_CHART} /> },
  { id: "youtube", eyebrow: "CHANNEL", title: "YouTube", detail: "Views by day", icon: <MaterialIcon d={ICON_SMART_DISPLAY} /> },
  { id: "ga4", eyebrow: "GA4", title: "Analytics", detail: "Users by day", icon: <MaterialIcon d={ICON_MONITORING} /> },
  { id: "markets", eyebrow: "MARKETS", title: "Stocks", detail: "Equities & indexes", icon: <MaterialIcon d={ICON_TRENDING_UP} /> },
];

export function DashboardGallery({ focusedIndex, onOpen }: DashboardGalleryProps) {
  return (
    <div className="screen">
      <div className="hdr">
        <div>
          <div className="hdr-kicker">DASHBOARDS</div>
          <div className="hdr-title">Choose a view</div>
        </div>
        <div className="hdr-spacer" />
        <div className="hdr-hint">Turn dial · press to open</div>
      </div>
      <div className="gallery-grid">
        {MODULES.map((module, index) => (
          <button
            type="button"
            key={module.id}
            className={index === focusedIndex ? `gallery-card gallery-${module.id} is-focused` : `gallery-card gallery-${module.id}`}
            onClick={() => onOpen(module.id)}
          >
            <span className="gallery-icon">{module.icon}</span>
            <span className="gallery-eyebrow">{module.eyebrow}</span>
            <span className="gallery-title">{module.title}</span>
            <span className="gallery-detail">{module.detail}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
