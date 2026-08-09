-- ============================================================
-- Keep the focus briefing current without anyone pressing anything.
--
-- The dashboard reads whatever briefing is stored, so freshness is entirely a
-- question of who writes it. This schedules the writer.
--
-- site-summary authenticates the caller itself (admin session, or this shared
-- secret) because the publishable key ships in the dashboard bundle — "any
-- valid JWT" would let anyone spend model credits.
-- ============================================================

-- Generated in the database so the secret never passes through a file, a log,
-- or a chat window. ~256 bits.
insert into public.app_secrets (key, value)
values (
  'summary_cron_secret',
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
)
on conflict (key) do nothing;

-- Every two hours. The function itself declines to spend a call when nothing
-- has been reported since the last briefing, so quiet nights cost nothing.
select cron.schedule(
  'refresh-focus-summary',
  '0 */2 * * *',
  $$
  select net.http_post(
    url := 'https://odsofzzjniafttbdhtye.supabase.co/functions/v1/site-summary',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select value from public.app_secrets where key = 'summary_cron_secret')
    ),
    body := jsonb_build_object('days', 7),
    timeout_milliseconds := 55000
  )
  $$
);
