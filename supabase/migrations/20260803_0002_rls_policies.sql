-- ============================================================
-- RLS: default-deny; staff = read galleries, admin = everything
-- ============================================================

-- security-definer role helper (bypasses RLS on profiles, no recursion)
create schema if not exists private;

create or replace function private.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;
revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- enable RLS everywhere
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.workers enable row level security;
alter table public.project_workers enable row level security;
alter table public.reports enable row level security;
alter table public.report_media enable row level security;
alter table public.attendance enable row level security;
alter table public.settings enable row level security;
alter table public.app_secrets enable row level security;
alter table public.chat_sessions enable row level security;

-- anon gets nothing anywhere (no policies for anon at all)

-- ---------- profiles: see self; admins see + manage all ----------
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
create policy profiles_admin_insert on public.profiles for insert to authenticated
  with check ((select private.is_admin()));
create policy profiles_admin_update on public.profiles for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy profiles_admin_delete on public.profiles for delete to authenticated
  using ((select private.is_admin()));

-- ---------- projects / reports / media / workers: staff read, admin write ----------
create policy projects_select on public.projects for select to authenticated using (true);
create policy projects_admin_write on public.projects for insert to authenticated
  with check ((select private.is_admin()));
create policy projects_admin_update on public.projects for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy projects_admin_delete on public.projects for delete to authenticated
  using ((select private.is_admin()));

create policy workers_select on public.workers for select to authenticated using (true);
create policy workers_admin_write on public.workers for insert to authenticated
  with check ((select private.is_admin()));
create policy workers_admin_update on public.workers for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy workers_admin_delete on public.workers for delete to authenticated
  using ((select private.is_admin()));

create policy project_workers_select on public.project_workers for select to authenticated using (true);
create policy project_workers_admin_write on public.project_workers for insert to authenticated
  with check ((select private.is_admin()));
create policy project_workers_admin_delete on public.project_workers for delete to authenticated
  using ((select private.is_admin()));

create policy reports_select on public.reports for select to authenticated using (true);
create policy reports_admin_update on public.reports for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy reports_admin_delete on public.reports for delete to authenticated
  using ((select private.is_admin()));

create policy report_media_select on public.report_media for select to authenticated using (true);
create policy report_media_admin_delete on public.report_media for delete to authenticated
  using ((select private.is_admin()));

-- ---------- attendance: ADMIN ONLY, staff get zero rows ----------
create policy attendance_admin_select on public.attendance for select to authenticated
  using ((select private.is_admin()));
create policy attendance_admin_update on public.attendance for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- ---------- settings: admin only ----------
create policy settings_admin_all on public.settings for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- app_secrets + chat_sessions: NO policies — service_role only.
