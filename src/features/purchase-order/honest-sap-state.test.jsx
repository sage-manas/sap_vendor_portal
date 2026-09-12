import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

const renderLedger = (pos) => renderWithPortal(<PurchaseOrdersPage />, {
  plane: 'supplier',
  route: '/pos',
  api: { ...EMPTY_SUPPLIER_API, 'GET /pos': { pos, pagination: { total: pos.length, page: 1, limit: 20, pages: 1 } } },
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
