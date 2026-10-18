# Redesign — Phase 2: design directions

Two directions, one recommendation. Nothing in `src/` changed.

Each specimen is one static page carrying the same content: app shell with
labelled nav, top bar, page header, KPI strip, saved-view tabs, filter toolbar,
an 8-row PO table (selection, sort, totals row, hover/kebab actions),
"Needs your attention" task list, in-table empty state, every status variant,
buttons × 5 variants × 5 states + sizes, a form (focus, error, disabled,
numeric), performance meters with target ticks, and a drawer + toast over a
scrim. Light and dark for each.

**Side by side** (A left, B right; light top, dark bottom): [`directions/side-by-side.png`](directions/side-by-side.png)

| | Light | Dark |
|---|---|---|
| **A · Ledger** | [first screen](directions/ledger-light__1440x900.png) · [full](directions/ledger-light__full.png) · [html](directions/ledger-light.html) | [first screen](directions/ledger-dark__1440x900.png) · [full](directions/ledger-dark__full.png) · [html](directions/ledger-dark.html) |
| **B · Graphite** | [first screen](directions/graphite-light__1440x900.png) · [full](directions/graphite-light__full.png) · [html](directions/graphite-light.html) | [first screen](directions/graphite-dark__1440x900.png) · [full](directions/graphite-dark__full.png) · [html](directions/graphite-dark.html) |

Tokens for both live in [`directions/tokens.cjs`](directions/tokens.cjs); the
pages are generated from them by [`build.cjs`](directions/build.cjs), and
[`contrast.cjs`](directions/contrast.cjs) checks the same object — so the
numbers below are for exactly what's rendered.

---

## What both share (the brief's constraints, satisfied)

- One sans for UI, one mono **only** for identifiers and amounts
  (PO-2026-0080, GSTIN, GRN, ₹ values). Dates, statuses, prose, roles: sans.
- Sentence case everywhere; zero uppercase. Scale 12/13/14/16/20/24, line
  heights on a 4px grid, `tabular-nums` on `body`.
- Neutral ramp carries the UI; one accent; semantic colours used only on
  state. Status = dot + label in neutral text; a tinted fill appears only on
  states someone must act on (needs acknowledgement, match warning, sync
  failed, rejected).
- KPI strip is one bordered row, not four cards. Zero values render light and
  muted with a hint ("₹0 · Nothing outstanding"), not as a hero number.
- Money right-aligned and decimal-aligned in tables, with Indian grouping and
  the currency in the column header (`Value (₹)`) so every cell aligns.
- Empty state is a single line in the table body with one link.
- Meters show a target tick; bar turns success-coloured only once the target
  is met.
- Hairline borders; exactly two elevations (toast/popover, drawer/modal).
- Focus: 2px accent outline, 2px offset.
- Inputs get their own `inputBorder` token at ≥3:1 (WCAG 1.4.11) — dividers
  stay quiet hairlines, form fields stay findable. This also directly fixes
  the audit's "borderless input" bug class.

### Contrast (WCAG 2.x, scripted)

34 pairs per theme: all three text tones on all four surfaces, accent text on
surface/canvas/tint, text on accent, each semantic colour on surface, canvas
and its own tint, nav text on nav, and non-text (input border, accent) at 3:1.

| | Tightest pair | Result |
|---|---|---|
| A light | subtle text on subtle fill — 4.62:1 | pass |
| A dark | input border on surface — 3.31:1 | pass |
| B light | subtle text on subtle fill — 4.80:1 | pass |
| B dark | input border on surface — 3.12:1 | pass |

All 136 pairs pass. For comparison, today's UI has visible failures
(amber "Not confirmed yet", neon net amounts, pink error notices — audit §4.2).

---

## A · Ledger

**IBM Plex Sans + Plex Mono · cool slate ramp · ink-blue accent `#1E4FD0`
(dark `#7C9DFF`) · light sidebar · radii 6 / 10 / 14 · 40px rows (comfortable)**

*Rationale.* The people on this product read paperwork for a living: a
supplier's accounts clerk checking whether invoice MC/2026-27/0148 cleared, a
finance team matching three documents, an operator chasing an SAP sync. Ledger
is built to look like a well-set financial document. Plex was drawn for
exactly this register (the ui-ux-pro-max DB files it as "Financial Trust —
banks, finance, enterprise; excellent for data"); Plex Mono's slashed zero and
distinct `1/l/I` matter in GSTINs and PO numbers that people re-type into SAP
and Tally. Plex also ships a Devanagari family, which keeps Hindi/Marathi
supplier-facing copy open later without a second visual voice. The light
sidebar keeps chrome quiet, so the tenant's brand colour (which replaces the
accent) is what gives each workspace its identity. Comfortable rows suit
suppliers on 1366×768 laptops and phones; workspace/platform tables drop to
compact 36px.

*Costs.* Two new font families (~120–150 KB of Latin WOFF2 for 3 sans weights
+ 2 mono, self-hosted via `next/font/local` as today). Blue is a common B2B
accent — safe rather than distinctive.

## B · Graphite

**Geist + Geist Mono · true-neutral zinc ramp · deep-teal accent `#0D6B5B`
(dark `#3FB89F`) · dark sidebar in both themes · radii 4 / 6 / 10 · 36px rows
(compact)**

*Rationale.* Graphite is the Linear/Vercel school: tighter, denser, more
"instrument". It reuses the Geist files already self-hosted, so it costs zero
extra bytes — real on mid-range Android phones. The dark sidebar is a strong
surface-identity cue (platform vs. workspace could differ by sidebar tint
alone) and a compact default suits the finance team and operators who live in
tables.

*Costs, seen in the specimens.*
- **Accent collides with "success".** Teal and the success green sit next to
  each other: "Needs acknowledgement" (accent) and "Delivered" (success) read
  as the same family at a glance — exactly the status confusion the audit
  flagged. A tenant who picks green makes it worse.
- **The dark sidebar disappears in dark mode** (navBg ≈ canvas), so the
  identity cue only works in one theme.
- A dark slab on every light-mode screen is heavy for supplier staff who sign
  in a few times a week, and compact rows are tight for touch.
- Geist has no Devanagari.

---

## Recommendation: **A · Ledger**

It reads as the tool a CFO trusts, keeps the accent unambiguous against
semantic colours, works equally in both themes, and its two density modes
cover both audiences (suppliers comfortable; workspace/platform compact). The
font cost is one-time and small.

Worth borrowing from B regardless of the pick: the per-surface sidebar header
tint as the platform-vs-workspace identity cue (Phase 4), and B's compact row
height as Ledger's compact density.

### Notes that carry into Phase 3 whichever you pick

- **Tenant accent safety.** `branding.js` only sets
  `--color-emerald-default-rgb`. The accent's text tone, tint and on-accent
  colour should be derived in CSS (`color-mix`, `oklch` relative colours) from
  that one variable, so any tenant colour still yields readable link text and
  button labels — no change to `branding.js`. A very light tenant colour
  (e.g. yellow) can't meet 4.5:1 for white button text by maths alone; I'll
  propose a CSS-only fallback (dark on-accent text) and flag it rather than
  touching branding logic.
- **Dark mode** is designed, not inverted: separate ramps, lighter accent,
  stronger scrim.
- The audit's open decisions (dashboard "Connected" toggle, static SAP chip,
  copy renames, demo DB reset) still stand.

**Waiting for your choice of direction before Phase 3.**
