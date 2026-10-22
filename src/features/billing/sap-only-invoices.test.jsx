import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import InvoicesPage from '@/app/invoices/page';

// Issue #300. An invoice AP has posted (MIRO) is real whether or not
// jobs/handlers/sweepInvoices.js has recorded it here — the same rule
// PurchaseOrdersView already applies to an order SAP raised directly, which
// src/features/purchase-order/honest-sap-state.test.jsx pins.
//
// It is not merely the gap between SAP posting and the next sweep. Where AP
// invoiced a PO with no goods receipt — legal whenever the vendor master has
// GR-based invoice verification off — the sweep can create no row at all,
// because an Invoice must hang off a GRN or an invoicing-plan date (a
// database CHECK). The browser holds the document either way; before this it
// was used only to badge rows that already existed, so such an invoice was
// invisible to the supplier with no notice of any kind.

const miro = (overrides) => ({
  miroDoc: '5105609771',
  fiscalYear: '2026',
  docType: 'RE',
  docDate: '20261001',
  postingDate: '20261001',
  companyCode: 'SSDN',
  currency: 'INR',
  grossAmount: 25000,
  taxableAmount: 0,
  taxCode: 'V0',
  items: [{ poNumber: '4500022838', poItem: '00010', amount: 25000, quantity: 10 }],
  ...overrides,
});

const invoice = (overrides) => ({
  id: 'INV-2026-0001',
  invoiceNumber: 'INV-2026-0001',
  invoiceDate: '2026-10-01T00:00:00.000Z',
  poId: 'PO-2026-0001',
  subTotal: 10000,
  taxAmount: 1800,
  totalAmount: 11800,
  status: 'Submitted',
  ...overrides,
});

const renderLedger = (invoices, api = {}) => renderWithPortal(<InvoicesPage />, {
  plane: 'supplier',
  route: '/invoices',
  api: {
    ...EMPTY_SUPPLIER_API,
    'GET /invoices': { invoices, pagination: { total: invoices.length, page: 1, limit: 20, pages: 1 } },
    ...api,
  },
});

describe('an invoice SAP holds that the portal has not recorded', () => {
  it('lists it, rather than dropping it on the floor', async () => {
    renderLedger([], { 'GET /invoices/sap-status': { documents: [miro()], paymentDetails: {} } });

    expect(await screen.findByText('5105609771')).toBeInTheDocument();
    // The PO it was posted against is what makes the row actionable for a
    // supplier trying to recognise it.
    expect(await screen.findByText('4500022838')).toBeInTheDocument();
  });

  it('marks it as not recorded here, so the row does not read as tracked', async () => {
    renderLedger([], { 'GET /invoices/sap-status': { documents: [miro()], paymentDetails: {} } });

    expect(await screen.findByText(/not recorded here yet/i)).toBeInTheDocument();
  });

  // The number belongs to the buyer's system, and the row says so once. It
  // used to appear in the supplier's own "Your invoice" column too, which
  // dressed a MIRO document up as something this supplier had raised.
  it('shows the MIRO number as the buyer\'s reference, not as the supplier\'s own', async () => {
    renderLedger([], { 'GET /invoices/sap-status': { documents: [miro()], paymentDetails: {} } });

    await screen.findByText('5105609771');
    expect(screen.getAllByText('5105609771')).toHaveLength(1);
    expect(screen.queryByText(/^Ref /)).not.toBeInTheDocument();
  });

  it('does not claim the supplier submitted it', async () => {
    renderLedger([], { 'GET /invoices/sap-status': { documents: [miro()], paymentDetails: {} } });

    await screen.findByText('5105609771');
    expect(screen.queryByText('Submitted')).not.toBeInTheDocument();
    expect(await screen.findByText(/Posted by your buyer/i)).toBeInTheDocument();
  });

  it('does not duplicate an invoice the portal already tracks', async () => {
    renderLedger(
      [invoice({ sapMiroDoc: '5105609771' })],
      { 'GET /invoices/sap-status': { documents: [miro()], paymentDetails: {} } },
    );

    await screen.findByText('INV-2026-0001');
    expect(screen.queryByText(/not recorded here yet/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('5105609771')).toHaveLength(1);
  });
});

// The cross-check had no failure state: a connectivity error, a thrown error
// and a body missing `documents` all left the Confirmed column on a spinner
// that never resolved — which a supplier reads as "still checking" forever,
// and which also hides the merged rows above with no explanation.
describe('when the MIRO cross-check cannot be read', () => {
  const unanswerable = {
    'GET /invoices/sap-status': { status: 500, body: { error: 'upstream unavailable' } },
  };

  it('says the check failed instead of spinning forever', async () => {
    renderLedger([invoice()], unanswerable);

    expect(await screen.findByTitle(/Could not reach your buyer's system to check this invoice/i))
      .toBeInTheDocument();
  });

  it('treats a body without `documents` as a failure, not as an empty ledger', async () => {
    renderLedger([invoice()], { 'GET /invoices/sap-status': { orders: [] } });

    expect(await screen.findByTitle(/Could not reach your buyer's system to check this invoice/i))
      .toBeInTheDocument();
  });

  it('offers a retry rather than a silently short list', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderLedger([invoice()], unanswerable);

    expect(await screen.findByText(/Could not reach your buyer.s records/i)).toBeInTheDocument();
    const before = apiMock.callsTo('GET', '/invoices/sap-status').length;

    await user.click(await screen.findByRole('button', { name: /Try again/i }));

    await waitFor(() =>
      expect(apiMock.callsTo('GET', '/invoices/sap-status').length).toBeGreaterThan(before));
  });
});
