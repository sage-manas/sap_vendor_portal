const { prisma } = require('../db/prisma');

// The next free <prefix><seq> for this tenant — shared by every controller
// that mints a sequential business id (RFQ-<year>-, PO-<year>-, and now a
// discovery sweep minting one for an SAP-originated PO the portal never
// awarded). Read-then-write with no lock, a deliberately kept race (migration
// plan decision point: scan-and-increment vs. a real Postgres sequence).
//
// What is NOT deliberate: this used to pick the "latest" id with
// `orderBy: { id: 'desc' }` and take the first row — a plain string sort,
// which is only correct while every suffix has the same digit width. Once a
// tenant passes 999 RFQs (or 9999 POs) in a year, the padding no longer
// holds — "...-1000" sorts *before* "...-999" as a string, since '1' < '9' at
// the first differing character — so this would forever find "999" as the
// latest, forever recompute "1000", and forever fail the create against the
// row that's already there. Comparing the numeric suffixes themselves, not
// the id strings, is what the padding was supposed to give it for free and
// stopped doing once a suffix outgrew its own padding.
//
// `client` defaults to the tenant-scoped `prisma`; a caller inside its own
// transaction (awardBid, a discovery sweep's upsert) passes its `tx` instead,
// so the read happens inside the same transaction as the create that follows.
const nextSequentialId = async (model, prefix, padLength, client = prisma) => {
  const rows = await client[model].findMany({
    where: { id: { startsWith: prefix } },
    select: { id: true },
  });
  let seq = 1;
  for (const row of rows) {
    const match = row.id.match(/-(\d+)$/);
    if (match) seq = Math.max(seq, parseInt(match[1], 10) + 1);
  }
  return `${prefix}${String(seq).padStart(padLength, '0')}`;
};

module.exports = { nextSequentialId };
