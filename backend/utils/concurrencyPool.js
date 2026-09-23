// A small bounded-concurrency map. `Promise.all(items.map(fn))` has no cap —
// "one call per matched invoice" turned into a burst of as many simultaneous
// requests as the vendor had matched invoices against someone else's SAP
// gateway (issue #71). At most `limit` calls to `fn` run at once; results
// land at the same index as their input, same as Promise.all.
const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await fn(items[index], index);
    }
  };

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
};

module.exports = { mapWithConcurrency };
