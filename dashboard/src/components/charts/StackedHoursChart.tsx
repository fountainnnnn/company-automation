import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { formatDay, formatDayShort, formatHours } from "../../lib/format";
import { useElementWidth } from "../../lib/useElementWidth";
import type { OtDayRow } from "../../lib/types";
import { niceTicks } from "./ActivityChart";

const HEIGHT = 184;
const PAD = { top: 8, right: 8, bottom: 30, left: 34 };
const NORMAL = "var(--series-1)";
const OT = "var(--series-2)";

type WeeklyHours = {
  start: string;
  end: string;
  normal_hours: number;
  ot_hours: number;
};

/** Compact weekly totals keep the dashboard legible without hiding hours. */
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

  const buckets: WeeklyHours[] = [];
  for (let end = data.length; end > 0; end -= 7) {
    const rows = data.slice(Math.max(0, end - 7), end);
    buckets.unshift({
      start: rows[0].day,
      end: rows[rows.length - 1].day,
      normal_hours: rows.reduce((sum, row) => sum + row.normal_hours, 0),
      ot_hours: rows.reduce((sum, row) => sum + row.ot_hours, 0),
    });
  }

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const n = buckets.length;
  const peak = Math.max(1, ...buckets.map((d) => d.normal_hours + d.ot_hours));
  const rawTicks = niceTicks(peak);
  const middleTick = Math.floor((rawTicks.length - 1) / 2);
  const ticks = rawTicks.filter(
    (_, index) => index === 0 || index === middleTick || index === rawTicks.length - 1,
  );
  const yMax = rawTicks[rawTicks.length - 1];
  const band = innerW / n;
  const colW = Math.max(12, Math.min(band * 0.42, 34));
  const cx = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
  const h = (v: number) => (v / yMax) * innerH;

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

  const point = active === null ? null : buckets[active];
  const tipX = active === null ? 0 : Math.min(Math.max(cx(active), 84), Math.max(84, width - 84));

  return (
    <>
      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: NORMAL }} aria-hidden="true" />
          Normal
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
        aria-label="Normal and overtime hours by week. Use the left and right arrow keys to read each period."
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
          <title>Normal and overtime hours by week over the selected window</title>

          {ticks.map((tick) => (
            <g key={tick}>
              <line className="grid-line" x1={PAD.left} x2={PAD.left + innerW} y1={y(tick)} y2={y(tick)} />
              <text className="axis-label" x={PAD.left - 7} y={y(tick) + 3} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}

          {buckets.map((bucket, index) => (
            <text
              key={bucket.end}
              className="axis-label"
              x={cx(index)}
              y={HEIGHT - 8}
              textAnchor="middle"
            >
              {formatDayShort(bucket.end)}
            </text>
          ))}

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
            {buckets.map((bucket, index) => (
              <g key={bucket.end}>
                <rect
                  x={cx(index) - colW / 2}
                  y={y(bucket.normal_hours)}
                  width={colW}
                  height={Math.max(0, h(bucket.normal_hours))}
                  fill={NORMAL}
                  rx="3"
                />
                <rect
                  x={cx(index) - colW / 2}
                  y={y(bucket.normal_hours + bucket.ot_hours)}
                  width={colW}
                  height={Math.max(0, h(bucket.ot_hours))}
                  fill={OT}
                  rx="3"
                />
              </g>
            ))}
          </g>
        </svg>

        {point && (
          <div className="chart-tip" style={{ left: tipX }}>
            <p className="tip-day">{formatDayShort(point.start)} to {formatDayShort(point.end)}</p>
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
        <caption>Normal and overtime hours by weekly period</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Normal hours</th>
            <th scope="col">Overtime hours</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.end}>
              <th scope="row">{formatDay(bucket.start)} to {formatDay(bucket.end)}</th>
              <td>{formatHours(bucket.normal_hours)}</td>
              <td>{formatHours(bucket.ot_hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
