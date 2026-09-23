-- Issue #67: Vendor.gstin was globally unique, so a supplier trading with two
-- tenants could never onboard with the second buyer under the same real
-- GSTIN. Scope it per tenant instead (ADR-0039). vendorId/email stay global
-- login identities (ADR-0002) and are untouched here.
DROP INDEX "vendors_gstin_key";

CREATE UNIQUE INDEX "vendors_clientId_gstin_key" ON "vendors"("clientId", "gstin");
