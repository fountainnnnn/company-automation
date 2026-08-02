-- ============================================================
-- Storage bucket, realtime, nightly no-checkout flagging, base settings
-- ============================================================

-- ---------- private media bucket ----------
insert into storage.buckets (id, name, public)
values ('site-media', 'site-media', false)
on conflict (id) do nothing;

-- dashboard users may read (signed URLs / downloads); only service role writes
create policy site_media_read on storage.objects for select to authenticated
  using (bucket_id = 'site-media');

-- ---------- realtime feed for the dashboard ----------
alter publication supabase_realtime add table public.reports;
alter publication supabase_realtime add table public.report_media;
alter publication supabase_realtime add table public.attendance;

-- ---------- nightly close of forgotten checkouts (02:00 SGT = 18:00 UTC) ----------
create extension if not exists pg_cron;

select cron.schedule(
  'flag-missing-checkouts',
  '0 18 * * *',
  $$
  update public.attendance
     set flags = array_append(flags, 'no_checkout'),
         review_status = 'pending'
   where check_out_at is null
     and not ('no_checkout' = any(flags))
     and check_in_at < now() - interval '4 hours'
  $$
);

-- ---------- base settings ----------
insert into public.settings (key, value) values
  ('flag_distance_km', '10'),
  ('timezone', '"Asia/Singapore"')
on conflict (key) do nothing;

-- ---------- hardening: pin search_path on trigger fn (advisor 0011) ----------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;
