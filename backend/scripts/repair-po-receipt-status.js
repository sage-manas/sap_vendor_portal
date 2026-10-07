#!/usr/bin/env node
// One-time repair for a defect in vendorPoGrnDisplay (zpo_grn_vendor/Detail):
// RECEIVED_QUANTITY mirrored ORDERED_QUANTITY on every line, GRN[] empty or
// not, so every PO jobs/handlers/sweepPurchaseOrders.js discovered read
// "Delivered" the moment it was found, with no goods receipt in SAP behind
// it. s4odata.driver.js's vendorPoGrnDisplay now derives receivedQuantity
// from GRN[] itself instead of trusting that field, so a fresh sweep goes on
// reading correctly — this script corrects the rows a sweep already wrote
// wrong under the old, buggy read.
//
// syncPoStatus (db/poHelpers.js) never regresses a PO's status by design —
// right for a stale/late tick during normal operation, wrong for undoing a
// correction to data that was never right to begin with. So this recomputes
// and writes status directly, allowing it to move backward, rather than
// going through that guard.
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { getSapAdapterForClient } = require('../sap');
const { formatPo, PO_INCLUDE } = require('../db/poHelpers');
const { derivePoStatus } = require('../services/poStatus.service');
const { toNumber: toQty } = require('../utils/quantity');

const clientId = process.argv[2];
if (!clientId) {
  console.error('Usage: node backend/scripts/repair-po-receipt-status.js <clientId>');
  process.exit(1);
}

async function recomputeStatus(poId) {
  const fresh = await prisma.purchaseOrder.findFirst({ where: { id: poId }, include: PO_INCLUDE });
  const [asnCount, invoices] = await Promise.all([
    prisma.aSN.count({ where: { poId: fresh.id } }),
    prisma.invoice.findMany({ where: { poId: fresh.id }, include: { items: true } }),
  ]);

  const invoicedQtyByLine = new Map();
  for (const invoice of invoices) {
    for (const item of invoice.items) {
      if (item.line == null) continue;
      invoicedQtyByLine.set(item.line, (invoicedQtyByLine.get(item.line) || 0) + toQty(item.quantity));
    }
  }

  const derived = derivePoStatus(fresh, {
    asnCount,
    invoicedQtyByLine,
    invoiceCount: invoices.length,
    allInvoicesCleared: invoices.length > 0 && invoices.every((invoice) => invoice.status === 'Cleared'),
  });

  if (derived !== fresh.status) {
    await prisma.purchaseOrder.update({ where: { pk: fresh.pk }, data: { status: derived } });
    console.log(`${fresh.id} (SAP ${fresh.sapPoNumber}): status ${fresh.status} -> ${derived}`);
  }
}

async function run() {
  await runWithTenant(clientId, async () => {
    const adapter = await getSapAdapterForClient(clientId);
    const vendors = await prisma.vendor.findMany({ where: { sapVendorCode: { not: null } } });

    for (const vendor of vendors) {
      const localPos = await prisma.purchaseOrder.findMany({
        where: { vendorId: vendor.vendorId, sapSyncState: 'synced', sapPoNumber: { not: null } },
        include: { items: true },
      });
      if (!localPos.length) continue;

      // eslint-disable-next-line no-await-in-loop
      const result = await adapter.vendorPoGrnDisplay({ vendor, pos: localPos.map(formatPo) });
      const byNumber = new Map((result?.orders || []).map((o) => [o.poNumber, o]));

      for (const po of localPos) {
        const order = byNumber.get(po.sapPoNumber);
        if (!order) continue;

        const itemsByLine = new Map(po.items.map((item) => [item.line, item]));
        let lineChanged = false;
        for (const orderItem of order.items || []) {
          const item = itemsByLine.get(Number(orderItem.itemNumber));
          if (!item) continue;
          const correctGrnQuantity = Number(orderItem.receivedQuantity) || 0;
          if (correctGrnQuantity !== toQty(item.grnQuantity)) {
            // eslint-disable-next-line no-await-in-loop
            await prisma.purchaseOrderItem.update({ where: { pk: item.pk }, data: { grnQuantity: correctGrnQuantity } });
            console.log(`${po.id} (SAP ${po.sapPoNumber}) line ${item.line}: grnQuantity ${toQty(item.grnQuantity)} -> ${correctGrnQuantity}`);
            lineChanged = true;
          }
        }

        if (lineChanged) {
          // eslint-disable-next-line no-await-in-loop
          await recomputeStatus(po.id);
        }
      }
    }
  });
}

run()
  .then(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    return prisma.$disconnect().then(() => process.exit(1));
  });
