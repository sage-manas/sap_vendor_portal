// Issue #64: when the SAP match is ambiguous (a periodic invoicing plan's
// same-amount siblings, most commonly), the watch job must park the invoice
// for manual resolution instead of retrying it into `orphaned` — and the
// reconciliation queue must show it, with both candidate documents named,
// the moment it happens rather than after a retry budget burns down.
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { AmbiguousInvoiceMatchError } = require('../sap/mappings/invoice-match');
const awaitPaymentRun = require('../jobs/handlers/awaitPaymentRun');

const seedVendor = (clientId, vendorId) => runWithTenant(clientId, () => prisma.vendor.create({
  data: {
    vendorId, sapVendorCode: 'VENAMBIG', companyName: `${vendorId} Pvt Ltd`,
    gstin: '27AAAAA8000A1Z8', pan: 'AAAAA8000A', email: `${vendorId}@example.com`,
  },
}));

const seedPoAndInvoice = (clientId, { poId, invoiceId, vendorId, totalAmount }) => runWithTenant(clientId, async () => {
  const po = await prisma.purchaseOrder.create({
    data: { id: poId, vendorId, status: 'Invoiced', sapPoNumber: `4500${poId.slice(-6)}` },
  });
  const invoice = await prisma.invoice.create({
    data: {
      id: invoiceId, poId: po.id, vendorId, invoiceNumber: `V-${invoiceId}`, invoiceDate: new Date(),
      status: 'Submitted', subTotal: totalAmount, taxAmount: 0, totalAmount,
      sapSyncState: 'pending',
      invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
    },
  });
  return { po, invoice };
});

// Stands in for the wrapped adapter jobs/handlers code actually receives —
// its awaitPaymentRun throws AmbiguousInvoiceMatchError exactly the way
// s4odata.driver.js's does when matchInvoiceDocument can't disambiguate.
const ambiguousAdapter = (candidates) => ({
  awaitPaymentRun: async () => {
    throw new AmbiguousInvoiceMatchError(candidates);
  },
});

const runWatch = (clientId, { invoiceId, poId, vendorId }, adapter) => runWithTenant(clientId, () => awaitPaymentRun({
  job: { clientId, args: { invoiceId, poId, vendorId }, createdAt: new Date() },
  adapter,
}));

describe('awaitPaymentRun — an ambiguous SAP match is parked, not orphaned (issue #64)', () => {
  it('marks the invoice needs_manual_match and stops the job, rather than throwing', async () => {
    const clientId = 'CLT-0001';
    const vendorId = 'vendor_ambig_1';
    await seedVendor(clientId, vendorId);
    const { po, invoice } = await seedPoAndInvoice(clientId, {
      poId: 'PO-AMBIG-1', invoiceId: 'INV-AMBIG-1', vendorId, totalAmount: 50000,
    });

    const candidates = [{ miroDoc: '5100000001' }, { miroDoc: '5100000002' }];
    const result = await runWatch(clientId, { invoiceId: invoice.id, poId: po.id, vendorId }, ambiguousAdapter(candidates));

    // The job itself is done — nothing about another attempt would change
    // the outcome, so it must not keep retrying.
    expect(result).toEqual({ done: true });

    const reloaded = await runWithTenant(clientId, () => prisma.invoice.findFirst({ where: { pk: invoice.pk } }));
    expect(reloaded.status).toBe('Submitted'); // never fabricated a clearing
    expect(reloaded.sapSyncState).toBe('needs_manual_match');
    expect(reloaded.sapSyncState).not.toBe('orphaned');
    // Both candidates named, not just a count — a human resolving this needs
    // to know which two documents to look at.
    expect(reloaded.sapSyncError).toContain('5100000001');
    expect(reloaded.sapSyncError).toContain('5100000002');
  });

  it('two identical-amount invoices on one PO both park instead of one silently winning', async () => {
    const clientId = 'CLT-0001';
    const vendorId = 'vendor_ambig_2';
    await seedVendor(clientId, vendorId);
    const poId = 'PO-AMBIG-2';
    const invoiceA = await seedPoAndInvoice(clientId, { poId, invoiceId: 'INV-AMBIG-2A', vendorId, totalAmount: 75000 });
    const invoiceB = await runWithTenant(clientId, () => prisma.invoice.create({
      data: {
        id: 'INV-AMBIG-2B', poId, vendorId, invoiceNumber: 'V-INV-AMBIG-2B', invoiceDate: new Date(),
        status: 'Submitted', subTotal: 75000, taxAmount: 0, totalAmount: 75000, sapSyncState: 'pending',
        invoicePlanRef: { line: 10, planLineNumber: 2, planType: 'Periodic', settlementDate: new Date().toISOString() },
      },
    }));

    const candidates = [{ miroDoc: '5100000010' }, { miroDoc: '5100000011' }];
    await runWatch(clientId, { invoiceId: invoiceA.invoice.id, poId, vendorId }, ambiguousAdapter(candidates));
    await runWatch(clientId, { invoiceId: invoiceB.id, poId, vendorId }, ambiguousAdapter(candidates));

    const reloaded = await runWithTenant(clientId, () => prisma.invoice.findMany({
      where: { id: { in: [invoiceA.invoice.id, invoiceB.id] } },
    }));
    expect(reloaded.every((inv) => inv.sapSyncState === 'needs_manual_match')).toBe(true);
    expect(reloaded.every((inv) => inv.sapSyncState !== 'orphaned')).toBe(true);
  });

  it('an error unrelated to matching still propagates — only ambiguity is caught here', async () => {
    const clientId = 'CLT-0001';
    const vendorId = 'vendor_ambig_3';
    await seedVendor(clientId, vendorId);
    const { po, invoice } = await seedPoAndInvoice(clientId, {
      poId: 'PO-AMBIG-3', invoiceId: 'INV-AMBIG-3', vendorId, totalAmount: 1000,
    });

    const genuineFailureAdapter = { awaitPaymentRun: async () => { throw new Error('SAP gateway unreachable'); } };

    await expect(runWatch(clientId, { invoiceId: invoice.id, poId: po.id, vendorId }, genuineFailureAdapter))
      .rejects.toThrow('SAP gateway unreachable');

    const reloaded = await runWithTenant(clientId, () => prisma.invoice.findFirst({ where: { pk: invoice.pk } }));
    expect(reloaded.sapSyncState).toBe('pending'); // unchanged — jobs/worker.js's own catch handles this one
  });
});
