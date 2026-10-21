import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, listOf, summaryOf } from '@/test/fixtures';

import DashboardPage from '@/app/page';
import AnalyticsPage from '@/app/analytics/page';

// Issue #280. Every figure on these two screens was computed in the browser
// from `state.pos` / `state.invoices` / `state.payments`, each of which holds
// one page of a list endpoint. A supplier with more than a page of documents
// read "Open orders", "Awaiting payment", total order value, the ageing
// buckets, the ledger balance and every CSV export as totals over their
// newest twenty — silently, with no indication that anything was missing.
//
// So the figures come from GET /api/dashboard/summary, counted in the
// database. Each case below hands the API a summary that DISAGREES with the
// rows on the same page — the shape of the bug, where the page holds fewer
// documents than the supplier has — and asserts the screen shows the
// server's number. A view that quietly fell back to counting the array would
// print the array's length and fail here.

const poRow = (id, netValue) => ({
  id,
  status: 'Open',
  createdDate: '2026-03-04T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', netValue, plant: 'P100' }],
});

const invoiceRow = (id, totalAmount) => ({
  id,
  invoiceNumber: id,
  poId: 'PO-2026-0001',
  status: 'Submitted',
  invoiceDate: '2026-03-10T00:00:00.000Z',
  totalAmount,
  taxAmount: 0,
  outstandingAmount: totalAmount,
  items: [],
});

describe('the supplier Overview renders the server\'s figures, not the loaded page', () => {
  const api = {
    ...EMPTY_SUPPLIER_API,
    // One page's worth of rows — far fewer than the supplier has.
    'GET /pos': listOf('pos', [poRow('PO-2026-0001', 1000)]),
    'GET /invoices': listOf('invoices', [invoiceRow('INV-0001', 1000)]),
    'GET /dashboard/summary': summaryOf({
      pos: {
        total: 31,
        // Every status represented, and the two groups deliberately
        // different sizes: 18 awaiting the supplier, 25 not yet invoiced
        // (issue #288). A fixture where they match cannot tell the Overview
        // reading the wrong one from the Overview reading the right one.
        byStatus: { Open: 11, Acknowledged: 7, Dispatched: 4, Delivered: 3, Invoiced: 5, Paid: 1 },
        awaitingAcknowledgement: 11,
        awaitingSupplierCount: 18,
        notInvoicedCount: 25,
        notInvoicedValue: 7654321,
        totalValue: 9876543,
      },
      grns: { awaitingInvoice: 9 },
      invoices: { total: 23, openCount: 14, openValue: 456789, matchWarningCount: 2 },
      rfqs: { invited: 10, quoted: 4, openForBids: 6 },
    }),
  };

  it('counts orders awaiting the supplier, goods receipts to invoice and open RFQs from the summary', async () => {
    renderWithPortal(<DashboardPage />, { plane: 'supplier', route: '/', api });
    await screen.findByText('Awaiting payment', {}, { timeout: 3000 });

    // 18 orders awaiting the supplier, of which 11 await acknowledgement —
    // not the 1 PO row the page is holding, and not the 25 that are merely
    // not yet invoiced, which is the Reports page's question (issue #288).
    expect(screen.getByText('Awaiting you')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.queryByText('25')).not.toBeInTheDocument();
    expect(screen.getByText('11 awaiting acknowledgement')).toBeInTheDocument();
    // 9 goods receipts awaiting an invoice, with no GRN rows loaded at all:
    // the figure cannot have come from the array.
    expect(screen.getByText('9 goods receipts')).toBeInTheDocument();
  });

  it('shows the outstanding total the server computed, not the sum of the loaded invoices', async () => {
    renderWithPortal(<DashboardPage />, { plane: 'supplier', route: '/', api });
    await screen.findByText('Awaiting payment', {}, { timeout: 3000 });

    expect(screen.getByText('₹4,56,789.00')).toBeInTheDocument();
    expect(screen.getByText('14 invoices still open')).toBeInTheDocument();
    // What summing the one loaded invoice would have produced.
    expect(screen.queryByText('₹1,000.00')).not.toBeInTheDocument();
  });

  it('names documents in an alert but counts them from the summary', async () => {
    renderWithPortal(<DashboardPage />, { plane: 'supplier', route: '/', api });
    await screen.findByText('Awaiting payment', {}, { timeout: 3000 });

    // One id is loaded and named; the count is the server's 11, so the line
    // reads "+8" beyond the three it would have sampled.
    expect(await screen.findByText(/11 purchase orders awaiting acknowledgement/)).toBeInTheDocument();
    expect(screen.queryByText(/1 purchase order awaiting acknowledgement/)).not.toBeInTheDocument();
  });
});

