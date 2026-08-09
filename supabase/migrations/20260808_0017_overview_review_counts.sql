-- ============================================================
-- Give "Needs review" something real to count.
--
-- Its only item used to be attendance flags, which went with 0016. These three
-- are the checkable, non-guessing signals the archive still has — the panel is
-- the deterministic counterpart to the written briefing, so everything here is
-- an exact count with somewhere to go and fix it.
-- ============================================================

drop function if exists public.overview_stats();

create function public.overview_stats()
returns table (
  reports_7d bigint,
  reports_30d bigint,
  media_total bigint,
  media_7d bigint,
  active_workers bigint,
  pending_workers bigint,
  active_projects bigint,
  workers_7d bigint,
  undescribed_7d bigint,
  workers_no_code bigint,
  silent_sites bigint
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
    (select count(distinct worker_id) from public.reports where report_date >= current_date - 6),
    -- A record with no description is findable by date and site but not by what
    -- it shows; that is the archive's main quality risk now.
    (select count(*) from public.reports r
      where r.report_date >= current_date - 6
        and (r.note is null or btrim(r.note) = '')),
    (select count(*) from public.workers
      where status = 'active' and worker_code is null),
    (select count(*) from public.projects p
      where p.status = 'active'
        and not exists (
          select 1 from public.reports r
          where r.project_id = p.id and r.created_at >= now() - interval '48 hours'
        ))
$$;
