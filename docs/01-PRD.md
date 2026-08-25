# Product Requirements Document (PRD)
## CustomerConnect SaaS — Multi-Tenant B2B Customer Portal for SAP-Running Enterprises

| | |
|---|---|
| **Version** | 1.0 (Draft) |
| **Author** | Manas Singh |
| **Date** | 2026-07-25 |
| **Status** | For review |

---

## 1. Product Vision

A white-label, multi-tenant SaaS platform that gives manufacturers, distributors, and B2B sellers running **SAP S/4HANA (or ECC)** a modern customer self-service portal covering the full **Order-to-Cash (O2C)** cycle — onboarding, catalogue, quotations, orders, delivery tracking, invoicing, payments, support, and analytics — with **first-class Indian statutory compliance** (GST, e-Invoice/IRN, e-Way Bill, PAN/TDS/TCS).

**One platform, many tenants.** Each subscribing company (tenant) connects its own SAP system, applies its own branding, configures its own field mappings and approval workflows, and onboards its own customers as portal users.

## 2. Problem Statement

B2B sellers on SAP handle customer interactions manually: orders arrive by email/phone/WhatsApp, sales staff re-key them into VA01, customers call for order status, finance chases payments against FBL5N printouts. Consequences:

- High order-entry cost and error rate (wrong material codes, prices, quantities).
- Zero customer visibility into order status, stock, pricing, ledger, or credit position.
- Slow onboarding of new customers (paper KYC, manual GSTIN checks, weeks to a customer code).
- Compliance overhead: e-Invoice IRN, e-Way Bills, GST reconciliation are manual and error-prone.
- SAP-native portal options (SAP Commerce/CX) are expensive, heavy, and rarely adopted by Indian mid-market companies.

## 3. Target Market & Personas

### 3.1 Buyer (the tenant)
- Indian mid-market to large enterprises (₹100 Cr–₹5,000 Cr revenue) running SAP S/4HANA or ECC 6.0 with the SD and FI-AR modules; typically manufacturing, auto components, chemicals, pharma, FMCG distribution, industrial goods.
- Buying personas: CIO/IT Head (integration, security), Sales Head (adoption, revenue), CFO (AR, compliance).

