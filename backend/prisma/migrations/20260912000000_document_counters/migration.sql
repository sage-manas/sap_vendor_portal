-- One allocation counter per (tenant, business-id prefix). See the
-- DocumentCounter model in schema.prisma for why it exists and why it is not
-- tenant-scoped through the Prisma extension.
CREATE TABLE "document_counters" (
    "clientId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "document_counters_pkey" PRIMARY KEY ("clientId", "prefix")
);

-- Backfill: seed each counter past the highest suffix already in use, so the
-- first allocation after this migration cannot collide with an existing row.
-- The suffix is compared numerically, never as a string — the whole point of
-- the fix this table inherits (see tests/sequential-id-overflow.test.js): once
-- a suffix outgrows its zero-padding, '1000' sorts before '999'.
--
-- The prefix is everything up to and including the final '-', which is what
-- the callers in rfq.controller.js and jobs/handlers/sweepPurchaseOrders.js
-- pass ('RFQ-2026-', 'PO-2026-'), so a tenant gets one counter per year.
INSERT INTO "document_counters" ("clientId", "prefix", "next_value")
SELECT
    "clientId",
    substring("id" from '^(.*-)[0-9]+$')                     AS prefix,
    MAX((regexp_match("id", '([0-9]+)$'))[1]::bigint) + 1     AS next_value
FROM "rfqs"
WHERE "id" ~ '^.*-[0-9]+$'
GROUP BY "clientId", substring("id" from '^(.*-)[0-9]+$')
ON CONFLICT ("clientId", "prefix") DO NOTHING;

INSERT INTO "document_counters" ("clientId", "prefix", "next_value")
SELECT
    "clientId",
    substring("id" from '^(.*-)[0-9]+$')                     AS prefix,
    MAX((regexp_match("id", '([0-9]+)$'))[1]::bigint) + 1     AS next_value
FROM "purchase_orders"
WHERE "id" ~ '^.*-[0-9]+$'
GROUP BY "clientId", substring("id" from '^(.*-)[0-9]+$')
ON CONFLICT ("clientId", "prefix") DO NOTHING;
