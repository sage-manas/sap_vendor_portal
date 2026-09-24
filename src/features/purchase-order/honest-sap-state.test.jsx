import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import PurchaseOrdersPage from '@/app/pos/page';

// The honest-UI rule this product rests on: a document number shown to a
// supplier is either genuinely from SAP, or it is clearly marked as not yet
// there. lib/syncState.js encodes the rule and has its own unit tests; this
// asserts the ledger actually obeys it on screen, which is the part a user
// sees and the part a refactor can quietly break.

const po = (overrides) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Open',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150 }],
  ...overrides,
});

const renderLedger = (pos, api = {}) => renderWithPortal(<PurchaseOrdersPage />, {
  plane: 'supplier',
  route: '/pos',
  api: {
    ...EMPTY_SUPPLIER_API,
    'GET /pos': { pos, pagination: { total: pos.length, page: 1, limit: 20, pages: 1 } },
    ...api,
  },
});

// The badge renders as `<Icon /> {label}`, so the label is split across nodes
// — but the span carries the same string as its title, which is exact.
const badge = (label) => screen.findByTitle(label);

const settle = () => waitFor(
  () => expect(screen.queryByText(/No Purchase Orders Found/i)).not.toBeInTheDocument(),
  { timeout: 4000 },
);

describe('what the purchase-order ledger claims about SAP', () => {
  it('shows a pending order as awaiting confirmation, not as a document number', async () => {
    renderLedger([po({ sapSyncState: 'pending', sapPoNumber: '4500000123' })]);
    await settle();

    expect(await badge('Awaiting SAP confirmation')).toBeInTheDocument();
    // The number exists on the record; showing it would assert something SAP
    // has not yet agreed to.
    expect(screen.queryByText('4500000123')).not.toBeInTheDocument();
  });

  it('shows a synced order as confirmed', async () => {
    renderLedger([po({ sapSyncState: 'synced', sapPoNumber: '4500000123' })]);
    await settle();

    expect(await badge('Confirmed')).toBeInTheDocument();
  });

  it('says so plainly when SAP never recorded the order', async () => {
    renderLedger([po({ sapSyncState: 'failed', sapPoNumber: '4500000123' })]);
    await settle();

    expect(await badge('Not yet recorded in SAP — your buyer has been notified')).toBeInTheDocument();
    expect(screen.queryByText('4500000123')).not.toBeInTheDocument();
  });

  it('does not claim SAP for an order the portal manages itself', async () => {
    renderLedger([po({ sapSyncState: 'local' })]);
    await settle();

    expect(await badge('Managed in this portal')).toBeInTheDocument();
  });
});

// GET /pos/sap-status answers the cross-check the ledger uses when an order
// carries no sapSyncState of its own. It used to have no failure state at all:
// a connectivity error, a thrown error and a response missing `orders` all
// left the column on a spinner that never resolved, which a supplier reads as
// "checking" rather than "we could not find out".
describe('when the SAP cross-check cannot be reached', () => {
  const unanswerable = {
    'GET /pos/sap-status': { status: 500, body: { error: 'upstream unavailable' } },
  };

  it('says the check failed instead of spinning forever', async () => {
    renderLedger([po({ sapPoNumber: '4500000123' })], unanswerable);
    await settle();

    expect(await badge(/Could not reach your buyer's system/i)).toBeInTheDocument();
  });

  it('still answers for an order that carries its own sync state', async () => {
    // sapSyncState travels on the PO record, so this order is answerable
    // whether or not the cross-check succeeded — the failure must not erase
    // an answer the ledger already had.
    renderLedger([po({ sapSyncState: 'pending', sapPoNumber: '4500000123' })], unanswerable);
    await settle();

    expect(await badge('Awaiting SAP confirmation')).toBeInTheDocument();
    expect(screen.queryByText(/Could not check/i)).not.toBeInTheDocument();
  });

  it('treats a body without `orders` as a failure, not as an empty ledger', async () => {
    // The shape drifting is not hypothetical — GET /asns already answers a
    // bare array where the other ledgers answer { rows, pagination }.
    renderLedger([po({ sapPoNumber: '4500000123' })], {
      'GET /pos/sap-status': { documents: [] },
    });
    await settle();

    expect(await badge(/Could not reach your buyer's system/i)).toBeInTheDocument();
  });

  // One list, not two. An order the buyer raised in SAP is real whether or not
  // jobs/handlers/sweepPurchaseOrders.js has recorded it yet, so it belongs in
  // the same table as the rest — marked, because there is nothing here to
  // acknowledge or ship against until that sweep runs.
  it('lists an order SAP holds that the portal has not recorded yet', async () => {
    renderLedger([po({ sapSyncState: 'synced', sapPoNumber: '4500000123' })], {
      'GET /pos/sap-status': {
        orders: [
          { poNumber: '4500000123', poDate: '2026-01-01', buyerName: 'SSDN', items: [] },
          {
            poNumber: '4500000999',
            poDate: '2026-02-02',
            buyerName: 'SSDN Technologies Pvt. Ltd.',
            currency: 'INR',
            items: [{ itemNumber: '00010', materialCode: 'MAT-009', description: 'Flanges', orderedQuantity: 10, receivedQuantity: 10, unitPrice: 100, netAmount: 1000, uom: 'EA' }],
          },
        ],
      },
    });
    await settle();

    // The order only SAP knows about is listed, and flagged...
    expect(await screen.findByText('4500000999')).toBeInTheDocument();
    expect(screen.getByText(/not recorded here yet/i)).toBeInTheDocument();
    // ...while the tracked one is not duplicated by its own ledger entry.
    expect(screen.getAllByText('PO-2026-0001')).toHaveLength(1);
  });

  it('opens the same detail page for an unrecorded order, without offering writes', async () => {
    const user = userEvent.setup();
    renderLedger([po()], {
      'GET /pos/sap-status': {
        orders: [{
          poNumber: '4500000999',
          poDate: '2026-02-02',
          buyerName: 'SSDN Technologies Pvt. Ltd.',
          currency: 'INR',
          items: [{ itemNumber: '00010', materialCode: 'MAT-009', description: 'Flanges', orderedQuantity: 10, receivedQuantity: 0, unitPrice: 100, netAmount: 1000, uom: 'EA' }],
        }],
      },
    });
    await settle();
    await screen.findByText('4500000999');

    // The row's own View PO — the second one, after the tracked order's.
    await user.click((await screen.findAllByRole('button', { name: /^View PO$/ }))[1]);

    expect(await screen.findByText(/Purchase Order: 4500000999/)).toBeInTheDocument();
    expect(screen.getByText('Flanges')).toBeInTheDocument();
    // Nothing here addresses a PurchaseOrder row, because there isn't one.
    expect(screen.getByText(/Read-only — not recorded in this portal yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Acknowledge Purchase Order/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /2. Delivery status/i })).not.toBeInTheDocument();
  });

  // The orders list is one table now, not a "Portal Orders"/"All SAP Orders"
  // pair, so the failed-ledger notice sits above that single list rather than
  // behind a tab the supplier has to find first.
  it('offers a retry rather than a dead spinner when the SAP ledger cannot be read', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderLedger([po()], unanswerable);
    await settle();

    expect(await screen.findByText(/Could not reach your buyer.s records/i)).toBeInTheDocument();
    const before = apiMock.callsTo('GET', '/pos/sap-status').length;

    await user.click(await screen.findByRole('button', { name: /Try again/i }));

    await waitFor(() =>
      expect(apiMock.callsTo('GET', '/pos/sap-status').length).toBeGreaterThan(before));
  });
});
