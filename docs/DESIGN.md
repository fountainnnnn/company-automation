# Dashboard design spec — glow-card system, ops-dashboard adaptation

Direction: house glow-card format (skill default; user asleep, per-goal no questions).
Structural/a11y layer: audit against web-design-guidelines before sign-off.

## Palette (construction brand, warm neutrals)
- Base surface: `#F7F6F3` (warm porcelain) · Cards/panels: `#FFFFFF`
- Ink: `#1C1917` · Secondary ink: `#78716C` · Hairline: `rgba(28,25,23,.08)`
- Accent: amber `#F59E0B` (safety amber — construction-native)
- Secondary hues for glow rotation: sky `#38BDF8`, violet `#8B5CF6`
- Deep band / dark tone: `#1C1917` (warm near-black, never pure black)
- Status: ok `#16A34A`, warn `#D97706`, flag `#DC2626`, info `#2563EB`

## Grammar → dashboard mapping
- **Login page** = the hero moment: centered glow card (radial top glow amber→sky resolving to white by 60%), gradient eyebrow "CL AUTOMATION", weight-500 title ending with a period ("Site records, found in seconds."), form on solid white.
- **Section headers** (each dashboard view): eyebrow (0.75rem, 600, uppercase, 1px tracking, gradient text) + weight-500 title (1.75–2rem in-app scale, -0.02em) + one-line secondary subtitle. One eyebrow per view.
- **Project cards** (Projects grid): glow cards, 20px radius, justify-end label at bottom, top radial glow with **hue pair rotating per card** (amber/sky → sky/violet → violet/amber), real cover = latest site photo (object-fit cover) as the prop; count chips inline beside the h3.
- **Data surfaces** (tables, galleries, drawers): solid white, 16px radius, hairline border, `0 10px 30px -10px rgba(28,25,23,.12)` shadow. No glow behind dense text — glows resolve before content starts.
- **Topbar**: floating glass island (white/70, backdrop-blur, hairline, rounded, soft shadow), appears detached; role chip (Admin amber-tint / Staff neutral).
- **Buttons**: primary amber fill + layered shadow (`0 1px 2px rgba(28,25,23,.18)`, `0 8px 24px rgba(245,158,11,.28)`), hover -1px lift, active press, 150ms. Secondary white/70 glass hairline. Ghost amber tint hover. Heights 36/44.
- **Ambient**: ONE fixed soft orb (70vw, blur 120px, ~10% opacity, amber→sky) drifting 30s; frozen under reduced-motion.
- **Motion**: view transitions + reveals = opacity + 20px translateY 600ms once; modals/drawers scale .98→1 + fade 200ms; counts with tabular-nums. Transform/opacity only.
- **Flags queue**: red-tinted white cards (never red fill) with distance badge; map links as black-outline pill buttons.

## Non-negotiables (inherited)
- Max 2–3 gradient moments per view (eyebrow + one highlighted phrase).
- No glass-on-glass; dense text on solid surfaces only.
- `min-w-0` on flex/grid children; truncate + title attr on names/paths.
- Real assets: covers/galleries use the actual stored photos, empty states use mesh texture, not stock icons.
