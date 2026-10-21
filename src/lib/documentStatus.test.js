import { describe, it, expect } from 'vitest';

import * as ui from './documentStatus';
// The registry itself. Reached by relative path rather than an alias because
// it is outside the Next app — the point of this test is that the two files
// are the same lists, so it has to read the real one.
import * as backend from '../../backend/config/statuses';

// documentStatus.js is a mirror of backend/config/statuses.js, kept in the
// bundle so a render-time filter does not need a round trip. A mirror with
// nothing checking it is just a second opinion waiting to be wrong — which
// is the bug the registry was introduced to end (issue #283): "not yet paid"
// meant one thing in the validator, another in the overview's counts, and a
// third in the supplier's ageing buckets.

describe('documentStatus mirrors the backend registry', () => {
  it.each([
    ['INVOICE_STATUS', 'INVOICE_STATUS'],
    ['INVOICE_STATUSES', 'INVOICE_STATUSES'],
    ['INVOICE_OPEN', 'INVOICE_OPEN'],
    ['INVOICE_TERMINAL', 'INVOICE_TERMINAL'],
    ['PO_STATUS', 'PO_STATUS'],
    ['PO_STATUSES', 'PO_STATUSES'],
    ['PO_AWAITING_SUPPLIER', 'PO_AWAITING_SUPPLIER'],
    ['PO_IN_FLIGHT', 'PO_IN_FLIGHT'],
    ['PO_NOT_INVOICED', 'PO_NOT_INVOICED'],
    ['PO_CLOSED', 'PO_CLOSED'],
  ])('%s is identical on both sides', (name) => {
    expect(ui[name]).toEqual(backend[name]);
  });

  it('every status is in exactly one of open or terminal', () => {
    expect([...ui.INVOICE_OPEN, ...ui.INVOICE_TERMINAL].sort())
      .toEqual([...ui.INVOICE_STATUSES].sort());
  });

  // Issue #288: "open orders" meant Open+Acknowledged on the Overview and
  // those plus Dispatched+Delivered on Reports. Both are real questions, so
  // the fix is that each group covers what it says and the two partition the
  // enum between them — no status counted twice, none left out.
  it('every PO status is in exactly one of not-invoiced or closed', () => {
    expect([...ui.PO_NOT_INVOICED, ...ui.PO_CLOSED].sort())
      .toEqual([...ui.PO_STATUSES].sort());
  });

  it('awaiting-the-supplier and in-flight split the not-invoiced group', () => {
    expect([...ui.PO_AWAITING_SUPPLIER, ...ui.PO_IN_FLIGHT].sort())
      .toEqual([...ui.PO_NOT_INVOICED].sort());
    // The narrower group is genuinely narrower — the bug was them being read
    // as the same thing under the same label.
    expect(ui.PO_AWAITING_SUPPLIER).not.toEqual(ui.PO_NOT_INVOICED);
  });

  it('a rejected invoice is not open — the whole point of the grouping', () => {
    expect(ui.isInvoiceOpen(ui.INVOICE_STATUS.REJECTED)).toBe(false);
    expect(ui.isInvoiceOpen(ui.INVOICE_STATUS.CLEARED)).toBe(false);
    expect(ui.isInvoiceOpen(ui.INVOICE_STATUS.SUBMITTED)).toBe(true);
  });
});
