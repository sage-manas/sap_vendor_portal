# Redesign — Phase 1 audit

Status: complete, no application code changed. Captured 2026-10-16 against the
demo seed (`supplier@meridiancastings.in`, `admin@nucleusmfg.in`) and a local
throwaway operator (`redesign-screens@local.test`).

Screenshots: [`before/`](before/) — 38 routes × {1440×900, 1280×800, 768×1024,
390×844} × {light, dark} = 304 PNGs (18 MB), named `<route>__<w>x<h>__<theme>.png`,
grouped `auth/ vendor/ workspace/ platform/`. Next's dev-tools badge (the
floating "N") is hidden in every capture — it is dev-only chrome, not product
UI, so it is struck from the problem list below.

---

## 1. What we are actually working with

| | |
|---|---|
| Styling | Tailwind v4, tokens in `src/app/globals.css` (381 lines) as RGB triplets + `@theme inline`; a small `.btn/.card/.status-badge/.label/.page-title` component layer; `shadcn-variants.css` aliases |
| Fonts | Geist + Geist Mono + Source Serif 4, all self-hosted via `next/font/local` (`src/app/layout.jsx`) |
| Theme | `.dark` on `<html>`, resolved pre-paint by an inline nonce'd script (`vc-theme` in localStorage, falls back to OS) |
| Branding | `src/lib/branding.js` writes only `--color-emerald-default-rgb` |
| Shells | **Three** separate shells: supplier `PortalLayout` (Header + Sidebar + CommandPalette), `app/workspace/layout.jsx`, `app/platform/layout.jsx` — the last two are near byte-identical copies |
| Primitive set | `src/components/ui` is thin; most UI is hand-written utility strings inside 5 very large feature views (PurchaseOrdersView 1,895 lines, RegistrationView 1,391, RfqView 1,248, DashboardView 938, PaymentTrackingView 709) |

### Anti-pattern counts (non-test source, `src/**`)

| Pattern | Hits | Files |
|---|---:|---:|
| `uppercase` | 115 | 34 |
| arbitrary `text-[Npx]` sizes | 430 | 58 |
| …of which 8–10px | 149 | 36 |
| `font-mono` / `.mono` | 310 | 47 |
| raw Tailwind palette colours (`rose-/amber-/red-/emerald-/blue-/green-NNN`) | 375 | 38 |
| hex literals in JSX | 40 | 8 |
| status pills (`status-badge` / `<StatusBadge>` / `<Status>`) | 65 | 25 |
| inline `style={{…}}` | 29 | 21 |
| `.card` wrappers | 122 | 38 |

Hotspots (uppercase + badge + mono + ≤10px per file): PurchaseOrdersView (109),
RfqView (81), DashboardView (47), ReportsAnalyticsView (31), RegistrationView (29),
PaymentTrackingView (28), `console/primitives.jsx` (25).

The 375 raw palette colours matter beyond looks: **none of them follow tenant
branding or the token system**, so a tenant who sets a green accent still gets
coral buttons beside hard-coded green links (`emerald-400` "Forgot password?").

---

## 2. Component inventory

"Used by" counts are import sites in non-test source.

### `src/components/ui`

