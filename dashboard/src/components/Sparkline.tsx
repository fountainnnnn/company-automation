const W = 60;
const H = 28;

interface Props {
  /** Real series only — never padded or invented to fill the box. */
  values: number[];
  color?: string;
  title?: string;
}

/** 60×28 trend line: no axes, no labels, one series, purely supporting. */
export function Sparkline({ values, color = "var(--series-1)", title }: Props) {
  if (values.length < 2) return null;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (W - 2) + 1;
      const y = H - 2 - ((v - min) / span) * (H - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

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
      <path d={d} style={{ stroke: color }} pathLength={1} />
    </svg>
  );
}
