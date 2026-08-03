# Dashboard design spec — v2 (reference-derived + glassmorphism)

Supersedes the v1 glow-card spec. **Layout and card language** come from a supplied
SaaS-dashboard reference (SellPilot); the **palette and type** come from a supplied
style guide (blue/gray, Haurora Sans); plus a **glass layer** on the chrome.

---

## 1. Palette (from the supplied style guide)

| Token | Value | Use |
|---|---|---|
| `--blue` | `#1153ED` | primary accent: primary buttons, active nav, links, focus rings |
| `--blue-dark` | `#03369D` | pressed/hover-deep state, dark bands, banner gradient end |
| `--blue-light` | `#DFE9FF` | tints: active nav fill, selected rows, badge backgrounds |
| `--light` | `#F2F4F7` | page surface |
| `--white` | `#FFFFFF` | cards, tables, dense-text surfaces |
| `--gray-light` | `#DBE1E8` | hairlines, borders, dividers, disabled fills |
| `--gray` | `#767A8C` | secondary/muted text, icon default |
| `--gray-dark` | `#4B5666` | body text on light surfaces, table cells |
| `--dark` | `#131415` | headings, primary ink |

> The style-guide image labels the blue swatch `#131415`, which is a copy-paste slip —
> its RGB (17, 83, 237) is authoritative, so **blue = `#1153ED`**.

Derived: hairline `#DBE1E8`; blue tint `rgba(17,83,237,.08)`; ink scale
`--dark` → `--gray-dark` → `--gray`.

**Status** (semantic, outside the brand ramp): ok `#16A34A` · warn `#E8871A` ·
flag `#DC2626` · info `#1153ED`. Tints = same hue at 10% over white, text stays the dark hue.

**Chart series** — fixed order, re-validated against white for this palette
(passes all-pairs CVD and normal-vision gates; the green carries a contrast WARN,
so it always ships with direct labels + legend):

`1 #1153ED` blue · `2 #EB6834` orange · `3 #1BAF7A` green

## 1b. Typography

Haurora Sans is not a distributable font, so the stack tries it first and falls back to
a close geometric match that we self-host (`@fontsource-variable/plus-jakarta-sans`):

```css
--font: "Haurora Sans", "Plus Jakarta Sans Variable", system-ui, -apple-system, sans-serif;
```

Scale (from the guide): 34 / 28 / 22 / 16 / 14 / 12 px.
Weights: **Medium 500** (default UI), **SemiBold 600** (labels, table heads, buttons),
**Bold 700** (page titles, stat numbers). Headings use -0.02em tracking; numbers use
`font-variant-numeric: tabular-nums`.

---

## 2. Glassmorphism — where it is allowed

Glass goes on **chrome and floating layers only**. Dense data always sits on solid
white. This is the rule that keeps glassmorphism from becoming unreadable.

| Layer | Treatment |
|---|---|
| Sidebar | `rgba(255,255,255,.72)` + `backdrop-filter: blur(20px) saturate(1.6)`, hairline right border |
| In-content topbar | `rgba(255,255,255,.65)` + `blur(18px)`, hairline bottom, sticky |
| Modals / drawers / lightbox chrome | `rgba(255,255,255,.80)` + `blur(24px)`, 1px `rgba(255,255,255,.6)` inner top highlight |
| Popovers, tooltips, chart tooltip, toasts | `rgba(255,255,255,.85)` + `blur(16px)` |
| Stat tiles (right rail) | subtle: `rgba(255,255,255,.78)` + `blur(12px)` |
| **Tables, galleries, forms, long text** | **solid `#FFFFFF` — never glass** |

Rules: never glass directly on glass (frost the top layer only); every glass surface
needs a hairline border or it dissolves; provide `@supports not (backdrop-filter: blur(1px))`
fallbacks to solid `#FFFFFF` at 96% opacity.

Behind the glass sits one soft ambient wash (blue `#1153ED` → light blue `#DFE9FF`,
~8% opacity, blurred 120px, fixed, reduced-motion-frozen) so the blur has something to do.

---

## 3. Layout

```
┌────────────┬─────────────────────────────────────────────┐
│            │  topbar: title · search · icon actions      │
│  sidebar   ├─────────────────────────────────────────────┤
│  248px     │  [ optional banner strip ]                  │
│  glass     │  ┌───────────────────────┬────────────────┐ │
│            │  │ main column (2fr)     │ right rail 1fr │ │
│            │  │ chart card            │ stat card      │ │
│            │  │ table card            │ stat card      │ │
│            │  │                       │ activity list  │ │
│            │  └───────────────────────┴────────────────┘ │
└────────────┴─────────────────────────────────────────────┘
```

- Content grid: `grid-template-columns: minmax(0,2fr) minmax(300px,1fr)`, 20px gap.
  Collapses to one column under 1100px. Right rail moves **below** main on collapse.
- Page padding 24px; max width 1440.

### Sidebar (per reference)
- Brand row: mark + wordmark, plus a collapse affordance on the right.
- Nav items: icon + label, 40px high, 10px radius. Active = light-blue fill (`--blue-light`) + blue text
  (+ a 3px blue left indicator). Hover = 4% blue tint.
