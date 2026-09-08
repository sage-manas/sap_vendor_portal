const { Prisma } = require('@prisma/client');

// A handful of business documents (Invoice, Payment, ASN…) are keyed by a
// short human-legible reference — 'INV-482913' — generated with
// `Math.random()` rather than a real sequence, and made unique only per
// tenant (`@@unique([clientId, id])`). A 6-digit random suffix has a 1-in-900k
// chance of repeating on any given attempt — negligible once, but with no
// retry a collision meant the create failed outright and the request that
// triggered it (submitting an invoice, dispatching a shipment) errored for a
// reason that had nothing to do with what the caller did wrong.
//
// This is the minimal fix for that: on a unique-constraint violation, generate
// a fresh id and try again, up to a few times. It does not touch the id
// *format* — nothing downstream that pattern-matches these references changes
// shape — and it stays safe to retry blindly only because the caller has
// confirmed the model's one unique constraint is the id itself (see the call
// sites' comments); a table with an unrelated unique field would need the
// violation's `meta.target` checked before retrying.
const isUniqueViolation = (err) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * @param {() => string} genId - produces a candidate id; called again on each retry
 * @param {(id: string) => Promise<any>} create - performs the create with the given id
 * @param {number} [attempts]
 */
const createWithUniqueId = async ({ genId, create, attempts = 5 }) => {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await create(genId());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
};

module.exports = { createWithUniqueId };
