const W = 76;
const H = 28;
const GAP = 3;

interface Props {
  /** Real series only — never padded or invented to fill the box. */
  values: number[];
  color?: string;
  title?: string;
}

/**
 * A few bars, not a line.
 *
 * Daily site counts drop to zero every Sunday, so 30 raw points in 60px render
 * as a seismograph — motion with no readable trend. Callers bucket the series
 * (weekly) before it gets here; bars then survive the zeros honestly and stay
 * legible at this size, which a 30-point polyline never can.
 */
export function Sparkline({ values, color = "var(--series-1)", title }: Props) {
  if (values.length < 2) return null;

  const max = Math.max(...values, 1);
  const n = values.length;
  const barW = Math.max(2, (W - GAP * (n - 1)) / n);

  return (
    <svg
      className="spark"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title ?? "Trend"}
    >
      {title && <title>{title}</title>}
      {values.map((v, i) => {
        // a zero week still gets a 2px stub, so "nothing happened" is visible
        const h = Math.max(2, (v / max) * (H - 2));
        return (
          <rect
            key={i}
            x={i * (barW + GAP)}
            y={H - h}
            width={barW}
            height={h}
            rx={1.5}
            style={{ fill: color }}
            // the latest bucket is the point of the chart; older ones recede
            opacity={i === n - 1 ? 1 : 0.38}
          />
        );
      })}
    </svg>
  );
}
