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
// touch the database. Persisting an answer is the caller's job, via the
// handler passed to a deferred method.
//
// awaitGoodsReceipt/awaitPaymentRun no longer own a timer (Phase 1 of
// docs/04-sap-runtime-engineering-plan.md moved that to jobs/worker.js): each
// is now a one-shot probe, called once per job attempt, that answers once
// `timings.*Ms` of wall-clock time has passed since the job was created —
// same delay semantics as before, just measured against a durable timestamp
// instead of owning a setTimeout.

const DEFAULT_TIMINGS = {
  goodsReceiptMs: 10000,
  paymentRunMs:   12000,
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
// A stable stand-in for the purchase order number SAP would have issued.
// Awarding an RFQ creates a local order with `sapPoNumber: null` — the portal
// does not create purchase orders in SAP — so the simulator supplies the number
// its real counterpart would, derived from the order id rather than random so
// repeated reads agree with each other.
const mockSapPoNumber = (po) => {
  if (po.sapPoNumber) return po.sapPoNumber;
  const serial = String(po.id || '').replace(/\D/g, '').padStart(8, '0').slice(-8);
  return `45${serial}`;
};

// The FPLA plan number SAP would have assigned to an item's invoicing plan.
// Derived from the order and item rather than random, for the same reason as
// mockSapPoNumber: two reads of the same plan must agree.
const mockPlanNumber = (po, item) =>
  `${String(po?.id || '').replace(/\D/g, '').padStart(6, '0').slice(-6)}${String(item?.line ?? 0).padStart(4, '0')}`;

// The plan dates cross the driver boundary as ISO "YYYY-MM-DD" strings, never
// as Date objects, so a caller cannot tell which driver answered.
const isoDay = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);

