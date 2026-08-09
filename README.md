# CL Automation — Site Reporting Pipeline

Telegram bot (**@CLAutomationBot**) → Supabase (`automation` project) → Web dashboard.

One thing flows through it:

**Site records** — workers send photos, videos, documents or plain text; each is archived by
**project + date + worker**, described in the worker's own words, and searchable.

The dashboard adds a written **focus briefing** over that archive: what needs attention
across sites and teams, regenerated on a schedule.

Roster capture, pay calculation and GPS attendance were all removed in August 2026. What
remains is the archive and the reading of it.

**Status: live.** Webhook registered, schema deployed, dashboard built and tested.

## The pieces

| Piece | Where | Notes |
|---|---|---|
| Telegram bot | Supabase Edge Function `telegram-webhook` | Stateless; webhook mode with secret-token validation |
| Focus briefing | Supabase Edge Function `site-summary` | Server-side model call; key in `app_secrets`, cached, `pg_cron` every 2h |
| Database + storage | Supabase `odsofzzjniafttbdhtye` (ap-northeast-1) | Postgres + private `site-media` bucket; full RLS |
| Dashboard | `dashboard/` (Vite + React + TS) | `npm run dev` locally · `npm run build` for deploy |
| Migrations | `supabase/migrations/*.sql` | Already applied to the live project |
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

1. An admin adds you in Dashboard → Workers with your **Telegram username**. There is no
   self-registration — the bot only ever reads that list, and never writes to it. Message
   the bot and it recognises you immediately.
2. Send photos/videos/files — or just type what happened. The bot asks which site, then the
   record stays **open**: keep adding, then tap ✅ Done. Captions become searchable notes,
   and buttons let you add a note, change the date, or move site.
3. **Group mode** — add @CLAutomationBot to a site's group chat, link it once
   (`/link` → pick the site), and from then on every photo/video/file posted by
   anyone lands in that site's archive, credited to the sender, acknowledged with
   a 👍 reaction — the bot never clutters the group with replies. A sender the admin
   hasn't added is not recognised and their post is not filed. `/unlink` to detach.

## Operating notes

- **Add workers**: Dashboard → Workers → **Add worker**. The Telegram username is required —
  it is how the bot recognises them. Assign projects from the same page.
- **Needs review**: Overview, admin only. Exact counts with a link to where you fix each —
  workers awaiting approval, records filed with no description, sites silent over 48 hours.
- **Needs focus**: Overview. A written briefing over the archive, regenerated every two
  hours by `pg_cron` and skipped entirely when nothing new has been reported. Admins can
  force one with **Refresh**. The model key lives in `app_secrets`, never in the bundle.
- **Locale**: the system assumes **Singapore only** — `Asia/Singapore` timezone, day-first
  dates, 24-hour times, metric distances, maps centred on Singapore.
- **Purge the test data** created during the build: run `scripts/purge-test-data.sql` in the Supabase SQL editor.
- **New dashboard users**: invite via Supabase Auth dashboard; a `profiles` row (role `staff`)
  is auto-created — promote to `admin` by updating `profiles.role`.
- **Worker IDs**: Dashboard → Workers → set each person's **Worker ID**, role
  (`worker`/`driver`/`welder`/`supervisor`) and team. These label who a site record came
  from; nothing is calculated from them.

## Known limitations / accepted risks

1. **Real-photo round trip untested**: everything was tested against the live webhook +
   database, but no real Telegram account has sent a photo yet (that requires a human
   Telegram session). First thing to try: add yourself in Dashboard → Workers with your
   Telegram username, message the bot, send a photo. The `getFile → storage` path has
   failure reporting either way (never silently claims "Saved").
2. **Staff API surface**: staff logins can read `workers` rows (incl. telegram usernames)
   and `projects` site coordinates via the REST API even though the UI doesn't show them.
   If this matters, move staff reads to restricted views.
3. **Leaked-password protection** (Supabase advisor WARN): enable in Dashboard → Auth →
   Passwords (can't be toggled via API).
4. Telegram bot API caps downloads at ~20 MB per file — very long videos should be sent
   as documents or split.
5. **Placeholder data is currently loaded** (6 sites, 10 workers, ~34 reports, no media).
   Clear it with `scripts/purge-test-data.sql` **and** `python3 scripts/purge_storage.py --yes`;
   put it back with `scripts/seed-base-data.sql`. Note the media seeders need the service
   role key — `storage.objects` has no INSERT policy for authenticated users.

## Architecture / decision history

See [PLAN.md](PLAN.md). Design system: [docs/DESIGN.md](docs/DESIGN.md).
