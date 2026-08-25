# Technical Requirements Document (TRD) & System Architecture
## CustomerConnect SaaS — Multi-Tenant SAP Customer Portal

Version 1.0 · 2026-07-25 · Companion to 01-PRD.md

---

## 1. Recommended Technology Stack (with rationale)

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | **React 18 + TypeScript + Next.js** | SSR for fast loads & SEO on tenant subdomains, per-tenant theming, large talent pool |
| UI system | Tailwind CSS + shadcn/ui + design tokens per tenant | White-labelling via CSS variables (as in the reference design) |
| API backend | **NestJS (Node.js + TypeScript)** | Structured modular framework, DI, guards/interceptors ideal for tenant-context enforcement; single language across stack |
| SAP connector service | **Java (Spring Boot) microservice** | SAP JCo (RFC/BAPI) is Java-native; OData also supported. Keep SAP protocol mess isolated in one service |
| Database | **PostgreSQL 16** with **Row-Level Security (RLS)** | Battle-tested tenant isolation; JSONB for metadata-driven field mapping |
| Cache | Redis | Session, catalogue/pricing cache, rate limiting |
| Queue / events | **RabbitMQ** (or SQS) + outbox pattern | Reliable async SAP writes, retries, DLQ for failed syncs |
| Object storage | S3-compatible | KYC documents, invoice PDFs, PODs, product images — tenant-prefixed buckets, SSE |
| Search | Postgres FTS (MVP) → OpenSearch (scale) | Catalogue search |
| Auth | **Keycloak** (or Auth0) — one realm per tenant | OIDC, MFA, SSO for tenant staff (SAML/AD), realm-level isolation |
| Infra | AWS (Mumbai region) · Docker · **Kubernetes (EKS)** | India data residency (DPDP), tenant workload isolation options |
| IaC / CI-CD | Terraform + GitHub Actions | Reproducible envs: dev → staging → prod |
| Observability | OpenTelemetry + Grafana/Prometheus/Loki + Sentry | Per-tenant dashboards; SAP sync-health metrics are a product feature |
| e-Invoice / GST | GSP/ASP provider (ClearTax / MastersIndia / Zoho) behind interface | Avoid direct NIC API operational burden |
| Payments (P2) | Razorpay primary, gateway-adapter interface | Tenant-selectable |

**Alternative considered:** single Java/Spring monolith (simpler ops, native JCo everywhere) — valid if the team is Java-first. The recommendation above optimizes for TS product velocity while quarantining SAP-specific complexity.

## 2. High-Level Architecture

```
                        ┌────────────────────────────────────────────┐
  Customer users ──────►│  Next.js web app (per-tenant domain/theme)  │
  Tenant staff   ──────►│                                            │
                        └────────────────┬───────────────────────────┘
                                         │ HTTPS (OIDC bearer)
                        ┌────────────────▼───────────────────────────┐
                        │  API Gateway (rate limit, WAF, tenant resolve)│
                        └────────────────┬───────────────────────────┘
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
   ┌──────────────────┐      ┌──────────────────┐       ┌──────────────────┐
   │ Core API (NestJS)│      │ Admin API        │       │ Notification svc │
   │ onboarding/orders│      │ (tenant+platform)│       │ email/in-app     │
   │ invoices/ledger  │      └──────────────────┘       └──────────────────┘
   └───────┬──────────┘
           │  events / commands (RabbitMQ, outbox)
           ▼
   ┌─────────────────────────────┐        ┌──────────────────────────┐
   │ SAP Integration Service     │◄──────►│ Tenant SAP S/4HANA / ECC │
   │ (Spring Boot + JCo/OData)   │  RFC / │ via VPN, SAP Cloud       │
   │ mapping engine, retry, DLQ  │  OData │ Connector, or on-prem    │
   └─────────────────────────────┘        │ connector agent          │
           │                              └──────────────────────────┘
           ▼
   ┌─────────────┐  ┌────────┐  ┌──────────┐  ┌───────────────┐
   │ PostgreSQL  │  │ Redis  │  │ S3 docs  │  │ GSP (GST/IRN) │
   │ (RLS)       │  └────────┘  └──────────┘  │ Payment GW    │
   └─────────────┘                            └───────────────┘
```

