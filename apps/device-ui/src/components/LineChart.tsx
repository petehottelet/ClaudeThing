import type { ChartPoint } from "../data/showcase";

export interface ChartGeometry {
  linePath: string;
  areaPath: string;
  dots: { x: number; y: number }[];
  min: number;
  max: number;
}

// Match the plot box's rendered proportions on the 800x480 stage (~525x335).
// The svg stretches to fill via preserveAspectRatio="none"; with the viewBox
// aspect equal to the rendered aspect the stretch is 1:1, so circles stay
// round and glyphs undistorted. Mismatched aspect showed up on-device as
// vertically-elongated dots.
const WIDTH = 525;
const HEIGHT = 335;
const LEFT = 19;
const RIGHT = 19;
const TOP = 24;
const BOTTOM = 46;

/** Pure geometry kept separate so old kiosk rendering can be tested in Node. */
export function chartGeometry(series: ChartPoint[]): ChartGeometry {
  const values = series.length > 0 ? series.map((point) => point.value) : [0];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(1, rawMax - rawMin);
  const min = rawMin - span * 0.15;
  const max = rawMax + span * 0.15;
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const dots = series.map((point, index) => ({
    x: LEFT + (series.length <= 1 ? plotWidth / 2 : (index / (series.length - 1)) * plotWidth),
    y: TOP + ((max - point.value) / (max - min)) * plotHeight,
  }));
  const linePath = dots.map((dot, index) => `${index === 0 ? "M" : "L"}${dot.x.toFixed(2)},${dot.y.toFixed(2)}`).join(" ");
  const floor = HEIGHT - BOTTOM;
  const areaPath = dots.length > 0
    ? `${linePath} L${dots[dots.length - 1]!.x.toFixed(2)},${floor} L${dots[0]!.x.toFixed(2)},${floor} Z`
    : "";
  return { linePath, areaPath, dots, min, max };
}

interface LineChartProps {
  points: ChartPoint[];
  color: string;
  formatValue: (value: number) => string;
  ariaLabel: string;
}

export function LineChart({ points, color, formatValue, ariaLabel }: LineChartProps) {
  const geometry = chartGeometry(points);
  const last = points[points.length - 1];
  const lastDot = geometry.dots[geometry.dots.length - 1];
  return (
    <div className="line-chart" role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="chart-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.38" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
          <filter id="chart-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {[0.2, 0.5, 0.8].map((ratio) => (
          <line
            key={ratio}
            x1={LEFT}
            x2={WIDTH - RIGHT}
            y1={TOP + ratio * (HEIGHT - TOP - BOTTOM)}
            y2={TOP + ratio * (HEIGHT - TOP - BOTTOM)}
            className="chart-gridline"
          />
        ))}
        <path d={geometry.areaPath} fill="url(#chart-area)" />
        <path d={geometry.linePath} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" filter="url(#chart-glow)" />
        {geometry.dots.map((dot, index) => (
          <circle
            key={points[index]?.label ?? index}
            cx={dot.x}
            cy={dot.y}
            r={index === geometry.dots.length - 1 ? 6 : 3.5}
            fill={index === geometry.dots.length - 1 ? color : "var(--panel-2)"}
            stroke={color}
            strokeWidth="2.5"
          />
        ))}
        {last && lastDot && (
          <text x={Math.min(lastDot.x, WIDTH - 54)} y={Math.max(15, lastDot.y - 13)} className="chart-last-value">
            {formatValue(last.value)}
          </text>
        )}
        {points.map((point, index) =>
          point.label === "" ? null : (
            <text key={`${point.label}-${index}`} x={geometry.dots[index]?.x ?? 0} y={HEIGHT - 12} className="chart-day">
              {point.label}
            </text>
          ),
        )}
      </svg>
    </div>
  );
}
