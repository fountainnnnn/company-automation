-- ============================================================
-- Review fixes: attendance openness, pending media, profiles
-- bootstrap, storage delete, project stats, cleanup
-- ============================================================

-- 1. "Open shift" is now defined by the no_checkout flag, not review_status,
--    so flagging/clearing a row never orphans a live check-in and the admin
--    clearing a flag never blocks/unblocks the bot unexpectedly.
drop index if exists public.attendance_open_per_worker_uidx;
create unique index attendance_open_per_worker_uidx on public.attendance (worker_id)
  where check_out_at is null and not ('no_checkout' = any(flags));

-- Cron: flag only genuinely stale rows (18h — a night shift is never caught mid-shift)
select cron.unschedule('flag-missing-checkouts');
select cron.schedule(
  'flag-missing-checkouts',
  '0 18 * * *',
  $$
  update public.attendance
     set flags = array_append(flags, 'no_checkout'),
         review_status = 'pending'
   where check_out_at is null
     and not ('no_checkout' = any(flags))
     and check_in_at < now() - interval '18 hours'
  $$
);

-- 2. Pending media moves from the racy session-draft JSON into a real table:
--    concurrent album parts INSERT rows instead of read-modify-writing one blob.
create table public.pending_media (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  media jsonb not null,
  caption text,
  created_at timestamptz not null default now()
);
create index pending_media_chat_idx on public.pending_media (chat_id);
alter table public.pending_media enable row level security; -- service role only

-- 3. Original filenames are worth keeping for documents/videos.
alter table public.report_media add column file_name text;

-- 4. Unused FTS infrastructure removed (search is ILIKE substring by design).
alter table public.reports drop column search_vector;

-- 5. Every new auth user gets a profiles row (default staff) — no silent
--    role-less accounts, no admin bootstrap deadlock on rebuild.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), 'staff')
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- 6. Admins may delete media objects (report delete cleans the bucket).
create policy site_media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'site-media' and (select private.is_admin()));

-- 7. Per-project aggregates + cover in one call (replaces unbounded client scans).
create or replace function public.project_stats()
returns table (
  project_id bigint,
  report_count bigint,
  media_count bigint,
  last_activity timestamptz,
  cover_path text
)
language sql stable security invoker set search_path = '' as $$
  with agg as (
    select r.project_id,
           count(distinct r.id) as report_count,
           count(m.id) as media_count,
           max(greatest(r.created_at, coalesce(m.created_at, r.created_at))) as last_activity
    from public.reports r
    left join public.report_media m on m.report_id = r.id
    group by r.project_id
  ), covers as (
    select distinct on (r.project_id) r.project_id, m.storage_path
    from public.report_media m
    join public.reports r on r.id = m.report_id
    where m.media_type = 'photo'
    order by r.project_id, m.created_at desc
  )
  select a.project_id, a.report_count, a.media_count, a.last_activity, c.storage_path
  from agg a
  left join covers c using (project_id)
$$;
