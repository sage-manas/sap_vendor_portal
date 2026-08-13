const { assertImplements } = require('../contract');

// The mock SAP system.
//
// Everything in here used to live as `setTimeout` blocks and `Math.random()`
// calls inside five controllers. That arrangement had two costs: the business
// rules of a *simulation* were tangled with the business rules of the product,
// and the two famous delays — ten seconds to a goods receipt, twelve to an
// F110 payment run — were magic numbers nobody could change without editing a
// controller. Both are now this driver's configuration, which means a demo can
// run at 10s, a test at 0ms, and a design partner's pilot somewhere in between,
// with no code change anywhere.
//
// The rule this file obeys: it invents SAP's *answers* — document numbers,
// acceptance quantities, TDS deductions, timing — and nothing else. It does not
// touch the database and does not know what a Mongoose model is. Persisting an
// answer is the caller's job, via the handler passed to a deferred method.

const DEFAULT_TIMINGS = {
  vendorApprovalMs: 5000,
  goodsReceiptMs:   10000,
  paymentRunMs:     12000,
};

const DEFAULT_BEHAVIOUR = {
  // Share of a delivered quantity the mock warehouse accepts; the remainder is
  // rejected with an inspection reason, which is what exercises the 3-way match.
  grnAcceptanceRate: 0.95,
  // Section 194C withholding, applied by the payment run.
  tdsRate: 0.01,
  companyCode: '1000',
  plant: '1000',
  bankName: 'HDFC Bank Ltd',
  paymentMethod: 'NEFT',
};

const digits = (n) => Math.floor(10 ** (n - 1) + Math.random() * 9 * 10 ** (n - 1));

const CATALOGUE = [
  { code: 'MAT-3849', desc: 'Steel Pipe 3" SCH40' },
  { code: 'MAT-9210', desc: 'Flange 3" ANSI 150#' },
  { code: 'MAT-5531', desc: 'Hex Bolt M12x50 Grade 8.8' },
  { code: 'MAT-1029', desc: 'Gasket 3" Non-Asbestos' },
];

/**
 * @param {object} options
 * @param {object} [options.config]  the tenant's SapConnection.config
 * @param {string} [options.clientId]
 */