| Component | Used by | Current problems | Planned replacement |
|---|---|---|---|
| `button.tsx` | 8 views + ErrorBoundary | Variants map to legacy `.btn-*` classes; `ghost` is actually a tinted accent fill; `secondary`≡`outline`; 1px ring at 50% — focus barely visible; `xs` = 10px text; `active:scale` | Rewrite on tokens: primary / secondary / ghost / destructive / link × sm/md/lg/icon, `loading` prop (width-stable), 2px offset focus ring. Keep export + prop names; alias old variant names |
| `Card.jsx` | 5 | Trivial `div.card`; card has border **and** shadow; used to box every section → cards-in-cards | Keep API; flat surface, hairline only, no shadow. Add `Card.Header` / `Section` so pages stop boxing everything |
| `EmptyState.jsx` | 6 | Dashed 2px-radius box, `py-10 m-3`, 48px icon disc — 200px+ tall even inside a table; copy in 11px | Compact inline variant (one line, optional icon, one CTA) + `TableEmpty` row variant; max 120px |
| `KPICard.jsx` | 2 (Dashboard, POs) | Coloured 3px left rail + tinted icon chip + 28px value; zero renders exactly like signal; 4 hard-coded hexes | Label / value / optional delta+sparkline / optional link; muted zero with hint; no rail, no chip |
| `Page.jsx` | **0** | Dead — every page hand-rolls its header instead | Becomes the single `PageHeader` (breadcrumb, title, description, one primary, overflow menu) used by all three surfaces |
| `StatusBadge.jsx` | 6 | Pass-through to `.status-badge`: uppercase mono 10px pill, tint+border on every value; caller picks the `variant`, so the same status gets different colours on different pages (Invoices: `CLEARED` is amber like `MATCH WARNING`) | Dot + sentence-case label, neutral by default, filled tint only for attention states; **one** domain→tone map for PO/GRN/ASN/invoice/payment/RFQ/bid/vendor/SAP-sync, merged with `console/primitives` `Status` |
| `TableSkeleton.jsx` | 2 | Fine structurally; uses `animate-pulse` on `border-em` grey | Fold into DataTable loading state; respect reduced motion |
| `Spinner.jsx` | **0** | Dead | Becomes the button/inline spinner |
| `Drawer.jsx` | 1 (Dashboard) | Gradient top bar (`from-primary/60`), `backdrop-blur`, `z-[90]/[100]`, hard-coded `top-11` (44px) though header is 52px → 8px gap; close button has no accessible name; no focus trap | Base UI Dialog-based sheet; tokens; labelled close; focus management |
| `Modal.jsx` | 6 | Hand-rolled; `shadow-2xl`; no focus trap (focus can tab behind it); header/footer on `surface2` = two more boxes | Base UI Dialog; keep `open/onClose/title/footer` props |
| `FieldCard.jsx` | 4 | **Label to the left, fixed `w-28`** — truncates longer labels; 11px bold red error relies on colour; good a11y association logic | Keep `useLabelledControl` untouched; label above, helper/error below with icon + text |
| `CommandPalette.jsx` | 1 (PortalLayout) | Works; duplicates the nav list from Sidebar (two copies of module names); supplier-only | Restyle only; source nav from one list (presentation refactor, no behaviour change) |

### `src/components/portal`

| Component | Used by | Current problems | Planned replacement |
|---|---|---|---|
| `PortalLayout.jsx` | root layout | Fine | Keep; swap shell children |
| `Header.jsx` | PortalLayout | "Connected · GST + TDS + MSME" mono chip is static text, not status; red `bg-red-500` unread bubble; notification header uppercase 11px; timestamps in 9px mono; `sidebarCollapsed` pulled but unused here | Top bar: workspace name, Ctrl K search, single SAP status indicator w/ popover, notifications, theme, user menu |
| `Sidebar.jsx` | PortalLayout | Collapsed by default → 72px icon rail, labels only on hover-expand; "Navigation"/"Modules" uppercase group labels; badge counts with no accessible label; logout & "Reset demo data" styled as 11px **mono** links; **never collapses on mobile** (stays 72px at 390px) | Labelled sidebar per Phase 4, persisted collapse, mobile sheet, accessible count pills |
| `ToastNotification.jsx` | portal-context | Hard-coded `bg-white text-slate-900` — **white toast in dark mode**; 4px coloured left border; title is the type name in uppercase ("SUCCESS"); close button unlabelled | Token toast, icon + message, labelled dismiss, `aria-live` region |
| `WorkspaceBrand.jsx` | sign-in, sign-up | Caption in 10px mono uppercase repeats the title when unbranded ("VendorConnect / SUPPLIER PORTAL · VENDORCONNECT") | Logo/initial + name + quiet caption |
| `TenantBranding.jsx` | PortalLayout | Functional, no visual | Untouched |
| `payment/components/DesignComponents.jsx` | **0** | Dead (330 lines: a second KPICard with `bgGradient`, etc.) | Delete in Phase 3 |

### `src/components/console`, `platform`, `shared`

