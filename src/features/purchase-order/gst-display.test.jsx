import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import PurchaseOrdersPage from '@/app/pos/page';
import InvoicesPage from '@/app/invoices/page';

// Issue #113. A tax code or rate shown against a line used to be a literal —
// "G1 (18%)" on every purchase-order line regardless of the line's real
// taxCode, and "(18%)" in the invoice ledger's column header regardless of
// what an invoice's own lines actually carried (#66 made that a per-line,
// nullable value precisely because it isn't always 18%). This is the same
// honest-UI rule honest-sap-state.test.jsx asserts for SAP document numbers,
// applied to tax data: a rate shown on screen is either the record's own, or
// nothing.

const po = (overrides) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Open',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [{
    line: 10, materialCode: 'MAT-001', description: 'Hex bolts',
    quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150,
    ...overrides.item,
  }],
  ...overrides,
});

describe('what the purchase-order line-item table claims about GST', () => {
  it('shows the line’s own tax code rather than a fixed G1 (18%)', async () => {
    renderWithPortal(<PurchaseOrdersPage />, {
      plane: 'supplier',
      route: '/pos',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /pos': { pos: [po({ item: { taxCode: 'V0' } })], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: /view po/i }));

    expect(await screen.findByText('V0')).toBeInTheDocument();
    expect(screen.queryByText(/G1 \(18%\)/)).not.toBeInTheDocument();
  });

  it('shows a dash rather than a guessed rate when the line carries no tax code', async () => {
    // The common case: awardRfq never carries a bid's tax code onto the PO
    // line it creates, so an ordinary (non-asset) line's taxCode is null.
    renderWithPortal(<PurchaseOrdersPage />, {
      plane: 'supplier',
      route: '/pos',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /pos': { pos: [po({ item: { taxCode: null } })], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: /view po/i }));

    await waitFor(() => expect(screen.getByText('Hex bolts')).toBeInTheDocument());
    const row = screen.getByText('Hex bolts').closest('tr');
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/18%/)).not.toBeInTheDocument();
  });
});

const invoice = (overrides) => ({
  id: 'INV-001',
  invoiceNumber: 'INV/2026/001',
  invoiceDate: '2026-01-01T00:00:00.000Z',
  poId: 'PO-2026-0001',
  status: 'Submitted',
  subTotal: 1000,
  taxAmount: 120,
  totalAmount: 1120,
  ...overrides,
});

describe('what the invoice ledger claims about GST', () => {
  it('heads the value column with no asserted rate', async () => {
    renderWithPortal(<InvoicesPage />, {
      plane: 'supplier',
      route: '/invoices',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /invoices': { invoices: [invoice()], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      },
    });

    expect(await screen.findByText('GST Invoice Value')).toBeInTheDocument();
    expect(screen.queryByText(/GST Invoice Value \(18%\)/)).not.toBeInTheDocument();
  });

  it('shows the invoice’s own effective rate, derived from its own totals', async () => {
    // 120 / 1000 = 12%, not the 18% the header used to assert unconditionally.
    renderWithPortal(<InvoicesPage />, {
      plane: 'supplier',
      route: '/invoices',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /invoices': { invoices: [invoice({ subTotal: 1000, taxAmount: 120 })], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      },
    });

    expect(await screen.findByText('GST 12%')).toBeInTheDocument();
  });

  it('shows nothing where a rate cannot honestly be derived', async () => {
    renderWithPortal(<InvoicesPage />, {
      plane: 'supplier',
      route: '/invoices',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /invoices': { invoices: [invoice({ subTotal: 0, taxAmount: 0 })], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      },
    });

    await waitFor(() => expect(screen.getByText('INV/2026/001')).toBeInTheDocument());
    expect(screen.queryByText(/GST \d/)).not.toBeInTheDocument();
  });
});
