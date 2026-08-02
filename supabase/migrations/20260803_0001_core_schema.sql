-- ============================================================
-- Site Reporting & Attendance Pipeline — core schema
-- ============================================================

-- ---------- dashboard users ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

-- ---------- projects / construction sites ----------
create table public.projects (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  site_address text,
  site_lat double precision,
  site_lng double precision,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);

-- ---------- field workers (telegram identities) ----------
create table public.workers (
  id bigint generated always as identity primary key,
  full_name text not null,
  telegram_user_id bigint unique,
  telegram_username text,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  default_project_id bigint references public.projects (id) on delete set null,
  created_at timestamptz not null default now()
);
create index workers_default_project_id_idx on public.workers (default_project_id);
create index workers_status_idx on public.workers (status);

create table public.project_workers (
  project_id bigint not null references public.projects (id) on delete cascade,
  worker_id bigint not null references public.workers (id) on delete cascade,
  primary key (project_id, worker_id)
);
create index project_workers_worker_id_idx on public.project_workers (worker_id);

-- ---------- site reports (one submission = media + info) ----------
create table public.reports (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.projects (id) on delete cascade,
  worker_id bigint not null references public.workers (id) on delete restrict,
  report_date date not null default current_date,
  note text,
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(note, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reports_project_date_idx on public.reports (project_id, report_date desc);
create index reports_worker_id_idx on public.reports (worker_id);
create index reports_created_at_idx on public.reports (created_at desc);
create index reports_search_idx on public.reports using gin (search_vector);

create table public.report_media (
  id bigint generated always as identity primary key,
  report_id bigint not null references public.reports (id) on delete cascade,
  storage_path text not null,
  media_type text not null check (media_type in ('photo', 'video', 'document')),
  telegram_file_id text,
  mime_type text,
  file_size bigint,
  width int,
  height int,
  media_group_id text,
  created_at timestamptz not null default now()
);
create index report_media_report_id_idx on public.report_media (report_id);
create index report_media_group_idx on public.report_media (media_group_id) where media_group_id is not null;

-- ---------- attendance: GPS is mandatory, a location-less row is unrepresentable ----------
create table public.attendance (
  id bigint generated always as identity primary key,
  worker_id bigint not null references public.workers (id) on delete restrict,
  project_id bigint references public.projects (id) on delete set null,
  check_in_at timestamptz not null default now(),
  in_lat double precision not null,
  in_lng double precision not null,
  check_out_at timestamptz,
  out_lat double precision,
  out_lng double precision,
  distance_m integer,
  flags text[] not null default '{}',
  review_status text not null default 'none' check (review_status in ('none', 'pending', 'cleared')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  admin_note text,
  constraint checkout_requires_gps
    check ((check_out_at is null) = (out_lat is null) and (out_lat is null) = (out_lng is null))
);
create index attendance_worker_id_idx on public.attendance (worker_id);
create index attendance_check_in_at_idx on public.attendance (check_in_at desc);
create index attendance_project_id_idx on public.attendance (project_id);
create index attendance_reviewed_by_idx on public.attendance (reviewed_by);
create index attendance_pending_idx on public.attendance (review_status) where review_status = 'pending';
-- one open (not checked out) row per worker at a time; rows already flagged for
-- review (e.g. no_checkout closed by the nightly cron) stop blocking re-check-in
create unique index attendance_open_per_worker_uidx on public.attendance (worker_id)
  where check_out_at is null and review_status = 'none';

-- ---------- config + bot plumbing ----------
create table public.settings (
  key text primary key,
  value jsonb not null
);

-- secrets: RLS enabled with NO policies — only service_role (bot) can read
create table public.app_secrets (
  key text primary key,
  value text not null
);

create table public.chat_sessions (
  chat_id bigint primary key,
  worker_id bigint references public.workers (id) on delete cascade,
  state text not null default 'idle',
  draft jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create index chat_sessions_worker_id_idx on public.chat_sessions (worker_id);

-- ---------- updated_at maintenance ----------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger reports_set_updated_at before update on public.reports
  for each row execute function public.tg_set_updated_at();
create trigger chat_sessions_set_updated_at before update on public.chat_sessions
  for each row execute function public.tg_set_updated_at();