| Component | Used by | Current problems | Planned replacement |
|---|---|---|---|
| `console/primitives.jsx` `PageHeader` | 22 workspace/platform pages | The *good* header — but vendor pages don't use it → two header patterns | Superseded by shared `PageHeader` |
| `…Notice` | many | `text-rose-400` on `rose-500/10` in **light** mode ≈ 2.9:1 — fails AA (visible on every rate-limit/error banner) | Token `Callout` (info/warn/danger) |
| `…Field` | console forms | `<input>` rendered **without `type`** → none of the global `input[type=…]` styles apply → **borderless inputs that read as static text** (New asset PO, Reconciliation tenant filter) | Field primitive with explicit input styling — fixes a real usability bug |
| `…Status` | console tables | Second status map, separate from `StatusBadge` | Merge into the one status map |
| `…Table` | console lists | Every cell defaults to mono; no numeric alignment; no mobile behaviour (squeezes to one visible column at 390px); empty row centred | DataTable |
| `…Loading` | console | OK | Skeleton |
| `platform/PlatformGate.jsx` | platform layout | Sign-in / change-password / MFA panels; secret key shown in accent colour; 11px links | Auth layout primitives |
| `shared/FileUploadZone.jsx` | 2 | Dashed drop zone (legit use of dashed), 10px text | Restyle |
| `shared/SkeletonLoader.jsx` | 2 | Third skeleton implementation | Merge with TableSkeleton |
| `ErrorBoundary.jsx` | 5 | OK | Restyle |

### Shell duplication

`app/workspace/layout.jsx` and `app/platform/layout.jsx` repeat the same header
+ 224px text sidebar markup. At 768 and 390px neither has any responsive
behaviour: the sidebar stays 224px, the header wraps the tenant chip onto three
lines, and tables are cut to one column (`workspace_purchase-orders__390x844`).
The platform console is distinguishable from a tenant workspace **only** by the
word in the header chip.

---

## 3. Route inventory and primary job

| Surface | Route | Primary job | Worst problems seen |
|---|---|---|---|
| Vendor | `/` dashboard | See what needs doing today | See §4.1 |
| | `/pos` | Acknowledge & ship orders | 4 KPI cards all "0"; dashed empty box ~230px; empty copy says "click the simulation button above" — **no such button exists** |
| | `/invoices` | Know where each invoice stands | Header inside a white card (other pages: on canvas); prose "Awaiting the buyer's finance team" set in mono; `CLEARED` amber = same tone as `MATCH WARNING`; "Not confirmed yet" amber-500 text on white ≈ 2.1:1 |
| | `/payments` | Reconcile money received | 10-column table **overflows at 1440** (last column clipped); net amount in neon `#00c58e`-ish green ≈ 2.3:1 on white; TDS shown as "- ₹ 1,770.00" with a spaced rupee; dates `18.07.2026` here vs `02 Jul 2026` on Invoices vs `16 Oct 2026` on dashboard; UTR wraps mid-number; dashed empty box for "payments recorded by your buyer" directly below a populated table of payments |
| | `/rfqs` | Quote on open requests | RFQ title SHOUTED; two-pane split with redundant "Hide list" + collapse chevron; numbered step chips "01/02" decorate section headings; progress stepper is a card row inside a card inside a card |
| | `/performance` | Understand and improve score | Grade "C" in a box + "78/100" big + KPI tiles; meters are orange regardless of state with **no target tick** (target only as text); guidelines block titled "Operational compliance guidelines & protocol rules" |
| | `/analytics` | Analyse orders, invoices, ledger | No charts; every value is a centred tinted pill with an icon-labelled uppercase caption — "₹ 0.00", "–", "0" in yellow/blue/green capsules; tabs numbered "1. Orders & Spend" |
| | `/registration` | Complete onboarding | Left-label `FieldCard` truncation; long single page |
| Workspace | `/workspace` | Spot what needs a decision | 14 identical bordered tiles in 5 uppercase groups; attention is shown by a pink border + pink number (colour only) |
| | `/workspace/suppliers` (+ detail) | Approve / manage suppliers | Detail: 3 boxed sections + 2 boxed side panels; "Not provided" in mono; email wraps mid-word ("…example.co / m") |
| | `/workspace/purchase-orders` (+ detail, new-asset) | Track / raise POs | Value column left-aligned; every cell mono; date+time in mono; **borderless inputs** on New asset PO |
| | shipments, invoices, payments, rfqs, audit, users, settings | Back-office lists/forms | Same table; Settings switch is hard-coded green, not accent; field keys (`branding.logo`) shown in mono under every setting |
| | `/admin` | redirect | — |
| Platform | `/platform`, tenants (+ detail, SAP), operators, sap, reconciliation, audit | Operate tenants and SAP | Visually identical to workspace; status pills `TRIAL`/`ACTIVE`; "growth" plan in mono; Reconciliation filter input borderless |
| Auth | sign-in, sign-up, forgot/reset/change-password, confirm-email, accept-invitation, platform sign-in | Get in | Card on canvas is fine structurally; title-case button "Sign In to Portal"; off-palette green links; password placeholder `••••••••` reads as a filled value; 10px uppercase labels |

