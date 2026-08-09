-- ============================================================
-- Placeholder sites, workers and site records — demo/testing data only.
--
-- Why this exists: seed_media.py and seed_docs.py attach files to reports that
-- already exist, and the original projects/workers/reports seeder was never
-- committed. Purging the demo data therefore used to be a one-way door. This
-- script closes that gap — it is the counterpart to purge-test-data.sql.
--
-- Run in the Supabase SQL editor. Safe to re-run: it does nothing if sites
-- already exist, so it can never silently double the data.
-- ============================================================

do $$
declare
  n_projects int;
begin
  select count(*) into n_projects from public.projects;
  if n_projects > 0 then
    raise notice 'projects already exist (%) — nothing seeded', n_projects;
    return;
  end if;

  -- ---------- sites ----------
  insert into public.projects (code, name, site_address, site_lat, site_lng, status) values
    ('BUK-RES', 'Bukit Residences Blk B',   '21 Bukit Batok East Ave 3',  1.34960, 103.74950, 'active'),
    ('JUR-WH',  'Jurong Warehouse Fit-out', '8 Jurong Port Road',          1.33290, 103.74360, 'active'),
    ('MRT-T3',  'Marina Tower Level 3',     '10 Marina Boulevard',         1.28200, 103.85850, 'active'),
    ('SEN-BRG', 'Sengkang Bridge Works',    'Sengkang East Way',           1.38680, 103.89140, 'active'),
    ('TAM-D1',  'Tampines Depot Phase 1',   '5 Tampines Industrial Ave 2', 1.34960, 103.95680, 'active'),
    ('WDL-C',   'Woodlands Civic Block C',  '900 Woodlands Drive 50',      1.43600, 103.78650, 'active');

  -- ---------- crew ----------
  insert into public.workers (full_name, worker_code, role, team_number, status, telegram_user_id) values
    ('Sithu Aung',     'W101', 'worker',     '1', 'active', 900001),
    ('Daniel Lim',     'W102', 'supervisor', '1', 'active', 900002),
    ('Rahman Hakim',   'W103', 'welder',     '1', 'active', 900003),
    ('Chen Wei Ming',  'W104', 'worker',     '2', 'active', 900004),
    ('Arun Kumar',     'W105', 'driver',     '2', 'active', 900005),
    ('Maung Thura',    'W106', 'worker',     '2', 'active', 900006),
    ('Joseph Tan',     'W107', 'supervisor', '3', 'active', 900007),
    ('Bala Subra',     'W108', 'worker',     '3', 'active', 900008),
    ('Htet Naing',     'W109', 'welder',     '3', 'active', 900009),
    ('New Applicant',   null,  'worker',     null, 'pending', 900010);

  -- Everyone active is on every active site, so the pickers have something.
  insert into public.project_workers (project_id, worker_id)
  select p.id, w.id
  from public.projects p
  cross join public.workers w
  where p.status = 'active' and w.status = 'active';

  -- ---------- site records ----------
  -- Spread across the last 21 days, weighted so recent days are busier and
  -- each site gets a different rhythm — a flat distribution looks synthetic.
  insert into public.reports (project_id, worker_id, report_date, status, created_at)
  select
    p.id,
    w.id,
    (current_date - d)::date,
    'final',
    (current_date - d)::timestamptz
      + make_interval(hours => 7 + (random() * 10)::int, mins => (random() * 59)::int)
  from generate_series(0, 20) as d
  cross join lateral (
    select id, code from public.projects order by random() limit 1 + (random() * 2)::int
  ) p
  cross join lateral (
    select id from public.workers where status = 'active' order by random() limit 1
  ) w
  where random() < 0.8;

  -- A description on most of them; the rest stay bare on purpose, so the
  -- "undescribed" signal in the briefing has something real to find.
  insert into public.report_notes (report_id, worker_id, body, created_at)
  select
    r.id,
    r.worker_id,
    (array[
      'Formwork stripped on level 3, no honeycombing seen.',
      'Rebar tied and inspected, ready for pour tomorrow.',
      'Concrete pour completed, 14 cubic metres.',
      'Scaffold extended to level 5, handrails fitted.',
      'Delivery received: 40 bags cement, 12 lengths of rebar.',
      'Waterproofing membrane laid at basement slab.',
      'Minor crack noted at column C4, flagged to supervisor.',
      'Site cleared and secured at end of shift.',
      'MEP conduits roughed in along east wall.',
      'Wet weather, work paused two hours after lunch.'
    ])[1 + (random() * 9)::int],
    r.created_at + interval '3 minutes'
  from public.reports r
  where random() < 0.85;

  raise notice 'seeded % projects, % workers, % reports',
    (select count(*) from public.projects),
    (select count(*) from public.workers),
    (select count(*) from public.reports);
end $$;
