-- Invoice.grnId / Invoice.invoicePlanRef are a discriminated union in the
-- application today (invoice.controller.js's GRN-matched path vs.
-- submitPlanInvoice), enforced only by controller logic. This CHECK makes it
-- a real database guarantee — a genuine improvement over the Mongoose schema,
-- which had no equivalent.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoice_grn_xor_plan_ref"
  CHECK (("grnId" IS NOT NULL) != ("invoicePlanRef" IS NOT NULL));

-- Append-only enforcement, layer 2 (layer 1 is backend/db/appendOnlyExtension.js).
-- Mongoose's throwing pre-hooks only ever protected callers going through
-- Mongoose itself; a raw driver call bypassed them. These grants close that
-- gap at the database level: even `$queryRaw` or a future dev who forgets the
-- extension exists cannot mutate or remove an existing audit entry.
--
-- CURRENT_USER is whatever role Prisma's DATABASE_URL connects as. If the
-- app is later given its own dedicated runtime role (recommended before
-- production), re-run these two REVOKEs against that role name instead.
REVOKE UPDATE, DELETE ON "audit_logs" FROM CURRENT_USER;
REVOKE UPDATE, DELETE ON "sap_connection_audits" FROM CURRENT_USER;