Not captured: `/platform/reset-password` (needs a token), PO detail on the vendor
side (opens in-view, not a route), and drawers/modals (need interaction — will
be covered by the Phase 3 `/__design` route).

---

## 4. Critique

### 4.1 Confirming the brief's list

| Brief claim | Verdict | Evidence |
|---|---|---|
| Uppercase-tracked micro-labels everywhere | **Confirmed, worse than stated** | 115 `uppercase`, 149 sizes ≤10px. Table headers, form labels (`.label`), KPI labels, section titles, sidebar groups, toast titles, status pills — the only sentence-case text on most pages is body copy |
| Status pills compete with data | **Confirmed** | 65 sites; pill is uppercase mono 10px with tint *and* border. Worse: tone is chosen per call site, so the same status is coloured differently across pages |
| KPI tiles = rail + chip + giant number; zeros shouted | **Confirmed** | Dashboard, POs (four "0"s), Workspace overview (14 tiles), Performance |
| Big dashed empty states | **Confirmed** | POs ~230px, Payments ~120px under a full table, Dashboard PO monitor |
| Analytics = centred floating pills | **Confirmed** | `analytics__1440x900__dark` |
| Icon-only rail, unexplained badges | **Confirmed (default state)** — the rail is a 250px sidebar that *defaults* to collapsed 72px and expands on hover. Badge "1" sits on the RFQ icon with no label |
| Two header patterns | **Confirmed, three actually**: serif title on canvas (Dashboard, POs, Payments, RFQs, Analytics), title inside a white card (Invoices, Performance), and the console `PageHeader` with a rule below |
| Redundant controls | **Confirmed** | "Connected" ×2 on dashboard (header chip + page button) plus "Approved" pill; "View Invoices" ×4 (header button, quick tile, alert link "Review invoices", ledger "All Invoices"); 5 quick tiles duplicate the nav |
| Mono for money, dates *and* badges | **Confirmed** | 310 sites; also prose ("Awaiting the buyer's finance team", "Not provided", "Pending Master"), logout link, role names |
| Keep Indian grouping, align decimals | **Confirmed** formatting correct; amounts are right-aligned in some tables, left in others (workspace POs); rupee sign is sometimes spaced ("₹ 1,770.00") which breaks alignment |
| Floating "N" button | **Struck** — Next.js dev indicator, absent in production |

### 4.2 New findings

**Defects that are visual but user-facing (fix in Phase 3/5, no logic change):**

1. **Borderless inputs** in console forms — `Field` renders `<input>` without
   `type`, so global input styles never apply. New asset PO looks like a
   read-only summary.
2. **White toast in dark mode** — `ToastNotification` hard-codes `bg-white`.
3. **Contrast failures** (to be verified by script in Phase 2, eyeballed here):
   amber-500 "Not confirmed yet" on white; neon green net amounts; `text-rose-400`
   error notices on light pink; `emerald-400` links on cream; 9–10px
   `text-tertiary` text throughout.
4. **No responsive shell for workspace & platform** — at 390px the 224px nav
   stays, header wraps, tables show one column. The supplier shell keeps a 72px
   rail on phones.
