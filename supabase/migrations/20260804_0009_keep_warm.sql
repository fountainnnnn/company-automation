-- Keep the webhook isolate warm: a cold start adds ~1-2s to the first message
-- after an idle spell, which is exactly the moment a worker is watching.
-- The ping carries no secret header, so the function answers 401 in a few ms —
-- but only after loading config, which is what keeps it warm.
create extension if not exists pg_net;

select cron.schedule(
  'keep-webhook-warm',
  '*/4 * * * *',
  $$
  select net.http_get(
    url := 'https://odsofzzjniafttbdhtye.supabase.co/functions/v1/telegram-webhook',
    timeout_milliseconds := 5000
  )
  $$
);