### 3.2 End users (per tenant)
| Persona | Type | Needs |
|---|---|---|
| **Customer user** | External (tenant's B2B customer) | Browse catalogue at their prices, order, track, download invoices, pay, raise tickets |
| **Customer admin** | External | Manage their company's portal users, addresses, bank details |
| **Sales user** | Internal (tenant staff) | Review onboarding, issue quotations, confirm orders |
| **Credit team** | Internal | Approve credit limits, release credit-blocked orders |
| **Support agent** | Internal | Resolve tickets within SLA |
| **Tenant admin** | Internal | Branding, user management, field-mapping config, SAP connection, workflows |
| **Platform admin** | Us (SaaS operator) | Tenant provisioning, billing, monitoring, support |

## 4. Goals & Success Metrics

| Goal | Metric | Target (12 mo post-GA) |
|---|---|---|
| Tenant acquisition | Paying tenants | 15+ |
| Order digitization | % of tenant orders via portal | ≥40% per mature tenant |
| Order-entry effort | Sales time per order | −70% |
| DSO improvement | Days sales outstanding | −10% for tenants using payments |
| Onboarding speed | Prospect → active SAP customer code | < 3 business days |
| Reliability | Portal availability | 99.9% |
| SAP sync integrity | Failed sync transactions auto-recovered | ≥99% |

## 5. Scope

### 5.1 MVP (Phase 1 — first sellable version): Core O2C
1. **Customer Onboarding** — 4-step registration (company, tax, credit, documents), GSTIN validation, internal approval workflow, SAP customer-master creation.
2. **Product Catalogue** — material browse/search, plant-level stock, customer-specific pricing.
3. **Sales Order Management** — order creation (direct), ATP check, credit-check status, order status tracking, confirmation PDF.
4. **Delivery & Tracking** — delivery status, dispatch dates, carrier/AWB, e-Way Bill download, proof-of-delivery confirmation with discrepancy capture.
5. **Billing & Invoices** — invoice list/detail, GST breakup, IRN/e-invoice download, credit/debit notes (view).
6. **Account Statement** — ledger view (invoices, payments, notes), outstanding balance, AR aging.
7. **Tenant admin console (minimum)** — branding, user management, SAP connection config, field-mapping overrides, approval routing.
8. **Platform admin console (minimum)** — tenant provisioning, subscription state, health monitoring.

### 5.2 Phase 2
- Inquiry & Quotation (raise inquiry → quote → convert to order).
- Online payments (UPI/NEFT/card gateway; auto-posting and clearing in SAP).
- Service & Support ticketing with SLA.
- Reports & analytics dashboards (purchase trends, on-time delivery %, AR aging charts).

### 5.3 Phase 3
- Loyalty tiers & rebate visibility.
- Order change/cancel workflows; returns & credit-memo requests.
- Mobile apps / PWA; WhatsApp notifications.
- Multi-country tax packs (beyond India); multi-language.
- Marketplace of connectors (SAP CPI, Business One, other ERPs).

### 5.4 Out of scope (all phases, initially)
- B2C commerce, cart abandonment marketing, freight procurement, warehouse management, SAP configuration consulting.

## 6. Key Product Requirements (Epic level)

### E1 — Multi-tenancy & white-labelling
- R1.1 Tenant-scoped data isolation for all records; no cross-tenant leakage under any query path.
- R1.2 Per-tenant branding: logo, colors, custom domain (portal.tenantco.com), email templates.
- R1.3 Per-tenant configuration: enabled modules, field visibility/labels, mandatory-field rules, approval chains, number formats, fiscal year.
- R1.4 Per-tenant SAP connection profile (host, credentials, protocol, system type ECC/S4, mapping overrides).

### E2 — Customer onboarding
- R2.1 Multi-step wizard with draft save; sections: Company Identity, Billing Address, Contacts; Tax (PAN, GSTIN, GST reg. type, CIN, TAN, MSME/Udyam); Credit & bank; Documents.
- R2.2 Real-time GSTIN verification via GSTN public API; PAN format validation; duplicate detection (GSTIN/PAN already registered for this tenant).
- R2.3 Configurable approval workflow (sales review → credit review, parallel or serial per tenant).
- R2.4 On approval, create SAP Customer Master via BAPI (general data KNA1, sales area KNVV, credit KNKK, contacts, bank KNBK); sync customer code back; auto-issue portal credentials.
- R2.5 Rejection / request-more-info loop with customer notification.

### E3 — Catalogue & pricing
- R3.1 Material sync from SAP (MARA/MAKT/MARC/MVKE) — scheduled + on-demand.
- R3.2 Customer-specific pricing resolved from SAP condition records (or simulated via pricing BAPI); never show another customer's price.
- R3.3 Plant-level available stock (ATP) with configurable display (exact qty / range / in-stock flag per tenant).
- R3.4 Product images and spec-sheet attachments managed in the portal (or GOS-linked).
- R3.5 MOQ and sales-unit enforcement at cart level.

### E4 — Orders
- R4.1 Order creation with customer PO reference, requested delivery date, ship-to selection (partner function SH), line items (material, qty, UoM).
- R4.2 Real-time ATP simulation before submit; show confirmed qty/date.
- R4.3 Submit to SAP via order-create BAPI; store SAP order number; idempotent retry on failure.
- R4.4 Surface SAP statuses: overall (GBSTK), delivery (WBSTK), credit block (CMGST) with plain-language labels.
- R4.5 Credit-blocked orders visible to tenant credit team with release action (writes back to SAP or notifies, per tenant config).
- R4.6 Order confirmation PDF download.

### E5 — Delivery
- R5.1 Delivery documents linked to orders; status timeline (created → picked → packed → PGI → delivered).
- R5.2 e-Way Bill number & PDF surfacing; carrier + tracking ID with deep link where carrier supported.
- R5.3 POD: customer confirms receipt qty vs dispatched; discrepancy auto-creates a support ticket (Phase 2) or notification (MVP).

### E6 — Invoices & statement
- R6.1 Invoice list with GST breakup (CGST/SGST/IGST), due date, status (open/overdue/paid).
- R6.2 IRN + signed QR e-invoice download; standard invoice PDF.
- R6.3 Ledger/statement: open & cleared items from SAP AR (BSID/BSAD) with running balance, filters, Excel/PDF export.
- R6.4 AR aging buckets (0–30/31–60/61–90/>90).
- R6.5 Dispute flag on invoice (routes to tenant AR team).

### E7 — Notifications
- R7.1 Event-driven email (MVP) + in-app notifications: onboarding decisions, order confirmed, credit block, dispatch, invoice issued, payment due reminders.
- R7.2 Per-tenant template customization; per-user notification preferences.

### E8 — Payments (Phase 2)
- R8.1 Gateway integration (Razorpay/PayU/Cashfree — tenant-selectable); pay one or multiple open invoices, full or partial.
- R8.2 Webhook-driven reconciliation: post incoming payment to SAP (F-28 equivalent BAPI/IDoc) with gateway reference; clearing against selected invoices.
- R8.3 Failure handling: payment success + SAP posting failure must never lose money — queued retry with finance-team alerting.

### E9 — Tenant & platform administration
- R9.1 Tenant self-service admin: users/roles, branding, module toggles, field config, SAP connection test, sync monitor (queue depth, failures, replay).
- R9.2 Platform console: tenant lifecycle (trial → active → suspended), plan/subscription management, usage metering (orders/month, users, API calls), health dashboards.
- R9.3 Audit log of all admin and data-changing actions, tenant-scoped, exportable.

## 7. Non-Functional Requirements (product view)

| Area | Requirement |
|---|---|
| Availability | 99.9% monthly for portal; SAP-dependent features degrade gracefully (read from cache, queue writes) when tenant SAP is down |
| Performance | P95 page load < 2s on cached reads; order submit round-trip to SAP < 8s or async with status |
| Scale | 100 tenants, 50k customer users, 10k orders/day design target |
| Security | Tenant isolation, RBAC, MFA option, encryption at rest & transit, OWASP ASVS L2 |
| Compliance | India DPDP Act 2023, GST/e-Invoice/e-Way Bill regulations, SOC 2 Type II roadmap |
| Localization | INR + Indian number format (lakh/crore) day one; architecture ready for multi-currency/multi-locale |
| Accessibility | WCAG 2.1 AA for customer-facing screens |

## 8. Monetization

- **Subscription per tenant**: tiered by modules enabled + customer-user count + order volume. Indicative: Starter / Growth / Enterprise.
- **One-time onboarding/integration fee** per tenant (SAP connection setup, mapping workshop).
- **Payment processing margin** (Phase 2) and premium connectors as add-ons.

## 9. Competitive Landscape (positioning input)

SAP Commerce Cloud (too heavy/costly for mid-market), custom Fiori/BTP builds (per-company, not SaaS), generic B2B commerce (Shopify B2B, Unizap — weak SAP depth, weak Indian compliance). **Differentiators: deep SAP field-level integration, India compliance built-in, fast tenant onboarding, mid-market pricing.**

## 10. Assumptions & Risks

| # | Assumption / Risk | Mitigation |
|---|---|---|
| A1 | Tenants can expose SAP via RFC/OData over secure channel | Support VPN, SAP Cloud Connector, and agent-based connector deployed in tenant network |
| R1 | Every tenant's SAP is configured differently (Z-fields, pricing procedures) | Metadata-driven mapping layer, not hardcoded fields; paid onboarding service |
| R2 | GSTN/e-Invoice APIs change or rate-limit | Use GSP/ASP provider abstraction (e.g., ClearTax/MastersIndia APIs) behind an interface |
| R3 | Tenant SAP downtime blamed on portal | Health dashboard per tenant, cached reads, explicit "SAP unavailable" states |
| R4 | Long enterprise sales cycles | Design-partner program: 2–3 tenants co-develop MVP at discount |

## 11. Open Questions

1. Do we ship an on-premise connector agent in MVP, or require SAP-side network exposure (VPN)?
2. ECC 6.0 support at GA, or S/4HANA only first?
3. Is the internal-staff experience (sales/credit/support) in the portal, or do staff keep working in SAP GUI with the portal only writing/reading? (MVP recommendation: minimal internal screens for onboarding approval + credit release only.)
4. Pricing display: live SAP pricing call per catalogue view vs. nightly-synced price cache — per-tenant choice?

---
*Companion documents: 02-TRD (architecture), 03-FRD (module functional detail), 04-SAP Integration Spec, 05-Multi-tenancy & Security Spec, 06-Roadmap.*
