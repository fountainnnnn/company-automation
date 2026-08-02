# CL Automation — Site Reporting & Attendance Pipeline

Telegram bot (**@CLAutomationBot**) → Supabase (`automation` project) → Web dashboard.
Workers send site photos/videos/documents and check in/out with GPS; everything is
archived by **project + date + worker** and searchable in the dashboard.

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

## Operating notes

- **Approve workers**: Dashboard → Workers → pending card → Approve (+ assign projects, optional default).
- **Flags queue**: Dashboard → Attendance (admin only). Clear with an optional note; map links show both GPS points.
- **Threshold**: Dashboard → Settings. The bot picks changes up within 60 s.
- **Purge the test data** created during the build: run `scripts/purge-test-data.sql` in the Supabase SQL editor.
- **New dashboard users**: invite via Supabase Auth dashboard; a `profiles` row (role `staff`)
  is auto-created — promote to `admin` by updating `profiles.role`.

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

## Architecture / decision history

See [PLAN.md](PLAN.md). Design system: [docs/DESIGN.md](docs/DESIGN.md).
