const { prisma } = require('../db/prisma');
const {
  generateDataKey, wrapDataKey, unwrapDataKey, encryptWithDataKey, decryptWithDataKey,
} = require('../utils/secretBox');

// Replaces the three Mongoose instance methods on SapConnection
// (models/SapConnection.js: setSecrets/decryptSecrets/secretNames), now that
// `secrets` is a child table (SapConnectionSecret) instead of a Mongoose Map.
//
// `connection` here is the SapConnection row possibly carrying a `secrets`
// relation array (include it, or pass secrets explicitly) — every function
// takes what it needs rather than assuming a shape, since callers fetch this
// row in different ways (with/without the relation, with/without
// wrappedDataKey per the `omit` config in backend/db/prisma.js).

// Writes `values` into the connection's SapConnectionSecret rows, encrypted.
// A key mapped to null or '' deletes that row — same "clear a credential
// without a second endpoint" behavior as before. Keys absent from `values`
// are left alone. Returns the (possibly new) wrappedDataKey to persist on the
// connection row alongside this call, since generating a data key is a side
// effect of the first secret ever written.
const setSecrets = async (connection, values = {}) => {
  if (!Object.keys(values).length) return connection.wrappedDataKey;

  let dataKey;
  let wrappedDataKey = connection.wrappedDataKey;
  if (wrappedDataKey) {
    dataKey = unwrapDataKey(wrappedDataKey);
  } else {
    dataKey = generateDataKey();
    wrappedDataKey = wrapDataKey(dataKey);
  }

  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === '') {
      await prisma.sapConnectionSecret.deleteMany({ where: { connectionPk: connection.pk, name } });
    } else {
      await prisma.sapConnectionSecret.upsert({
        where: { connectionPk_name: { connectionPk: connection.pk, name } },
        create: { connectionPk: connection.pk, name, ciphertext: encryptWithDataKey(dataKey, value) },
        update: { ciphertext: encryptWithDataKey(dataKey, value) },
      });
    }
  }

  return wrappedDataKey;
};

// The only way plaintext comes back out, and it exists for exactly one
// caller: the driver factory, which needs credentials to open a connection.
// Requires `wrappedDataKey` (omitted by default — pass `omit: { wrappedDataKey: false }`
// when fetching the connection for this purpose).
const decryptSecrets = async (connection) => {
  if (!connection.wrappedDataKey) return {};

  const dataKey = unwrapDataKey(connection.wrappedDataKey);
  const rows = await prisma.sapConnectionSecret.findMany({ where: { connectionPk: connection.pk } });
  const out = {};
  for (const row of rows) {
    out[row.name] = decryptWithDataKey(dataKey, row.ciphertext);
  }
  return out;
};

// Which credentials are set, without saying what they are.
const secretNames = async (connection) => {
  const rows = await prisma.sapConnectionSecret.findMany({
    where: { connectionPk: connection.pk },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => row.name);
};

const ENVIRONMENTS = ['sandbox', 'production'];

module.exports = { setSecrets, decryptSecrets, secretNames, ENVIRONMENTS };
