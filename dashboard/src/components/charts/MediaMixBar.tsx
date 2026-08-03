import type { MediaMixRow } from "../../lib/types";

/** Fixed slice order and fixed hues — the mix never re-colours between loads. */
const SLICES: Array<{ type: MediaMixRow["media_type"]; label: string; color: string }> = [
  { type: "photo", label: "Photos", color: "var(--series-1)" },
  { type: "video", label: "Videos", color: "var(--series-2)" },
  { type: "document", label: "Documents", color: "var(--series-3)" },
];

export function MediaMixBar({ rows }: { rows: MediaMixRow[] }) {
  const counts = new Map(rows.map((r) => [r.media_type, Number(r.count)]));
  const parts = SLICES.map((s) => ({ ...s, value: counts.get(s.type) ?? 0 }));
  const total = parts.reduce((sum, p) => sum + p.value, 0);

  if (total === 0) {
    return (
      <div className="chart-empty">
        <p className="title">Nothing uploaded in this window</p>
        <p className="hint">Photos, videos and documents from site reports are counted here.</p>
      </div>
    );
  }

  return (
    <>
      <div className="mix-bar" aria-hidden="true">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.type}
              className="mix-seg"
              style={{ flexGrow: p.value, background: p.color }}
            />
          ))}
      </div>

      {/* only types actually present — a "Videos 0 · 0%" row is noise, and the
          colour it reserves never appears in the bar beside it */}
      <ul className="mix-legend" aria-label="Media mix">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <li key={p.type}>
              <span className="legend-swatch" style={{ background: p.color }} aria-hidden="true" />
              <span className="mix-name">{p.label}</span>
              <span className="mix-value tnum">
                {p.value} · {Math.round((p.value / total) * 100)}%
              </span>
            </li>
          ))}
      </ul>
    </>
  );
}
