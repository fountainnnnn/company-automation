-- Purge the synthetic data created while building/testing the pipeline.
-- Run in the Supabase SQL editor when you're ready to start fresh.
-- Keeps: projects, dashboard users, settings, secrets.

delete from public.report_media;
delete from public.reports;
delete from public.attendance;
delete from public.pending_media;
delete from public.chat_sessions;
delete from public.project_workers;
delete from public.workers;  -- removes 'Test Worker One' / 'Second Tester'

-- Optionally rename the placeholder projects:
-- update public.projects set name = 'Real name', site_address = '...' where code = 'SITE-A';
