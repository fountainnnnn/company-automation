-- ============================================================
-- Remove the timesheet (roster) and payroll (salary) systems.
--
-- These were two separate systems that shared only the worker columns:
--   * timesheets    — the supervisor's pasted crew roster
--   * payroll       — pay derived from GPS attendance, NOT from rosters
--
-- GPS attendance itself is untouched: check-in/out, distance flagging and the
-- review queue all stay. What goes is the money layer on top of it.
--
-- worker_code, team_number and role are DELIBERATELY KEPT — they label who a
-- site record came from, and outlive the roster feature that introduced them.
-- ============================================================

-- views first: attendance_pay is what the payroll RPCs read
drop view if exists public.timesheet_rows;
drop view if exists public.attendance_pay;

-- roster analytics
drop function if exists public.timesheet_stats(int);
drop function if exists public.hours_by_role(int);
drop function if exists public.hours_by_team(int);

-- pay analytics
drop function if exists public.payroll_summary(date, date);
drop function if exists public.cost_by_project(int);
drop function if exists public.ot_by_day(int);

-- the backfill trigger lives on workers, so it must go before its function
drop trigger if exists workers_backfill_timesheets on public.workers;
drop function if exists public.tg_backfill_timesheet_worker();

-- entries first (FK), then the header; their own triggers/policies/indexes
-- are dropped with the tables
drop table if exists public.timesheet_entries;
drop table if exists public.timesheets;
drop function if exists public.tg_resolve_timesheet_worker();

-- pay rates on workers
alter table public.workers
  drop column if exists hourly_rate,
  drop column if exists expected_hours,
  drop column if exists ot_multiplier;

delete from public.settings where key = 'payroll_day_start';

-- bot_context is on the hot path for every Telegram update; it still named the
-- payroll setting it will now never find. Body is otherwise unchanged.
create or replace function public.bot_context(p_chat_id bigint, p_tg_user_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'worker',     (select to_jsonb(w) from public.workers w where w.telegram_user_id = p_tg_user_id),
    'session',    (select to_jsonb(s) from public.chat_sessions s where s.chat_id = p_chat_id),
    'group_link', (select to_jsonb(g) from public.group_links g where g.chat_id = p_chat_id),
    'settings',   (select jsonb_object_agg(key, value) from public.settings
                    where key in ('timezone', 'flag_distance_km')),
    'open_report',(select to_jsonb(r) from public.reports r
                    where r.worker_id = (select id from public.workers where telegram_user_id = p_tg_user_id)
                      and r.status = 'open' order by r.id desc limit 1)
  )
$$;
revoke execute on function public.bot_context(bigint, bigint) from public, anon, authenticated;
