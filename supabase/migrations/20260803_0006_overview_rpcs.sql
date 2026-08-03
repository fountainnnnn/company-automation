-- ============================================================
-- Overview aggregations. All SECURITY INVOKER so RLS applies:
-- attendance-derived numbers return empty for staff by construction.
-- ============================================================

-- Headline counters for the overview tiles.
create or replace function public.overview_stats()
returns table (
  reports_7d bigint,
  reports_30d bigint,
  media_total bigint,
  media_7d bigint,
  active_workers bigint,
  pending_workers bigint,
  active_projects bigint,
  on_site_now bigint,
  open_flags bigint,
  hours_7d numeric
)
language sql stable security invoker set search_path = '' as $$
  select
    (select count(*) from public.reports where report_date >= current_date - 6),
    (select count(*) from public.reports where report_date >= current_date - 29),
    (select count(*) from public.report_media),
    (select count(*) from public.report_media where created_at >= now() - interval '7 days'),
    (select count(*) from public.workers where status = 'active'),
    (select count(*) from public.workers where status = 'pending'),
    (select count(*) from public.projects where status = 'active'),
    (select count(*) from public.attendance
       where check_out_at is null and not ('no_checkout' = any(flags))),
    (select count(*) from public.attendance where review_status = 'pending'),
    (select coalesce(round(sum(extract(epoch from (check_out_at - check_in_at)) / 3600)::numeric, 1), 0)
       from public.attendance
      where check_out_at is not null and check_in_at >= now() - interval '7 days')
$$;

-- Daily activity for the last N days, zero-filled so the axis has no gaps.
create or replace function public.reports_by_day(days int default 30)
returns table (day date, reports bigint, media bigint)
language sql stable security invoker set search_path = '' as $$
  select d::date,
         count(distinct r.id),
         count(m.id)
  from generate_series(current_date - (days - 1), current_date, interval '1 day') d
  left join public.reports r on r.report_date = d::date
  left join public.report_media m on m.report_id = r.id
  group by d
  order by d
$$;

-- Volume per project over the window (drives the ranked bars).
create or replace function public.reports_by_project(days int default 30)
returns table (project_id bigint, code text, name text, reports bigint, media bigint)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.code, p.name,
         count(distinct r.id),
         count(m.id)
  from public.projects p
  left join public.reports r
         on r.project_id = p.id and r.report_date >= current_date - (days - 1)
  left join public.report_media m on m.report_id = r.id
  where p.status = 'active'
  group by p.id, p.code, p.name
  order by count(distinct r.id) desc, p.code
$$;

-- Hours per worker over the window (admin-only via RLS on attendance).
create or replace function public.hours_by_worker(days int default 7)
returns table (worker_id bigint, full_name text, hours numeric, shifts bigint)
language sql stable security invoker set search_path = '' as $$
  select w.id, w.full_name,
         round(sum(extract(epoch from (a.check_out_at - a.check_in_at)) / 3600)::numeric, 1),
         count(*)
  from public.attendance a
  join public.workers w on w.id = a.worker_id
  where a.check_out_at is not null
    and a.check_in_at >= now() - make_interval(days => days)
  group by w.id, w.full_name
  order by 3 desc
$$;

-- Media mix for the window.
create or replace function public.media_mix(days int default 30)
returns table (media_type text, count bigint)
language sql stable security invoker set search_path = '' as $$
  select m.media_type, count(*)
  from public.report_media m
  where m.created_at >= now() - make_interval(days => days)
  group by m.media_type
  order by 2 desc
$$;