### 2.1 Service decomposition (MVP = modular monolith + 1 satellite)
Do **not** over-microservice at MVP. Ship:
1. **core-api** (NestJS modular monolith): auth glue, tenants, onboarding, catalogue, orders, deliveries, invoices, ledger, notifications module, admin module.
2. **sap-connector** (Spring Boot): the only service speaking RFC/BAPI/OData; exposes an internal REST/gRPC contract ("create order", "get open items") that is **SAP-version agnostic**; contains the metadata-driven field-mapping engine.
3. Split further (notifications, payments, reporting) only when load or team size demands.

## 3. Multi-Tenancy Model

| Concern | Decision |
|---|---|
| Data | **Shared DB, shared schema + `tenant_id` column + Postgres RLS** on every table. RLS policy bound to `current_setting('app.tenant_id')` set per request from the JWT. Enterprise tier can be offered schema-per-tenant later. |
| Tenant resolution | Subdomain / custom domain → tenant record → injected into request context by gateway middleware; JWT also carries `tenant_id`; both must match. |
| Auth | Keycloak realm per tenant (isolated user stores, per-tenant MFA/SSO policy). |
| SAP connectivity | Per-tenant connection profile (encrypted credentials in Vault/KMS) + per-tenant mapping metadata. Connection pool per tenant in sap-connector. |
| Files | S3 keys prefixed `tenant/{id}/...`; presigned URLs only; bucket policy denies cross-prefix access. |
| Queues | Single queues with tenant_id in message + per-tenant rate limiting / fair scheduling so one tenant's burst can't starve others. |
| Config | `tenant_config` JSONB: modules on/off, field overrides, labels, workflow definitions, notification templates. |

## 4. Data Model (core entities)

```
tenants(id, name, status, plan, domains[], created_at)
tenant_sap_profiles(tenant_id, system_type[S4|ECC], protocol[RFC|ODATA], host_ref→vault, sales_org_defaults, health_status)
tenant_field_mappings(tenant_id, entity, portal_field, sap_table, sap_field, type, len, required, transform, active)
users(id, tenant_id, kind[CUSTOMER|STAFF|PLATFORM], idp_sub, email, status)
roles / user_roles (RBAC, tenant-scoped)
customer_accounts(id, tenant_id, sap_customer_no, legal_name, gstin, pan, status[DRAFT|SUBMITTED|APPROVED|REJECTED|ACTIVE|BLOCKED], credit_limit_cache, tier)
onboarding_applications(id, tenant_id, account_id, step_data JSONB, documents[], workflow_state, decisions[])
addresses, contacts, bank_accounts (tenant_id + account_id scoped)
materials_cache(tenant_id, matnr, description, matkl, meins, moq, attrs JSONB, synced_at)
price_cache(tenant_id, account_id, matnr, rate, currency, valid_from, valid_to, source)
stock_cache(tenant_id, matnr, werks, qty, synced_at)
orders(id, tenant_id, account_id, sap_vbeln, po_ref, req_date, status, credit_status, totals, sync_state)
order_items(order_id, matnr, qty, uom, net_price, plant, confirmed_qty, confirmed_date)
deliveries(id, tenant_id, order_id, sap_vbeln, status, gi_planned, gi_actual, carrier, tracking_no, eway_bill_no)
pods(delivery_id, confirmed_qty, receipt_date, discrepancy_note, doc_ref)
invoices(id, tenant_id, account_id, sap_vbeln, fkart, date, due_date, net, tax_breakup JSONB, gross, irn, status)
ledger_items(tenant_id, account_id, sap_doc, doc_type, posting_date, dr_cr, amount, open_amount, clearing_doc, synced_at)
payments(id, tenant_id, account_id, gateway, gateway_ref, amount, invoice_allocations[], sap_posting_state)   -- Phase 2
tickets(...)                                                                                                   -- Phase 2
sync_jobs(id, tenant_id, type, payload, state[PENDING|SENT|CONFIRMED|FAILED|DLQ], attempts, sap_ref, error)
audit_log(tenant_id, actor, action, entity, before/after JSONB, at)
notifications, notification_templates(tenant_id, ...)
```

