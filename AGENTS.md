<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project context

For a complete, self-contained overview of this project — architecture, data model, every module, the full API endpoint map, the SAP-simulation design, conventions, and gotchas — read `PROJECT_CONTEXT.md` at the repo root. It is the canonical orientation doc; when it conflicts with older `workflow/` docs, trust the code first, then `PROJECT_CONTEXT.md`.

# When a test has to reach around the API, stop

This repo's two most serious defects — an uninvited supplier could bid on a
sealed tender, and the first bid closed that tender to everyone else — both
survived a suite of 30+ backend files. Neither was untested. Both were
*wrongly* tested:

```js
// One asserted the hole as the expected behaviour:
it('accepts a bid from a non-invited vendor by dynamically inviting them', …)

// The other seeded around it, and said so:
// Seed two competing bids directly (API closes bidding after the first bid)
await prisma.rfqBid.create({ … });
```

An untested path is a known unknown; coverage tooling finds it. A wrongly
tested path is worse — it reads as covered, it goes green on every run, and it
actively resists the fix, because correcting the code turns the test red.

So:

1. **API-bypassing setup is a defect report.** If you need to write through
   Prisma to construct a state the API is supposed to be able to produce, you
   have found something about the API. Fix it, or file it and link the issue
   from the test. Seeding *preconditions* you are not exercising — a tenant, an
   approved supplier, historical rows, another tenant's data — is normal and
   expected; `tests/tenant-isolation.test.js` could not exist otherwise.

2. **Never name a test after a defect approvingly.** If the name would alarm a
   reviewer scanning the file, that is the point. Write what should happen.

3. **A test that pins known-imperfect behaviour must link the issue** that
   tracks the decision, so the debt stays visible instead of curing into
   "that's just how it works".

Both example tests above have since been rewritten. See ADR-0037.
