-- ============================================================
-- The bot stops writing to `workers` entirely.
--
-- Before: an admin created a worker row carrying a @username, and the worker's
-- first message bound it to their Telegram id (`claimPreregistered`). That was
-- the bot's only write to the table.
--
-- Now: workers are created in the dashboard and nowhere else, so bot_context
-- resolves them by username as well as by id. Nothing needs to be written back
-- on first contact, and an unknown sender is simply told to ask an admin.
--
-- Trade-off worth knowing: Telegram usernames are mutable. If a worker changes
-- theirs, they stop being recognised until an admin updates the row. Matching
-- prefers telegram_user_id when it is set, so populating that column (by hand,
-- or from a future dashboard field) makes a worker immune to the change.
-- ============================================================

drop function if exists public.bot_context(bigint, bigint);

create function public.bot_context(
  p_chat_id bigint,
  p_tg_user_id bigint,
  p_username text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select w.*
    from public.workers w
    where w.telegram_user_id = p_tg_user_id
       or (
         p_username is not null
         and w.telegram_username is not null
         and lower(w.telegram_username) = lower(p_username)
       )
    order by (w.telegram_user_id = p_tg_user_id) desc nulls last
    limit 1
  )
  select jsonb_build_object(
    'worker',     (select to_jsonb(m) from me m),
    'session',    (select to_jsonb(s) from public.chat_sessions s where s.chat_id = p_chat_id),
    'group_link', (select to_jsonb(g) from public.group_links g where g.chat_id = p_chat_id),
    'settings',   (select jsonb_object_agg(key, value) from public.settings
                    where key in ('timezone')),
    'open_report',(select to_jsonb(r) from public.reports r
                    where r.worker_id = (select id from me)
                      and r.status = 'open' order by r.id desc limit 1)
  )
$$;

revoke execute on function public.bot_context(bigint, bigint, text) from public, anon, authenticated;