Key principles: **SAP is the system of record** for master/transactional data; portal keeps caches + portal-native data (applications, PODs, tickets, users, config). Every SAP-bound write goes through `sync_jobs` (outbox) for idempotency and replay.

## 5. Integration Architecture (summary — full detail in 04-SAP-Integration-Spec)

- **Writes** (customer create, order create, payment post): command → outbox → sap-connector → BAPI/OData → store SAP doc number → emit event → notify. Idempotency key = portal entity id; retries with exponential backoff; DLQ surfaced in tenant admin sync monitor.
- **Reads**: two modes per data type — *live* (ATP, credit position, ledger on demand) and *cached* (catalogue, prices, stock snapshots via scheduled sync every N minutes, tenant-configurable).
- **Change capture from SAP** (order status, delivery, invoice created in SAP directly): options ranked — (a) OData polling with delta tokens, (b) IDoc/ALE push to connector endpoint, (c) SAP Business Events → webhook. MVP: polling; per-tenant choice later.
- **Connectivity options**: site-to-site VPN, SAP Cloud Connector (for BTP-fronted OData), or our **on-prem connector agent** (outbound-only WebSocket/gRPC tunnel — easiest firewall story; recommended default).

## 6. Non-Functional Requirements (engineering)

| Category | Requirement |
|---|---|
| Performance | P95: cached reads <300ms API; SAP live reads <3s; order submit sync path <8s else async with progress state |
| Scalability | Horizontal: stateless API pods, HPA; DB read replicas; design load 10k orders/day, 500 concurrent users/tenant peak |
| Availability | 99.9%; multi-AZ; graceful degradation matrix per feature when tenant SAP down (read cache, queue writes, banner state) |
| RPO/RTO | RPO 15 min (PITR), RTO 4h; daily encrypted backups, restore drills quarterly |
| Security | See 05 doc. TLS 1.2+, AES-256 at rest, Vault/KMS for SAP creds, OWASP ASVS L2, dependency & container scanning in CI |
| Auditability | Immutable audit log; SAP sync journal per transaction with request/response payload retention (PII-masked), 7-year invoice-linked retention |
| Observability | Per-tenant SLO dashboards; sync failure alerting; distributed tracing across core-api → connector → SAP |
| Testability | Contract tests against a **SAP mock service** (recorded BAPI fixtures); sandbox tenant with demo dataset; E2E via Playwright |
| Data residency | ap-south-1 (Mumbai) primary; no PII leaves India for Indian tenants (DPDP) |
| Cost | Target infra cost < 8% of ARR at 20 tenants |

## 7. Environments & Delivery

- **Environments**: dev (shared), staging (tenant-clone capable, SAP mock + one real SAP sandbox), production.
- **Branching/CI**: trunk-based, PR checks (lint, unit, contract, SAST), auto-deploy staging, gated prod deploys, feature flags (per-tenant rollout).
- **Migrations**: versioned (Prisma/Flyway), backward compatible, RLS policies in migration review checklist.
- **Tenant provisioning** is code: one command/API creates realm, DB rows, S3 prefix, default mappings, sample branding.

## 8. Key Technical Risks

| Risk | Mitigation |
|---|---|
| SAP variance across tenants (Z-fields, custom pricing) | Metadata mapping engine + per-tenant transform hooks (sandboxed expressions); onboarding playbook with mapping workshop |
| RFC/JCo licensing & ops complexity | Prefer OData (API_SALES_ORDER_SRV etc.) where tenant is S/4; JCo only where needed (ECC) |
| Slow tenant SAP boxes killing UX | Timeouts + circuit breakers per tenant; aggressive caching; async-first writes |
| RLS bypass bugs | RLS enforced at DB, not only app; automated cross-tenant leak tests in CI; no superuser app connections |
| e-Invoice/GSTN API instability | GSP abstraction with provider failover |
| Payment posted but SAP down | Money-safe saga: payment ledger in portal is source of truth until SAP confirmation; finance alert + auto-replay |
