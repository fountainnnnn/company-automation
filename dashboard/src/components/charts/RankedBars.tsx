export interface BarItem {
  key: string;
  label: string;
  title: string;
  value: number;
}

interface Props {
  items: BarItem[];
  /** Rows shown before the tail is folded into one "Other" row. */
  maxRows?: number;
  format?: (value: number) => string;
  label: string;
  emptyTitle: string;
  emptyHint: string;
}

/** Magnitude bars: one hue (series 1), direct-labeled, ranked desc. */
export function RankedBars({
  items,
  maxRows = 6,
  format = (v) => String(v),
  label,
  emptyTitle,
  emptyHint,
}: Props) {
  const ranked = [...items].sort((a, b) => b.value - a.value).filter((i) => i.value > 0);

  if (ranked.length === 0) {
    return (
      <div className="chart-empty">
        <p className="title">{emptyTitle}</p>
        <p className="hint">{emptyHint}</p>
      </div>
    );
  }

  // Folding only pays when it hides a real tail. Rolling two rows into an
  // "Other" that outranks every named bar misreads as "Other is the leader".
  const foldable = ranked.length - (maxRows - 1);
  const rows =
    foldable >= 3
      ? [
          ...ranked.slice(0, maxRows - 1),
          {
            key: "__other",
            label: "Other",
            title: `${foldable} more`,
            value: ranked.slice(maxRows - 1).reduce((sum, i) => sum + i.value, 0),
          },
        ]
      : ranked;

  // "Other" is an aggregate, not a competitor — scale the bars to the largest
  // named row and mark it neutral so it never reads as the top performer.
  const named = rows.filter((r) => r.key !== "__other");
  const max = Math.max(...named.map((r) => r.value), 1);

  return (
    <ul className="bar-list" aria-label={label}>
      {rows.map((r) => {
        const other = r.key === "__other";
        return (
          <li key={r.key} className={`bar-row${other ? " is-other" : ""}`}>
            <span className="bar-label truncate" title={r.title}>
              {r.label}
              {other && <span className="bar-sub"> · {r.title}</span>}
            </span>
            <span className="bar-track" aria-hidden="true">
              <span
                className="bar-fill"
                style={{ width: `${Math.min(100, (r.value / max) * 100)}%` }}
              />
            </span>
            <span className="bar-value tnum">{format(r.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}
