import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, SUPPLIER_SESSION } from '@/test/renderWithPortal';
import PurchaseOrdersPage from '@/app/pos/page';
import InvoicePlanPanel from './components/InvoicePlanPanel';

// The buyer-side page (workspace/purchase-orders/[id]/page.jsx) reads its :id
// through React's use(params) — nothing in this harness has a working pattern
// yet for driving that Suspense boundary in a test, and building one is
// orthogonal to this feature. InvoicePlanPanel takes canManage/canPropose as
// plain props, not from session context, so rendering it directly exercises
// the exact same component and wiring without that gap.

// The UI half of the propose/approve/reject flow — the backend's own
// authorization, reconciliation and race-condition guarantees are covered by
// backend/tests/invoice-plan.test.js; this checks that the two audiences
// actually see the controls the permission they hold entitles them to, wired
// to the right endpoints, which nothing on the server side can catch.

const po = (overrides = {}) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Acknowledged',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  // invoicePlan.enabled is what showInvoicePlanTab (PurchaseOrdersView.jsx)
  // reads to decide whether the tab exists at all — the same field GET /pos
  // itself would report via formatPlan.
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Annual contract', quantity: 1, uom: 'EA', unitPrice: 100000, netValue: 100000, invoicePlan: { enabled: true } }],
  ...overrides,
});

const planLine = (overrides = {}) => ({
  lineNumber: 10,
  description: 'On order',
  settlementDate: '2020-01-01T00:00:00.000Z',
  percentage: 100,
  amount: 100000,
  status: 'Open',
  blocked: false,
  ...overrides,
});

const planItem = ({ pendingChange = null, lines = [planLine()] } = {}) => ({
  line: 10,
  materialCode: 'MAT-001',
  description: 'Annual contract',
  quantity: 1,
  unitPrice: 100000,
  netValue: 100000,
  uom: 'EA',
  plan: {
    enabled: true, planNumber: '0000001255', type: 'Partial',
    currency: 'INR', lines, source: 'sap', syncedAt: null, pendingChange,
  },
  summary: {
    type: 'Partial', totalLines: lines.length, totalValue: 100000,
    invoicedLines: 0, invoicedValue: 0, openValue: 100000,
    dueLines: 1, dueValue: 100000, nextDueDate: lines[0]?.settlementDate,
    blockedLines: 0, complete: false,
  },
});

describe('a supplier proposing a change to their own invoicing plan', () => {
  it('offers "Propose a change" and sends it to the propose endpoint, not the buyer-only one', async () => {
    const user = userEvent.setup();
    const session = {
      ...SUPPLIER_SESSION,
      auth: { ...SUPPLIER_SESSION.auth, permissions: [...SUPPLIER_SESSION.auth.permissions, 'po:invoice-plan:propose'] },
    };

    const { apiMock } = renderWithPortal(<PurchaseOrdersPage />, {
      plane: 'supplier',
      route: '/pos',
      session,
      api: {
        'GET /pos': { pos: [po()], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
        'GET /pos/PO-2026-0001': po(),
        'GET /pos/PO-2026-0001/invoice-plan': { poId: 'PO-2026-0001', invoicePlanningEnabled: true, items: [planItem()], billable: [] },
        'PUT /pos/PO-2026-0001/items/10/invoice-plan/propose': {
          message: 'Proposed change sent for line 10',
          item: planItem({ pendingChange: { input: {}, requestedAt: new Date().toISOString(), requestedBy: 'VND-00001' } }),
        },
      },
    });

    await user.dblClick(await screen.findByText('PO-2026-0001'));
    await user.click(await screen.findByRole('button', { name: /Invoicing plan/i }));

    const proposeButton = await screen.findByRole('button', { name: /Propose a change/i });
    // A supplier must never see the buyer's own direct-edit control.
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();

    await user.click(proposeButton);
    await user.click(await screen.findByRole('button', { name: /Send proposal to buyer/i }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/pos/PO-2026-0001/items/10/invoice-plan/propose').length).toBe(1));
    // Never the endpoint that writes SAP directly.
    expect(apiMock.callsTo('PUT', '/pos/PO-2026-0001/items/10/invoice-plan')).toHaveLength(0);
  });
});

describe("a buyer deciding a supplier's proposed change", () => {
  const pendingItem = () => planItem({
    pendingChange: {
      input: { type: 'Partial', milestones: [{ settlementDate: '2020-06-01', percentage: 100, description: 'Revised' }] },
      requestedAt: '2026-01-05T00:00:00.000Z',
      requestedBy: 'VND-00001',
    },
  });

  it('shows the pending proposal and approves it against the approve endpoint', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<InvoicePlanPanel po={po()} canManage />, {
      plane: 'bare',
      api: {
        'GET /pos/PO-2026-0001/invoice-plan': { poId: 'PO-2026-0001', invoicePlanningEnabled: true, items: [pendingItem()], billable: [] },
        'PUT /pos/PO-2026-0001/items/10/invoice-plan/propose/approve': {
          message: 'Proposed change for line 10 approved and saved to SAP',
          item: planItem({ lines: [planLine({ settlementDate: '2020-06-01T00:00:00.000Z' })] }),
        },
      },
    });

    expect(await screen.findByText(/Proposed change awaiting approval/i)).toBeInTheDocument();
    expect(screen.getByText(/VND-00001/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Approve & save to SAP/i }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/pos/PO-2026-0001/items/10/invoice-plan/propose/approve').length).toBe(1));
  });

  it('rejects with a reason, without ever calling the approve endpoint', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<InvoicePlanPanel po={po()} canManage />, {
      plane: 'bare',
      api: {
        'GET /pos/PO-2026-0001/invoice-plan': { poId: 'PO-2026-0001', invoicePlanningEnabled: true, items: [pendingItem()], billable: [] },
        'PUT /pos/PO-2026-0001/items/10/invoice-plan/propose/reject': {
          message: 'Proposed change for line 10 rejected',
          item: planItem(),
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^Reject$/ }));
    await user.type(await screen.findByPlaceholderText(/Why this proposal is being rejected/i), 'Keep the original schedule');
    await user.click(screen.getByRole('button', { name: /Reject proposal/i }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/pos/PO-2026-0001/items/10/invoice-plan/propose/reject').length).toBe(1));
    expect(apiMock.lastBody('PUT', '/pos/PO-2026-0001/items/10/invoice-plan/propose/reject')).toEqual({ reason: 'Keep the original schedule' });
    expect(apiMock.callsTo('PUT', '/pos/PO-2026-0001/items/10/invoice-plan/propose/approve')).toHaveLength(0);
  });
});
