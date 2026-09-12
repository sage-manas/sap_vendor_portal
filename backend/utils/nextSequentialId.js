const { Prisma } = require('@prisma/client');
const { prisma } = require('../db/prisma');
const { getTenantId } = require('./tenantContext');

// The next free <prefix><seq> for this tenant — shared by every controller
// that mints a sequential business id (RFQ-<year>-, PO-<year>-, and a
// discovery sweep minting one for an SAP-originated PO the portal never
// awarded).
//
// This used to select every row whose id started with the prefix, pull them
// all into Node and scan in JavaScript. That cost grew with the tenant's
// document count — 20,000 POs meant 20,000 rows loaded to allocate one id —
// and on the award path it ran inside the caller's transaction, holding locks
// for the length of the scan. It also raced: the read and the write were
// separate, and once a background sweep started minting ids too (see
// jobs/handlers/sweepPurchaseOrders.js) a sweep and a concurrent award could
// compute the same number, with the loser failing on a unique constraint.
//
// Allocation is now one atomic statement against document_counters, so it is
// O(1) in the tenant's document count and two allocators can never be handed
// the same number. Gaps are expected and harmless: a rolled-back transaction
// burns its number, exactly as a SAP number range does.
//
// What is preserved from the previous fix: suffixes are compared NUMERICALLY,
// never as strings. A plain string sort is only correct while every suffix has
// the same digit width — past 999 (RFQ's 3-digit padding) or 9999 (PO's
// 4-digit padding), '...-1000' sorts before '...-999' because '1' < '9' at the
// first differing character. See tests/sequential-id-overflow.test.js.

// Raw SQL needs the physical table name, and an identifier cannot be a bound
// parameter. Read it from Prisma's own datamodel rather than hardcoding a
// second mapping that could drift from schema.prisma's @@map.
const tableNameCache = new Map();
const tableFor = (modelProp) => {
  if (tableNameCache.has(modelProp)) return tableNameCache.get(modelProp);

  const model = Prisma.dmmf.datamodel.models.find(
    (entry) => entry.name.charAt(0).toLowerCase() + entry.name.slice(1) === modelProp
  );
  if (!model) throw new Error(`nextSequentialId: no Prisma model for "${modelProp}"`);

  const table = model.dbName || model.name;
  // Belt and braces: this value is interpolated, not bound, so refuse anything
  // that is not a plain identifier even though it came from the datamodel.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`nextSequentialId: unsafe table name "${table}"`);
  }
  tableNameCache.set(modelProp, table);
  return table;
};

// The highest suffix already in use for this tenant and prefix, or 0. Runs
// once per (tenant, prefix) — only when no counter row exists yet, i.e. the
// first allocation after this table was introduced, or the first of a new
// year. The aggregate stays in Postgres; no row set crosses into Node.
const highestExistingSuffix = async (client, modelProp, prefix, clientId) => {
  const table = Prisma.raw(`"${tableFor(modelProp)}"`);
  const rows = await client.$queryRaw`
    SELECT COALESCE(MAX((regexp_match("id", '([0-9]+)$'))[1]::bigint), 0) AS max_suffix
    FROM ${table}
    WHERE "clientId" = ${clientId}
      AND "id" LIKE ${`${prefix}%`}
      AND "id" ~ '^.*-[0-9]+$'`;
  return Number(rows[0]?.max_suffix ?? 0);
};

const nextSequentialId = async (model, prefix, padLength, client = prisma) => {
  const clientId = getTenantId();
  if (!clientId) {
    throw new Error(
      `nextSequentialId: refusing to allocate "${prefix}" without a bound tenant — wrap the call in runWithTenant(clientId, fn)`
    );
  }

  // Steady state: one row touched, one round trip. UPDATE ... RETURNING is
  // atomic, so concurrent allocators queue on the row lock and each leaves
  // with a distinct number.
  const claimed = await client.$queryRaw`
    UPDATE "document_counters"
    SET "next_value" = "next_value" + 1
    WHERE "clientId" = ${clientId} AND "prefix" = ${prefix}
    RETURNING "next_value" - 1 AS seq`;

  if (claimed.length > 0) {
    return format(prefix, claimed[0].seq, padLength);
  }

  // No counter for this (tenant, prefix) yet. Seed it past whatever is already
  // there — rows can predate this table, and a discovery sweep can import an
  // SAP document with an id the portal never allocated.
  const start = await highestExistingSuffix(client, model, prefix, clientId) + 1;

  // ON CONFLICT rather than a plain INSERT: another allocator may have seeded
  // the same counter between the UPDATE above and here, in which case this
  // takes the normal increment path and still returns a number nobody else has.
  const seeded = await client.$queryRaw`
    INSERT INTO "document_counters" ("clientId", "prefix", "next_value")
    VALUES (${clientId}, ${prefix}, ${BigInt(start + 1)})
    ON CONFLICT ("clientId", "prefix")
    DO UPDATE SET "next_value" = "document_counters"."next_value" + 1
    RETURNING "next_value" - 1 AS seq`;

  return format(prefix, seeded[0].seq, padLength);
};

// Postgres bigint arrives as a JS BigInt; the padding is a floor, not a cap —
// a suffix wider than padLength is left at its natural width.
const format = (prefix, seq, padLength) =>
  `${prefix}${String(Number(seq)).padStart(padLength, '0')}`;

module.exports = { nextSequentialId };
