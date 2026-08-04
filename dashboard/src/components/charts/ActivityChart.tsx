import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { formatDay, formatDayShort } from "../../lib/format";
import { useElementWidth } from "../../lib/useElementWidth";
import type { DayVolumeRow } from "../../lib/types";

const HEIGHT = 260;
const PAD = { top: 14, right: 14, bottom: 26, left: 42 };
/** Fixed series order — hues are identity here, never rank. */
const REPORTS = "var(--series-1)";
const MEDIA = "var(--series-2)";

/** 3–4 round ticks covering `max`, so the axis reads without decoding. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

export function ActivityChart({ data }: { data: DayVolumeRow[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const [active, setActive] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="chart-empty">
        <p className="title">No activity in this window</p>
        <p className="hint">Reports sent from Telegram appear here the same day.</p>
      </div>
    );
  }

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const n = data.length;

  const peak = Math.max(1, ...data.map((d) => Math.max(d.reports, d.media)));
  const ticks = niceTicks(peak);
  const yMax = ticks[ticks.length - 1];

  const x = (i: number) => (n === 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;

  const line = (key: "reports" | "media") =>
    data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const area = (key: "reports" | "media") =>
    `${line(key)} L${x(n - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(
      PAD.top + innerH
    ).toFixed(1)} Z`;

  // Thin labels out by available width — never let two dates collide.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 74))));

  function pick(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = n === 1 ? 0 : Math.round(((px - PAD.left) / innerW) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    setActive((prev) => Math.min(n - 1, Math.max(0, (prev ?? 0) + step)));
  }

  const point = active === null ? null : data[active];
  const tipX = active === null ? 0 : Math.min(Math.max(x(active), 78), Math.max(78, width - 78));

  return (
    <>
      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: REPORTS }} aria-hidden="true" />
          Reports
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: MEDIA }} aria-hidden="true" />
          Photos &amp; files
        </span>
      </div>

      <div
        className="chart-frame"
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label="Reports and media per day. Use the left and right arrow keys to read each day."
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
        >
          <title>Reports and media per day over the selected window</title>

          {ticks.map((t) => (
            <g key={t}>
              <line
                className="grid-line"
                x1={PAD.left}
                x2={PAD.left + innerW}
                y1={y(t)}
                y2={y(t)}
              />
              <text className="axis-label" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}

          {data.map((d, i) =>
            i % every === 0 ? (
              <text
                key={d.day}
                className="axis-label"
                x={x(i)}
                y={HEIGHT - 8}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              >
                {formatDayShort(d.day)}
              </text>
            ) : null,
          )}

          {n > 1 && (
            <>
              {/* Media always sits above reports, so two translucent fills would
                  stack into a muddy third colour. Only the headline series is
                  filled; media reads as a clean line above it. */}
              <path className="chart-area" d={area("reports")} style={{ fill: REPORTS }} />
              <path className="chart-line" d={line("media")} style={{ stroke: MEDIA }} pathLength={1} />
              <path className="chart-line" d={line("reports")} style={{ stroke: REPORTS }} pathLength={1} />
            </>
          )}

          {n === 1 && (
            <>
              <circle cx={x(0)} cy={y(data[0].media)} r={5} style={{ fill: MEDIA }} />
              <circle cx={x(0)} cy={y(data[0].reports)} r={5} style={{ fill: REPORTS }} />
            </>
          )}

          {point && (
            <g>
              <line
                className="crosshair"
                x1={x(active as number)}
                x2={x(active as number)}
                y1={PAD.top}
                y2={PAD.top + innerH}
              />
              <circle className="marker" cx={x(active as number)} cy={y(point.media)} r={5} style={{ fill: MEDIA }} />
              <circle
                className="marker"
                cx={x(active as number)}
                cy={y(point.reports)}
                r={5}
                style={{ fill: REPORTS }}
              />
            </g>
          )}
        </svg>

        {point && (
          <div className="chart-tip" style={{ left: tipX }}>
            <p className="tip-day">{formatDay(point.day)}</p>
            <p className="tip-row tnum">
              <span className="legend-swatch" style={{ background: REPORTS }} aria-hidden="true" />
              {point.reports} reports
            </p>
            <p className="tip-row tnum">
              <span className="legend-swatch" style={{ background: MEDIA }} aria-hidden="true" />
              {point.media} files
            </p>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Reports and media per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Reports</th>
            <th scope="col">Photos and files</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <th scope="row">{formatDay(d.day)}</th>
              <td>{d.reports}</td>
              <td>{d.media}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
