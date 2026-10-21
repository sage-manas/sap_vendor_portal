import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal, TENANT_SESSION, routeParams } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API, VENDOR_PROFILE } from '@/test/fixtures';
import WorkspaceInvoicesPage from '@/app/workspace/invoices/page';
import WorkspacePurchaseOrdersPage from '@/app/workspace/purchase-orders/page';
import WorkspacePaymentsPage from '@/app/workspace/payments/page';
import SupplierDetailPage from '@/app/workspace/suppliers/[id]/page';

// Issue #285. These four staff lists formatted money with
// `maximumFractionDigits: 0`, so ₹1,234.56 rendered as ₹1,235 — on the very
// pages finance reconciles from, and against the two decimals every other
// screen showed for the same document. They all go through
// `formatMoney` (src/lib/money.js) now.
//
// Each assertion names the rounded string as well, because the rounded string
// is the defect: a test that only looked for the exact figure would still pass
// if a tile beside it kept rounding.

const listOf = (key, rows) => ({
  [key]: rows,
  pagination: { total: rows.length, page: 1, limit: 50, pages: 1 },
});

const api = (extra) => ({ ...EMPTY_WORKSPACE_API, 'GET /auth/me': TENANT_SESSION, ...extra });

const INVOICE = {
  id: 'INV-0001',
  invoiceNumber: 'ACME/2026/01',
  vendorId: 'vendor_test_001',
  vendorName: 'Acme Industries Pvt Ltd',
  poId: 'PO-2026-0001',
  totalAmount: 1234.56,
  currency: 'INR',
  status: 'Submitted',
  invoiceDate: '2026-02-02T00:00:00.000Z',
};

const PO = {
  id: 'PO-2026-0001',
  vendorId: 'vendor_test_001',
  vendorName: 'Acme Industries Pvt Ltd',
  currency: 'INR',
  status: 'Open',
  createdDate: '2026-02-01T00:00:00.000Z',
  items: [{ line: 10, netValue: 1234.56 }],
};

const PAYMENT = {
  id: 'PAY-0001',
  vendorId: 'vendor_test_001',
  invoiceRefs: ['INV-0001'],
  grossAmount: 1234.56,
  tdsDeducted: 24.69,
  netAmount: 1209.87,
  utrCode: 'UTR123456',
  paymentMethod: 'NEFT',
  paymentDate: '2026-02-10T00:00:00.000Z',
};

const QUARTER = {
  id: 'q-1',
  fiscalYearLabel: 'FY 2025-26',
  quarterLabel: 'Q4',
  paymentCount: 1,
  grossPaid: 1234.56,
  taxWithheld: 24.69,
  section: '194C',
};

describe('workspace money never rounds below paise', () => {
  it('on the tenant-wide invoice list', async () => {
    renderWithPortal(<WorkspaceInvoicesPage />, {
      plane: 'workspace',
      route: '/workspace/invoices',
      api: api({ 'GET /invoices': listOf('invoices', [INVOICE]) }),
    });

    expect(await screen.findByText('₹1,234.56')).toBeInTheDocument();
    expect(screen.queryByText('₹1,235')).not.toBeInTheDocument();
  });

  it('on the tenant-wide purchase-order list', async () => {
    renderWithPortal(<WorkspacePurchaseOrdersPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders',
      api: api({ 'GET /pos': listOf('pos', [PO]) }),
    });

    expect(await screen.findByText('₹1,234.56')).toBeInTheDocument();
    expect(screen.queryByText('₹1,235')).not.toBeInTheDocument();
  });

  it('on the payment list and the TDS-by-quarter table', async () => {
    renderWithPortal(<WorkspacePaymentsPage />, {
      plane: 'workspace',
      route: '/workspace/payments',
      api: api({
        'GET /payments': listOf('payments', [PAYMENT]),
        'GET /payments/tds-summary': { quarters: [QUARTER] },
      }),
    });

    // Gross on the payment row and gross paid in the quarter summary.
    expect((await screen.findAllByText('₹1,234.56')).length).toBe(2);
    // TDS appears on the row, in the quarter table and in the by-supplier
    // table — ₹24.69 is the amount the whole-rupee format destroyed most.
    expect(screen.getAllByText('₹24.69').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('₹1,209.87')).toBeInTheDocument();
    expect(screen.queryByText('₹1,235')).not.toBeInTheDocument();
    expect(screen.queryByText('₹25')).not.toBeInTheDocument();
  });

  it('on the supplier trading-history panel', async () => {
    renderWithPortal(<SupplierDetailPage params={routeParams({ id: 'vendor-pk-1' })} />, {
      plane: 'workspace',
      route: '/workspace/suppliers/vendor-pk-1',
      api: api({
        'GET /vendors/vendor-pk-1': {
          vendor: { ...VENDOR_PROFILE, pk: 'vendor-pk-1', sapVendorCode: '1120250081' },
          awaitingDecision: false,
          activity: {
            purchaseOrders: { total: 1, value: 1234.56, byStatus: {} },
            invoices: {
              total: 1, value: 1234.56, receivableValue: 1234.56, outstandingValue: 24.69, byStatus: {},
            },
            payments: { total: 1, grossPaid: 1234.56, netPaid: 1209.87, tdsDeducted: 24.69 },
            rfqInvitations: 0,
            goodsReceipts: 0,
            shipments: 0,
          },
          recentOrders: [],
        },
      }),
    });

    expect((await screen.findAllByText('₹1,234.56')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('₹1,209.87')).toBeInTheDocument();
    expect(screen.queryByText('₹1,235')).not.toBeInTheDocument();
    expect(screen.queryByText('₹25')).not.toBeInTheDocument();
  });
});
