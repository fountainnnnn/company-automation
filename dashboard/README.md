# CL Automation — dashboard

Vite + React 19 + TypeScript SPA for the site reporting & attendance pipeline
(see `../PLAN.md` §6 and `../docs/DESIGN.md`).

```bash
npm install
npm run dev      # local
npm run build    # tsc -b && vite build
npm run lint     # oxlint
```

## Structure

- `src/lib` — Supabase client, auth context, shared types, date/format helpers,
  signed-URL cache, report queries, small hooks.
- `src/components` — primitives (Button, Card, Modal, Toast, Skeleton, EmptyState,
  FilterBar, Lightbox) plus the app shell and report card.
- `src/pages` — one file per route.
- `src/styles` — `tokens.css` (design tokens) and `base.css` (everything else).

## Routes

| Path | Access | View |
|---|---|---|
| `/login` | public | Sign in |
| `/` | any | Projects grid |
| `/projects/:id` | any | Project gallery (realtime) |
| `/search` | any | Global search |
| `/attendance` | admin | Flags queue + day table |
| `/workers` | admin | Approve / assign / disable workers |
| `/projects-admin` | admin | Create, edit, archive projects |
| `/settings` | admin | Flag distance threshold |

Roles come from `profiles.role`. Admin-only areas are hidden in the UI and
enforced server-side by RLS.

## Notes

- Media lives in the private `site-media` bucket and is rendered through batched
  1-hour signed URLs cached in `src/lib/signedUrls.ts`.
- The Supabase URL and publishable key are client-side by design; all access
  control is RLS.
