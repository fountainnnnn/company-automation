# CL Automation — Site Reporting & Attendance Pipeline

Telegram bot (**@CLAutomationBot**) → Supabase (`automation` project) → Web dashboard.

Three things flow through it:

1. **Site records** — workers send photos/videos/documents with a description; archived by
   **project + date + worker** and searchable.
2. **Timesheets** — a supervisor pastes the day's crew list (`date, team, location` then
   `WorkerID - hours/reason` per line); the bot parses it into rows the office can filter.
3. **GPS attendance** — `/checkin` and `/checkout` with a mandatory location tap, flagged
   when the two points are far apart.

Timesheets and GPS attendance are **separate and complementary**: attendance proves an
individual reached the site, the timesheet is the supervisor's record of the whole crew —
including no-shows, which produce no GPS event at all.

**Status: live.** Webhook registered, schema deployed, dashboard built and tested.

## The pieces

| Piece | Where | Notes |
|---|---|---|
| Telegram bot | Supabase Edge Function `telegram-webhook` (v3) | Stateless; webhook mode with secret-token validation |
| Database + storage | Supabase `odsofzzjniafttbdhtye` (ap-northeast-1) | Postgres + private `site-media` bucket; full RLS |
| Dashboard | `dashboard/` (Vite + React + TS) | `npm run dev` locally · `npm run build` for deploy |
| Migrations | `supabase/migrations/*.sql` | Already applied to the live project (5 files) |
| Test harness | `scripts/tg_update.py` | Drives the real webhook with synthetic Telegram updates |

## Logins & secrets

See [docs/CREDENTIALS.md](docs/CREDENTIALS.md) (admin + staff dashboard logins).
Bot token + webhook secret live in the `app_secrets` table (service-role only).
Rotate the token via @BotFather `/revoke` → update the `telegram_bot_token` row → re-run `setWebhook`.

## Running the dashboard

```bash
cd dashboard && npm run dev
```

Deploy: `npm run build` → host `dist/` anywhere static (Vercel recommended; add a SPA
rewrite so deep links like `/projects/2` resolve to index.html).

## How the bot works (worker's view)

1. Message @CLAutomationBot → send your **full name** → wait for admin approval
   (admin approves + assigns projects in dashboard → Workers).
2. Send photos/videos/files — saved instantly to your active project
   (`/project` to switch; captions become searchable notes; buttons on the
   confirmation let you add a note, change the date, or move project).
3. `/checkin` and `/checkout` — one tap on the 📍 button each. **No location = no log**
   (enforced in the schema, not just the flow).
4. Check-in/out points ≥ **10 km** apart (Settings-tunable) → flagged for admin review.
   Forgotten checkouts are flagged nightly (rows older than 18 h, so night shifts are safe).
5. **Timesheets** — paste the day's list (or use `/timesheet`). The bot recognises a roster
   automatically, e.g.:

   ```
   03/08 Team 2 Tuas
   (W101 - 8)
   (W104 - 8.5)
   (W107 - 8 driver)
   (W142 - MC)
   ```

   It reads the date (day-first), team, location, and each worker's hours **or** reason for
   no-show, plus `driver`/`welder`/`supervisor` roles. A confirmation card lets you fix the
   date/team/location before saving. Anything it can't read is shown back under
   *"Couldn't read"* — never dropped silently.

## Operating notes

- **Approve workers**: Dashboard → Workers → pending card → Approve (+ assign projects, optional default).
- **Flags queue**: Dashboard → Attendance (admin only). Clear with an optional note.
  **"View map"** opens an interactive map (Leaflet + OpenStreetMap, no API key) showing the
  check-in pin, the check-out pin, a dashed connector labelled with the straight-line
  distance, and the registered site marker — so you can see at a glance whether the worker
  arrived on site and where they ended up. External map links and raw coordinates stay
  beneath it as a fallback.
- **Locale**: the system assumes **Singapore only** — `Asia/Singapore` timezone, day-first
  dates, 24-hour times, metric distances, maps centred on Singapore.
- **Threshold**: Dashboard → Settings. The bot picks changes up within 60 s.
- **Purge the test data** created during the build: run `scripts/purge-test-data.sql` in the Supabase SQL editor.
- **New dashboard users**: invite via Supabase Auth dashboard; a `profiles` row (role `staff`)
  is auto-created — promote to `admin` by updating `profiles.role`.
- **Worker IDs**: Dashboard → Workers → set each person's **Worker ID** (the code supervisors
  write in rosters), role and team. A roster naming an unknown ID still saves — the row shows
  as *"unknown ID"*, and assigning that code later **retroactively links their whole history**.
- **Timesheets**: Dashboard → Timesheets. Filter by date range, team, role, location, or
  worker (ID or name); "Roster" on any row shows the supervisor's original message verbatim.
  Export CSV honours the current filter.

## Known limitations / accepted risks

1. **Real-photo round trip untested**: everything was tested against the live webhook +
   database, but no real Telegram account has sent a photo yet (that requires a human
   Telegram session). First thing to try after waking up: message the bot, register,
   approve yourself in the dashboard, send a photo. The `getFile → storage` path has
   failure reporting either way (never silently claims "Saved").
2. **Staff API surface**: staff logins can read `workers` rows (incl. telegram usernames)
   and `projects` site coordinates via the REST API even though the UI doesn't show them.
   Attendance GPS is fully blocked for staff. If this matters, move staff reads to
   restricted views.
3. **Leaked-password protection** (Supabase advisor WARN): enable in Dashboard → Auth →
   Passwords (can't be toggled via API).
4. Telegram bot API caps downloads at ~20 MB per file — very long videos should be sent
   as documents or split.
5. **Placeholder data is currently loaded** (6 sites, 9 workers, ~130 reports with 324 real
   image/PDF files, 219 GPS shifts, 94 timesheets). Clear it with
   `scripts/purge-test-data.sql` **and** `python scripts/purge_storage.py --yes` — the SQL
   clears rows, the script clears the uploaded files.
6. **Timesheet formats deliberately not parsed**: month-name dates (`12 Aug`), time ranges
   (`8am-5pm` — break deduction is a policy call), worker-ID ranges (`101-105 - 8`), and
   hours > 24. These land in *"Couldn't read"* for the supervisor to correct rather than
   being guessed at.

## Architecture / decision history

See [PLAN.md](PLAN.md). Design system: [docs/DESIGN.md](docs/DESIGN.md).
