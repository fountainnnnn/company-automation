export type Role = "admin" | "staff";
export type ProjectStatus = "active" | "archived";
export type WorkerStatus = "pending" | "active" | "disabled";
export type MediaType = "photo" | "video" | "document";
export type TimesheetRole = "worker" | "driver" | "welder" | "supervisor";
export type ReviewStatus = "none" | "pending" | "cleared";

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
  /** Code the supervisors write on paper rosters — unique, links timesheet entries. */
  worker_code: string | null;
  role: TimesheetRole;
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

export interface Report {
  id: string;
  project_id: string;
  worker_id: string | null;
  report_date: string;
  note: string | null;
  created_at: string;
  updated_at: string | null;
  workers: { full_name: string } | null;
  projects: { code: string; name: string } | null;
  report_media: ReportMedia[];
}

export interface Attendance {
  id: string;
  worker_id: string;
  project_id: string | null;
  check_in_at: string;
  in_lat: number | null;
  in_lng: number | null;
  check_out_at: string | null;
  out_lat: number | null;
  out_lng: number | null;
  distance_m: number | null;
  flags: string[] | null;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  admin_note: string | null;
  workers: { full_name: string } | null;
  /** Site coordinates come along so the map can show the assigned site. */
  projects: { code: string; name: string; site_lat: number | null; site_lng: number | null } | null;
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
  on_site_now: number;
  open_flags: number;
  hours_7d: number;
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

/** One worker from `hours_by_worker(days)` — empty for staff, by RLS. */
export interface WorkerHoursRow {
  worker_id: string | number;
  full_name: string;
  hours: number;
  shifts: number;
}

/** One slice from `media_mix(days)`. */
export interface MediaMixRow {
  media_type: MediaType;
  count: number;
}

/** One entry of one daily roster, joined to its header — the `timesheet_rows` view. */
export interface TimesheetRow {
  entry_id: number;
  timesheet_id: number;
  work_date: string;
  team_number: string | null;
  location: string | null;
  project_id: number | null;
  project_code: string | null;
  worker_code: string;
  worker_id: number | null;
  worker_name: string | null;
  role: TimesheetRole;
  hours: number | null;
  absence_reason: string | null;
  /** The written code matches no registered worker, so the row is unlinked. */
  unresolved: boolean;
  submitted_by: number | null;
  submitted_by_name: string | null;
  created_at: string;
}

/** The roster header — one Telegram submission, one team, one day. */
export interface Timesheet {
  id: number;
  work_date: string;
  team_number: string | null;
  location: string | null;
  project_id: number | null;
  submitted_by: number | null;
  raw_text: string | null;
  created_at: string;
  updated_at: string | null;
}

/** The single row returned by `timesheet_stats(days)`. */
export interface TimesheetStats {
  total_hours: number;
  entries: number;
  absences: number;
  crews: number;
  unresolved: number;
}

/** One role from `hours_by_role(days)`. */
export interface RoleHoursRow {
  role: TimesheetRole;
  hours: number;
  entries: number;
}

export interface TimesheetFilters {
  from: string;
  to: string;
  team: string;
  role: string;
  worker: string;
  location: string;
}

export const EMPTY_TIMESHEET_FILTERS: TimesheetFilters = {
  from: "",
  to: "",
  team: "",
  role: "",
  worker: "",
  location: "",
};

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
