import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { formatDay, formatDayShort, formatHours } from "../../lib/format";
import { useElementWidth } from "../../lib/useElementWidth";
import type { OtDayRow } from "../../lib/types";
import { niceTicks } from "./ActivityChart";

const HEIGHT = 240;
const PAD = { top: 14, right: 14, bottom: 26, left: 44 };
/** Fixed series order — hues are identity here, never rank. */
const NORMAL = "var(--series-1)";
const OT = "var(--series-2)";

/**
 * Normal and overtime hours per day, stacked on one shared y-axis. Columns
 * rather than an area: OT is a daily quantity, and a filled curve would imply
 * hours flow between days.
 */
export function StackedHoursChart({ data }: { data: OtDayRow[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const [active, setActive] = useState<number | null>(null);

  const total = data.reduce((sum, d) => sum + d.normal_hours + d.ot_hours, 0);
  if (data.length === 0 || total === 0) {
    return (
      <div className="chart-empty">
        <p className="title">No hours in this window</p>
        <p className="hint">Overtime appears once shifts are checked out and priced.</p>
      </div>
    );
  }

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const n = data.length;

  const peak = Math.max(1, ...data.map((d) => d.normal_hours + d.ot_hours));
  const ticks = niceTicks(peak);
  const yMax = ticks[ticks.length - 1];

  const band = innerW / n;
  const colW = Math.max(2, Math.min(band - 2, 22));
  const cx = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
  const h = (v: number) => (v / yMax) * innerH;

  // Thin labels out by available width — never let two dates collide.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 74))));

  function pick(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - PAD.left) / band);
    setActive(Math.min(n - 1, Math.max(0, i)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    setActive((prev) => Math.min(n - 1, Math.max(0, (prev ?? 0) + step)));
  }

  const point = active === null ? null : data[active];
  const tipX = active === null ? 0 : Math.min(Math.max(cx(active), 84), Math.max(84, width - 84));

  return (
    <>
      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: NORMAL }} aria-hidden="true" />
          Normal hours
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: OT }} aria-hidden="true" />
          Overtime
        </span>
      </div>

      <div
        className="chart-frame"
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label="Normal and overtime hours per day. Use the left and right arrow keys to read each day."
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
          <title>Normal and overtime hours per day over the selected window</title>

          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={PAD.left} x2={PAD.left + innerW} y1={y(t)} y2={y(t)} />
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
                x={cx(i)}
                y={HEIGHT - 8}
                textAnchor={i === 0 ? "start" : i >= n - every ? "end" : "middle"}
              >
                {formatDayShort(d.day)}
              </text>
            ) : null,
          )}

          {active !== null && (
            <rect
              className="col-band"
              x={PAD.left + band * active}
              y={PAD.top}
              width={band}
              height={innerH}
            />
          )}

          <g className="col-rise">
            {data.map((d, i) => (
              <g key={d.day}>
                <rect
                  x={cx(i) - colW / 2}
                  y={y(d.normal_hours)}
                  width={colW}
                  height={Math.max(0, h(d.normal_hours))}
                  fill={NORMAL}
                />
                <rect
                  x={cx(i) - colW / 2}
                  y={y(d.normal_hours + d.ot_hours)}
                  width={colW}
                  height={Math.max(0, h(d.ot_hours))}
                  fill={OT}
                />
              </g>
            ))}
          </g>
        </svg>

        {point && (
          <div className="chart-tip" style={{ left: tipX }}>
            <p className="tip-day">{formatDay(point.day)}</p>
            <p className="tip-row tnum">
              <span className="legend-swatch" style={{ background: NORMAL }} aria-hidden="true" />
              {formatHours(point.normal_hours)}h normal
            </p>
            <p className="tip-row tnum">
              <span className="legend-swatch" style={{ background: OT }} aria-hidden="true" />
              {formatHours(point.ot_hours)}h overtime
            </p>
          </div>
        )}
      </div>

      <table className="sr-only">
        <caption>Normal and overtime hours per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Normal hours</th>
            <th scope="col">Overtime hours</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <th scope="row">{formatDay(d.day)}</th>
              <td>{formatHours(d.normal_hours)}</td>
              <td>{formatHours(d.ot_hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
