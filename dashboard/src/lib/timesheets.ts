import { supabase } from "./supabase";
import type { TimesheetFilters, TimesheetRow } from "./types";

export const TS_PAGE_SIZE = 50;

/** PostgREST caps a response; totals and exports walk the set in these steps. */
const CHUNK = 1000;
/** A hard stop so a cleared filter can never pull the whole history into memory. */
const MAX_SCAN = 20000;

export const TS_SELECT =
  "entry_id,timesheet_id,work_date,team_number,location,project_id,project_code," +
  "worker_code,worker_id,worker_name,role,hours,absence_reason,unresolved," +
  "submitted_by,submitted_by_name,created_at";

/** or() takes a comma/paren-delimited grammar, so those characters can't pass through. */
function safeTerm(term: string): string {
  return term.replace(/[,()*%\\"]/g, " ").trim();
}

/** One filtered query over the view. Every filter here runs server-side. */
function tsQuery(filters: TimesheetFilters, columns: string) {
  let q = supabase.from("timesheet_rows").select(columns);
  if (filters.from) q = q.gte("work_date", filters.from);
  if (filters.to) q = q.lte("work_date", filters.to);
  if (filters.team) q = q.eq("team_number", filters.team);
  if (filters.role) q = q.eq("role", filters.role);
  if (filters.location.trim()) q = q.ilike("location", `%${filters.location.trim()}%`);
  const worker = safeTerm(filters.worker);
  if (worker) q = q.or(`worker_code.ilike.*${worker}*,worker_name.ilike.*${worker}*`);
  return q.order("work_date", { ascending: false }).order("team_number").order("worker_code");
}

/** numeric(4,1) can arrive as a string; hours are arithmetic everywhere downstream. */
function normalize(row: TimesheetRow): TimesheetRow {
  return { ...row, hours: row.hours === null ? null : Number(row.hours) };
}

export interface TimesheetPage {
  rows: TimesheetRow[];
  hasMore: boolean;
  error: string | null;
}

export async function fetchTimesheetPage(
  filters: TimesheetFilters,
  offset: number,
): Promise<TimesheetPage> {
  const { data, error } = await tsQuery(filters, TS_SELECT).range(
    offset,
    offset + TS_PAGE_SIZE - 1,
  );
  if (error) return { rows: [], hasMore: false, error: error.message };
  const rows = ((data ?? []) as unknown as TimesheetRow[]).map(normalize);
  return { rows, hasMore: rows.length === TS_PAGE_SIZE, error: null };
}

/** Walks the whole filtered set — used for the footer total and the CSV export. */
async function scanAll(filters: TimesheetFilters, columns: string): Promise<TimesheetRow[]> {
  const out: TimesheetRow[] = [];
  for (let offset = 0; offset < MAX_SCAN; offset += CHUNK) {
    const { data, error } = await tsQuery(filters, columns).range(offset, offset + CHUNK - 1);
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as unknown as TimesheetRow[]).map(normalize);
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

export interface TimesheetTotals {
  hours: number;
  entries: number;
  absences: number;
}

/** Exact totals for the current filter, not just the pages already on screen. */
export async function fetchTimesheetTotals(
  filters: TimesheetFilters,
): Promise<TimesheetTotals> {
  const rows = await scanAll(filters, "hours,absence_reason");
  return {
    hours: rows.reduce((sum, r) => sum + (r.hours ?? 0), 0),
    entries: rows.length,
    absences: rows.filter((r) => r.absence_reason !== null).length,
  };
}

export function fetchAllTimesheetRows(filters: TimesheetFilters): Promise<TimesheetRow[]> {
  return scanAll(filters, TS_SELECT);
}

/** Every team that has ever filed a roster, for the filter select. */
export async function fetchTeams(): Promise<string[]> {
  const { data } = await supabase
    .from("timesheet_rows")
    .select("team_number")
    .not("team_number", "is", null)
    .limit(CHUNK);
  const teams = new Set((data ?? []).map((r) => (r as { team_number: string }).team_number));
  return Array.from(teams).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

const CSV_HEADERS = [
  "Date",
  "Team",
  "Location",
  "Worker ID",
  "Name",
  "Role",
  "Hours",
  "Status",
];

function cell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(rows: TimesheetRow[]): string {
  const lines = [CSV_HEADERS.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.work_date,
        r.team_number ?? "",
        r.location ?? "",
        r.worker_code,
        r.worker_name ?? "",
        r.role,
        r.hours === null ? "" : r.hours.toFixed(1),
        r.absence_reason ?? "",
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  // Excel reads a BOM-less UTF-8 CSV as latin-1 and mangles every name.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
