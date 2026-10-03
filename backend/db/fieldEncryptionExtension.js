const { encrypt, decrypt, isEncrypted } = require('../utils/secretBox');

// Field-level encryption at rest for the few columns whose exposure is a fraud
// or identity-theft event on its own: a supplier's bank account number, its PAN,
// and the PAN a TDS payment records.
//
//   Vendor.pan, Vendor.accountNumber
//   Vendor.pendingBankChange.accountNumber   (a JSON column; only that key)
//   Payment.deducteePan
//
// Values are sealed with AES-256-GCM under MASTER_KEY (utils/secretBox.js,
// `v1:` blobs) as they are written, and opened as rows are returned, so no
// controller, job or driver changes: they see plaintext, the table holds
// ciphertext. A database dump, a read-only SQL account or a backup copy yields
// blobs.
//
// Deliberate edges:
//   * A value that is not a `v1:` blob is returned as it is. Rows written before
//     this existed keep working until scripts/encrypt-existing-fields.js seals
//     them, so there is no flag day. (No PAN or account number can start with
//     `v1:`, so the two are never confused.)
//   * A value that IS a blob but will not open (wrong or lost MASTER_KEY,
//     tampering) throws. Returning the ciphertext, or null, would let a caller
//     treat it as the supplier's real data, and would let a save write it back.
//   * These columns cannot be filtered or sorted on, because the same plaintext
//     encrypts differently every time. Nothing does today; a `where` that tries
//     is refused loudly rather than silently matching nothing.
//   * Not encrypted: bank name, IFSC, account name, branch, GSTIN. They identify
//     rather than authorise, they appear in search and in SAP, and GSTIN is a
//     unique key and public.
//   * `$queryRaw` bypasses this layer. Raw SQL that selects these columns gets
//     ciphertext; none does today.

const MODELS = {
  vendor: { scalars: ['pan', 'accountNumber'], json: { pendingBankChange: ['accountNumber'] } },
  payment: { scalars: ['deducteePan'], json: {} },
};

const seal = (value) => {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const text = String(value);
  return isEncrypted(text) ? text : encrypt(text);
};

const open = (value) => (isEncrypted(value) ? decrypt(value) : value);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const sealJson = (value, keys) => {
  if (!isPlainObject(value)) return value;
  const out = { ...value };
  for (const key of keys) if (key in out) out[key] = seal(out[key]);
  return out;
};

const openJson = (value, keys) => {
  if (!isPlainObject(value)) return value;
  const out = { ...value };
  for (const key of keys) if (key in out) out[key] = open(out[key]);
  return out;
};

// Rewrites the writable shape of one row: a bare value, or `{ set: value }`.
const sealData = (spec, data) => {
  if (!isPlainObject(data)) return data;
  const out = { ...data };

  for (const field of spec.scalars) {
    if (!(field in out)) continue;
    const given = out[field];
    out[field] = isPlainObject(given) && 'set' in given ? { ...given, set: seal(given.set) } : seal(given);
  }
  for (const [field, keys] of Object.entries(spec.json)) {
    if (!(field in out)) continue;
    const given = out[field];
    out[field] = isPlainObject(given) && 'set' in given ? { ...given, set: sealJson(given.set, keys) } : sealJson(given, keys);
  }
  return out;
};

const sealMany = (spec, data) => (Array.isArray(data) ? data.map((row) => sealData(spec, row)) : sealData(spec, data));

// Refuses a filter on an encrypted column anywhere in a `where`.
const assertNotFiltered = (model, spec, where) => {
  if (!where || typeof where !== 'object') return;
  if (Array.isArray(where)) { where.forEach((part) => assertNotFiltered(model, spec, part)); return; }

  for (const [key, value] of Object.entries(where)) {
    if (spec.scalars.includes(key) && value !== undefined) {
      throw new Error(`Cannot filter ${model} by "${key}": it is stored encrypted, so a comparison would silently match nothing`);
    }
    if (['AND', 'OR', 'NOT'].includes(key)) assertNotFiltered(model, spec, value);
  }
};

const WRITE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn']);

const queryFor = (model, spec) => ({
  async $allOperations({ operation, args, query }) {
    assertNotFiltered(model, spec, args?.where);

    if (WRITE_OPS.has(operation) && args?.data !== undefined) {
      return query({ ...args, data: sealMany(spec, args.data) });
    }
    if (operation === 'upsert') {
      return query({ ...args, create: sealData(spec, args.create), update: sealData(spec, args.update) });
    }
    return query(args);
  },
});

const resultFor = (spec) => {
  const result = {};
  for (const field of spec.scalars) {
    result[field] = { needs: { [field]: true }, compute: (row) => open(row[field]) };
  }
  for (const [field, keys] of Object.entries(spec.json)) {
    result[field] = { needs: { [field]: true }, compute: (row) => openJson(row[field], keys) };
  }
  return result;
};

const fieldEncryptionExtension = {
  name: 'field-encryption',
  query: Object.fromEntries(Object.entries(MODELS).map(([model, spec]) => [model, queryFor(model, spec)])),
  result: Object.fromEntries(Object.entries(MODELS).map(([model, spec]) => [model, resultFor(spec)])),
};

module.exports = { fieldEncryptionExtension, MODELS, seal, sealJson, open };
