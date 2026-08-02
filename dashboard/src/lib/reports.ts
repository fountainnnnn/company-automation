import { supabase } from "./supabase";
import { getSignedUrls } from "./signedUrls";
import type { Filters, Report, ReportMedia } from "./types";

export const PAGE_SIZE = 30;
export const REPORT_SELECT = "*,workers(full_name),projects(code,name),report_media(*)";

export interface ReportPage {
  rows: Report[];
  hasMore: boolean;
  error: string | null;
}

/** One filtered, paged query. Date/worker/note filters run server-side. */
export async function fetchReports(
  filters: Filters,
  projectId: string | undefined,
  offset: number,
): Promise<ReportPage> {
  let q = supabase.from("reports").select(REPORT_SELECT);

  const pid = projectId ?? (filters.projectId || undefined);
  if (pid) q = q.eq("project_id", pid);
  if (filters.from) q = q.gte("report_date", filters.from);
  if (filters.to) q = q.lte("report_date", filters.to);
  if (filters.workerId) q = q.eq("worker_id", filters.workerId);
  if (filters.query.trim()) q = q.ilike("note", `%${filters.query.trim()}%`);

  const { data, error } = await q
    .order("report_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) return { rows: [], hasMore: false, error: error.message };
  const rows = (data ?? []) as unknown as Report[];
  return { rows, hasMore: rows.length === PAGE_SIZE, error: null };
}

export async function fetchReportById(id: string): Promise<Report | null> {
  const { data, error } = await supabase
    .from("reports")
    .select(REPORT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as Report;
}

/** Media of a report after the media-type filter. */
export function mediaOf(report: Report, mediaType: string): ReportMedia[] {
  const all = report.report_media ?? [];
  return mediaType ? all.filter((m) => m.media_type === mediaType) : all;
}

/** Reports with nothing left to show are dropped when a media filter is on. */
export function visibleReports(reports: Report[], mediaType: string): Report[] {
  if (!mediaType) return reports;
  return reports.filter((r) => mediaOf(r, mediaType).length > 0);
}

export async function signReportMedia(reports: Report[]): Promise<Record<string, string>> {
  const paths = reports.flatMap((r) => (r.report_media ?? []).map((m) => m.storage_path));
  if (paths.length === 0) return {};
  return getSignedUrls(paths);
}

export function groupByDate(reports: Report[]): Array<[string, Report[]]> {
  const map = new Map<string, Report[]>();
  for (const r of reports) {
    const list = map.get(r.report_date) ?? [];
    list.push(r);
    map.set(r.report_date, list);
  }
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
}