5. **Payments table clips at 1440px.**
6. **Drawer offset bug** — `top-11` (44px) vs a 52px header.
7. **Unlabelled icon buttons** — Drawer close, toast close, sidebar count badges.
8. **Off-brand hard-coded colours** — 375 raw palette classes + 40 hexes ignore
   tenant branding (Settings toggle green, links green, warnings amber, net
   amounts green) — a tenant's accent only reaches buttons and the active nav.

**Inconsistency:**

9. Three date formats (`18.07.2026`, `02 Jul 2026`, `16 Oct 2026, 4:42 pm`).
10. Three skeleton implementations, two KPI cards, two status maps, two field
    wrappers, three shells.
11. Radius scale in use: 2px (`rounded-none`/sm), 5px, 6, 8, 12, 16, full — the
    brief allows three.
12. Elevation: card shadow, `shadow-lg` popovers, `shadow-xl` toasts,
    `shadow-2xl` modals, coloured `borderPulse` glow — four-plus levels.
13. Title Case vs sentence case mixed ("Sign In to Portal", "No Purchase Orders
    Found" vs "Every order SAP holds…").
14. Platform and workspace are visually indistinguishable — risk of an operator
    acting in the wrong plane.

**Typography:**

15. Serif headline + humanist sans + mono on most screens = three families
    fighting; serif at 23px in a dense console reads as marketing.
16. No type scale — 430 arbitrary px sizes; 8, 9, 10, 11, 12, 13, 14, 15, 16,
    22, 23, 28px all appear.

**Things that are good and must survive:** sentence-case vendor-facing copy
(recent rewrite), `FieldCard`'s label association, `Modal`'s focus fix, the
console `PageHeader` idea, Indian number grouping, `formatDateOnly` UTC handling,
skip link, the pre-paint theme script, per-tenant accent.

### 4.3 Copy to flag (not renaming — user decision, per §8 of the brief)

| Where | Current | Note |
|---|---|---|
| Dashboard panel | "Logistics Invoices Ledger" | Marketing-ish; it lists invoices |
| Dashboard panel | "Purchase Orders Monitor" / Orders tab "Orders Monitor" | "Monitor" adds nothing |
| Performance | "Operational metrics timeline check", "Operational compliance guidelines & protocol rules" | Brief proposes "How your score is calculated" |
| Performance | "Supplier Performance scorecard" | Mixed case |
| Payments | "TDS Tax Certificates" | "Tax" duplicates the T in TDS |
| POs empty state | "…or click the simulation button above" | **Broken** — refers to a control that doesn't exist |
| Nav | "Vendor Dashboard", "Invoice Processing", "Payment Tracking", "RFQ Management" | Brief's Phase 4 names: Overview / Invoices / Payments / RFQs |
| Sign-in | "Sign In to Portal" | → "Sign in" |

### 4.4 Behaviour found that is *not* presentation (listed, not touched)

- **Dashboard "Connected" is a button that toggles a simulated disconnect**
  (`DashboardView.jsx` `toggleConnection`, title "Click to toggle the
  connection state"). It is a demo control in the production UI. Restyling it
  as a status indicator would hide a behaviour; removing it is a logic change.
  **Decision needed.**
- Header "Connected · GST + TDS + MSME" chip is static text — it never reflects
  real SAP state. Making the Phase 4 indicator real needs a data source
  (logic change). **Decision needed**: keep static, or wire it up.
- Sidebar "Reset demo data" is gated by `NODE_ENV !== 'production'` — fine, will
  restyle as a dev-only menu item.
- Dev DB contains backend-test residue (`vendor_fy_collide`, `vendor_fy_driver_1`)
  that shows in workspace lists — data, not design; screenshots in Phase 5 will
  use a fresh `seed:demo --reset` if you approve that.

---

## 5. Inputs for Phase 2

Design-first priorities, in order: (1) DataTable — it's on ~20 screens and
carries most of the damage; (2) status map + StatusBadge; (3) PageHeader;
(4) Field/inputs (fixes the borderless bug); (5) KPI; (6) shells, including a
mobile story for workspace/platform that doesn't exist today.
