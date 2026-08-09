-- ============================================================
-- Focus summary: an LLM-written "what needs attention" briefing across sites
-- and teams.
--
-- Two pieces:
--   * focus_snapshot(days)  — gathers the facts as jsonb. Service-role only:
--     it reads attendance, which RLS closes to staff.
--   * site_summaries        — the generated briefings, newest wins. Readable by
--     any signed-in user; written only by the edge function (service role).
--
-- The snapshot is deliberately text/count only — no coordinates ever leave the
-- database, so a briefing can be shown to staff without leaking GPS.
-- ============================================================

create table public.site_summaries (
  id bigint generated always as identity primary key,
  generated_at timestamptz not null default now(),
  window_days int not null,
  model text not null,
  summary text not null,
  focus jsonb not null default '[]'::jsonb,
  snapshot jsonb,
  generated_by uuid references auth.users (id) on delete set null
);

create index site_summaries_generated_at_idx on public.site_summaries (generated_at desc);

alter table public.site_summaries enable row level security;

-- Everyone signed in can read the briefing; nobody can write it from the
-- client — the edge function uses the service role, which bypasses RLS.
create policy site_summaries_select on public.site_summaries
  for select to authenticated using (true);

/**
 * Everything the briefing is written from, in one round trip. Counts and names
 * only — never coordinates.
 */
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

    'attendance', (
      select jsonb_build_object(
        'shifts', count(*),
        'open_now', count(*) filter (
          where a.check_out_at is null and not ('no_checkout' = any(a.flags))
        ),
        'missing_checkout', count(*) filter (where 'no_checkout' = any(a.flags)),
        'flagged_pending', count(*) filter (where a.review_status = 'pending')
      )
      from public.attendance a
      where a.check_in_at >= now() - make_interval(days => days)
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

-- Service role only: the snapshot aggregates attendance, which staff must not read.
revoke execute on function public.focus_snapshot(int) from public, anon, authenticated;
