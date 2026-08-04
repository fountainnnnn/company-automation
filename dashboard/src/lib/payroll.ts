import { supabase } from "./supabase";
import type { AttendancePayRow, PayrollRow } from "./types";

/** PostgREST hands numerics back as strings often enough that every one is coerced. */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const PAY_SELECT =
  "attendance_id,worker_id,worker_name,worker_code,role,project_id,project_code," +
  "work_date,check_in_at,check_out_at,flags,review_status,hourly_rate,expected_hours," +
  "ot_multiplier,paid_from,paid_hours,normal_hours,ot_hours,gross_pay";

/** The whole period in one call — the set is one row per worker, so it stays small. */
export async function fetchPayrollSummary(
  from: string,
  to: string,
): Promise<PayrollRow[]> {
  const { data, error } = await supabase.rpc("payroll_summary", {
    from_date: from,
    to_date: to,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as PayrollRow[]).map((r) => ({
    ...r,
    worker_id: num(r.worker_id),
    hourly_rate: numOrNull(r.hourly_rate),
    expected_hours: num(r.expected_hours),
    ot_multiplier: num(r.ot_multiplier),
    days_worked: num(r.days_worked),
    paid_hours: num(r.paid_hours),
    normal_hours: num(r.normal_hours),
    ot_hours: num(r.ot_hours),
    gross_pay: num(r.gross_pay),
    missing_checkout: num(r.missing_checkout),
    flagged: num(r.flagged),
  }));
}

/** The shifts behind one worker's row, for the drill-down dialog. */
export async function fetchWorkerShifts(
  workerId: number,
  from: string,
  to: string,
): Promise<AttendancePayRow[]> {
  const { data, error } = await supabase
    .from("attendance_pay")
    .select(PAY_SELECT)
    .eq("worker_id", workerId)
    .gte("work_date", from)
    .lte("work_date", to)
    .order("work_date", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as AttendancePayRow[]).map((r) => ({
    ...r,
    worker_id: num(r.worker_id),
    hourly_rate: numOrNull(r.hourly_rate),
    expected_hours: num(r.expected_hours),
    ot_multiplier: num(r.ot_multiplier),
    paid_hours: numOrNull(r.paid_hours),
    normal_hours: numOrNull(r.normal_hours),
    ot_hours: numOrNull(r.ot_hours),
    gross_pay: numOrNull(r.gross_pay),
  }));
}

const CSV_HEADERS = [
  "Worker ID",
  "Name",
  "Role",
  "Rate",
  "Days",
  "Paid hours",
  "Normal hours",
  "OT hours",
  "Gross pay",
];

function cell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Same columns as the table on screen; unpriced workers export a blank, never a 0. */
export function toPayrollCsv(rows: PayrollRow[]): string {
  const lines = [CSV_HEADERS.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.worker_code ?? "",
        r.worker_name,
        r.role,
        r.hourly_rate === null ? "" : r.hourly_rate.toFixed(2),
        String(r.days_worked),
        r.paid_hours.toFixed(1),
        r.normal_hours.toFixed(1),
        r.ot_hours.toFixed(1),
        r.hourly_rate === null ? "" : r.gross_pay.toFixed(2),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}
