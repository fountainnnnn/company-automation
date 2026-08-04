-- ============================================================
-- Payroll: pay runs from a FIXED 08:00 start to the actual check-out (company
-- policy), regardless of when the worker checked in. The real check-in time and
-- GPS stay untouched in `attendance` — they are the audit trail and drive the
-- off-site flag; they simply don't move the money.
--
-- NOTE the null handling below: Postgres least()/greatest() IGNORE nulls, so a
-- naive least(paid_hours, expected) pays a full day for a shift that was never
-- checked out of. Every derived column is explicitly guarded.
-- ============================================================

alter table public.workers
  add column hourly_rate numeric(10,2),
  add column expected_hours numeric(4,1) not null default 8
    check (expected_hours > 0 and expected_hours <= 24),
  add column ot_multiplier numeric(4,2) not null default 1.5
    check (ot_multiplier >= 1 and ot_multiplier <= 5);

insert into public.settings (key, value)
values ('payroll_day_start', '"08:00"')
on conflict (key) do nothing;

create or replace view public.attendance_pay
with (security_invoker = true) as
with tz as (
  select coalesce(value #>> '{}', 'Asia/Singapore') as name
    from public.settings where key = 'timezone'
),
start_at as (
  select coalesce(value #>> '{}', '08:00')::time as t
    from public.settings where key = 'payroll_day_start'
)
select
  a.id as attendance_id, a.worker_id, w.full_name as worker_name, w.worker_code, w.role,
  a.project_id, p.code as project_code,
  ((a.check_in_at at time zone (select name from tz))::date) as work_date,
  a.check_in_at, a.check_out_at, a.flags, a.review_status,
  w.hourly_rate, w.expected_hours, w.ot_multiplier,
  (((a.check_in_at at time zone (select name from tz))::date
      + (select t from start_at)) at time zone (select name from tz)) as paid_from,
  pay.paid_hours,
  case when pay.paid_hours is null then null
       else least(pay.paid_hours, w.expected_hours) end        as normal_hours,
  case when pay.paid_hours is null then null
       else greatest(pay.paid_hours - w.expected_hours, 0) end as ot_hours,
  case when pay.paid_hours is null or w.hourly_rate is null then null
       else round(
         least(pay.paid_hours, w.expected_hours) * w.hourly_rate
         + greatest(pay.paid_hours - w.expected_hours, 0) * w.hourly_rate * w.ot_multiplier
       , 2) end                                                as gross_pay
from public.attendance a
join public.workers w on w.id = a.worker_id
left join public.projects p on p.id = a.project_id
cross join lateral (
  select case
    when a.check_out_at is null then null
    else greatest(round((extract(epoch from (
        a.check_out_at
        - (((a.check_in_at at time zone (select name from tz))::date
            + (select t from start_at)) at time zone (select name from tz))
      )) / 3600)::numeric, 2), 0)
  end as paid_hours
) pay;

create or replace function public.payroll_summary(from_date date, to_date date)
returns table (
  worker_id bigint, worker_code text, worker_name text, role text,
  hourly_rate numeric, expected_hours numeric, ot_multiplier numeric,
  days_worked bigint, paid_hours numeric, normal_hours numeric, ot_hours numeric,
  gross_pay numeric, missing_checkout bigint, flagged bigint
)
language sql stable security invoker set search_path = '' as $$
  select w.id, w.worker_code, w.full_name, w.role,
    w.hourly_rate, w.expected_hours, w.ot_multiplier,
    count(*) filter (where ap.paid_hours is not null),
    coalesce(sum(ap.paid_hours), 0)::numeric,
    coalesce(sum(ap.normal_hours), 0)::numeric,
    coalesce(sum(ap.ot_hours), 0)::numeric,
    case when w.hourly_rate is null then null else coalesce(sum(ap.gross_pay), 0)::numeric end,
    count(*) filter (where ap.check_out_at is null),
    count(*) filter (where ap.review_status = 'pending')
  from public.workers w
  join public.attendance_pay ap on ap.worker_id = w.id
  where ap.work_date between from_date and to_date
  group by w.id, w.worker_code, w.full_name, w.role,
           w.hourly_rate, w.expected_hours, w.ot_multiplier
  order by w.full_name
$$;

-- ---------- team + cost analytics for the overview ----------
create or replace function public.hours_by_team(days int default 30)
returns table (team_number text, hours numeric, entries bigint, absences bigint, workers bigint)
language sql stable security invoker set search_path = '' as $$
  select coalesce(t.team_number, '—'), coalesce(sum(e.hours), 0)::numeric, count(*),
         count(*) filter (where e.absence_reason is not null),
         count(distinct e.worker_code)
  from public.timesheet_entries e
  join public.timesheets t on t.id = e.timesheet_id
  where t.work_date >= current_date - (days - 1)
  group by coalesce(t.team_number, '—') order by 2 desc
$$;

create or replace function public.cost_by_project(days int default 30)
returns table (project_id bigint, code text, name text, hours numeric, ot_hours numeric, gross_pay numeric)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.code, p.name,
    coalesce(sum(ap.paid_hours), 0)::numeric,
    coalesce(sum(ap.ot_hours), 0)::numeric,
    coalesce(sum(ap.gross_pay), 0)::numeric
  from public.projects p
  join public.attendance_pay ap on ap.project_id = p.id
  where ap.work_date >= current_date - (days - 1)
  group by p.id, p.code, p.name order by 6 desc
$$;

create or replace function public.ot_by_day(days int default 30)
returns table (day date, normal_hours numeric, ot_hours numeric)
language sql stable security invoker set search_path = '' as $$
  select d::date, coalesce(sum(ap.normal_hours), 0)::numeric,
         coalesce(sum(ap.ot_hours), 0)::numeric
  from generate_series(current_date - (days - 1), current_date, interval '1 day') d
  left join public.attendance_pay ap on ap.work_date = d::date
  group by d order by d
$$;
