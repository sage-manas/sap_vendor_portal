# Ledger — VendorConnect design system

The reference for building any screen in the supplier portal, the tenant
workspace or the platform console. Direction chosen in
[02-directions.md](02-directions.md) (A · Ledger); the problems it answers are
in [01-audit.md](01-audit.md).

- Tokens: [`src/app/globals.css`](../../src/app/globals.css)
- Primitives: [`src/components/ui/`](../../src/components/ui/)
- Visual test bed: **`/__design`** (development only — every primitive, every
  state, light beside dark)
- Contrast check: `npm run check:contrast`

> **Redesign v2 ("Ledger Night").** Dark is the default theme, the neutral
> ramp is graphite rather than blue slate, the default accent is pink and charts
> gain `--chart-series-2` (electric blue). Plan: `04-redesign-v2-plan.md`.

## Principles

1. **Calm and exact.** Nothing on screen that does not carry information. No
   gradients, glows, glass, icon chips, coloured rails, or decorative motion.
2. **Neutral carries the UI; colour means state.** One accent (the tenant's) for
   actions and the current selection. Success / warning / danger / info appear
   only on state.
3. **Tables are the product.** Most screens are a list someone works through.
   Design the table first; the page is its frame.
4. **Sentence case, readable sizes.** No uppercase-tracked labels. Nothing
   smaller than 12px.
5. **Mono means "identifier or amount".** `PO-2026-0080`, GSTINs, GRN numbers,
   `₹1,00,000.00` — never dates, statuses, roles or prose.
6. **Empty is quiet.** One line pointing to the next step, never a dashed box.

---

## Tokens

Three layers in `globals.css`:

| Layer | Example | Who uses it |
|---|---|---|
| Primitive | `--slate-500`, `--radius-control` | Only the semantic layer |
| Semantic | `--surface`, `--fg-muted`, `--accent-text`, `--danger-tint` | Components, via Tailwind utilities (`bg-surface`, `text-fg-muted`) |
| Legacy | `--color-surface2-rgb`, `text-text-tertiary`, `.btn-v` | Screens not yet migrated. Mapped onto Ledger values; delete each once nothing references it |

### Neutral ramp (slate)

| Token | Hex | Light role | Dark role |
|---|---|---|---|
| `--slate-0` | `#FFFFFF` | surface | |
| `--slate-25` | `#F6F7F9` | canvas, row hover | |
| `--slate-50` | `#EFF1F4` | subtle fill | fg |
| `--slate-100` | `#E2E5EA` | border | |
| `--slate-200` | `#C9CED6` | border-strong | |
| `--slate-300` | `#A9B2C0` | | fg-muted |
| `--slate-400` | `#858E9C` | input-border | fg-subtle |
| `--slate-500` | `#636D7D` | fg-subtle | input-border |
| `--slate-600` | `#465163` | fg-muted | |
| `--slate-700` | `#323C4B` | | border-strong |
| `--slate-800` | `#232B37` | | border |
| `--slate-850` | `#1A2130` | | subtle, hover |
| `--slate-900` | `#11161E` | | surface |
| `--slate-950` | `#0B0F15` | fg | canvas |

(14 steps rather than the brief's 11: dark mode needs three surfaces close
together — 850/900/950 — to separate canvas, surface and fill without borders
doing all the work.)

### Semantic

| Token | Use | Light | Dark |
|---|---|---|---|
| `--canvas` | Page background | slate-25 | slate-950 |
| `--surface` | Cards, tables, popovers | white | slate-900 |
| `--subtle` | Fills: selected nav, totals row, disabled input | slate-50 | slate-850 |
| `--hover` | Row / item hover | slate-25 | slate-850 |
| `--border` | Hairlines | slate-100 | slate-800 |
| `--border-strong` | Secondary-button outline | slate-200 | slate-700 |
| `--input-border` | Form-field outline (≥ 3:1, WCAG 1.4.11) | slate-400 | slate-500 |
| `--fg` | Primary text | slate-950 | slate-50 |
| `--fg-muted` | Secondary text, labels | slate-600 | slate-300 |
| `--fg-subtle` | Captions, placeholders, helper text | slate-500 | slate-400 |
| `--success` / `-tint` | Completed state | `#2B7550` / `#E7F3EC` | `#62C08F` / `#14261D` |
| `--warning` / `-tint` | Needs a look | `#8A5A0F` / `#FBF1DF` | `#D9A54C` / `#2A2112` |
| `--danger` / `-tint` | Failed, refused, destructive | `#B02F27` / `#FBE9E7` | `#F07C72` / `#2E1715` |
| `--info` / `-tint` | In progress | `#2A6496` / `#E6F0F8` | `#72AADB` / `#132232` |

Utilities: `bg-canvas bg-surface bg-subtle bg-hover`, `text-fg text-fg-muted
text-fg-subtle`, `border-border border-border-strong border-input-border`,
`text-success bg-success-tint` (and warning / danger / info),
`text-accent-text bg-accent-tint bg-accent-solid text-accent-fg`.

### Accent and tenant branding

`src/lib/branding.js` (ADR-0030) sets one variable on `<html>`:
`--color-emerald-default-rgb` (an `r, g, b` triplet). It is still the only
source of the accent — nothing in `branding.js` changed. Every accent role is
derived from it in CSS, per theme:

| Token | Light | Dark |
|---|---|---|
| `--accent` | the tenant colour | the tenant colour |
| `--accent-solid` (buttons, focus ring, checked controls) | `--accent` | lightness lifted to ≥ 0.70 (oklch) |
| `--accent-text` (links, accent labels) | lightness capped at ≤ 0.50 | lightness lifted to ≥ 0.76 |
| `--accent-tint` (selection, "needs action" fill) | 9% over surface | 22% over surface |
| `--accent-fg` (text on the button) | white if L < 0.60, else ink | same rule on `--accent-solid` |

So a tenant can pick any colour — yellow, light sky, lime — and links and
button labels stay ≥ 4.5:1 in both themes. `npm run check:contrast` runs nine
sample tenant colours through the same maths; the redesign PR also verified the
browser-computed values. Default accent: pink `#E8457E` since redesign v2
(Ledger's ink blue `#1E4FD0` stays in the sample set).

Browsers without relative colour syntax get `color-mix` approximations; the
exact `oklch` derivations sit in an `@supports (color: oklch(from red l c h))`
block (a second declaration of a custom property can't act as a fallback —
custom properties never fail to parse).

### Type

IBM Plex Sans (UI) and IBM Plex Mono (identifiers and amounts), self-hosted in
`src/app/fonts` via `next/font/local`. Latin is preloaded; Latin Extended
(which carries **₹**, U+20B9) loads only for glyphs in its range. Every number
uses `tabular-nums` (set on `body`).

| Utility | Size / line | Use |
|---|---|---|
| `text-xs` | 12 / 16 | Captions, helper text, table headers |
| `text-sm` | 13 / 20 | Table cells, labels, secondary text |
| *(body)* | 14 / 20 | Default — no class needed |
| `text-lg` | 16 / 24 | Card and section titles |
| `text-xl` | 20 / 28 | Page sections, empty KPI values |
| `text-2xl` / `.page-title` | 24 / 32 | Page title, KPI values |
| `text-3xl` | 32 / 40 | Rare display numbers |

Weights: 400 body, 500 labels and emphasis, 600 titles. One weight jump per
block. **Don't use `text-base`** until the legacy `--color-base` is removed —
the two names collide and `text-base` would set the text colour to the canvas.

### Space, shape, elevation, motion

- 4px grid. Common steps: 4 / 8 / 12 / 16 / 24 / 32.
- Radii (v2): `rounded-md` 10px (inputs, nav rows), `rounded-tile` 14px (tiles
  nested in a card), `rounded-lg` 20px (containers), `rounded-xl` 24px
  (overlays), `rounded-pill` (buttons, chips, badges, segmented controls).
  `rounded-full` only for dots and avatars.
- Cards may use `shadow-card`: a faint drop in light, a 4% top-edge highlight
  in dark.
- Hairline borders, no shadows on in-page surfaces. Two elevations:
  `shadow-popover` (menus, tooltips, toasts) and `shadow-modal` (dialogs,
  drawers). Scrim: `bg-[var(--scrim)]`.
- Motion 120–200ms, `--ease-out`, opacity/transform only. Everything collapses
  under `prefers-reduced-motion`.
- Icons: `lucide-react`, stroke 1.5, sizes 14 / 16 / 20 only.

### Focus

2px `--accent-solid` outline, 2px offset, keyboard only (`:focus-visible`).
Form fields use their border + a 3px tint ring instead.

---

## Primitives

All in `src/components/ui/`. Props listed are additions; every pre-existing
export and prop still works.

### Button — `button.tsx`
`variant`: `primary` · `secondary` · `ghost` · `destructive` · `link`
(`default` = primary, `outline` = secondary, kept as aliases).
`size`: `sm` · `md` · `lg` · `icon` (+ legacy `xs`, `icon-xs`, `icon-sm`,
`icon-lg`). `loading` swaps the label for a spinner without changing width and
sets `aria-busy`.

- ✅ One primary per view. Secondary for the rest; ghost for low-emphasis
  actions in rows and toolbars.
- ❌ Gradient or coloured-shadow buttons; two primaries side by side.

Markup that still writes `className="btn btn-v"` gets the same styles.

### StatusBadge — `StatusBadge.jsx` + `status.js`
A dot and the status's own words. The tone comes from **one domain map**
(`status.js`) keyed by the label — PO, GRN/QC, invoice, payment/TDS/MSME,
RFQ/bid, supplier approval, tenant, user, invitation and SAP sync — so
"Cleared" looks the same everywhere whatever `variant` a caller passes.

| Tone | Looks like | Meaning | Examples |
|---|---|---|---|
| `action` | accent fill | Waiting on this reader | Open (PO), Bidding Open, Under Review |
| `warn` | warning fill | Something is off | Match Warning, needs_manual_match |
| `danger` | danger fill | Failed / refused / overdue | Failed, Rejected, QC Discrepancy |
| `progress` | info dot | Moving, no one needs to act | Acknowledged, Dispatched, Submitted |
| `done` | success dot | Finished | Delivered, Cleared, Paid, Approved, Synced |
| `neutral` | grey dot | At rest | Draft, Pending, Local |
| `ended` | hollow dot | Closed without completing | Cancelled, Closed, Expired |

`variant` (legacy) is used only for labels the map doesn't know; `tone`
overrides both. Labels render exactly as given (no CSS text-transform) — tests
and users rely on the words.

- ✅ Add a new domain status to `status.js`, not a one-off colour.
- ❌ Pills in every cell; colour without a word.

### KPICard / KPIStrip / Sparkline — `KPICard.jsx`
`<KPIStrip>` puts up to four `<KPICard>`s in one bordered row (2 columns in a
narrow container, 4 when there's room — a container query, not the viewport).
KPICard: `label`, `value`, `hint` (or legacy `sub`), `delta` + `deltaTone`,
`spark`, `href`/`onClick` + `linkLabel`, `empty`. A zero (`0`, `"₹0"`,
`"0.00"`) renders muted and smaller automatically; pass `empty` for rich values.
`icon` and `tone` are accepted and ignored.

- ✅ "₹0 · Nothing outstanding" in muted text.
- ❌ Icon chips, coloured stripes, a hero "0".

### PageHeader / Page — `Page.jsx`
The one header for all three surfaces: `breadcrumb`, `title`, `description`
(`caption` alias), `primary` (the one primary action), `secondary` (typically a
`DropdownMenu` of the rest). `console/primitives`' `PageHeader` now renders
this.

### Card / CardHeader / Section — `Card.jsx`
`Card` is a hairline surface. `Section` is an *unboxed* heading + content —
what most page groupings should be.

- ❌ Cards inside cards; every section in its own box.

### DataTable / ColumnsMenu — `DataTable.jsx`
Columns: `key`, `header`, `render`, `align: 'right'` (numbers), `mono`
(identifiers, amounts), `sortable`, `width`, `wrap`, `primary` (card title on
phones), `mobile: false`.
Table props: `rows`, `getRowId`, `loading`, `empty`, `density`
(`comfortable` 40px / `compact` 36px), `sort` + `onSortChange`, `selectable` +
`selected` + `onSelectedChange`, `onRowClick`, `inlineActions(row)` (revealed
on hover/focus), `rowActions(row)` (kebab menu — always visible, so touch works),
`totals` (`{ label, [key]: value }`), `hiddenColumns`, `caption`, `maxHeight`.

Behaviour: with `maxHeight` the body scrolls inside the table under a sticky
header (a header can only stick inside a box that scrolls vertically); `aria-sort` on sorted headers; select-all with
indeterminate; single-line cells by default (the table scrolls sideways if it
must); below 768px each row becomes a card, with a labelled open button when
the row is clickable. State is controlled — the screen
decides what sorting and selection mean.

- ✅ Currency in the column header (`Value (₹)`), right-aligned mono values, a
  totals row.
- ✅ Vendor portal: `comfortable`. Workspace and platform: `compact`.
- ❌ Status pills and mono in every column; "View" buttons on every row (row
  click + chevron instead).

`console/primitives`' `Table` keeps its API and gains `align` and `mono: false`.

### FieldCard — `FieldCard.jsx`
Label **above** the control, hint or error below; error carries an icon and
text. The label/`aria-*` association logic is unchanged.
Native inputs, selects and textareas are styled globally (36px, `--input-border`,
focus ring, `aria-invalid` and `:disabled` states) — including a bare `<input>`
with no `type`, which used to fall through and render borderless.

### Controls — `controls.jsx` (Base UI)
`Tabs` + `TabPanel` (underline, counts), `SegmentedControl` (radiogroup),
`Meter` (value + **target tick**; neutral until the target is met, then
success), `Avatar` (initials, rounded square), `Tooltip` (+ `TooltipProvider`)
for supplementary text only, `DropdownMenu` (overflow actions; `'separator'`
entries; `destructive` items), `Checkbox` (with `indeterminate`), `Switch`,
`Pagination`.

### Overlays and feedback
- **Modal** — same API and focus behaviour; scrim token, `shadow-modal`, 14px
  radius, labelled close.
- **Drawer** — same API plus `description` and `footer`. Full viewport height
  (the old one started at a hard-coded 44px under a 52px header); `role=dialog`,
  labelled close; focus moves into the panel on open and back to the opener on
  close; `inert` and hidden while closed so its contents aren't tabbable
  off-screen.
- **Toast** (`portal/ToastNotification.jsx`) — theme tokens (it was hard-coded
  white in dark mode), icon + message, type announced to screen readers, labelled
  dismiss.
- **EmptyState** — compact block (≤ 120px) or `inline` one-liner;
  `TableEmpty` for a single row in a table body.
- **Notice** (`console/primitives`) — error / warn / success / info callouts on
  tint tokens (the old error notice failed contrast in light mode).
- **Spinner**, **TableSkeleton**.

---

## App shell — `src/components/shell/`

One shell (`AppShell`) for the supplier portal (`PortalLayout`), the tenant
workspace (`app/workspace/layout.jsx`) and the platform console
(`app/platform/layout.jsx`). Each layout passes its own navigation — still
filtered by its own permission registry (`workspaceNav.js`, `platformNav.js`,
`onboarding.js`'s `modulesFor`) — plus identity and top-bar items.

- **Sidebar:** labelled, 240px, collapsible to a 56px icon rail (`Ctrl+B`, or
  the button left of the top bar). Collapse is remembered in `localStorage`
  (`vc-sidebar-collapsed`). Registry entries with `group: 'admin'` sit at the
  foot. Count badges are neutral pills with an accessible label ("3 orders need
  acknowledgement"); collapsed, they become a dot.
- **Identity:** the sidebar header names whose space this is — the buyer's
  workspace (logo or initial) with "Supplier portal" or "Workspace" under it.
  The **platform console's header is inverted** so an operator can never mistake
  it for a tenant workspace.
- **Top bar:** search (`Ctrl K`, supplier portal), `SapStatus`,
  notifications (supplier portal), `ThemeToggle`, `UserMenu`.
- **`SapStatus`:** the one SAP indicator — a dot and a word, with a popover of
  last sync, system and the last 24h of calls. Reads
  `GET /api/dashboard/sap-status` every 60s (the workspace's row of the platform
  health board). States: connected / degraded / unreachable / idle (no traffic
  today, synced before) / no activity yet / unavailable. Not shown on the
  platform console, which has the per-tenant health board instead.
- **Phones (< 768px):** the sidebar is a sheet (dialog, Escape closes, focus
  returns to the menu button).

- ❌ Status chips repeating the SAP state on pages; red alarm count bubbles;
  icon-only navigation without a label.

---

## Migrating a screen

| Old | New |
|---|---|
| `.label` (10px uppercase) | Already restyled; or `FieldCard` |
| `text-[10px] uppercase tracking-…` | `text-xs text-fg-subtle` (sentence case in the source) |
| `.page-title` serif | Already sans; prefer `<PageHeader>` |
| `text-text-tertiary` / `-secondary` / `-primary` | `text-fg-subtle` / `text-fg-muted` / `text-fg` |
| `bg-surface2` | `bg-subtle` |
| `border-border-em` | `border-border-strong` (or `border-input-border` on fields) |
| `text-emerald-text`, `rgb(var(--color-emerald-default-rgb))` | `text-accent-text`, `bg-accent-solid` |
| `text-rose-500`, `text-amber-500`, `#059669` … | `text-danger`, `text-warning`, `text-success` |
| Dashed `EmptyState` | `EmptyState inline` or `DataTable empty` |
| Four `KPICard`s in a grid | `KPIStrip` |
| `font-mono` on dates / statuses / prose | remove |

Delete a legacy token from `globals.css` when `grep` finds no reference to it.

## Checks before merging UI work

- `/__design` still renders every primitive in both themes.
- `npm run check:contrast` passes.
- Screens checked at 1440, 1280, 768 and 390, light and dark.
- No new uppercase-tracked text, raw palette colours (`rose-500`, hex), or
  sub-12px text.

## Known gaps (tracked for later phases)

- `Modal` has no Tab focus trap yet — focus can leave the dialog. Behaviour
  change; deliberately out of the presentation-only phases.
- `src/lib/statusColors.js` still returns legacy variants (it is lib code and
  out of scope); `StatusBadge` overrides them from the domain map for every
  known label.
- In a tenant workspace, "Open" on a purchase order is shown as `action`
  (it is the supplier's to acknowledge). Screens where it isn't the reader's
  action should pass `tone="progress"`.