// A stable stand-in for the MIRO document an AP clerk would have posted.
// Derived from the invoice id rather than random, so every poll of
// vendorMiroDisplay reports the same number for the same invoice.
const mockMiroDoc = (invoice) => {
  const serial = String(invoice.id || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
  return `51${serial}${String(new Date(invoice.invoiceDate || Date.now()).getFullYear()).slice(-2)}`;
};

const createMockDriver = ({ config = {} } = {}) => {
  // Timings default to zero under test: a suite must not wait twelve real
  // seconds to assert that a payment lands, and a timer outliving the test that
  // scheduled it is how a Jest run ends up leaking handles.
  const baseTimings = process.env.NODE_ENV === 'test'
    ? { goodsReceiptMs: 0, paymentRunMs: 0 }
    : DEFAULT_TIMINGS;

  const timings = { ...baseTimings, ...(config.timings || {}) };
  const behaviour = { ...DEFAULT_BEHAVIOUR, ...(config.behaviour || {}) };

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

    // Mirrors the real VENDOR_CR driver's { TYPE, MESSAGE, VENDOR } response
    // shape (see sap/drivers/s4odata.driver.js and sap/mappings/vendor-create.map.js)
    // without actually calling anything — `settings` (the tenant's
    // sapVendorCreate config group) is accepted for signature parity but
    // ignored, since the mock invents its own vendor code either way. Called
    // from approveVendor, so the code is minted and returned on the spot —
    // there is nothing left to wait on.
    vendorCreate: async ({ vendor, settings = {} }) => ({
      data: { sapVendorCode: vendor.sapVendorCode || `VND-${digits(5)}` },
      log: {
        vendorId: vendor.vendorId,
        payload: {
          vendorId: vendor.vendorId,
          companyName: vendor.companyName,
          gstin: vendor.gstin,
          pan: vendor.pan,
          email: vendor.email,
          accountGroup: settings.accountGroup,
        },
        status: 'SUCCESS',
        documentRef: String(vendor._id),
      },
    }),

    // Real region/payment-terms codes pulled from a confirmed live sandbox
    // (Z REST catalogues), not invented — so a demo built against the mock
    // exercises the same dropdown shape the real driver's registration form
    // uses, and doesn't quietly let free-text region/payment-terms values
    // back in.
    vendorRegionCatalogue: async () => ({
      data: {
        regions: [
          { code: '01', label: 'Andra Pradesh' }, { code: '02', label: 'Arunachal Pradesh' },
          { code: '03', label: 'Assam' }, { code: '04', label: 'Bihar' },
          { code: '05', label: 'Goa' }, { code: '06', label: 'Gujarat' },
          { code: '07', label: 'Haryana' }, { code: '08', label: 'Himachal Pradesh' },
          { code: '09', label: 'Jammu und Kashmir' }, { code: '10', label: 'Karnataka' },
          { code: '11', label: 'Kerala' }, { code: '12', label: 'Madhya Pradesh' },
          { code: '13', label: 'Maharashtra' }, { code: '14', label: 'Manipur' },
          { code: '15', label: 'Megalaya' }, { code: '16', label: 'Mizoram' },
          { code: '17', label: 'Nagaland' }, { code: '18', label: 'Orissa' },
          { code: '19', label: 'Punjab' }, { code: '20', label: 'Rajasthan' },
          { code: '21', label: 'Sikkim' }, { code: '22', label: 'Tamil Nadu' },
          { code: '23', label: 'Tripura' }, { code: '24', label: 'Uttar Pradesh' },
          { code: '25', label: 'West Bengal' }, { code: '26', label: 'Andaman und Nico.In.' },
          { code: '27', label: 'Chandigarh' }, { code: '28', label: 'Dadra und Nagar Hav.' },
          { code: '29', label: 'Daman und Diu' }, { code: '30', label: 'Delhi' },
          { code: '31', label: 'Lakshadweep' }, { code: '32', label: 'Pondicherry' },
        ],
      },
    }),

    vendorPaymentTermsCatalogue: async () => ({
      data: {
        paymentTerms: [
          '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009',
          '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017',
          '1-01', '1-02', '2-10', 'JP01', 'JP02', 'JP03', 'JP04', 'JP05', 'JP10',
          'MF01', 'NT30', 'NT60', 'R001', 'SR00', 'T00D', 'T20D', 'T20E', 'T301', 'T40D',
          'ZB00', 'ZB01', 'ZB02', 'ZB03', 'ZB04', 'ZB05', 'ZB06', 'ZB07', 'ZB08',
          'ZB09', 'ZB10', 'ZB11', 'ZB13', 'ZB14', 'ZB15', 'ZB50', 'ZB99',
          'ZR01', 'ZR02', 'ZR03',
        ],
      },
    }),

    vendorPaymentMethodCatalogue: async () => ({
      data: {
        paymentMethods: [
          { code: '1', label: 'paymet by check' },
          { code: '5', label: 'paymet by check HPL1' },
          { code: 'C', label: 'Cheque' },
          { code: 'H', label: 'Payment method for HP00' },
          { code: 'K', label: 'cheque for kanvi' },
          { code: 'R', label: 'Cheque' },
          { code: 'S', label: 'check payment spl1' },
          { code: 'T', label: 'Bank Transfer' },
          { code: 'U', label: 'Cheque' },
        ],
      },
    }),

    // Mirrors the shape the real driver's zpo_grn_vendor/Detail endpoint
    // returns. The mock has no database access — the caller passes back the
    // POs it already tracks for this vendor, and this just re-describes them
    // (and their GRN-derived receipt quantities) the way the real endpoint would.
    vendorPoGrnDisplay: async ({ pos = [] }) => ({
      data: {
        orders: pos.map((po) => ({
          poNumber: mockSapPoNumber(po),
          // Which of the caller's own PurchaseOrder rows this is — the mock can
          // say so honestly because it built this row from that same `po`. The
          // real driver queries SAP directly by vendor code (see its own
          // vendorPoGrnDisplay) and has no such correlation, so it always
          // answers `poId: null` here; a caller that wants to persist the SAP
          // number it just discovered back onto its own record checks this
          // rather than assuming array order lines up between the two sides.
          poId: po.id,
          // ISO date string, matching the real driver's normalized shape
          // (see sapDotDateToIso in s4odata.driver.js) — callers that sort or
          // compare poDate as a string must not care which driver answered.
          poDate: po.createdDate ? new Date(po.createdDate).toISOString().slice(0, 10) : null,
          buyerName: po.buyerName,
          shipToCity: null,
          shipToState: null,
          companyCode: behaviour.companyCode,
          currency: po.currency,
          netAmount: po.items.reduce((sum, item) => sum + item.netValue, 0),
          grossAmount: po.items.reduce((sum, item) => sum + item.netValue, 0),
          items: po.items.map((item) => ({
            itemNumber: String(item.line).padStart(5, '0'),
            materialCode: item.materialCode,
            description: item.description,
            orderedQuantity: item.quantity,
            receivedQuantity: item.grnQuantity,
            invoicedQuantity: item.grnQuantity,
            uom: item.uom,
            unitPrice: item.unitPrice,
            netAmount: item.netValue,
            grossAmount: item.netValue,
            grStatus: item.grnQuantity >= item.quantity ? 'Closed' : null,
            plant: po.plant,
            grns: [],
            // The simulator has no service-procurement POs, so this is always
            // empty — it exists so both drivers return the same item shape.
            serviceEntries: [],
          })),
        })),
      },
    }),

    // --- Invoicing plans (FPLA/FPLT) ------------------------------------
    //
    // The simulator has no invoicing-plan store of its own, and inventing one
    // would be inventing SAP's *records* rather than its *answers* — the line
    // this driver does not cross. So it reads back the plans the portal has
    // already configured on the order, in the same normalized shape the real
    // driver produces, and mints the FPLA plan number SAP would have assigned.
    poInvoicePlanDisplay: async ({ po }) => ({
      data: {
        poNumber: mockSapPoNumber(po || {}),
        plans: (po?.items || [])
          .filter((item) => item.invoicePlan?.enabled)
          .map((item) => {
            const plan = item.invoicePlan;
            return {
              line: item.line,
              planNumber: plan.planNumber || mockPlanNumber(po, item),
              type: plan.type,
              frequency: plan.frequency || null,
              invoicingRule: plan.invoicingRule || null,
              periodicAmount: plan.periodicAmount ?? null,
              currency: plan.currency || po.currency || 'INR',
              startDate: isoDay(plan.startDate),
              endDate: isoDay(plan.endDate),
              reference: plan.reference || null,
              lines: (plan.lines || []).map((line) => ({
                lineNumber: line.lineNumber,
                description: line.description || null,
                settlementDate: isoDay(line.settlementDate),
                billingDate: isoDay(line.billingDate || line.settlementDate),
                percentage: line.percentage || 0,
                amount: line.amount,
                // SAP reports the billing status (FKSAF) and the billing block
                // (FAKSP) separately; the portal's own record of which invoice
                // covered a date is not something SAP would echo back.
                status: line.status,
                blocked: Boolean(line.blocked),
              })),
            };
          }),
      },
    }),

    poInvoicePlanUpdate: async ({ po, item, plan }) => {
      const planNumber = plan.planNumber || mockPlanNumber(po, item);
      return {
        data: { planNumber, line: item.line, dates: (plan.lines || []).length },
        log: {
          vendorId: po.vendorId,
          payload: {
            poNumber: mockSapPoNumber(po),
            item: String(item.line).padStart(5, '0'),
            planNumber,
            planType: plan.type,
            frequency: plan.frequency || null,
            invoicingRule: plan.invoicingRule || null,
            dates: (plan.lines || []).length,
          },
          documentRef: `${po.id}/${item.line}`,
        },
      };
    },

    // Mirrors the shape the real driver's ZME43/ME43 endpoint returns. The
    // mock has no database access, so the caller passes back the RFQs this
    // vendor was invited to; each becomes a synthetic SAP RFQ document.
    vendorRfqDisplay: async ({ rfqs = [] }) => ({
      data: {
        // Dates are the SAP YYYYMMDD string the real endpoint sends, not a Date
        // — same convention as vendorQuotationDisplay below, so a caller that
        // sorts or formats this field cannot care which driver answered.
        documents: rfqs.map((rfq) => ({
          sapRfqNumber: `6${digits(9)}`,
          date: rfq.createdDate
            ? new Date(rfq.createdDate).toISOString().slice(0, 10).replace(/-/g, '')
            : null,
          currency: rfq.currency || 'INR',
          purchasingOrg: rfq.purchasingOrg || '1000',
        })),
      },
    }),

    // Mirrors the shape the real driver's ZCL_ME48/vendor endpoint returns.
    // That endpoint is named for ME48 Display Quotation but actually hands
    // back every purchasing document on the vendor code — quotations and POs
    // together (see the note on vendorQuotationDisplay in s4odata.driver.js) —
    // so the mock does the same, from the RFQs and POs the caller passes back.
    // Dates are the SAP YYYYMMDD string the real endpoint sends, not ISO.
    vendorQuotationDisplay: async ({ rfqs = [], pos = [] }) => {
      const sapDate = (value) => (value ? new Date(value).toISOString().slice(0, 10).replace(/-/g, '') : null);

      return {
        data: {
          documents: [
            ...rfqs.map((rfq) => ({
              documentNumber: `6${digits(9)}`,
              documentType: 'Quotation',
              date: sapDate(rfq.createdDate),
              currency: rfq.currency || 'INR',
              purchasingOrg: rfq.purchasingOrg || '1000',
            })),
            ...pos.map((po) => ({
              documentNumber: mockSapPoNumber(po),
              documentType: 'Purchase Order',
              date: sapDate(po.createdDate),
              currency: po.currency || 'INR',
              purchasingOrg: po.purchasingOrg || '1000',
            })),
          ],
        },
      };
    },

    // Mirrors the shape the real driver's zpayment_api/payment endpoint
    // returns. As above, the mock has no database access — the caller passes
    // back the Payment record it already has for this invoice (if any), and
    // this just re-describes it the way the real endpoint would.
    invoicePaymentDetail: async ({ payment }) => {
      if (!payment) return { data: { found: false } };
      return {
        data: {
          found: true,
          status: 'CLEARED',
          grossAmount: payment.grossAmount,
          tdsDeducted: payment.tdsDeducted,
          netDisbursed: payment.netAmount,
          clearingDocument: payment.sapPaymentDoc || null,
          clearingDate: payment.paymentDate,
          postingDate: payment.paymentDate,
          paymentMethod: payment.paymentMethod || null,
          utrReference: payment.utrCode || null,
        },
      };
    },

    // The vendor's whole payment ledger. The real driver assembles this from
    // SAP's MIRO display plus a clearing read per document; the mock has no
    // database (see file header), so the caller hands back the Payment rows it
    // already holds for the vendor and this re-describes them in the same
    // shape. Every mock payment is by definition cleared — awaitPaymentRun
    // only ever produces settled ones.
    vendorPaymentDisplay: async ({ payments = [] }) => ({
      data: {
        payments: payments.map((payment) => ({
          miroDoc: payment.sapMiroDoc || null,
          fiscalYear: payment.fiscalYear ? String(payment.fiscalYear) : String(new Date(payment.paymentDate).getFullYear()),
          poNumber: payment.poId,
          companyCode: behaviour.companyCode,
          currency: 'INR',
          status: 'CLEARED',
          grossAmount: payment.grossAmount,
          tdsDeducted: payment.tdsDeducted,
          netDisbursed: payment.netAmount,
          clearingDocument: payment.sapPaymentDoc || null,
          clearingDate: payment.paymentDate,
          postingDate: payment.paymentDate,
          paymentMethod: payment.paymentMethod || behaviour.paymentMethod,
          utrReference: payment.utrCode || null,
        })),
      },
    }),

    // Mirrors the shape the real driver's zmiro_display/MIRO endpoint
    // returns. The mock never touches the database (see file header), so it
    // cannot look invoices up itself — the caller passes back the same
    // invoices it already tracks, and this just re-describes them the way
    // SAP's own MIRO display would.
    //
    // The simulator stands in for an AP clerk who has already posted the
    // invoice: it *mints* the MIRO number here rather than echoing one the
    // portal wrote, because nothing in the portal writes one any more. The
    // number is derived from the invoice id so it is stable across polls —
    // discovery matches on it repeatedly, and a fresh random number each call
    // would never converge.
    vendorMiroDisplay: async ({ vendor, invoices = [] }) => ({
      data: {
        documents: invoices.map((invoice) => ({
          miroDoc: invoice.sapMiroDoc || mockMiroDoc(invoice),
          fiscalYear: String(new Date(invoice.invoiceDate).getFullYear()),
          docType: 'RD',
          docDate: invoice.invoiceDate,
          postingDate: invoice.invoiceDate,
          poNumber: invoice.poId,
          companyCode: behaviour.companyCode,
          currency: invoice.currency,
          grossAmount: invoice.totalAmount,
          taxableAmount: invoice.taxAmount,
          taxCode: invoice.taxCode,
          paymentTerm: '',
          items: (invoice.items || []).map((item) => ({
            poNumber: invoice.poId,
            poItem: String(item.line).padStart(5, '0'),
            materialCode: item.materialCode,
            amount: item.amount,
            quantity: item.quantity,
            uom: 'EA',
            totalValue: item.amount,
          })),
        })),
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

    vendorReject: async ({ vendor, reason }) => ({
      data: {},
      log: {
        vendorId: vendor.vendorId,
        payload: { status: 'Rejected', reason },
        documentRef: String(vendor._id),
      },
    }),

    // --- Sourcing ---------------------------------------------------------

    poAcknowledge: async ({ po }) => ({
      data: {},
      log: {
        vendorId: po.vendorId,
        payload: { poId: po.id, acknowledgedAt: po.acknowledgedAt },
        documentRef: po.id,
      },
    }),

    // Mirrors the real driver's ZQUOT_NETPR/QUOT_UPDPR: always accepts the
    // price update and echoes the document number back, the way SAP's `{
    // STATUS: 'S', MESSAGE, RFQ_NUMBER }` response does.
    quotationUpdatePrice: async ({ vendor, sapRfqNumber, items = [] }) => ({
      data: { status: 'S', message: 'Quotation updated successfully', sapRfqNumber },
      log: {
        vendorId: vendor?.vendorId,
        payload: { rfq_number: sapRfqNumber, items },
        status: 'SUCCESS',
        documentRef: sapRfqNumber,
      },
    }),

    // --- Delivery and goods receipt ---------------------------------------

    // One-shot probe, called once per job attempt (jobs/worker.js) rather
    // than owning its own timer — see docs/04-sap-runtime-engineering-plan.md
    // Phase 1.6. `startedAt` is the job's createdAt, threaded through by
    // jobs/handlers/awaitGoodsReceipt.js; timings.goodsReceiptMs keeps its
    // old meaning (a wall-clock delay), just measured against that instead of
    // a driver-owned setTimeout. A caller with no `startedAt` (a direct driver
    // call, e.g. in a test) gets an immediate answer rather than one that can
    // never arrive — the honest failure mode for a simulator is "too eager",
    // not "hangs forever".
    awaitGoodsReceipt: async ({ asn, po, vendorId, startedAt }, handler) => {
      const startedAtMs = startedAt ? new Date(startedAt).getTime() : 0;
      if (Date.now() - startedAtMs < timings.goodsReceiptMs) return false;

      await handler({
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
      });
      return true;
    },

    // --- Invoice and payment ----------------------------------------------

    // Same one-shot shape as awaitGoodsReceipt above.
    awaitPaymentRun: async ({ invoice, vendor, vendorId, startedAt }, handler) => {
      const startedAtMs = startedAt ? new Date(startedAt).getTime() : 0;
      if (Date.now() - startedAtMs < timings.paymentRunMs) return false;

      const gross = invoice.totalAmount;
      const tdsDeducted = Math.round(gross * behaviour.tdsRate * 100) / 100;

      await handler({
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
      return true;
    },
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
