# VendorConnect — Full Visual Redesign Brief

> Paste everything below the line into a fresh Claude Code session at the repo root.
> It is written to be executed in phases, with a hard stop for review after Phase 2.

---

## 0. Role and mission

You are a senior product designer **and** a staff frontend engineer. Your job is a
**complete visual and interaction redesign** of VendorConnect — the SAP vendor portal
in this repo — across all three surfaces:

| Surface | Who uses it | Routes |
|---|---|---|
| **Vendor portal** | Supplier staff (e.g. "Kaveri Forge & Fittings") | `src/app/{pos,invoices,payments,rfqs,performance,analytics,registration}`, the vendor dashboard |
| **Tenant workspace** | Client company admins / finance (`finance` = AP/AR manager) | `src/app/workspace/**`, `src/app/admin` |
| **Platform console** | Our operators | `src/app/platform/**` |
| **Auth / public** | Everyone | `sign-in`, `sign-up`, `forgot-password`, `reset-password`, `change-password`, `confirm-email`, `accept-invitation` |

Nothing should look the way it does today. The current "Cream & Coral" look (warm cream
canvas, coral accent, serif page titles, uppercase-tracked micro-labels, pill badges in
every cell, dashed-border empty states, a 64px icon-only rail with red count bubbles,
floating "N" button) must be **retired entirely**, not re-skinned.

**Functionality is frozen.** Every route, API call, permission check, form field, validation
rule, state transition, socket event, keyboard shortcut (Ctrl K palette), CSV export,
tenant-branding injection, and dark mode must behave exactly as before. This is a
presentation-layer project only.

---

## 1. Non-negotiable guardrails (read before touching anything)

1. Read `AGENTS.md`, `PROJECT_CONTEXT.md`, and the relevant guides in
   `node_modules/next/dist/docs/` first. This is **Next 16.4 / React 19.3 / Tailwind v4 /
   @base-ui/react** — not the versions in your training data.
2. **Do not change** data fetching, hooks, context providers, API clients, route files'
   exports, `src/lib/**` logic, or backend code. If a visual change seems to require a
   logic change, stop and list it instead of doing it.
3. **Tenant branding is functional.** `src/lib/branding.js` (ADR-0030) writes the
   `--color-emerald-*` CSS variables at runtime to inject a tenant's brand colour. Keep
   those variable names and their RGB-triplet format working; you may *map* your new
   accent token onto them, never rename or delete them.
4. **Dark mode** is a `.dark` class on `<html>` (`theme-context.js`), not
   `prefers-color-scheme`. Design both themes as first-class, not dark as an afterthought.
5. **Keep every test green without editing assertions to fit.** Run `npm test` and the
   Playwright suite before and after. Preserve `data-testid`, ARIA roles, accessible names
   and visible copy that tests or users rely on. If a selector is purely visual and must
   change, update the test *selector* only and say so in the PR.
   ⚠️ `npm run e2e` targets the dev DB and a **real SAP sandbox** and wipes the live SAP
   connection config — do not run it unattended; ask first. Backend tests truncate the dev
   DB. Prefer component tests + Playwright screenshots against the demo seed
   (`npm run seed:demo`).
