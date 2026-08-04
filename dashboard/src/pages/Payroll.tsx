import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  formatDay,
  formatDayShort,
  formatHours,
  formatMoney,
  formatTime,
  toDateInput,
} from "../lib/format";
import { fetchPayrollSummary, fetchWorkerShifts, toPayrollCsv } from "../lib/payroll";
import { downloadCsv } from "../lib/timesheets";
import type { AttendancePayRow, PayrollRow } from "../lib/types";
import { Banknote, Clock, Timer, Users } from "lucide-react";
import { SectionHeader } from "../components/SectionHeader";
import { StatCard } from "../components/StatCard";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonList } from "../components/Skeleton";
import { StatusChip } from "../components/StatusChip";
import { useToast } from "../components/Toast";

const PAY_ICONS = {
  gross: <Banknote size={20} strokeWidth={1.75} aria-hidden="true" />,
  hours: <Clock size={20} strokeWidth={1.75} aria-hidden="true" />,
  ot: <Timer size={20} strokeWidth={1.75} aria-hidden="true" />,
  workers: <Users size={20} strokeWidth={1.75} aria-hidden="true" />,
};

/** The fixed start every shift is priced from, spelled out wherever pay is shown. */
const POLICY_NOTE =
  "Pay runs from 08:00 to check-out. Actual check-in is shown for reference only.";

function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** First and last calendar day of a yyyy-MM month. */
function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return { from: `${month}-01`, to: `${month}-28` };
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type SortKey = "name" | "gross";

interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

/** A worker with no rate has no money value at all — never a zero. */
function isPriced(row: PayrollRow): boolean {
  return row.hourly_rate !== null;
}

