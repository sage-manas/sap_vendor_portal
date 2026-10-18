# Redesign v2 — "Ledger Night" implementation plan

Reference: the Resq.io dashboard shot the user shared (2026-10-18).
Builds **on top of** the Ledger redesign (PRs #260 → #261 → #264 → #265 → #266),
not instead of it.

---

## 0. What "keep the last redesign" means

Ledger did two kinds of work. Only one of them is replaced.

| Keep (structure, from Ledger) | Replace (skin, from the reference) |
|---|---|
| Token architecture + `/__design` page + `npm run check:contrast` (#260) | Token *values*: palette, radii, elevation, type scale |
| AppShell, real SAP status chip, removed toggle, nav renames (#261) | Shell layout: sidebar → floating top pill nav |
| Page-title-as-h1, supplier page structure (#264) | Card/panel styling, KPI presentation |
| Console Table/Field rebuild, phone cards, `useNarrow` (#265) | Table + badge visuals |
| AuthHeader, PasswordChecklist, operator forms (#266) | Auth page backdrop |
| The four settled decisions in memory | — |

Because the Ledger primitives already centralise styling, v2 is mostly a
**token + primitive** swap, with page work limited to layout (bento grids).

**Precondition:** merge the Ledger stack into master first (#260→#261→#264→#265→#266).
Starting v2 on top of five unmerged stacked PRs would make a seven-deep stack — too fragile.
`master` today still ships Cream & Coral.

---

## 1. Reading the reference — design language to extract

| Trait in the shot | Token / rule it becomes |
|---|---|
| Near-black canvas (#121214-ish), cards one step lighter (#1C1C20), hairline 1px borders at ~8% white | `--color-base`, `--color-surface`, `--color-border` dark values |
| Large radii: cards ~20px, inner tiles ~14px, buttons/tabs fully pill | `--radius-card: 20px`, `--radius-tile: 14px`, `--radius-pill: 999px` |
| Floating pill nav (segmented, active item filled) top-centre; round icon buttons right | New `TopNav` in AppShell |
| Big light-weight numerals (38 / 26 / 103) with tiny delta badge | `KPICard` "hero" variant |
| Progress pills (20% / 25% / 40% / 15%) — solid, white, grey, hatched | `MeterPill` primitive (solid / inverse / muted / hatched) |
| One saturated feature card (blue "Vulnerability") | `Card tone="accent"` — max **one per page**, uses tenant accent |
| Two accent hues only: magenta-pink + electric blue, used in charts/badges | `--chart-1` (accent), `--chart-2` (secondary); status colours stay semantic |
| Segmented control (12 months / 30 days / 1 week) | `Segmented` primitive (Base UI Toggle Group) |
| Smooth spline line chart, glowing point, floating tooltip | Chart theme (see §4) |
| Bubble "Statistics" chart | Optional — only where a share-of-total exists (PO status mix) |
| List tiles with count chip (Triage 1234) | `StatTile` primitive |
| Incident cards: status pill, ID + age top-right, avatar footer | `RecordCard` — reused for POs, invoices, RFQs, approvals |
| Assistant panel with quick-action chips | Optional — see §6 |
| Generous spacing, bento grid, no tables on the dashboard | Dashboard layout rule |

**Type:** keep IBM Plex Sans/Mono from Ledger (vendor portal needs tabular numerals
for amounts). Use Plex Sans **300** at 40–48px for hero numerals to get the
reference's thin-numeral look. Do not add a third font.

---

## 2. Hard constraints (non-negotiable)

1. **Functionality frozen** — same rules as `docs/redesign-prompt.md` §1. Presentation only.
2. **Tenant branding** (`src/lib/branding.js`, ADR-0030) writes `--color-emerald-*`.
   The reference's pink/blue must map onto those variables, not hard-coded. The
   accent feature card and chart series 1 follow the tenant colour.
3. **Light mode must still exist.** The reference is dark-only; supplier finance
   users work in daylight on bright office monitors. Plan: **dark becomes the
   default**, light is a fully designed counterpart (same radii/layout, slate surfaces),
   both pass `check:contrast`. Confirm default with the user (§8 Q1).
4. **Data density.** The reference shows ~10 numbers. PO lists, invoice lines, GRNs
   and reconciliation are tables with hundreds of rows. Bento/card styling applies to
   **dashboards and detail headers**; list pages keep the #265 Table (re-skinned:
   no zebra, 52px rows, rounded container, pill status) — never turned into card grids
   on desktop.
5. **Contrast.** Reference grey-on-black labels (~#8A8A90 on #121214) are borderline.
   Tertiary text must hit 4.5:1; hatched pills need a text label, not colour alone.
6. **Scope respect** (memory): no buyer-facing flows, no supplier↔buyer messaging,
   `finance` role name unchanged.

---

## 3. Phases (one PR each, based on master after the Ledger merge)

### Phase A — Tokens & theme (≈1 PR, small, highest leverage)
- `src/app/globals.css`: new dark + light values for base/surface/surface2/surface3,
  borders, text tiers; new radius tokens; elevation = border + subtle inner highlight
  (`inset 0 1px 0 rgb(255 255 255 / .04)`), no drop shadows in dark.
- Map `--color-emerald-*` defaults to the new accent (pink `#E8457E`-ish); add
  `--color-accent-2` (blue `#4F6BFF`-ish) for series 2 / info.
- Chart tokens `--chart-1..5`, grid/axis tokens.
- Flip default theme; keep the existing toggle + `prefers-color-scheme`.
- Update `/__design` and `check:contrast` pairs (incl. text on accent card).
- **Done when:** every page renders in the new palette with zero component edits,
  contrast script green in both themes, tenant branding still recolours accent.

### Phase B — Primitives (`src/components/ui`)
Re-skin: `Card` (radius 20, `tone="default|raised|accent"`), `KPICard` (hero
variant: thin numeral + delta chip), `StatusBadge` (pill, dot + label), `button`
(pill, ghost-round icon variant), `Modal`/`Drawer` (radius, dark scrim blur),
`EmptyState`, `TableSkeleton`, `CommandPalette`.
New: `Segmented`, `MeterPill`, `StatTile`, `RecordCard`, `Avatar` (initials;
no stock photos), `DeltaChip`.
- Add all to `/__design` with both themes.
- **Done when:** `/__design` matches the reference's component vocabulary; Modal tests pass.

### Phase C — App shell
- Replace Ledger sidebar with: logo left · floating pill nav centre · search,
  notifications, SAP status chip, avatar right (reference header).
- Overflow: supplier nav has ~8 items, workspace more — pill nav shows primary 5,
  rest under "More". Below 1024px collapse to a bottom sheet/drawer.
- Keep Ctrl K palette, real SAP status (#261), tenant logo slot, role-based nav.
- "Welcome in, {name}" greeting row on dashboards only.
- **Done when:** all three surfaces navigate identically to before; keyboard + screen
  reader nav verified; phone width has no horizontal scroll.

### Phase D — Dashboards (the showcase)
Vendor dashboard layout mapped to the reference grid:

| Reference slot | Vendor portal content |
|---|---|
| Meter pills row | Profile completeness · ASN on-time % · invoice match rate · RFQ response rate |
| Hero numerals (38/26/103) | Open POs · invoices awaiting payment · amount due (₹, compact) |
| Summary tiles | PO pipeline: To acknowledge / To ship / To invoice (counts) |
| Incident frequency chart | Invoice & payment value over time, `Segmented` 12 mo / 30 d / 1 wk |
| Blue feature card | The one thing needing action (e.g. "3 RFQs close this week") |
| Active incidents cards | Latest POs/RFQs as `RecordCard`, Newest/All filters |
| Statistics bubbles | Invoice status mix (paid / pending / rejected) |
| Assistant panel | See §6 — placeholder: Quick actions (Create ASN, Submit invoice, Download statement) |

Workspace dashboard: approvals queue, supplier onboarding funnel, SAP sync health.
Platform console: tenant count, sync failures, job queue.
**Only uses data existing endpoints already return** — any missing metric is
listed as a backend follow-up, not invented (same rule as the reconciliation gap).

### Phase E — Supplier pages (pos, invoices, payments, rfqs, performance, analytics, registration)
Detail pages get the reference's header treatment (status pill, ID + age, hero amount,
segmented tabs). Lists keep the re-skinned table. Performance/analytics adopt chart theme.

### Phase F — Workspace + platform console + auth
Same patterns. Auth: dark canvas, centred card, faint accent glow — no illustrations.

### Phase G — QA & polish
- Before/after screenshots per route, both themes, desktop + 375px (reuse
  redesign-screenshot-setup tooling; `seed:demo --reset` first).
- `check:contrast`, axe pass, `prefers-reduced-motion` respected for chart/hover motion.
- Tenant-branding check with 3 colours (pink default, green, a dark navy — the accent
  card must stay readable with any of them; compute on-accent text colour).
- Full backend + e2e suites — **mind the memories: tests wipe the dev DB, e2e hits real SAP**;
  run in the worktree's Docker Postgres.

---

## 4. Charts
Pick one library and theme it once (check `package.json` for what Ledger used;
if none, Recharts). Rules: monotone splines, 2px strokes, no area fills except a
faint 8% gradient on series 1, dashed vertical gridlines only, glowing active dot,
tooltip as a surface3 pill. Amounts formatted with tenant currency, tabular nums.

## 5. Motion
150–200ms ease-out on hover/press; chart draw-in 400ms once; card hover = border
brighten, not lift. All gated by `prefers-reduced-motion`.

## 6. The assistant panel — decision needed
The reference's "How can I help you?" card is a **feature**, not styling. Building it
is out of scope for a presentation-only redesign. Default: render that slot as a
**Quick actions** card with the same chip styling, linking to existing flows.

## 7. Risks
| Risk | Mitigation |
|---|---|
| Dark-default alienates daylight finance users | Ship light as first-class; remember user choice; confirm default (Q1) |
| Top nav can't fit workspace's item count | "More" overflow + palette; validate in Phase C before page work |
| Pretty dashboard, empty metrics | Map only to existing API fields; list gaps as follow-ups |
| Tenant colour breaks accent card contrast | Auto on-accent text, contrast test with 3 brand colours |
| Long stacked PR chain again | Merge Ledger first; merge each v2 phase before starting the next where possible |

## 8. Questions for the user before Phase A
1. Default theme: **dark** (like the reference) with light available, or keep light default?
2. Default accent: reference pink, or keep Ledger's ink-blue and use pink as series 2?
3. Assistant panel: Quick actions placeholder (recommended), or scope a real assistant later?
4. OK to merge the Ledger stack (#260–#266) before v2 starts?