- **Expandable groups** with a chevron that rotates 180° on open; children indent to 34px
  with no icon, smaller type.
- **Badges** inline right: count pills (e.g. `06` in flag red tint) and label pills
  (e.g. `Pro`-style, here used for `NEW`).
- **Section label**: 0.68rem, 600, uppercase, 0.08em tracking, tertiary ink, 20px top margin.
- Footer block: secondary links (Settings, Sign out), then the user row — avatar circle,
  name, role, chevron.

### Topbar (inside the content column, per reference)
Sticky, glass. Left: page title. Centre: search input, 380px max,
pill radius, muted magnifier icon. Right: circular icon buttons (36px, hairline, white)
for notifications etc., then the avatar chip with chevron.

### Page titles — say what the page is, nothing more
The title is the **plain name of the page**: `Overview`, `Projects`, `Timesheets`,
`Attendance`, `Workers`, `Settings`. 1.35rem, weight 600, `--dark`.

- No marketing sentences, no full stops, no eyebrow line above it, no
  "question → answer" phrasing ("What the sites did this week." → **`Overview`**).
- The title matches the nav label exactly, so the sidebar and the heading agree —
  a user should never have to work out which page they landed on.
- A subtitle is only allowed when it states a fact the user cannot infer
  (e.g. a filtered count or a date range). Default to omitting it.
- Section headings inside a page follow the same rule: name the thing
  (`Flags queue`, `Hours by role`), don't narrate it.

### Banner strip (optional, top of Overview)
Full-width, 16px radius, **blue gradient** (`#1153ED → #03369D`), white text,
left icon in a translucent rounded square, right white pill button. Used for the
"needs attention" call-to-action; hidden when nothing needs attention.

---

## 4. Components

**Card** — white, 16px radius, `1px solid hairline`, `0 1px 2px rgba(19,20,21,.04), 0 12px 28px -18px rgba(19,20,21,.16)`, 20px padding. Header row: title (1rem, 500) left, controls right (range select, checkbox toggles, icon buttons).

**Stat card (right rail)** — label (0.8rem, secondary) · big number (1.9rem, 500, tabular-nums) · delta line (`+20% vs last month`, ok/flag colour) · **44px tinted rounded-square icon** left of the number · **sparkline** bottom-right (60×28, 2px stroke, series colour, no axes) · small arrow-out button top-right linking to the detail page.

**Status pill** — 6px/10px padding, pill radius, tinted background, dark hue text, 0.75rem/600, with a leading 6px dot or small icon. Never colour alone — the label carries the meaning.

**Table** — solid white, sticky header row (0.72rem, 600, uppercase, tertiary ink, hairline under), 48px rows, hairline separators, hover = `--light`. Sortable headers show a two-arrow glyph. Checkbox column when bulk actions exist. Toolbar above: search input + view toggle + filter icon buttons.

**Activity / notification list** — rows of: tinted round icon · title + one-line sub · timestamp (tertiary, right) · dismiss ✕ on hover. Footer "View all" ghost button.

**Buttons** — primary `--blue` fill, white text, 10px radius, `0 1px 2px rgba(19,20,21,.16), 0 8px 20px -8px rgba(17,83,237,.45)`; hover deepens to `--blue-dark` and lifts 1px; active presses back; disabled = `--gray-light` fill with `--gray` text. Secondary = white + hairline. Ghost = `--blue-light` on hover. Icon buttons 36px square, hairline, white, hover `--blue-light`. Heights 36/40/44.

**Inputs** — 38px, 10px radius, hairline, white; focus = 2px `--blue` ring + hairline→blue.

---

## 5. Motion
Reveals opacity+8px translateY 400ms once. Cards/rows hover 120ms. Modals scale .98→1 + fade 200ms. Sidebar group expand = height/opacity 200ms. Sparklines and chart paths draw once, 600ms. Transform/opacity only. Everything above is disabled under `prefers-reduced-motion`.

## 5b. Locale — Singapore only

The company operates solely in Singapore. Everything assumes it:

- Timezone `Asia/Singapore` (already the bot + dashboard default).
- Dates are **day-first**: `3 Aug 2026`, `03/08/2026`. Never US month-first.
- 24-hour clock (`16:13`), matching how the crews write times.
- Maps default-centre on Singapore (`1.3521, 103.8198`, zoom 11) when there is
  nothing to fit; coordinates far outside roughly `1.15–1.48 N, 103.6–104.1 E`
  are worth surfacing as suspicious rather than silently plotting.
- Metric only — metres and kilometres.

## 6. Non-negotiables
- Glass on chrome; **solid white under dense text**. No glass on glass.
- Brand blue is for interaction (buttons, active state, focus). It is NOT a status colour —
  green/amber/red mean ok/warn/flag and are never reused as decoration.
- Categorical chart hues fixed and never rank-based; one y-axis; legend for ≥2 series.
- `min-w-0` + truncate + `title` on every cell that can overflow.
- Contrast ≥ 4.5:1 for text — check ink on glass over the ambient wash, not over plain white.
- Real `<button>`/`<label>`, visible focus rings, no page-level horizontal scroll at 375px.
