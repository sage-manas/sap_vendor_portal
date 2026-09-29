import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, listOf } from '@/test/fixtures';

import PaymentsPage from '@/app/payments/page';

// Issue #163. The "Payment status" table (our own records) and "Payments
// recorded by your buyer" table (read straight from SAP) show the same
// remittance, but formatted their amounts differently: the top table always
// showed two decimals via toLocaleString('en-IN', { minimumFractionDigits: 2,
// maximumFractionDigits: 2 }), while the SAP table called toLocaleString('en-IN')
// with no options and dropped trailing zeros. Same money, two different-looking
// numbers on one screen.

const PAYMENT = {
  id: 'pay-1',
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-1001',
  amount: 177000,
  netAmount: 177000,
  grossAmount: 177000,
  tdsDeducted: 0,
  paymentDate: '2026-05-10T00:00:00.000Z',
  utrCode: 'UTR123456',
  paymentMethod: 'NEFT',
  sapMiroDoc: 'MIRO-1',
  sapPaymentDoc: 'CLR-1',
};

const SAP_ROW = {
  miroDoc: 'MIRO-1',
  clearingDocument: 'CLR-1',
  clearingDate: '2026-05-10T00:00:00.000Z',
  grossAmount: 177000,
  tdsDeducted: 0,
  netDisbursed: 177000,
  utrReference: 'UTR123456',
  paymentMethod: 'NEFT',
  status: 'CLEARED',
};

describe('/payments, the same amount across both tables', () => {
  it('is formatted identically whether it came from our records or SAP', async () => {
    renderWithPortal(<PaymentsPage />, {
      plane: 'supplier',
      route: '/payments',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /payments': listOf('payments', [PAYMENT]),
        'GET /payments/sap-status': { payments: [SAP_ROW] },
      },
    });

    // Gross and Net both read 1,77,000.00 (no TDS on this payment), once per
    // table — four matches total, all formatted the same way.
    await waitFor(() => expect(screen.getAllByText('₹ 1,77,000.00').length).toBe(4));
    expect(screen.queryByText('₹ 1,77,000')).not.toBeInTheDocument();
  });
});