export function PayrollPage() {
  const toast = useToast();

  const thisMonth = monthOf(toDateInput(new Date()));
  const initial = monthBounds(thisMonth);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  const [rows, setRows] = useState<PayrollRow[] | null>(null);
  const [sort, setSort] = useState<Sort>({ key: "gross", dir: "desc" });
  const [detail, setDetail] = useState<PayrollRow | null>(null);

  const valid = from !== "" && to !== "" && from <= to;

  const load = useCallback(async () => {
    if (!valid) return;
    setRows(null);
    try {
      setRows(await fetchPayrollSummary(from, to));
    } catch (e) {
      setRows([]);
      toast.error(e instanceof Error ? e.message : "Could not load payroll.");
    }
  }, [from, to, valid, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  function setMonth(month: string) {
    if (!month) return;
    const b = monthBounds(month);
    setFrom(b.from);
    setTo(b.to);
  }

  const totals = useMemo(() => {
    const list = rows ?? [];
    const priced = list.filter(isPriced);
    return {
      gross: priced.reduce((n, r) => n + r.gross_pay, 0),
      paidHours: list.reduce((n, r) => n + r.paid_hours, 0),
      otHours: list.reduce((n, r) => n + r.ot_hours, 0),
      paidWorkers: priced.filter((r) => r.gross_pay > 0).length,
      unpriced: list.length - priced.length,
      unresolved: list.reduce((n, r) => n + r.missing_checkout, 0),
    };
  }, [rows]);

  const sorted = useMemo(() => {
    const list = [...(rows ?? [])];
    const sign = sort.dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (sort.key === "name") return sign * a.worker_name.localeCompare(b.worker_name);
      // Unpriced rows carry no money, so they sit below everyone with a rate.
      const av = isPriced(a) ? a.gross_pay : -1;
      const bv = isPriced(b) ? b.gross_pay : -1;
      return av === bv ? a.worker_name.localeCompare(b.worker_name) : sign * (av - bv);
    });
    return list;
  }, [rows, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );
  }

  function ariaSort(key: SortKey): "ascending" | "descending" | "none" {
    if (sort.key !== key) return "none";
    return sort.dir === "asc" ? "ascending" : "descending";
  }

  function exportCsv() {
    if (sorted.length === 0) {
      toast.error("Nothing to export for this period.");
      return;
    }
    downloadCsv(`payroll-${from}_${to}.csv`, toPayrollCsv(sorted));
    toast.success(`Exported ${sorted.length} rows.`);
  }

  const lastMonth = shiftMonth(thisMonth, -1);
  const currentMonth = monthOf(from);

  return (
    <div className="reveal">
      <SectionHeader
        title="Payroll"
        subtitle={valid ? `${formatDay(from)} – ${formatDay(to)}` : "Pick a valid date range"}
        actions={
          <Button variant="secondary" disabled={!rows || rows.length === 0} onClick={exportCsv}>
            Export CSV
          </Button>
        }
      />

      <div className="toolbar">
        <div className="field">
          <label htmlFor="pay-month">Month</label>
          <input
            id="pay-month"
            className="input tnum"
            type="month"
            value={currentMonth}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pay-from">From</label>
          <input
            id="pay-from"
            className="input"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pay-to">To</label>
          <input
            id="pay-to"
            className="input"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="toolbar-actions">
          <div className="range-control" role="group" aria-label="Quick period">
            <button
              type="button"
              className={`range-btn${currentMonth === thisMonth ? " active" : ""}`}
              aria-pressed={currentMonth === thisMonth}
              onClick={() => setMonth(thisMonth)}
            >
              This month
            </button>
            <button
              type="button"
              className={`range-btn${currentMonth === lastMonth ? " active" : ""}`}
              aria-pressed={currentMonth === lastMonth}
              onClick={() => setMonth(lastMonth)}
            >
              Last month
            </button>
          </div>
        </div>
      </div>

      {rows === null ? (
        <div className="stat-row" aria-busy="true" aria-label="Loading totals">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="panel panel-p stack-tight">
              <Skeleton height={12} width="52%" />
              <Skeleton height={30} width="40%" />
              <Skeleton height={12} width="66%" />
            </div>
          ))}
        </div>
      ) : (
        <div className="stat-row">
          <StatCard
            label="Gross pay"
            value={formatMoney(totals.gross)}
            sub={
              totals.unpriced > 0
                ? `${totals.unpriced} worker${totals.unpriced === 1 ? "" : "s"} excluded — no rate set`
                : "every worker in this period has a rate"
            }
            tone={totals.unpriced > 0 ? "warn" : "blue"}
            icon={PAY_ICONS.gross}
          />
          <StatCard
            label="Paid hours"
            value={formatHours(totals.paidHours)}
            sub="from 08:00 to check-out"
            icon={PAY_ICONS.hours}
          />
          <StatCard
            label="Overtime hours"
            value={formatHours(totals.otHours)}
            sub="beyond each worker's expected hours"
            icon={PAY_ICONS.ot}
          />
          <StatCard
            label="Workers paid"
            value={String(totals.paidWorkers)}
            sub={
              totals.unresolved > 0
                ? `${totals.unresolved} shift${totals.unresolved === 1 ? "" : "s"} still without a check-out`
                : "every shift has a check-out"
            }
            tone={totals.unresolved > 0 ? "warn" : "blue"}
            icon={PAY_ICONS.workers}
          />
        </div>
      )}

      <h2 className="sub-head">Pay by worker</h2>

      {rows === null ? (
        <SkeletonList rows={3} />
      ) : !valid ? (
        <EmptyState
          title="That date range runs backwards"
          hint="Set From on or before To, and the period totals itself again."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No attendance in this period"
          hint="Nobody checked in between these dates, so there is nothing to pay. Try another month."
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data pay-table">
              <thead>
                <tr>
                  <th>Worker ID</th>
                  <th aria-sort={ariaSort("name")}>
                    <button type="button" className="sort-btn" onClick={() => toggleSort("name")}>
                      Name
                      <SortGlyph active={sort.key === "name"} dir={sort.dir} />
                    </button>
                  </th>
                  <th>Role</th>
                  <th className="num">Rate</th>
                  <th className="num">Days</th>
                  <th className="num">Paid hrs</th>
                  <th className="num">Normal</th>
                  <th className="num">OT</th>
                  <th className="num" aria-sort={ariaSort("gross")}>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort("gross")}
                    >
                      Gross
                      <SortGlyph active={sort.key === "gross"} dir={sort.dir} />
                    </button>
                  </th>
                  <th>
                    <span className="sr-only">Shifts</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <PayRow key={r.worker_id} row={r} onOpen={() => setDetail(r)} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="ts-total">
            <span className="label">Gross for this period</span>
            <span className="muted">
              {totals.paidWorkers} worker{totals.paidWorkers === 1 ? "" : "s"} paid
              {totals.unpriced > 0
                ? ` · ${totals.unpriced} excluded with no rate set`
                : ""}
            </span>
            <span className="sum tnum">{formatMoney(totals.gross)}</span>
          </div>

          <p className="muted pay-policy">{POLICY_NOTE}</p>
        </>
      )}

      {detail && (
        <ShiftsModal row={detail} from={from} to={to} onClose={() => setDetail(null)} />
      )}
    </div>
  );
}

