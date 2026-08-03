-- A Telegram group chat pinned to one site: everything posted there files to it.
create table public.group_links (
  chat_id bigint primary key,
  project_id bigint not null references public.projects (id) on delete cascade,
  chat_title text,
  linked_by bigint references public.workers (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index group_links_project_idx on public.group_links (project_id);

create trigger group_links_set_updated_at before update on public.group_links
  for each row execute function public.tg_set_updated_at();

alter table public.group_links enable row level security;
-- dashboard: admins can see which group feeds which site
create policy group_links_admin_select on public.group_links for select to authenticated
  using ((select private.is_admin()));
-- writes: service role (the bot) only
