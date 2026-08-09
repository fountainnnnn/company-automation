-- ============================================================
-- Remove GPS attendance: check-in / check-out and everything derived from it.
--
-- This is the third and last of the workforce pillars to go (timesheets and
-- payroll were 0013). What remains is the thing the system is actually for:
-- site records — photos, videos, files and notes, filed by project, date and
-- worker.
--
-- workers.team_number and .role stay, as before: they label who a record came
-- from, and nothing is calculated from them.
-- ============================================================

-- The nightly sweep flagged shifts nobody checked out of; there are no shifts.
select cron.unschedule('flag-missing-checkouts');

-- Reads attendance for per-worker hours.
drop function if exists public.hours_by_worker(int);

-- `create or replace` cannot change a return type, so this must be dropped.
drop function if exists public.overview_stats();

-- Rebuilt without on_site_now / open_flags / hours_7d, which were all
-- attendance. `workers_7d` replaces them with something the archive can
-- actually answer: how many people filed anything this week.
create function public.overview_stats()
returns table (
  reports_7d bigint,
  reports_30d bigint,
  media_total bigint,
  media_7d bigint,
  active_workers bigint,
  pending_workers bigint,
  active_projects bigint,
  workers_7d bigint
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
    (select count(distinct worker_id) from public.reports
      where report_date >= current_date - 6)
$$;

-- Same snapshot minus the attendance block.
create or replace function public.focus_snapshot(days int default 7)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'window_days', days,
    'generated_at', now(),

    'sites', (
      select coalesce(jsonb_agg(s order by s->>'code'), '[]'::jsonb) from (
        select jsonb_build_object(
          'code', p.code,
          'name', p.name,
          'reports', count(distinct r.id),
          'files', count(rm.id),
          'workers', count(distinct r.worker_id),
          'last_activity', max(r.created_at),
          'undescribed', count(distinct r.id) filter (where r.note is null or btrim(r.note) = '')
        ) as s
        from public.projects p
        left join public.reports r
          on r.project_id = p.id
         and r.report_date >= current_date - (days - 1)
        left join public.report_media rm on rm.report_id = r.id
        where p.status = 'active'
        group by p.id, p.code, p.name
      ) t
    ),

    'teams', (
      select coalesce(jsonb_agg(t order by t->>'team'), '[]'::jsonb) from (
        select jsonb_build_object(
          'team', coalesce(w.team_number, 'unassigned'),
          'workers', count(distinct w.id),
          'reports', count(distinct r.id),
          'last_activity', max(r.created_at)
        ) as t
        from public.workers w
        left join public.reports r
          on r.worker_id = w.id
         and r.report_date >= current_date - (days - 1)
        where w.status = 'active'
        group by coalesce(w.team_number, 'unassigned')
      ) t
    ),

    'workers', (
      select jsonb_build_object(
        'active', count(*) filter (where status = 'active'),
        'pending_approval', count(*) filter (where status = 'pending'),
        'no_worker_code', count(*) filter (where status = 'active' and worker_code is null)
      )
      from public.workers
    ),

    'silent_sites', (
      select coalesce(jsonb_agg(p.code order by p.code), '[]'::jsonb)
      from public.projects p
      where p.status = 'active'
        and not exists (
          select 1 from public.reports r
          where r.project_id = p.id
            and r.created_at >= now() - interval '48 hours'
        )
    )
  )
$$;

revoke execute on function public.focus_snapshot(int) from public, anon, authenticated;

-- Policies and indexes go with the table.
drop table if exists public.attendance;

-- The flag threshold only ever governed check-in/check-out distance.
delete from public.settings where key = 'flag_distance_km';
