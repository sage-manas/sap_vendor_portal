// Issue #71: mapWithConcurrency replaces an unbounded Promise.all wherever a
// caller was fanning out one SAP call per matched document — see
// controllers/invoice.controller.js's getSapInvoiceStatus. Tested standalone
// since the bound it guarantees is a property of this function, not of any
// one caller.
const { mapWithConcurrency } = require('../utils/concurrencyPool');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` calls at once', async () => {
    let current = 0;
    let max = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
      current += 1;
      max = Math.max(max, current);
      await delay(10);
      current -= 1;
      return item * 2;
    });

    expect(max).toBeLessThanOrEqual(3);
  });

  it('returns results in the same order as the input, regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 2, async (ms) => {
      await delay(ms);
      return ms;
    });

    expect(results).toEqual([30, 10, 20]);
  });

  it('runs everything at once when the limit is not smaller than the input', async () => {
    let current = 0;
    let max = 0;

    await mapWithConcurrency([1, 2, 3], 10, async (item) => {
      current += 1;
      max = Math.max(max, current);
      await delay(5);
      current -= 1;
      return item;
    });

    expect(max).toBe(3);
  });

  it('does nothing for an empty input', async () => {
    const results = await mapWithConcurrency([], 5, async () => { throw new Error('must not be called'); });
    expect(results).toEqual([]);
  });

  it('propagates a rejection from one of the calls', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom');
      return item;
    })).rejects.toThrow('boom');
  });
});
