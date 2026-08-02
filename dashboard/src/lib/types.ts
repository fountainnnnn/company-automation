export type Role = "admin" | "staff";
export type ProjectStatus = "active" | "archived";
export type WorkerStatus = "pending" | "active" | "disabled";
export type MediaType = "photo" | "video" | "document";
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
  projects: { code: string; name: string } | null;
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
