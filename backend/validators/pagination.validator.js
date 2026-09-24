const { z } = require('zod');

// Issue #118. `GET /api/vendors` — and, identically, eight other list
// endpoints (grn, invoice, payment, po, rfq, and three platform-plane
// screens) — took `?page`/`?limit` straight from the query string into
// Prisma's `skip`/`take` with no ceiling and no numeric validation:
// `?limit=1000000` returned every row a tenant had in one response, and
// `?limit=abc` reached Prisma as `NaN` and surfaced as a 500 instead of a
// 400. One schema, applied to every one of them, closes both gaps at once
// rather than nine near-identical hand-rolled checks drifting apart.
//
// `.passthrough()` is not optional: every one of these routes' `req.query`
// also carries its own filters — `status`, `search`, `q`, `clientId`,
// `kind`, `environment`, `action` — and zod's default `.object()` behaviour
// is to *strip* any key the schema does not name. Without this, validating
// pagination would silently delete every other filter a request sent.
//
// 200 is generous enough for this app's own largest legitimate callers —
// `new-asset/page.jsx`'s `?limit=200` vendor fetch and workspace purchase-
// orders' own `?limit=200` — without handing out a whole tenant's table in
// one response to anyone who asks for more.
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(20),
}).passthrough();

module.exports = { paginationSchema };
