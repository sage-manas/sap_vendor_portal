# VendorConnect Portal — Product Info (Landing Page Content)

> Prepared for the uvira.ai landing page, alongside 3 other products. Business-facing summary — technical detail deliberately left out except where it builds credibility.

---

## 1. Product Name & Tagline

**VendorConnect Portal**

Tagline options (pick one, or mix):
- *"One portal. Every supplier. Zero SAP re-keying."*
- *"Give your suppliers a front door into SAP — without giving them SAP."*
- *"The self-service portal that turns procurement into a conversation, not a paper chase."*

---

## 2. What It Does

VendorConnect Portal is a self-service web portal that lets a manufacturer's suppliers manage their entire relationship with procurement online — from first registration through to getting paid — without emailing spreadsheets or calling the purchasing desk. Suppliers register and submit compliance paperwork once, bid on RFQs, acknowledge purchase orders, log shipments, submit invoices, and track payment status, all in one place. Behind the scenes, every action is mirrored into the company's SAP system, so procurement, finance, and warehouse teams keep working in the systems they already trust — just with far less manual data entry and far fewer "where's my PO?" phone calls. It's built specifically for the workflows and compliance requirements of Indian manufacturing supply chains.

---

## 3. Target Users

- **Suppliers / vendors** — the external companies selling raw materials, components, or services to a manufacturer. They are the primary daily users.
- **Procurement / buying teams** — issue RFQs, award purchase orders, and manage supplier relationships.
- **Finance / accounts payable teams** — review invoices, track payment runs, and manage supplier tax/compliance documents.
- **Company (tenant) administrators** — configure their own SAP connection, branding, and internal approval workflows for their supplier base.
- **The platform operator (VendorConnect itself)** — provisions and monitors each customer company's private instance of the portal.

This is a **B2B, multi-tenant SaaS** product: each manufacturer that buys VendorConnect gets its own branded, isolated portal instance for its own suppliers.

---

## 4. Core Features (as user benefits)

- **One-time digital vendor onboarding** — suppliers fill in company, tax (GSTIN/PAN), banking, and compliance documents once, online, instead of mailing paper forms; automatic GSTIN/PAN validation speeds up approval.
- **RFQ & bidding, done online** — suppliers see requests for quotation, submit priced bids with delivery terms, and see award decisions — no more bid sheets over email.
- **Purchase order visibility & acknowledgment** — suppliers see new orders the moment they're issued and confirm them in one click.
- **Shipment / dispatch logging (ASN)** — suppliers log what they've shipped, with carrier and tracking details, so procurement always knows what's in transit.
- **Live order status tracking** — every order's status (open, dispatched, received, invoiced, paid) is visible in real time, replacing status-check phone calls.
- **Online invoice submission** — suppliers submit invoices digitally against confirmed deliveries or agreed billing schedules.
- **Payment transparency** — suppliers can see when a payment run has cleared their invoice, including tax deduction (TDS) detail — no more "has my invoice even been received?" uncertainty.
- **Built-in messaging with procurement, finance, quality and warehouse teams** — a running conversation thread tied to specific orders and RFQs, so context never gets lost across email chains.
- **A live "SAP activity" console** — every step a supplier takes is shown as a live feed of the underlying SAP transaction, giving suppliers (and buyers) confidence the system is actually talking to the company's ERP, not a black box.
- **Company-branded, self-service tenant administration** — each customer configures their own branding, users, and SAP connection without needing a developer.

---

## 5. Key Differentiators

- **Removes the #1 supplier pain point: not knowing what's happening.** Suppliers today chase status by phone, email, or WhatsApp. VendorConnect replaces that with a single source of truth they can check themselves, any time — a direct cut to "where's my PO / where's my payment" support load on procurement and finance teams.
- **No re-keying between supplier and ERP.** Instead of a buyer's staff manually typing supplier bids, dispatch notes, or invoices into SAP, suppliers enter their own data directly, and it flows straight into the company's SAP records — cutting order-entry effort and transcription errors.
- **Built for how SAP-run manufacturers actually operate**, not a generic supplier-management tool retrofitted onto SAP. It speaks SAP's own transaction language (purchase orders, goods receipt, invoice verification, payment runs) and mirrors SAP's approval boundaries — for example, it never lets a supplier post directly into the buyer's financial ledger, preserving the internal control your finance team relies on.
- **Multi-tenant from the ground up.** One manufacturer's supplier data is fully walled off from another's — this is a platform a company can roll out to its own supplier network under its own brand, not a shared marketplace.
- **India-compliance aware.** GSTIN/PAN validation, TDS handling, and Indian statutory document types are native, not bolted on — relevant for the Indian manufacturing/industrial market this product targets.
- **Transparency as a trust mechanism.** The live SAP-activity view isn't just a technical nicety — it's a visible signal to suppliers that their submissions are actually being processed, which builds trust in the relationship and reduces disputes.

---

## 6. Tech Highlights (credibility-relevant, non-technical framing)