6. Copy is mostly good and was recently reworded for vendors ("Once your buyer's finance
   team posts…"). Restyle it; don't rewrite it unless it's broken.
7. Never mention or design buyer-facing flows for the `buyer` role, supplier↔buyer
   messaging, or anything removed in prior PRs.

---

## 2. Tooling — use all of it, in this order

- **Skills (invoke via the Skill tool):**
  - `redesign-existing-projects` — audit-first method; run it before designing.
  - `design-taste-frontend` and `high-end-visual-design` — anti-slop rules; treat their
    banned-pattern lists as lint rules for this project.
  - `ui-ux-pro-max:ui-ux-pro-max` — query its palette, font-pairing and UX-guideline
    database for *B2B finance/ops SaaS, data-dense*. Use it to justify choices, not pick
    defaults.
  - `ui-ux-pro-max:design-system` — build the three-layer token architecture
    (primitive → semantic → component).
  - `ui-ux-pro-max:ui-styling` — component patterns on Base UI + Tailwind v4.
  - `awesome-design-html` — study **Linear, Stripe (dashboard, not marketing), Vercel,
    Mercury-style finance UIs** for density, table craft, and restraint. Steal principles,
    not brand assets.
  - `dataviz` — before touching any KPI tile, progress bar, scorecard or Recharts chart.
  - `taste` — run on your own diff at the end of each phase.
- **Playwright CLI** (`npx playwright …`, already a devDependency) for screenshots. The
  Playwright MCP server may not connect; the CLI is enough. Write a throwaway script in
  the scratchpad that logs in with the demo seed accounts and captures every route listed
  in §1 at **1440×900, 1280×800, 768×1024 and 390×844**, light and dark.
- The built-in browser pane for interactive spot-checks.

---

## 3. Phase 1 — Audit (no code changes)

1. Inventory every page and every component in `src/components/{ui,portal,console,platform,shared}`.
   Produce a table: component → where used → current visual problems → planned replacement.
2. Capture "before" screenshots of every route (§2 script) into `docs/redesign/before/`.
3. Write a ruthless critique of the current UI. Known problems to confirm and extend:
   - Every label is UPPERCASE-TRACKED micro-text → no hierarchy, shouty, hard to scan.
   - Status pills everywhere (`OPEN`, `DELIVERED`, `NEW`, `Confirmed`) compete with data.
   - KPI tiles with a coloured left stripe + icon chip + giant number are generic dashboard
     filler; "₹0 / 0 invoices" and "100/100" are presented with the same weight as real signal.
   - Empty states are big dashed boxes eating half the viewport (Invoices, RFQs, Ledger,
     Disbursements). Empty should be quiet and point to the next action.
   - Analytics page shows centred floating values in pills — no grid, no alignment, no
     comparison, nothing chart-like.
   - Icon-only nav rail with no labels, unexplained badges, and no indication of section.
   - Two different header patterns (serif title on canvas vs. title inside a white card).
   - Redundant controls: "Connected" shown three times on the dashboard; "View Invoices" in
     four places; quick-action tiles duplicating nav.
   - Mono font used for money *and* dates *and* status badges — monospace should mean
     "identifier/number", not "decoration".
   - Indian number formatting is correct (₹1,00,000.00) — **keep it**, but align it on
     the decimal in tables and use tabular figures.
4. Save as `docs/redesign/01-audit.md`.

---

## 4. Phase 2 — Design direction (stop for approval)

Propose **two** genuinely different directions, each with a one-paragraph rationale tied to
the users (Indian SME suppliers on mid-range laptops and phones; finance teams living in
tables all day; operators debugging SAP sync). Then recommend one. For each direction,
build a **single static HTML specimen** (scratchpad, no app code) showing: app shell with
nav, page header, KPI row, a data table with 8 rows, a form section, a drawer, a toast,
an empty state, all badge/status variants, buttons in every state — light and dark.
Screenshot them with Playwright and present side by side.

Direction constraints (both must satisfy):

- **Tone:** calm, exact, expensive-feeling operations software. Think "the tool a CFO
  trusts", not "a startup landing page". Zero decoration that doesn't carry information.
- **Typography:** one high-quality sans for UI (evaluate e.g. Inter Display/Inter, Geist,
  IBM Plex Sans, Söhne-alternatives available via `next/font`; justify with the
  ui-ux-pro-max pairing DB), plus a mono/tabular face **only** for IDs (PO-2026-0080,
  GSTIN, GRN numbers) and amounts. No serif headings. Sentence case everywhere; uppercase
  only for ≤2 tiny overlines per page, if at all.
  Type scale: 12 / 13 / 14 (base, dense UI) / 16 / 20 / 24 / 32, line-heights on a 4px grid,
  `font-variant-numeric: tabular-nums` on every number.
- **Colour:** a neutral, slightly cool or true-neutral grey ramp (11 steps) carries 90% of the
  UI. One accent (mapped onto the `--color-emerald-*` vars so tenant branding still works).
  Semantic colours (success, warning, danger, info) desaturated and used **only** for state,
  never for decoration. All text pairs ≥ 4.5:1, verified with a script, both themes.
- **Space & shape:** 4px base grid; radius scale of 3 values max (e.g. 6 / 10 / 14);
  hairline 1px borders over shadows; at most two elevation levels (popover, modal).
- **Density modes:** comfortable by default for vendor portal, compact by default for
  workspace and platform tables (row height 36–40px). Tables are the hero component of
  this product — design them first.

**STOP here and wait for the user to pick a direction.**

---

## 5. Phase 3 — Design system implementation

Rewrite the foundation, then the primitives, before any page.

1. **Tokens** in `src/app/globals.css` (`@theme` for Tailwind v4): primitives → semantic
   (`--bg`, `--bg-subtle`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--success`…) →
   component tokens. Map legacy variable names to the new semantics so untouched code
   keeps rendering during migration; delete the legacy layer only when nothing references it.
   Document every token in `docs/redesign/design-system.md`.
2. **Fonts** via `next/font` (check the Next 16 docs), self-hosted, `display: swap`, subset.
3. **Primitives** in `src/components/ui/` — keep file names and exported APIs/props
   backward-compatible; add variants rather than breaking signatures:
   - `button.tsx` — primary / secondary / ghost / destructive / link; sm/md/lg; icon-only;
     loading (spinner replaces label width-stable); disabled; focus-visible ring 2px offset.
     No gradient buttons, no coloured shadows.
   - Inputs, selects, comboboxes, checkboxes, radios, switches, date fields, file upload —
     labels above, helper/error text below, error state never relies on colour alone.
   - `StatusBadge.jsx` — redesign as a *dot + label* in neutral text by default; filled
     tint only for states needing attention. One mapping table for every status in the
     domain (PO, GRN, invoice, payment, RFQ, bid, vendor approval, SAP sync).
   - `KPICard.jsx` — label, value, optional delta/sparkline, optional link. No icon chips,
     no coloured stripes. Zero/empty values render muted with a hint, not a hero number.
   - `Card.jsx`, `Page.jsx` (one consistent page header: breadcrumb, title, description,
     primary action on the right, secondary actions in a menu), `Modal.jsx`, `Drawer.jsx`,
     `EmptyState.jsx` (compact, inline, icon optional, one CTA), `TableSkeleton.jsx`,
     `Spinner.jsx`, `CommandPalette.jsx`, toasts, tooltips, tabs (underline, not boxed),
     segmented control, pagination, dropdown menu, avatar, progress/meter.
   - **DataTable** pattern: sticky header, right-aligned numeric columns with tabular
     figures, ID columns in mono, row hover, row selection, sort indicators, column
     visibility, inline row actions revealed on hover + always in a kebab menu for touch,
     loading skeleton, empty row, responsive collapse to card list below 768px.
4. **Motion:** 120–200ms, ease-out, opacity/transform only; respect
   `prefers-reduced-motion`. No bouncing, no parallax, no shimmer on everything.
5. **Icons:** keep `lucide-react`, one stroke width (1.5), sizes 14/16/20 only.
6. Build a hidden `/__design` route (dev-only, behind `process.env.NODE_ENV !== 'production'`)
   rendering every primitive in every state and both themes — this is the visual test bed.

---

## 6. Phase 4 — App shell and navigation

- Replace the icon-only rail with a **labelled sidebar** (collapsible to icons, state
  persisted per user in localStorage, keyboard-toggle). Group items by job:
  - Vendor: *Overview · Orders · Deliveries · Invoices · Payments · RFQs · Performance ·
    Reports*, then *Company profile / Documents* at the bottom.
  - Tenant workspace: *Overview · Suppliers · Purchase orders · Shipments · Invoices ·
    Payments · RFQs · Audit*, then *Users · Settings*.
  - Platform: *Tenants · Operators · SAP connections · Reconciliation · Audit*.
  Use the actual routes and existing permission gating — hide what the role can't see,
  exactly as today.
- Badges: neutral count pills with an accessible label ("3 orders need acknowledgement"),
  not red alarm bubbles.
- Top bar: tenant/buyer switcher (if present today), global search (Ctrl K), SAP
  connection status as **one** small indicator with a popover (last sync time, GST/TDS/MSME
  flags), notifications, theme toggle, user menu. Remove duplicated status chips from pages.
- Mobile: sidebar becomes a sheet; top bar collapses; tables become card lists.
- Each surface gets a subtle identity cue (e.g. a label "Platform" + different neutral
  tint in the sidebar header) so operators never confuse the platform console with a
  tenant workspace.

---

## 7. Phase 5 — Page-by-page redesign

For **every** page, follow: screenshot before → state the page's one primary job →
redesign → screenshot after in all 4 viewports × 2 themes → run tests.
Specific direction for the pages in the reference screenshots:

- **Vendor dashboard:** a compact greeting line with supplier ID / GSTIN as quiet metadata
  and an approval status dot. Replace the 5 quick-action tiles + 4 KPI tiles + alert cards
  with: (1) a single **"Needs your attention"** task list (acknowledge 4 POs, invoice 4
  GRNs) where each row is actionable inline; (2) a slim KPI strip (open POs, to invoice,
  awaiting payment, score) with muted zeros; (3) recent orders as a real compact table;
  (4) payments & performance as small side panels. Empty panels collapse to one line.
- **Purchase orders:** filters as a single toolbar row (search, status, plant, buyer as
  compact selects/chips), saved tabs ("Needs acknowledgement 5", "In delivery", "Completed").
  Remove the four big KPI cards — the tab counts carry that. Type (Asset / Cost centre)
  as plain text, not a pill. "View PO" becomes row click + chevron.
- **PO detail / delivery receipts / shipment notice:** a document layout — header with
  status timeline (Created → Acknowledged → Shipped → Received → Invoiced → Paid), line
  items table, totals block aligned on decimals, sticky action bar.
- **Invoices / Payments / Ledger:** finance-grade tables; ageing shown as a bucketed bar;
  empty state is one line inside the table body.
- **RFQ management:** list/detail split view that never shows two empty panes; when no
  open RFQs, show the "My documents" history directly with a quiet note.
- **Performance scorecard:** one score with grade, three metrics as horizontal meters with
  a visible target tick (not just a full green bar), and trend over time if data exists.
  The guidelines section becomes a collapsible "How your score is calculated".
- **Reports & analytics:** real charts via Recharts styled per the `dataviz` skill
  (order value over time, by material, by plant), KPIs left-aligned in a grid, tables
  with totals rows. Export CSV in the page header only, once.
- **Tenant workspace & platform pages:** same system, compact density; supplier
  onboarding/approval and SAP reconciliation get clear diff/comparison layouts.
- **Auth pages:** quiet, centred, single column, tenant brand colour + logo where
  branding applies; password-policy checklist (10+ chars with complexity) shown inline.

---

## 8. Anti-"AI crap" checklist (fail the PR if any are present)

- ❌ Gradient text, purple/blue gradient backgrounds, glassmorphism, glow shadows.
- ❌ Emoji as icons; icon in a coloured circle next to every heading.
- ❌ Uppercase tracked labels on everything; more than one font weight jump per block.
- ❌ Cards inside cards inside cards; every section in its own bordered box.
- ❌ Giant KPI numbers for zero values; "Grade A 100/100" shouted twice on one page.
- ❌ Centred floating values without alignment; left-stripe accent cards.
- ❌ Dashed-border empty boxes taller than 120px.
- ❌ More than one primary button per view; duplicate CTAs to the same place.
- ❌ Marketing-style copy ("Treasury Disbursements", "Logistics Invoices Ledger") on
  operational UI — flag for the user, don't silently rename.
- ✅ Alignment to a grid, tabular numbers, decimal-aligned money, consistent page headers,
  visible focus, keyboard-operable everything, WCAG 2.2 AA in both themes.

---

## 9. Delivery

- Work on a branch in a git worktree off `master`, one PR per phase (3, 4, 5a vendor,
  5b workspace, 5c platform + auth) so each is reviewable.
- Each PR includes before/after screenshot grids (Playwright), a list of components touched,
  confirmation that `npm test`, `npm run lint` and `next build` pass, and an explicit
  statement: "No behavioural changes: no API, route, permission or state logic modified."
  List any exception explicitly.
- Run the `taste` skill and `/code-review` on each PR's diff before opening it.
- Finish with `docs/redesign/design-system.md` (tokens, primitives, do/don't examples) so
  future screens stay consistent.
