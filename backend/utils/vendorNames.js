const { prisma } = require('../db/prisma');

// Who a document belongs to, in the name a person uses for them.
//
// Finding 4.3: the tenant-wide workspace lists printed `vendorId` under a
// column headed "Supplier". That field is the portal's own internal key
// (ADR-0002) — not the SAP vendor code, and not a name anyone recognises. A
// buyer scanning a hundred orders had no way to tell whose they were without
// opening each one.
//
// This lives here rather than in either controller because the PO list and the
// invoice list need the identical answer, and because the two rows reach it
// differently: `PurchaseOrder` has a real `vendor` relation (through
// `vendorPk`, nullable), while `Invoice` carries only the `vendorId` string.
// Resolving on `vendorId` is the one lookup that works for both, and keeps a
// discovered order whose `vendorPk` was never correlated from reading as
// nameless.
//
// Batched on purpose. These are the every-supplier lists, so a per-row lookup
// is one query per order in the workspace — see `supplier-names-in-lists.test.js`,
// which asserts the count rather than only the names, because a correct set of
// names is exactly what an N+1 also produces.
const vendorNameMap = async (vendorIds) => {
  const unique = [...new Set(vendorIds.filter(Boolean))];
  if (!unique.length) return new Map();

  // Tenant-scoped by the Prisma extension, like every other read here, so this
  // can only ever resolve names inside the caller's own tenant.
  const vendors = await prisma.vendor.findMany({
    where: { vendorId: { in: unique } },
    select: { vendorId: true, companyName: true },
  });

  return new Map(vendors.map((vendor) => [vendor.vendorId, vendor.companyName]));
};

// Adds `vendorName` to each row. `null` where no supplier row matches — an
// order SAP's ledger reported for a LIFNR this tenant has never onboarded is a
// real state (sweepPurchaseOrders writes it), and null says "we do not hold a
// company for this code", which is different from a blank name. The caller
// renders the code it already has in that case.
const withVendorNames = async (rows) => {
  const names = await vendorNameMap(rows.map((row) => row.vendorId));
  return rows.map((row) => ({ ...row, vendorName: names.get(row.vendorId) ?? null }));
};

module.exports = { vendorNameMap, withVendorNames };
