import { describe, it, expect } from 'vitest';
import { poKind, lineKind, lineHasInvoicePlan, hasInvoicePlan, invoicePlanNumbers } from './poKind';

// SAP's account assignment category (EKPO-KNTTP) is the whole rule: 'A' asset,
// 'D' service, blank an ordinary material line. Getting it wrong shows a
// supplier the wrong kind of order, so it is pinned here rather than left to
// the component that renders the badge.

const line = (overrides) => ({ line: 10, description: 'Hex bolts', ...overrides });

describe('lineKind', () => {
  it('reads the account assignment category', () => {
    expect(lineKind(line({ accountAssignmentCategory: 'A' })).key).toBe('asset');
    expect(lineKind(line({ accountAssignmentCategory: 'D' })).key).toBe('service');
  });

  it('treats a blank category as an ordinary material line, not as unknown', () => {
    // Blank is what SAP sends for the common case — it is an answer, not a
    // missing field, so it must not read as indeterminate.
    expect(lineKind(line({ accountAssignmentCategory: '' })).key).toBe('standard');
    expect(lineKind(line({ accountAssignmentCategory: null })).key).toBe('standard');
    expect(lineKind(line()).key).toBe('standard');
  });

  it('is not fooled by case or surrounding whitespace', () => {
    expect(lineKind(line({ accountAssignmentCategory: ' a ' })).key).toBe('asset');
    expect(lineKind(line({ accountAssignmentCategory: 'd' })).key).toBe('service');
  });

  it('knows the cost-centre category that appears alongside A and D', () => {
    expect(lineKind(line({ accountAssignmentCategory: 'K' })).key).toBe('cost_centre');
  });

  it('reports an unrecognised category as itself rather than as a material line', () => {
    // SAP has more categories than the four described here. Calling one of
    // them "Material" would be a wrong answer where naming the code is a true
    // one.
    const kind = lineKind(line({ accountAssignmentCategory: 'F' }));
    expect(kind.key).toBe('other');
    expect(kind.label).toBe('F');
  });
});

describe('poKind', () => {
  it('describes an order by the category its lines carry', () => {
    expect(poKind({ items: [line({ accountAssignmentCategory: 'A' })] }).orderLabel).toBe('Asset PO');
    expect(poKind({ items: [line({ accountAssignmentCategory: 'D' })] }).orderLabel).toBe('Service PO');
    expect(poKind({ items: [line()] }).orderLabel).toBe('Standard PO');
  });

  it('says mixed rather than picking one, when the lines disagree', () => {
    // SAP permits this, so "the first line wins" would mislabel the order.
    const po = { items: [line({ accountAssignmentCategory: 'A' }), line({ line: 20 })] };
    expect(poKind(po).key).toBe('mixed');
  });

  it('does not call an order mixed when every line carries the same category', () => {
    const po = {
      items: [
        line({ accountAssignmentCategory: 'K' }),
        line({ line: 20, accountAssignmentCategory: 'K' }),
      ],
    };
    expect(poKind(po).key).toBe('cost_centre');
  });

  it('reads an order with no lines as standard', () => {
    expect(poKind({ items: [] }).key).toBe('standard');
    expect(poKind({}).key).toBe('standard');
    expect(poKind(null).key).toBe('standard');
  });
});

describe('invoicing plan', () => {
  it('recognises both spellings — the portal’s plan record and SAP’s bare number', () => {
    expect(lineHasInvoicePlan(line({ invoicePlan: { enabled: true, type: 'Milestone' } }))).toBe(true);
    expect(lineHasInvoicePlan(line({ invoicePlanNumber: '0000001255' }))).toBe(true);
  });

  it('does not count a plan record that is switched off', () => {
    expect(lineHasInvoicePlan(line({ invoicePlan: { enabled: false } }))).toBe(false);
    expect(lineHasInvoicePlan(line())).toBe(false);
  });

  it('is an axis of its own, not a fourth kind of order', () => {
    // An asset order may or may not be invoice-planned; the two facts are
    // reported separately.
    const assetPlanned = { items: [line({ accountAssignmentCategory: 'A', invoicePlanNumber: '0000001255' })] };
    expect(poKind(assetPlanned).key).toBe('asset');
    expect(hasInvoicePlan(assetPlanned)).toBe(true);
  });

  it('collects the distinct plan numbers on an order', () => {
    const po = { items: [
      line({ invoicePlanNumber: '0000001255' }),
      line({ line: 20, invoicePlanNumber: '0000001255' }),
      line({ line: 30, invoicePlanNumber: '0000001256' }),
      line({ line: 40 }),
    ] };
    expect(invoicePlanNumbers(po)).toEqual(['0000001255', '0000001256']);
    expect(invoicePlanNumbers({ items: [line()] })).toEqual([]);
  });
});
