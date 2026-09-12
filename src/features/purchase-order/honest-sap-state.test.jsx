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

  it('offers a retry on the SAP orders tab rather than a dead spinner', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderLedger([po()], unanswerable);
    await settle();

    await user.click(await screen.findByRole('button', { name: /All SAP Orders/i }));

    expect(await screen.findByText(/Could not reach your buyer.s records/i)).toBeInTheDocument();
    const before = apiMock.callsTo('GET', '/pos/sap-status').length;

    await user.click(await screen.findByRole('button', { name: /Try again/i }));

    await waitFor(() =>
      expect(apiMock.callsTo('GET', '/pos/sap-status').length).toBeGreaterThan(before));
  });
});