describe('the supplier Reports screen renders the server\'s figures', () => {
  const api = {
    ...EMPTY_SUPPLIER_API,
    'GET /pos': listOf('pos', [poRow('PO-2026-0001', 1000)]),
    'GET /invoices': listOf('invoices', [invoiceRow('INV-0001', 1000)]),
    'GET /dashboard/summary': summaryOf({
      pos: {
        total: 31,
        awaitingSupplierCount: 18,
        notInvoicedCount: 25,
        notInvoicedValue: 7654321,
        totalValue: 9876543,
        byMaterial: [{ code: 'MAT-001', description: 'Hex bolts M8', poCount: 29, value: 9876543 }],
        byPlant: [{ plant: 'P100', value: 9876543 }],
        byMonth: [{ month: '2026-03', value: 9876543 }],
      },
      invoices: {
        total: 23,
        clearedCount: 9,
        openCount: 14,
        openValue: 456789,
        taxTotal: 54321,
        ageing: { '0-30': 100000, '31-60': 200000, '61-90': 56789, '90+': 100000 },
      },
      payments: { total: 7, tdsTotal: 12345 },
      rfqs: { invited: 10, quoted: 4 },
      ledgerBalance: 654321,
    }),
  };

  it('takes total order value and the order count from the summary', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api });
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    // The summary arrives a tick after the heading does.
    expect(await screen.findByText('31')).toBeInTheDocument();
    // 9,876,543 — not the 1,000 of the single loaded order.
    expect(document.body.textContent).toMatch(/98,76,543/);
    expect(document.body.textContent).not.toMatch(/Total order value[\s\S]{0,40}1,000\.00/);
  });

  // The other half of issue #288: this screen counts PO_NOT_INVOICED, the
  // Overview counts PO_AWAITING_SUPPLIER, and each says which it means. The
  // two numbers differing is correct; the two labels matching was the bug.
  it('labels the wider group "Not yet invoiced" and counts it, not the awaiting-you group', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api });
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    expect(await screen.findByText('Not yet invoiced')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.queryByText('Open orders')).not.toBeInTheDocument();
    expect(screen.queryByText('18')).not.toBeInTheDocument();
  });

  it('takes the RFQ quote rate from the summary, not from the loaded RFQ page', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api });
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    // 4 of 10, with no RFQ rows loaded — the client had nothing to divide.
    expect(await screen.findByText('40.0%')).toBeInTheDocument();
    expect(screen.getByText('4 of 10 RFQs')).toBeInTheDocument();
  });

  it('takes the ageing buckets and the ledger balance from the summary', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api });
    await screen.findByRole('heading', { name: 'Reports', level: 1 });

    // The finance and ledger tabs.
    screen.getByRole('tab', { name: 'Invoices and tax' }).click();
    expect(await screen.findByText(/2,00,000/)).toBeInTheDocument();

    screen.getByRole('tab', { name: 'Account ledger' }).click();
    // The KPI and the balance-over-time chart's label both carry it.
    expect((await screen.findAllByText(/6,54,321/)).length).toBeGreaterThan(0);
  });
});

describe('a figure is not invented while the summary is still in flight', () => {
  it('shows no outstanding total until the server answers', async () => {
    const api = {
      ...EMPTY_SUPPLIER_API,
      'GET /pos': listOf('pos', [poRow('PO-2026-0001', 1000)]),
      'GET /invoices': listOf('invoices', [invoiceRow('INV-0001', 1000)]),
      // The one endpoint that is down. Falling back to the arrays here is
      // exactly the behaviour being removed: it would read as a complete
      // account summary while being one page of it.
      'GET /dashboard/summary': { status: 500, body: { error: 'nope' } },
    };

    renderWithPortal(<DashboardPage />, { plane: 'supplier', route: '/', api });
    await screen.findByRole('heading', { name: 'Overview', level: 1 });

    expect(screen.queryByText('₹1,000.00')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing needs your attention right now.')).not.toBeInTheDocument();
  });
});