function SortGlyph({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  return (
    <span className={`sort-glyph${active ? ` active ${dir}` : ""}`} aria-hidden="true">
      ▾
    </span>
  );
}

function PayRow({ row, onOpen }: { row: PayrollRow; onOpen: () => void }) {
  const priced = isPriced(row);
  return (
    <tr className="pay-row" onClick={onOpen}>
      <td>
        {row.worker_code ? (
          <span className="chip code" title={row.worker_code}>
            {row.worker_code}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td style={{ minWidth: 170 }}>
        <span className="truncate" title={row.worker_name} style={{ display: "block" }}>
          {row.worker_name}
        </span>
        {(!priced || row.missing_checkout > 0 || row.flagged > 0) && (
          <span className="pay-chips">
            {!priced && (
              <Link
                to="/workers"
                className="chip warn"
                onClick={(e) => e.stopPropagation()}
                title="Set an hourly rate on the Workers page to include this worker in pay totals."
              >
                no rate set
              </Link>
            )}
            {row.missing_checkout > 0 && (
              <StatusChip
                kind="warn"
                label={`${row.missing_checkout} no checkout`}
                title="Unpaid until someone closes the shift — the check-out is missing."
              />
            )}
            {row.flagged > 0 && (
              <Link
                to="/attendance"
                className="chip flag"
                onClick={(e) => e.stopPropagation()}
                title="Open the attendance flags queue"
              >
                {row.flagged} flagged
              </Link>
            )}
          </span>
        )}
      </td>
      <td className="truncate" title={row.role}>
        {row.role}
      </td>
      <td className="num tnum">{priced ? formatMoney(row.hourly_rate) : "—"}</td>
      <td className="num tnum">{row.days_worked}</td>
      <td className="num tnum">{formatHours(row.paid_hours)}</td>
      <td className="num tnum">{formatHours(row.normal_hours)}</td>
      <td className="num tnum">{formatHours(row.ot_hours)}</td>
      <td className="num tnum pay-gross">{priced ? formatMoney(row.gross_pay) : "—"}</td>
      <td>
        <div className="cell-actions">
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            Shifts
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** Every shift behind one worker's figure, with the paid-from time made explicit. */
function ShiftsModal({
  row,
  from,
  to,
  onClose,
}: {
  row: PayrollRow;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [shifts, setShifts] = useState<AttendancePayRow[] | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await fetchWorkerShifts(row.worker_id, from, to);
        if (active) setShifts(list);
      } catch (e) {
        if (!active) return;
        setShifts([]);
        toast.error(e instanceof Error ? e.message : "Could not load these shifts.");
      }
    })();
    return () => {
      active = false;
    };
  }, [row.worker_id, from, to, toast]);

  return (
    <Modal
      size="wide"
      title={`${row.worker_name} · ${formatDay(from)} – ${formatDay(to)}`}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        {row.worker_code && <span className="chip code">{row.worker_code}</span>}
        <span className="chip">{row.role}</span>
        <span className="chip tnum">
          {row.hourly_rate === null ? "no rate set" : `${formatMoney(row.hourly_rate)}/h`}
        </span>
        <span className="chip tnum">{formatHours(row.expected_hours)}h expected</span>
        <span className="chip tnum">OT ×{row.ot_multiplier.toFixed(1)}</span>
      </div>

      {shifts === null ? (
        <SkeletonList rows={1} />
      ) : shifts.length === 0 ? (
        <p className="muted">No shifts recorded in this period.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>In (actual)</th>
                <th>Paid from</th>
                <th>Out</th>
                <th className="num">Paid h</th>
                <th className="num">OT h</th>
                <th className="num">Pay</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.attendance_id}>
                  <td className="tnum nowrap">{formatDayShort(s.work_date)}</td>
                  <td className="tnum nowrap">{formatTime(s.check_in_at)}</td>
                  <td className="tnum nowrap">{formatTime(s.paid_from)}</td>
                  <td className="nowrap">
                    {s.check_out_at ? (
                      <span className="tnum">{formatTime(s.check_out_at)}</span>
                    ) : (
                      <StatusChip
                        kind="warn"
                        label="no checkout"
                        title="Unpaid until someone closes the shift — the check-out is missing."
                      />
                    )}
                  </td>
                  <td className="num tnum">{formatHours(s.paid_hours)}</td>
                  <td className="num tnum">{formatHours(s.ot_hours)}</td>
                  <td className="num tnum">{formatMoney(s.gross_pay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted pay-policy">{POLICY_NOTE}</p>
    </Modal>
  );
}
