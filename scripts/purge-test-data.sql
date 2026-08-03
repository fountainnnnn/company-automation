-- ============================================================
-- Purge ALL placeholder/demo data created while building the pipeline.
-- Run in the Supabase SQL editor when you're ready to go live.
--
-- Keeps: dashboard logins (profiles/auth users), settings, bot secrets.
-- Removes: seeded projects, workers, reports, media rows, attendance,
--          chat sessions.
--
-- IMPORTANT: run scripts/purge_storage.py afterwards (or delete the
-- project_* folders in Storage → site-media by hand). The SQL below only
-- clears database rows; the uploaded image/PDF objects live in Storage.
-- ============================================================

begin;

delete from public.report_media;
delete from public.reports;
delete from public.attendance;
delete from public.pending_media;
delete from public.chat_sessions;
delete from public.project_workers;
delete from public.workers;
delete from public.projects;

-- Identity counters restart so real data begins at 1.
alter sequence if exists projects_id_seq restart with 1;
alter sequence if exists workers_id_seq restart with 1;
alter sequence if exists reports_id_seq restart with 1;
alter sequence if exists report_media_id_seq restart with 1;
alter sequence if exists attendance_id_seq restart with 1;

commit;

-- Then create the real sites, e.g.:
-- insert into public.projects (code, name, site_address)
-- values ('ABC-01', 'Actual Site Name', '12 Real Road');
--
-- Workers add themselves by messaging the bot; approve them in Dashboard → Workers.
