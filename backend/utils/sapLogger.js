const { prisma } = require('../db/prisma');
const logger = require('./logger');
const { transaction } = require('../config/sapTransactions');

// Writes to the SAP communication log.
//
// Since Phase 4 the only caller is the adapter wrapper in `sap/index.js`: a
// controller no longer decides what a call was named or which direction it
// went, because the driver that made the call already knows. The transaction's
// code, type and direction come from `config/sapTransactions.js`, so a log row
// can never disagree with the call it describes.

/**
 * @param {object} entry
 * @param {string} entry.transaction  a key from config/sapTransactions.js
 * @param {string} entry.vendorId
 * @param {*}      entry.payload      serialised as JSON for the viewer
 * @param {'SUCCESS'|'PENDING'|'FAILED'} [entry.status]
 * @param {string} [entry.documentRef]
 * @param {string} [entry.errorMessage]
 */
const recordSapCall = async ({ transaction: key, vendorId, payload, status = 'SUCCESS', documentRef = '', errorMessage }) => {
  const { code, type, direction } = transaction(key);

  try {
    return await prisma.sapLog.create({
      data: {
        vendorId,
        type,
        direction,
        name: code,
        payload: typeof payload === 'object' ? JSON.stringify(payload, null, 2) : payload,
        status,
        errorMessage,
        documentRef,
      },
    });
  } catch (error) {
    // Losing the log must not lose the operation it described — the same
    // bargain utils/audit.js makes — but it must be loud.
    logger.error(`[sap] failed to write SapLog for ${code}: ${error.message}`);
    return null;
  }
};

/**
 * Closes out an entry left PENDING by an outbound call — the vendor-create
 * BAPI, today — once the system answers.
 */
const resolveSapCall = async (id, status, errorMessage) => {
  if (!id) return null;
  try {
    return await prisma.sapLog.update({
      where: { pk: id },
      data: { status, ...(errorMessage && { errorMessage }) },
    });
  } catch (error) {
    logger.error(`[sap] failed to resolve SapLog ${id}: ${error.message}`);
    return null;
  }
};

module.exports = { recordSapCall, resolveSapCall };
