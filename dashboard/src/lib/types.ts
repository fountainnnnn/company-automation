export type Role = "admin" | "staff";
export type ProjectStatus = "active" | "archived";
export type WorkerStatus = "pending" | "active" | "disabled";
export type MediaType = "photo" | "video" | "document";
export type WorkerRole = "worker" | "driver" | "welder" | "supervisor";

export interface Profile {
  id: string;
  full_name: string | null;
  role: Role;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  site_address: string | null;
  site_lat: number | null;
  site_lng: number | null;
  status: ProjectStatus;
  created_at: string;
}

export interface Worker {
  id: string;
  full_name: string;
  telegram_user_id: number | null;
  telegram_username: string | null;
  status: WorkerStatus;
  default_project_id: string | null;
  created_at: string;
  /** Short code identifying the worker on site records — unique. */
  worker_code: string | null;
  role: WorkerRole;
  team_number: string | null;
}

export interface ProjectWorker {
  project_id: string;
  worker_id: string;
}

export interface ReportMedia {
  id: string;
  report_id: string;
  storage_path: string;
  /** Original filename as it arrived from Telegram, when the sender gave one. */
  file_name: string | null;
  media_type: MediaType;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

/** One thing a worker said, at the time they said it. The unit of a report's story. */
export interface ReportNote {
  id: string;
  report_id: string;
  worker_id: string | null;
  body: string;
  created_at: string;
  workers: { full_name: string } | null;
}

/** A record is `open` while the worker is still adding to it from Telegram. */
export type ReportStatus = "open" | "final";

export interface Report {
  id: string;
  project_id: string;
  worker_id: string | null;
  report_date: string;
  /**
   * Trigger-maintained newline-joined mirror of `report_notes`. Read it for
   * search and filtering only — never render it, never write to it.
   */
  note: string | null;
  status: ReportStatus;
  closed_at: string | null;
  created_at: string;
  updated_at: string | null;
  workers: { full_name: string } | null;
  projects: { code: string; name: string } | null;
  report_media: ReportMedia[];
  report_notes?: ReportNote[];
}

/** One row of the `project_stats()` RPC. */
export interface ProjectStatsRow {
  project_id: string | number;
  report_count: number;
  media_count: number;
  last_activity: string | null;
  cover_path: string | null;
}

export interface ProjectStats {
  mediaCount: number;
  reportCount: number;
  lastActivity: string | null;
}

/** The single row returned by `overview_stats()`. */
export interface OverviewStats {
  reports_7d: number;
  reports_30d: number;
  media_total: number;
  media_7d: number;
  active_workers: number;
  pending_workers: number;
  active_projects: number;
  workers_7d: number;
  undescribed_7d: number;
  workers_no_code: number;
  silent_sites: number;
}

/** One zero-filled day from `reports_by_day(days)`. */
export interface DayVolumeRow {
  day: string;
  reports: number;
  media: number;
}

/** One project from `reports_by_project(days)`, busiest first. */
export interface ProjectVolumeRow {
  project_id: string | number;
  code: string;
  name: string;
  reports: number;
  media: number;
}

/** One slice from `media_mix(days)`. */
export interface MediaMixRow {
  media_type: MediaType;
  count: number;
}

export interface Filters {
  from: string;
  to: string;
  workerId: string;
  mediaType: string;
  query: string;
  projectId?: string;
}

export const EMPTY_FILTERS: Filters = {
  from: "",
  to: "",
  workerId: "",
  mediaType: "",
  query: "",
};

/** One thing the briefing says to look at. Severity drives the chip colour. */
export interface FocusItem {
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  /** A site code, a team, or "All sites" — whatever the item is about. */
  scope: string;
}

/** A generated briefing, from the `site_summaries` table. */
export interface SiteSummary {
  id: number;
  generated_at: string;
  window_days: number;
  model: string;
  summary: string;
  focus: FocusItem[];
}
