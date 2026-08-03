-- ============================================================
-- Timesheets: a supervisor files one roster per team per day.
--
-- This is separate from, and additional to, the GPS check-in/check-out
-- attendance flow — that records an individual's presence on site; this
-- records the crew's hours as the supervisor reports them, including
-- reasons for no-shows, which GPS can never capture.
--
-- Entries keep the worker CODE as typed so a roster never fails to save
-- because someone isn't registered yet; worker_id resolves via trigger.
-- ============================================================

alter table public.workers
  add column worker_code text unique,
  add column role text not null default 'worker'
    check (role in ('worker', 'driver', 'welder', 'supervisor')),
  add column team_number text;

create index workers_worker_code_idx on public.workers (worker_code);
create index workers_team_idx on public.workers (team_number);

create table public.timesheets (
  id bigint generated always as identity primary key,
  work_date date not null,
  team_number text,
  location text,
  project_id bigint references public.projects (id) on delete set null,
  submitted_by bigint references public.workers (id) on delete set null,
  raw_text text,                                   -- exactly what was sent
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index timesheets_work_date_idx on public.timesheets (work_date desc);
create index timesheets_team_idx on public.timesheets (team_number);
create index timesheets_project_idx on public.timesheets (project_id);
create index timesheets_submitted_by_idx on public.timesheets (submitted_by);

create table public.timesheet_entries (
  id bigint generated always as identity primary key,
  timesheet_id bigint not null references public.timesheets (id) on delete cascade,
  worker_code text not null,
  worker_id bigint references public.workers (id) on delete set null,
  hours numeric(4,1) check (hours is null or (hours >= 0 and hours <= 24)),
  absence_reason text,
  role text not null default 'worker'
    check (role in ('worker', 'driver', 'welder', 'supervisor')),
  -- a line is either hours worked or a reason for no-show, never both/neither
  constraint hours_xor_absence check ((hours is null) <> (absence_reason is null)),
  unique (timesheet_id, worker_code)
);
create index timesheet_entries_timesheet_idx on public.timesheet_entries (timesheet_id);
create index timesheet_entries_worker_idx on public.timesheet_entries (worker_id);
create index timesheet_entries_code_idx on public.timesheet_entries (worker_code);

create trigger timesheets_set_updated_at before update on public.timesheets
  for each row execute function public.tg_set_updated_at();

-- resolve worker_code -> worker_id on write...
create or replace function public.tg_resolve_timesheet_worker()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.worker_id is null then
    select id into new.worker_id from public.workers
     where worker_code is not null
       and upper(worker_code) = upper(new.worker_code);
  end if;
  return new;
end $$;

create trigger timesheet_entries_resolve_worker
  before insert or update of worker_code on public.timesheet_entries
  for each row execute function public.tg_resolve_timesheet_worker();

-- ...and backfill history the moment a worker is finally given that code
create or replace function public.tg_backfill_timesheet_worker()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.worker_code is not null
     and (old.worker_code is distinct from new.worker_code) then
    update public.timesheet_entries e
       set worker_id = new.id
     where e.worker_id is null
       and upper(e.worker_code) = upper(new.worker_code);
  end if;
  return new;
end $$;

create trigger workers_backfill_timesheets
  after update of worker_code on public.workers
  for each row execute function public.tg_backfill_timesheet_worker();

-- ---------- RLS: staff read, admin write, bot via service role ----------
alter table public.timesheets enable row level security;
alter table public.timesheet_entries enable row level security;

create policy timesheets_select on public.timesheets for select to authenticated using (true);
create policy timesheets_admin_insert on public.timesheets for insert to authenticated
  with check ((select private.is_admin()));
create policy timesheets_admin_update on public.timesheets for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy timesheets_admin_delete on public.timesheets for delete to authenticated
  using ((select private.is_admin()));

create policy tse_select on public.timesheet_entries for select to authenticated using (true);
create policy tse_admin_insert on public.timesheet_entries for insert to authenticated
  with check ((select private.is_admin()));
create policy tse_admin_update on public.timesheet_entries for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy tse_admin_delete on public.timesheet_entries for delete to authenticated
  using ((select private.is_admin()));

alter publication supabase_realtime add table public.timesheets;
alter publication supabase_realtime add table public.timesheet_entries;

-- ---------- one row per worker per day: what the office reads ----------
create or replace view public.timesheet_rows
with (security_invoker = true) as
select
  e.id as entry_id, t.id as timesheet_id,
  t.work_date, t.team_number, t.location,
  t.project_id, p.code as project_code,
  e.worker_code, e.worker_id, w.full_name as worker_name,
  e.role, e.hours, e.absence_reason,
  (e.worker_id is null) as unresolved,
  t.submitted_by, s.full_name as submitted_by_name,
  t.created_at
from public.timesheet_entries e
join public.timesheets t on t.id = e.timesheet_id
left join public.workers w on w.id = e.worker_id
left join public.workers s on s.id = t.submitted_by
left join public.projects p on p.id = t.project_id;

create or replace function public.timesheet_stats(days int default 30)
returns table (total_hours numeric, entries bigint, absences bigint, crews bigint, unresolved bigint)
language sql stable security invoker set search_path = '' as $$
  select
    coalesce(sum(e.hours), 0)::numeric,
    count(*),
    count(*) filter (where e.absence_reason is not null),
    count(distinct t.team_number),
    count(*) filter (where e.worker_id is null)
  from public.timesheet_entries e
  join public.timesheets t on t.id = e.timesheet_id
  where t.work_date >= current_date - (days - 1)
$$;

create or replace function public.hours_by_role(days int default 30)
returns table (role text, hours numeric, entries bigint)
language sql stable security invoker set search_path = '' as $$
  select e.role, coalesce(sum(e.hours), 0)::numeric, count(*)
  from public.timesheet_entries e
  join public.timesheets t on t.id = e.timesheet_id
  where t.work_date >= current_date - (days - 1)
  group by e.role
  order by 2 desc
$$;

-- ---------- trigger functions must not be REST-callable (advisor 0028/0029) ----------
revoke execute on function public.tg_resolve_timesheet_worker() from public, anon, authenticated;
revoke execute on function public.tg_backfill_timesheet_worker() from public, anon, authenticated;
revoke execute on function public.tg_set_updated_at() from public, anon, authenticated;
