const { prisma } = require('../../db/prisma');
const { EVENTS } = require('../../utils/socketEmitter');
const { notifyVendor } = require('../notify');
const { dueVendors, recordSweepTick } = require('../sweepHelpers');
const logger = require('../../utils/logger');

const FEED = 'quotation';

// SAP's purchasing-document ledger (ME48/ME43 — see the note on
// vendorQuotationDisplay in contract.js) for this vendor. Unlike
// sweepPurchaseOrders/sweepPayments, this creates nothing: the ledger is
// already read live by RfqView's "My SAP Documents" tab
// (GET /rfqs/sap-quotations) whenever a supplier looks — there is no local
// PurchaseOrder-shaped record for a "quotation" to become. What this sweep
// buys is early notice: a supplier finds out a new SAP document exists
// without having to open the tab first, via the same fingerprint-driven
// no-op-when-quiet mechanism as the other two sweeps.
module.exports = async ({ job, adapter }) => {
  const { clientId } = job;
  const due = await dueVendors(clientId, FEED);

  for (const { vendor } of due) {
    // eslint-disable-next-line no-await-in-loop
    await sweepOneVendor({ clientId, vendor, adapter });
  }

  return { done: true };
};

async function sweepOneVendor({ clientId, vendor, adapter }) {
  // rfqs/pos are the caller's own correlation input for the mock/s4odata
  // driver (see vendorQuotationDisplay in both) — the portal's own RFQs and
  // POs for this vendor, same as RfqView's live read already sends.
  const [rfqs, pos] = await Promise.all([
    prisma.rFQ.findMany({ where: { invitedVendors: { some: { vendorExtId: vendor.vendorId } } } }),
    prisma.purchaseOrder.findMany({ where: { vendorId: vendor.vendorId }, include: { items: true } }),
  ]);

  const result = await adapter.vendorQuotationDisplay({ vendor, rfqs, pos });
  const documents = result?.documents || [];

  const { changed } = await recordSweepTick({ clientId, feed: FEED, vendorCode: vendor.sapVendorCode, data: documents });
  if (!changed) return;

  logger.info(`[jobs] sweepQuotations: the purchasing-document ledger changed for vendor ${vendor.vendorId}`);
  notifyVendor(clientId, vendor.vendorId, EVENTS.LOG_NEW, {
    type: 'SYS', name: 'SAP_DOCUMENT_LEDGER_CHANGED',
  });
}
