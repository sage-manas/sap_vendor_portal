import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, EMPTY_WORKSPACE_API } from '@/test/fixtures';

import DashboardPage from '@/app/page';
import AnalyticsPage from '@/app/analytics/page';
import WorkspacePaymentsPage from '@/app/workspace/payments/page';

// Issue #282: every screen that shows a payment must name the invoice(s) it
// settled. #63 moved the invoice onto PaymentItem and removed the header's
// invoiceId/invoiceNumber, but four screens kept reading the header — so the
// Invoice column went permanently blank, the Overview's payment rows showed
// no invoice, and the ledger described every payment as "Payment for
// invoice". The fixture here is the case that broke them: ONE remittance
// settling TWO invoices, which is what an F110 run produces.

vi.mock('@/lib/download', async (importOriginal) => ({
  ...(await importOriginal()),
  downloadCsv: vi.fn(),
  downloadFromApi: vi.fn(() => Promise.resolve()),
}));

const { downloadCsv } = await import('@/lib/download');

// Shape as GET /api/payments returns it: header totals, one item per settled
// invoice, plus the `invoiceRefs` backend/db/paymentHelpers.js derives.
const TWO_INVOICE_PAYMENT = {
  id: 'PMT-282001',
  vendorId: 'vendor_282',
  paymentDate: '2026-05-20T00:00:00.000Z',
  utrCode: 'UTR282000001',
  paymentMethod: 'NEFT',
  grossAmount: 1500,
  tdsDeducted: 150,
  netAmount: 1350,
  totalTds: 150,
  invoiceRefs: ['REFS/2026/001', 'REFS/2026/002'],
  items: [
    { id: 1, invoiceId: 'INV-282001', invoiceNumber: 'REFS/2026/001', poId: 'PO-282001', grossAmount: 1000, tdsDeducted: 100, netAmount: 900 },
    { id: 2, invoiceId: 'INV-282002', invoiceNumber: 'REFS/2026/002', poId: 'PO-282002', grossAmount: 500, tdsDeducted: 50, netAmount: 450 },
  ],
};

const SUPPLIER_API = {
  ...EMPTY_SUPPLIER_API,
  'GET /payments': { payments: [TWO_INVOICE_PAYMENT] },
};

const WORKSPACE_API = {
  ...EMPTY_WORKSPACE_API,
  'GET /payments': { payments: [TWO_INVOICE_PAYMENT] },
};

const expectsBothInvoices = () => {
  expect(screen.getAllByText(/REFS\/2026\/001/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/REFS\/2026\/002/).length).toBeGreaterThan(0);
};

beforeEach(() => {
  downloadCsv.mockClear();
});

describe('a payment names the invoices it settled (issue #282)', () => {
  it('on the tenant Payments table, in the Invoice column', async () => {
    renderWithPortal(<WorkspacePaymentsPage />, {
      plane: 'workspace', route: '/workspace/payments', api: WORKSPACE_API,
    });

    await screen.findByText('UTR282000001');
    // Both numbers, in one cell — the truncation form the Overview uses.
    expect(screen.getByText('REFS/2026/001, REFS/2026/002')).toBeInTheDocument();
  });

  it("on the supplier Overview's recent payments", async () => {
    renderWithPortal(<DashboardPage />, { plane: 'supplier', route: '/', api: SUPPLIER_API });

    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    await screen.findByText('UTR282000001', {}, { timeout: 3000 });
    expect(screen.getByText('REFS/2026/001, REFS/2026/002')).toBeInTheDocument();
  });

  it('on the account ledger, as one credit row per invoice', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api: SUPPLIER_API });

    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    await userEvent.click(await screen.findByRole('tab', { name: /self.?service|ledger/i }));

    await waitFor(expectsBothInvoices);
    // Not "Payment for invoice" — the generic text this issue is about.
    expect(screen.queryByText('Payment for invoice')).not.toBeInTheDocument();
    expect(screen.getByText('Payment for REFS/2026/001')).toBeInTheDocument();
    expect(screen.getByText('Payment for REFS/2026/002')).toBeInTheDocument();

    // Each invoice's credit is its own gross (net + TDS), so the two rows
    // sum to the remittance rather than one row carrying the lot.
    expect(screen.getByText('1,000.00')).toBeInTheDocument();
    expect(screen.getByText('500.00')).toBeInTheDocument();
  });

  it('in the TDS CSV export, one row per invoice with that invoice\'s figures', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api: SUPPLIER_API });

    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: /More exports/i }));
    await userEvent.click(await screen.findByText(/Export TDS deducted/i));

    expect(downloadCsv).toHaveBeenCalled();
    const [, columns, rows] = downloadCsv.mock.calls.at(-1);
    expect(rows).toHaveLength(2);

    const invoiceColumn = columns.find((c) => c.header === 'Invoice');
    expect(rows.map(invoiceColumn.value)).toEqual(['REFS/2026/001', 'REFS/2026/002']);

    const cell = (header, row) => columns.find((c) => c.header === header).value(row);
    expect(rows.map((row) => cell('Gross (INR)', row))).toEqual(['1000.00', '500.00']);
    expect(rows.map((row) => cell('TDS (INR)', row))).toEqual(['100.00', '50.00']);
    expect(rows.map((row) => cell('Net (INR)', row))).toEqual(['900.00', '450.00']);
  });
});
