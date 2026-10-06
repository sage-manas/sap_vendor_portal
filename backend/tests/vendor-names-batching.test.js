// The batching half of finding 4.3, pinned separately from the integration
// tests in supplier-names-in-lists.test.js.
//
// Those assert the names are right. A per-row lookup produces exactly the same
// right names, so they cannot tell a batched resolve from an N+1 — and these
// are the tenant-wide lists, where N is every order the workspace holds. So
// this one asserts the shape of the query instead, against a stubbed client:
// one findMany, keyed on an `in` of the distinct ids.
//
// Unit-scoped on purpose. The alternative, counting SQL through
// `prisma.$on('query')`, does not work here: db/prisma.js builds the client
// without event-level logging and exports it already wrapped in three
// extensions, so there is no query event to subscribe to.

// `mock`-prefixed because jest hoists the factory above this declaration
// and refuses an out-of-scope reference that is not named that way.
const mockFindMany = jest.fn();

// Only `prisma.vendor.findMany` is stubbed. The rest of the module stays real
// because tests/setup.js imports `rawPrisma` from here to seed the tenant and
// reset the database between tests — replacing the whole module wholesale
// breaks that shared setup for this file.
jest.mock('../db/prisma', () => {
  const actual = jest.requireActual('../db/prisma');
  return {
    ...actual,
    prisma: new Proxy(actual.prisma, {
      get: (target, property) => (property === 'vendor'
        ? { ...target.vendor, findMany: (...args) => mockFindMany(...args) }
        : target[property]),
    }),
  };
});

const { vendorNameMap, withVendorNames } = require('../utils/vendorNames');

beforeEach(() => {
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([
    { vendorId: 'v1', companyName: 'Acme Industries Pvt Ltd' },
    { vendorId: 'v2', companyName: 'Beta Supplies Pvt Ltd' },
  ]);
});

describe('vendorNameMap', () => {
  it('resolves many ids in a single query', async () => {
    await vendorNameMap(['v1', 'v2', 'v1', 'v2']);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledWith({
      // Deduplicated — a list of 200 orders across 2 suppliers asks for 2.
      where: { vendorId: { in: ['v1', 'v2'] } },
      select: { vendorId: true, companyName: true },
    });
  });

  it('asks nothing at all when there are no ids to resolve', async () => {
    const map = await vendorNameMap([]);

    expect(map.size).toBe(0);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('ignores a row with no vendorId rather than querying for null', async () => {
    await vendorNameMap([null, undefined, '', 'v1']);

    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { vendorId: { in: ['v1'] } },
    }));
  });
});

describe('withVendorNames', () => {
  it('names each row and leaves the rest of it alone', async () => {
    const rows = await withVendorNames([
      { id: 'PO-1', vendorId: 'v1', status: 'Open' },
      { id: 'PO-2', vendorId: 'v2', status: 'Closed' },
    ]);

    expect(rows).toEqual([
      { id: 'PO-1', vendorId: 'v1', status: 'Open', vendorName: 'Acme Industries Pvt Ltd' },
      { id: 'PO-2', vendorId: 'v2', status: 'Closed', vendorName: 'Beta Supplies Pvt Ltd' },
    ]);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('answers null for an id no supplier row matches', async () => {
    const [row] = await withVendorNames([{ id: 'PO-3', vendorId: 'LIFNR-77001' }]);

    // Not '' and not the code echoed back: null is "we hold no company for
    // this code", which is what lets the list decide to show the code.
    expect(row.vendorName).toBeNull();
  });

  it('costs one query for a whole page, not one per row', async () => {
    const page = Array.from({ length: 50 }, (unused, index) => ({
      id: `PO-${index}`,
      vendorId: index % 2 ? 'v1' : 'v2',
    }));

    await withVendorNames(page);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});