const createMockDriver = ({ config = {} } = {}) => {
  // Timings default to zero under test: a suite must not wait twelve real
  // seconds to assert that a payment lands, and a timer outliving the test that
  // scheduled it is how a Jest run ends up leaking handles.
  const baseTimings = process.env.NODE_ENV === 'test'
    ? { vendorApprovalMs: 0, goodsReceiptMs: 0, paymentRunMs: 0 }
    : DEFAULT_TIMINGS;

  const timings = { ...baseTimings, ...(config.timings || {}) };
  const behaviour = { ...DEFAULT_BEHAVIOUR, ...(config.behaviour || {}) };

  // The one place a deferred answer is scheduled. `unref` keeps a pending
  // simulation from holding a process open at shutdown — the work is a
  // simulation, and losing it on exit is correct.
  const later = (ms, fn) => {
    const timer = setTimeout(fn, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  };

  const driver = {
    name: 'mock',
    timings,
    behaviour,

    // --- Connectivity -----------------------------------------------------

    testConnection: async () => ({
      data: {
        ok: true,
        message: 'Mock SAP responded to RFC_PING',
        latencyMs: 1,
        detail: { system: 'MOCK', client: behaviour.companyCode, timings },
      },
    }),

    health: async () => ({ data: { status: 'healthy', detail: { simulated: true } } }),

    // --- Vendor master ----------------------------------------------------

    vendorCreate: async ({ vendor }) => ({
      data: {},
      log: {
        vendorId: vendor.vendorId,
        payload: {
          vendorId: vendor.vendorId,
          companyName: vendor.companyName,
          gstin: vendor.gstin,
          pan: vendor.pan,
          email: vendor.email,
        },
        // Outbound and unanswered: `awaitVendorApproval` resolves this entry
        // when the mock system replies.
        status: 'PENDING',
        documentRef: String(vendor._id),
      },
    }),

    vendorVerifyKyc: async ({ vendor, result }) => ({
      data: { gstinValid: result.gstinValid, panValid: result.panValid },
      log: {
        vendorId: vendor.vendorId,
        payload: { gstin: vendor.gstin, pan: vendor.pan, result },
        status: result.gstinValid && result.panValid ? 'SUCCESS' : 'FAILED',
        documentRef: String(vendor._id),
      },
    }),

    vendorConfirm: async ({ vendor }) => {
      const sapVendorCode = vendor.sapVendorCode || `VND-${digits(5)}`;
      return {
        data: { sapVendorCode },
        log: {
          vendorId: vendor.vendorId,
          payload: { sapVendorCode, status: 'Approved' },
          documentRef: String(vendor._id),
        },
      };
    },

    vendorReject: async ({ vendor, reason }) => ({
      data: {},
      log: {
        vendorId: vendor.vendorId,
        payload: { status: 'Rejected', reason },
        documentRef: String(vendor._id),
      },
    }),

    awaitVendorApproval: ({ vendor, pendingLogId }, handler) =>
      later(timings.vendorApprovalMs, () => handler({
        data: { sapVendorCode: `VND-${digits(5)}` },
        // Resolving the outbound PENDING entry is part of the answer, not a
        // separate bookkeeping step the caller has to remember.
        resolve: pendingLogId ? { id: pendingLogId, status: 'SUCCESS' } : null,
        logs: (answer, approved) => [{
          transaction: 'VENDOR_CONFIRM',
          vendorId: vendor.vendorId,
          payload: { sapVendorCode: approved.sapVendorCode, status: 'Approved' },
          documentRef: String(approved._id || vendor._id),
        }],
      })),

    // --- Sourcing ---------------------------------------------------------

    rfqCreate: async ({ rfq, vendorId }) => ({
      data: {},
      log: {
        vendorId: vendorId || 'SYSTEM',
        payload: {
          EKKO: {
            EBELN: rfq.id,
            BSART: rfq.rfqType,
            ANGDT: rfq.deadlineDate,
            EKGRP: rfq.purchasingGroup || '001',
            ZTERM: rfq.paymentTerms,
          },
          EKPO: rfq.items,
        },
        documentRef: rfq.id,
      },
    }),

    rfqCancel: async ({ rfq }) => ({
      data: {},
      log: { vendorId: 'SYSTEM', payload: { rfqId: rfq.id, status: 'Closed' }, documentRef: rfq.id },
    }),

    rfqReissue: async ({ rfq }) => ({
      data: {},
      log: { vendorId: 'SYSTEM', payload: { rfqId: rfq.id, deadlineDate: rfq.deadlineDate }, documentRef: rfq.id },
    }),

    rfqSubmitBid: async ({ rfq, vendorId, bid }) => ({
      data: {},
      log: {
        vendorId,
        payload: {
          EBELN: rfq.id,
          LIFNR: vendorId,
          NETPR: bid.unitPrices,
          MWSKZ: bid.taxCode,
          PLIFZ: bid.deliveryLeadTimeDays,
          BNDDT: bid.validityDate,
        },
        documentRef: rfq.id,
      },
    }),

    infoRecordCreate: async ({ rfq, vendorId, items }) => {
      const infoRecord = `INF-${digits(6)}`;
      return {
        data: { infoRecord },
        log: {
          vendorId,
          payload: { LIFNR: vendorId, INFNR: infoRecord, items },
          documentRef: rfq.id,
        },
      };
    },

    // --- Purchase orders --------------------------------------------------

    poInboundSync: async ({ po, vendorId }) => ({
      data: {},
      log: { vendorId, payload: po, documentRef: po.id },
    }),

    // The inbound PO the /simulate endpoint asks for. The driver invents the
    // SAP-side document — number, buyer, terms, lines — and the controller
    // gives it a per-tenant business id and stores it.
    poProvision: async ({ vendorId }) => {
      const material = CATALOGUE[Math.floor(Math.random() * CATALOGUE.length)];
      const quantity = Math.floor(100 + Math.random() * 900);
      const unitPrice = Math.floor(50 + Math.random() * 450);

      return {
        data: {
          sapPoNumber: `4500${digits(6)}`,
          buyerName: 'SAP Buyer System',
          plant: behaviour.plant,
          paymentTerms: 'NET 30 Days',
          currency: 'INR',
          deliveryAddress: `Plant ${behaviour.plant} Main Warehouse, Mumbai`,
          items: [{
            line: 10,
            materialCode: material.code,
            description: material.desc,
            quantity,
            grnQuantity: 0,
            unitPrice,
            netValue: unitPrice * quantity,
            uom: 'EA',
          }],
        },
        // Logged by the caller once the PO has an id — see poProvisioned below.
        log: null,
      };
    },

    poProvisioned: async ({ po, vendorId }) => ({
      data: {},
      log: { vendorId, payload: po, documentRef: po.id },
    }),

    poAcknowledge: async ({ po }) => ({
      data: {},
      log: {
        vendorId: po.vendorId,
        payload: { poId: po.id, acknowledgedAt: po.acknowledgedAt },
        documentRef: po.id,
      },
    }),

    // --- Delivery and goods receipt ---------------------------------------

    deliveryCreate: async ({ asn, po, vendorId }) => {
      const sapInboundDelivery = `180${digits(7)}`;
      return {
        data: { sapInboundDelivery },
        log: {
          vendorId: vendorId || po?.vendorId,
          payload: {
            LIKP: {
              VBELN: sapInboundDelivery,
              WADAT: asn.shipDate,
              TDLNR: asn.carrierName,
              LIFEX: asn.trackingNumber,
            },
            LIPS: asn.items,
          },
          documentRef: asn.id,
        },
      };
    },

    awaitGoodsReceipt: ({ asn, po, vendorId }, handler) =>
      later(timings.goodsReceiptMs, () => handler({
        data: {
          grnId: `GRN-1800${digits(5)}`,
          sapMigoDoc: `MIGO-18${digits(9)}`,
          postingDate: new Date(),
          receivedBy: 'SAP Warehouse Staff',
          items: asn.items.map((item) => {
            const received = item.shippedQuantity;
            const accepted = Math.round(received * behaviour.grnAcceptanceRate);
            const rejected = received - accepted;
            return {
              line: item.line,
              materialCode: item.materialCode,
              description: item.description,
              receivedQuantity: received,
              acceptedQuantity: accepted,
              rejectedQuantity: rejected,
              rejectionReason: rejected > 0 ? 'Surface inspection defect / Dimensional variance' : undefined,
              uom: item.uom || 'EA',
            };
          }),
        },
        // `grn` is whatever the handler persisted, so the log carries the real
        // stored document rather than the driver's draft of it.
        logs: (answer, grn) => [
          {
            transaction: 'GOODS_RECEIPT',
            vendorId: vendorId || asn.vendorId,
            payload: grn,
            documentRef: grn.id,
          },
          {
            transaction: 'GOODS_RECEIPT_READ',
            vendorId: vendorId || asn.vendorId,
            payload: { migoDoc: grn.sapMigoDoc, items: grn.items },
            documentRef: grn.id,
          },
        ],
      })),

    // --- Invoice and payment ----------------------------------------------

    invoiceCreate: async ({ invoice, vendorId }) => {
      const sapMiroDoc = invoice.sapMiroDoc || `MIRO-51${digits(9)}`;
      return {
        data: { sapMiroDoc },
        log: {
          vendorId,
          payload: {
            HEADER: {
              INVOICE_IND: 'X',
              DOC_TYPE: 'RE',
              DOC_DATE: invoice.invoiceDate,
              PSTNG_DATE: new Date(),
              COMP_CODE: behaviour.companyCode,
              CURRENCY: invoice.currency,
              GROSS_AMOUNT: invoice.totalAmount,
            },
            ITEMS: invoice.items,
          },
          documentRef: invoice.id,
        },
      };
    },

    awaitPaymentRun: ({ invoice, vendor, vendorId }, handler) =>
      later(timings.paymentRunMs, () => {
        const gross = invoice.totalAmount;
        const tdsDeducted = Math.round(gross * behaviour.tdsRate * 100) / 100;

        return handler({
          data: {
            paymentId: `PMT-${digits(6)}`,
            sapPaymentDoc: `PAY-53${digits(8)}`,
            runId: `F110-${Date.now().toString().slice(-6)}`,
            utrCode: `UTR${Date.now()}${digits(3)}`,
            paymentDate: new Date(),
            paymentMethod: behaviour.paymentMethod,
            bankName: behaviour.bankName,
            grossAmount: gross,
            tdsDeducted,
            netAmount: gross - tdsDeducted,
            tdsSection: '194C',
            deducteePan: vendor?.pan || 'PAN-MOCK123',
            deductorTan: `TAN-SAP${behaviour.companyCode}`,
          },
          logs: (answer, payment) => [{
            transaction: 'PAYMENT_RUN',
            vendorId: vendorId || invoice.vendorId,
            payload: payment,
            documentRef: payment.id,
          }],
        });
      }),
  };

  return assertImplements(driver, 'mock');
};

// The mock accepts any config: there is nothing to get wrong about connecting
// to a system that does not exist. Timings must still be sane, though, because
// a negative delay is a typo that would otherwise fire instantly and confuse
// whoever set it.
const validateConfig = (config = {}) => {
  const errors = {};
  for (const [key, value] of Object.entries(config.timings || {})) {
    if (!(key in DEFAULT_TIMINGS)) errors[`timings.${key}`] = `Unknown timing "${key}"`;
    else if (!Number.isFinite(value) || value < 0) errors[`timings.${key}`] = 'Must be a non-negative number of milliseconds';
  }
  return errors;
};

module.exports = {
  createMockDriver,
  validateConfig,
  DEFAULT_TIMINGS,
  DEFAULT_BEHAVIOUR,
  // No credentials: the mock has nothing to authenticate against.
  secretFields: [],
  configFields: [
    { name: 'timings.vendorApprovalMs', label: 'Vendor approval delay (ms)', type: 'number', default: DEFAULT_TIMINGS.vendorApprovalMs },
    { name: 'timings.goodsReceiptMs', label: 'Goods receipt delay (ms)', type: 'number', default: DEFAULT_TIMINGS.goodsReceiptMs },
    { name: 'timings.paymentRunMs', label: 'Payment run delay (ms)', type: 'number', default: DEFAULT_TIMINGS.paymentRunMs },
  ],
};
