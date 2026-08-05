-- Notes are EVENTS, not one string. Concatenating "big stuffs" (11:22) and
-- "big stuffs too" (11:23) into one field destroyed the only thing that made
-- them useful. Each is now a row with its own time and author.
-- reports.note is kept as a newline-joined mirror (trigger-maintained) so the
-- existing full-text search and ilike filters keep working untouched.
create table public.report_notes (
  id bigint generated always as identity primary key,
  report_id bigint not null references public.reports (id) on delete cascade,
  worker_id bigint references public.workers (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index report_notes_report_idx on public.report_notes (report_id, created_at);
create index report_notes_worker_idx on public.report_notes (worker_id);

-- A record stays OPEN while the worker is still adding to it.
alter table public.reports
  add column status text not null default 'final' check (status in ('open', 'final')),
  add column closed_at timestamptz;
create index reports_open_idx on public.reports (worker_id, status) where status = 'open';

create or replace function public.tg_sync_report_note()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target bigint := coalesce(new.report_id, old.report_id);
begin
  update public.reports r
     set note = (select string_agg(n.body, E'\n' order by n.created_at, n.id)
                   from public.report_notes n where n.report_id = target)
   where r.id = target;
  return null;
end $$;

create trigger report_notes_sync
  after insert or update or delete on public.report_notes
  for each row execute function public.tg_sync_report_note();
revoke execute on function public.tg_sync_report_note() from public, anon, authenticated;

alter table public.report_notes enable row level security;
create policy report_notes_select on public.report_notes for select to authenticated using (true);
create policy report_notes_admin_write on public.report_notes for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
alter publication supabase_realtime add table public.report_notes;

-- SPEED: one round trip for "who is this and what were they doing?" instead of
-- 2-3 separate PostgREST calls (~200ms each) on every inbound message.
create or replace function public.bot_context(p_chat_id bigint, p_tg_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'worker',     (select to_jsonb(w) from public.workers w where w.telegram_user_id = p_tg_user_id),
    'session',    (select to_jsonb(s) from public.chat_sessions s where s.chat_id = p_chat_id),
    'group_link', (select to_jsonb(g) from public.group_links g where g.chat_id = p_chat_id),
    'settings',   (select jsonb_object_agg(key, value) from public.settings
                    where key in ('timezone', 'flag_distance_km', 'payroll_day_start')),
    'open_report',(select to_jsonb(r) from public.reports r
                    where r.worker_id = (select id from public.workers where telegram_user_id = p_tg_user_id)
                      and r.status = 'open' order by r.id desc limit 1)
  )
$$;
revoke execute on function public.bot_context(bigint, bigint) from public, anon, authenticated;