- **Real-time status tracking** — supplier-facing statuses update instantly, no page refresh or manual sync needed.
- **Automated approval and confirmation flows** — vendor approvals, goods-receipt matching, and payment-run confirmation happen automatically once the underlying SAP event occurs.
- **Secure document exchange** — compliance certificates, cheques, and other sensitive supplier documents are collected and stored securely, tied to each supplier's own account.
- **Role-based access control** — every user (supplier, buyer, finance, admin) only sees and can do what their role permits, enforced consistently across the whole platform.
- **Built-in audit trail** — every meaningful action (approvals, SAP connection changes, admin actions) is permanently logged for compliance and dispute resolution.
- **Enterprise-grade tenant isolation** — each customer's data is technically walled off from every other customer's, appropriate for handling sensitive commercial and financial data at scale.
- **Designed to degrade gracefully** — the portal keeps working for reading/status purposes even during a SAP connectivity hiccup, rather than going down with it.

---

## 7. Integration Points

**Primary integration (built-in, this is the product's core value):** VendorConnect connects to a company's **SAP ERP system** (S/4HANA or ECC) to mirror supplier onboarding, purchase orders, goods receipt, invoicing, and payment data — that's the whole premise of the product.

**Potential integration with your other uvira.ai products** (not currently built — needs product/eng scoping before promising this on the landing page):

- **DocParcer** — a natural fit: VendorConnect already collects a steady stream of supplier documents (compliance certificates, invoices, cheques, dispatch paperwork). DocParcer could plug in as the extraction/parsing layer for these uploads, e.g. auto-reading GSTIN/PAN off certificates or line-item data off invoices, instead of relying on manual form entry.
- **Asset Management System** — plausible downstream link if your Asset Management product tracks goods received from suppliers (e.g. equipment, components) — GRN (goods receipt) data from VendorConnect could feed asset records automatically.
- **Customer Portal** (if this refers to a sibling *customer-facing* O2C portal — note there is a design document in this repo for a similarly-named "CustomerConnect" product) — VendorConnect (supplier/procure-to-pay side) and a Customer Portal (buyer/order-to-cash side) are natural mirror-image products for the same SAP-run manufacturer: one digitizes what a company buys, the other what it sells. Positioning them as a matched pair ("digitize both sides of your SAP supply chain") is a strong narrative, but the actual technical integration between the two products does not exist yet in this codebase.

**Recommendation:** don't state these as live integrations on the landing page — frame them as the product roadmap / platform vision unless engineering confirms otherwise.

---

## 8. Screenshots / UI References

**None found.** I searched the repository for image assets, mockups, and screenshots and found only:
- Generic Next.js boilerplate icons (`public/*.svg` — file/globe/vercel/window icons, not product UI)
- Two images and one photo inside `backend/uploads/` — these are **test data uploaded by a demo vendor account** (a sample cancelled cheque and profile images), **not** UI screenshots or design mockups, and shouldn't be used for marketing.

**Action needed:** there are no existing screenshots or UI mockups in this codebase suitable for the landing page. You'll need to either take fresh screenshots of the running app (dashboard, RFQ view, PO tracking, SAP activity console are the most visually compelling screens based on the code) or commission new mockups.

---

## 9. Existing Marketing Copy (quoted verbatim, for reuse or reference)

From `PROJECT_CONTEXT.md`:
> "VendorConnect Portal is a full-stack, SAP-integrated supplier self-service platform for Indian manufacturing procurement."

From `workflow/architecture_document.md`:
> "VendorConnect Portal is a full-stack, SAP-integrated supplier self-service platform built for Indian enterprise procurement contexts."

From `workflow/working.md`:
> "VendorConnect Portal is a full-stack digital supply chain dashboard that bridges external suppliers and an internal enterprise SAP ERP system."

From `DESIGN.md` (design philosophy, useful for brand tone/voice, not a tagline):
> "VendorConnect is an industrial-strength self-service portal for Indian manufacturing procurement. Its visual system reflects precision, high data density, and operational focus."

**Note:** none of this is polished landing-page copy — it's engineering/architecture documentation describing the product, not marketing material. The README.md is unmodified Next.js boilerplate and contains nothing product-specific. There is **no existing tagline, mission statement, or customer-facing marketing language** anywhere in the repo — everything in Section 1 above is newly drafted, not sourced from the codebase.

---

## Gaps & Things to Flag Before Publishing

1. **No screenshots or UI mockups exist** in the repo (see §8) — these must be created separately.
2. **No product marketing copy exists** anywhere in the codebase — README is Next.js boilerplate; all internal docs are engineering-facing (see §9).
3. **`docs/01-PRD.md` describes a different, unrelated product** ("CustomerConnect," an Order-to-Cash *customer* portal) — it appears to be either an early pivot artifact or a companion product's spec that landed in this repo by mistake. I did not use it as source material for this file, since it doesn't describe what this codebase actually builds. Worth checking with whoever owns this repo whether that file should be deleted or moved.
4. **Payments (online payment collection) is explicitly a future phase**, not built yet (per `docs/01-PRD.md` — though note that PRD is for the other product, this may still hold true here; confirm with engineering before claiming "online payments" as a live feature). The current payment functionality is *payment status tracking*, not payment processing.
5. Integration with **DocParcer, Asset Management System, and Customer Portal is currently conceptual** (§7) — no code in this repo integrates with them. Frame as vision/roadmap, not shipped capability.
6. The product's actual live differentiator around "the portal never posts directly into SAP's financial ledger" is a real, deliberate architectural decision (documented at length in the code) — it's a legitimate trust/compliance selling point if your buyer persona includes CFOs or IT/security leads, but it may be too technical for a general landing page audience. Consider a simplified version: *"Respects your finance team's approval process — suppliers submit, your team still reviews and posts."*
