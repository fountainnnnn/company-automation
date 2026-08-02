-- race-safe album grouping: one report per Telegram media_group_id
-- (unique allows unlimited NULLs; only album reports carry a value)
alter table public.reports add column album_group_id text unique;
