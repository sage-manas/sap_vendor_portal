const { notImplementedDriver, assertImplements } = require('../contract');
const logger = require('../../utils/logger');
const { buildVendorCreatePayload } = require('../mappings/vendor-create.map');
const { matchInvoiceDocument } = require('../mappings/invoice-match');
const { runWithTenant } = require('../../utils/tenantContext');

// S/4HANA via the OData APIs (API_BUSINESS_PARTNER, API_PURCHASEORDER_PROCESS_SRV,
// API_INBOUND_DELIVERY_SRV, API_MATERIAL_DOCUMENT_SRV, API_SUPPLIERINVOICE_PROCESS_SRV, …).
//
// Filled in against the SAP API Business Hub's published contracts for these
// services. It has NOT been run against a live sandbox — there wasn't one
// available while writing it — so treat the OData paths, entity/field names and
// the account-group / tax-number-type / number-range values below as a strong
// starting point, not gospel. Two things are near-certain to need adjustment
// once a real system is available, and both are called out inline:
//
//   1. Fields that are genuinely client-specific (supplier account group,
//      India tax number categories, company code, plant) are config, not
//      constants — set them from what MM confirms about the target system.
//   2. Sourcing is not here at all. An RFQ issued to an external vendor, and
//      that vendor bidding electronically, is a supplier-*portal* flow core S/4
//      does not expose — normally SAP Ariba/Business Network territory. Those
//      methods used to call a custom Z-OData `sourcing` service that was never
//      built, so they threw on every real tenant. RFQs, bids and awards now
//      live in the application; what SAP holds is read back through
//      vendorRfqDisplay and vendorQuotationDisplay.
//
// Everything below the config/HTTP plumbing produces the same `{ data, log }` /
// `{ data, resolve, logs }` shapes the mock driver does (see mock.driver.js) —
// that contract is what controllers and the SapLog viewer depend on, and it
// doesn't change with the transport.
//
// EXCEPTION — vendorCreate (Phase 7): as of the real VENDOR_CR contract, this
// is a single flat JSON POST to a custom Z REST endpoint
// (zvendor_create/VENDOR_CR), NOT an OData call. It does not go through
// createODataClient's CSRF/session dance below: the live endpoint accepts a
// plain POST with no CSRF token and no credentials, and `sap-client` travels
// as a URL query parameter rather than only a header. The outbound body's
// shape and every field name in it are CONFIRMED against the real contract —
// see sap/mappings/vendor-create.map.js, which also records what an earlier
// reconstruction of this contract got wrong.
//
// --- HTTP / OData plumbing -------------------------------------------------

const authHeader = (secrets) => {
  if (!secrets.username || !secrets.password) return undefined;
  return `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString('base64')}`;
};

const baseHeaders = (config, secrets) => {
  const headers = { Accept: 'application/json' };
  const auth = authHeader(secrets);
  if (auth) headers.Authorization = auth;
  if (config.sapClient) headers['sap-client'] = String(config.sapClient);
  return headers;
};

const abortableFetch = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// zmiro_display/MIRO is a GET that reads its filter (the vendor code) off a
// JSON request body — confirmed against the live sandbox: a GET with no body
// and a GET with the vendor as a query param both come back empty, only a GET
// carrying the JSON body returns rows. The Fetch API (both browser and
// Node's built-in) refuses to send a body on a GET/HEAD request at all
// ("Request with GET/HEAD method cannot have body"), so this one call has to
// go around fetch and use Node's http/https module directly, which has no
// such restriction.
const getWithBody = (url, { headers = {}, body, timeoutMs = 10000 } = {}) =>
  new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? require('https') : require('http');
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = transport.request(url, {
      method: 'GET',
      headers: {
        ...headers,
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { clearTimeout(deadline); resolve({ status: res.statusCode, statusText: res.statusMessage, text: data }); });
    });

    // Node's `timeout` option above is a socket *inactivity* timeout, not a
    // deadline for the whole call. zpo_grn_vendor/Detail streams half a
    // megabyte slowly — 84s observed against the live sandbox — without ever
    // pausing long enough to trip it, so on its own that option leaves this
    // request effectively unbounded. This is the actual ceiling.
    const deadline = setTimeout(() => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', (err) => { clearTimeout(deadline); reject(err); });
    if (payload !== undefined) req.write(payload);
    req.end();
  });

// The Z REST endpoints return dates as bare YYYYMMDD numbers/strings
// (GR_DATE, CLEARING_DATE, ...), not ISO strings.
const parseSapYyyymmdd = (value) => {
  const s = String(value ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
};

const setCookiesOf = (response) => {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
};

/**
 * A tiny OData V2 client: CSRF-token priming for writes, session-cookie reuse,
 * one retry on a stale token. This is standard boilerplate any OData client
 * (including SAP's own) has to do — there is nothing product-specific here.
 */
const createODataClient = ({ config }) => {
  let session = { token: null, cookie: null, fetchedAt: 0 };
  const sessionTtlMs = Number(config.sessionTtlMs) || 5 * 60 * 1000;

  const ensureSession = async (serviceUrl, secrets) => {
    if (session.token && Date.now() - session.fetchedAt < sessionTtlMs) return session;

    const headers = { ...baseHeaders(config, secrets), 'X-CSRF-Token': 'Fetch' };
    const response = await abortableFetch(serviceUrl + '/', { headers }, Number(config.timeoutMs) || 10000);
    const token = response.headers.get('x-csrf-token');
    if (!token) {
      throw new Error(`SAP gateway at ${serviceUrl} did not return an X-CSRF-Token on priming GET (status ${response.status}) — check the service is active in /IWFND/MAINT_SERVICE and reachable with these credentials`);
    }
    const cookie = setCookiesOf(response).map((c) => c.split(';')[0]).join('; ');
    session = { token, cookie, fetchedAt: Date.now() };
    return session;
  };

  /**
   * @param {string} service   OData service root, e.g. config.services.businessPartner
   * @param {string} path      entity path, e.g. "/A_BusinessPartner" or "/A_Supplier('123')"
   */
  const call = async ({ service, path, method = 'GET', body, query, secrets, retried = false }) => {
    const base = String(config.baseUrl || '').replace(/\/$/, '');
    const serviceUrl = `${base}${service}`;
    const url = `${serviceUrl}${path}${query ? `?${query}` : ''}`;
    const headers = { ...baseHeaders(config, secrets), 'Content-Type': 'application/json' };

    if (method !== 'GET') {
      const { token, cookie } = await ensureSession(serviceUrl, secrets);
      headers['X-CSRF-Token'] = token;
      if (cookie) headers.Cookie = cookie;
    }

    const response = await abortableFetch(
      url,
      { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined },
      Number(config.timeoutMs) || 10000,
    );

    // A CSRF token can expire between the priming GET and the write. One
    // retry with a forced re-fetch is normal OData client behaviour.
    if (!retried && method !== 'GET' && response.status === 403) {
      session = { token: null, cookie: null, fetchedAt: 0 };
      return call({ service, path, method, body, query, secrets, retried: true });
    }

    const text = await response.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (!response.ok) {
      const message = json?.error?.message?.value || json?.error?.message || json?.raw || `${response.status} ${response.statusText}`;
      const error = new Error(`SAP OData ${method} ${service}${path} failed: ${message}`);
      error.status = response.status;
      throw error;
    }

    return json.d !== undefined ? json.d : json;
  };

  return { call };
};

/** Runs `check()` on an interval until it returns a truthy result, then calls `onFound`. */
const poll = ({ intervalMs, timeoutMs, check, onFound, onTimeout, label }) => {
  const start = Date.now();
  const tick = async () => {
    try {
      const result = await check();
      if (result) return onFound(result);
    } catch (error) {
      logger.warn(`[sap:s4_odata] poll for ${label} errored, will retry: ${error.message}`);
    }
    if (Date.now() - start > timeoutMs) return onTimeout();
    schedule();
  };
  const schedule = () => {
    const timer = setTimeout(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();
};

// --- Service catalogue -------------------------------------------------

const services = (config) => ({
  businessPartner: config.services?.businessPartner || '/sap/opu/odata/sap/API_BUSINESS_PARTNER',
  purchaseOrder: config.services?.purchaseOrder || '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV',
  inboundDelivery: config.services?.inboundDelivery || '/sap/opu/odata/sap/API_INBOUND_DELIVERY_SRV',
  materialDocument: config.services?.materialDocument || '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV',
  supplierInvoice: config.services?.supplierInvoice || '/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV',
});

// The field SAP-side records carry to identify "which of our vendors is this"
// — since the driver has no database access, it cannot look up a Business
// Partner number from our internal vendorId any other way. Confirm with
// ABAP which field is free to reuse (or get a Z-field added) before pointing
// this at a real system; GSTIN is used as the fallback correlation key
// because it is already unique per vendor in this app.
const externalIdTaxType = (config) => config.taxNumberTypes?.correlation || null;

// The PO/GRN endpoint dates two ways in the same payload: PO_DATE as
// "23.09.2025" and GR_DATE as "20250923". Both become ISO here so callers get
// one format; either can arrive empty, which stays null rather than becoming
// an Invalid Date downstream.
const sapDotDateToIso = (value) => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || '').trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

// A row in the GRN array is a real goods receipt only if it carries a GR
// number; the service-entry-sheet rows that share the array leave it blank.
// The two are mutually exclusive in the sandbox — 406 receipts, 4 entry
// sheets, no row with both.
const isGoodsReceipt = (gr) => Boolean(String(gr.GR_NUMBER || '').trim());

const sapDayToIso = (value) => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value || '').trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

// The other direction, for the one write that sends dates: the portal stores
// invoicing plan dates as Dates/ISO strings, SAP wants bare YYYYMMDD.
const isoToSapDay = (value) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10).replace(/-/g, '');
};

const createS4ODataDriver = ({ config = {}, secrets = {} } = {}) => {
  const odata = createODataClient({ config });
  const svc = services(config);
  const companyCode = config.companyCode || '1000';
  const plant = config.plant || '1000';
  const pollIntervalMs = Number(config.pollIntervalMs) || 30000;
  const goodsReceiptTimeoutMs = Number(config.goodsReceiptTimeoutMs) || 24 * 60 * 60 * 1000;
  const paymentRunTimeoutMs = Number(config.paymentRunTimeoutMs) || 30 * 24 * 60 * 60 * 1000;
  const catalogueTtlMs = Number(config.catalogueTtlMs) || 60 * 60 * 1000; // master data, not per-request state

  // There is deliberately no simulation fallback in this driver. It used to
  // fall back to the mock when the OData gateway had no credentials, which
  // meant a misconfigured tenant received an invented MIRO number and, twelve
  // seconds later, an entirely fabricated payment — a made-up UTR reference and
  // TDS figure that a supplier could reconcile their own books against. A
  // tenant that has declared a real SAP now waits for real answers, and the
  // simulator is reachable only by selecting the `mock` driver outright.

  // GET a JSON array from a custom Z REST catalogue endpoint (same shape as
  // VENDOR_CR's own path config: sap-client as a query param, no OData
  // session/CSRF dance — these are plain reads). `cache` is one of the
  // per-driver-instance holders declared just below.
  const fetchCatalogue = async (path, cache) => {
    if (cache.rows && Date.now() - cache.fetchedAt < catalogueTtlMs) return cache.rows;

    const base = String(config.baseUrl || '').replace(/\/$/, '');
    const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;
    const response = await abortableFetch(url, { headers: baseHeaders(config, secrets) }, Number(config.timeoutMs) || 10000);
    const text = await response.text();
    let rows;
    try { rows = text ? JSON.parse(text) : []; } catch { rows = null; }

    if (!response.ok || !Array.isArray(rows)) {
      const error = new Error(`SAP catalogue GET ${path} failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    cache.rows = rows;
    cache.fetchedAt = Date.now();
    return rows;
  };
  const regionCache = { rows: null, fetchedAt: 0 };
  const paymentTermsCache = { rows: null, fetchedAt: 0 };
  const paymentMethodCache = { rows: null, fetchedAt: 0 };

  const driver = {
    ...notImplementedDriver('s4_odata'),
    name: 's4_odata',

    // --- Connectivity -----------------------------------------------------

    testConnection: async () => {
      const started = Date.now();
      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const url = `${base}${config.pingPath || '/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata'}`;

      const headers = { Accept: 'application/xml' };
      if (secrets.username && secrets.password) headers.Authorization = authHeader(secrets);
      if (config.sapClient) headers['sap-client'] = String(config.sapClient);

      try {
        const response = await abortableFetch(url, { headers }, Number(config.timeoutMs) || 10000);
        return {
          data: {
            ok: response.ok,
            message: response.ok
              ? `Gateway answered ${response.status}`
              : `Gateway answered ${response.status} ${response.statusText} — the host is reachable but the request was refused`,
            latencyMs: Date.now() - started,
            detail: { status: response.status, url },
          },
        };
      } catch (error) {
        return {
          data: {
            ok: false,
            message: error.name === 'AbortError' ? 'Timed out waiting for the gateway' : `Could not reach the gateway: ${error.message}`,
            latencyMs: Date.now() - started,
            detail: { url },
          },
        };
      }
    },

    health: async () => {
      const result = await driver.testConnection();
      return { data: { status: result.data.ok ? 'healthy' : 'unreachable', detail: result.data } };
    },

    // --- Vendor master ------------------------------------------------

    // XK01/BP create. Called from approveVendor once the client admin has
    // approved the vendor in the portal — approval is a portal-only decision,
    // never SAP-driven, so this is the only place the vendor master gets
    // created in SAP.
    // VENDOR_CR (Phase 7) — a single flat POST to a custom Z REST endpoint,
    // not OData. `settings` is the tenant's sapVendorCreate config group
    // (config/tenantSettings.js) — system-controlled fields an admin sets
    // once, never asked of the supplier. The payload's shape and field names
    // are confirmed against the live contract; see vendor-create.map.js.
    vendorCreate: async ({ vendor, settings = {} }) => {
      const payload = buildVendorCreatePayload(vendor, settings);
      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.vendorCrPath || '/zvendor_create/VENDOR_CR';
      // Confirmed against a live instance of this endpoint: sap-client is a
      // URL query parameter here, not just a header — this Z REST handler
      // isn't behind the OData gateway's usual header-only client resolution.
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;
      const headers = { ...baseHeaders(config, secrets), 'Content-Type': 'application/json' };

      const response = await abortableFetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        Number(config.timeoutMs) || 10000,
      );

      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

      // Confirmed response shape: { TYPE, MESSAGE, VENDOR }. TYPE is an SAP
      // message class — 'S' on success, 'E' on failure — and a failure also
      // comes back as HTTP 500 with an empty VENDOR. All three are checked
      // rather than any one of them, because MESSAGE is the only part that
      // says *why*, and it is the half worth putting in front of a person.
      if (!response.ok || json.TYPE !== 'S' || !json.VENDOR) {
        const message = json.MESSAGE || json.raw || `${response.status} ${response.statusText}`;
        const error = new Error(`SAP VENDOR_CR POST ${path} failed: ${message}`);
        error.status = response.status;
        throw error;
      }

      const businessPartner = json.VENDOR;
      return {
        data: { sapVendorCode: businessPartner },
        log: {
          vendorId: vendor.vendorId,
          payload: { businessPartner, request: payload, response: { TYPE: json.TYPE, MESSAGE: json.MESSAGE } },
          status: 'SUCCESS',
          documentRef: String(vendor._id),
        },
      };
    },

    // VENDOR_CR's general_data.region, company_code_data.payment_terms and
    // company_code_data.payment_method are all SAP master-data codes (T005S /
    // T052 / T042Z-style), not free text — a registration form that lets a
    // supplier type "Net 30", "NEFT" or a state name sends something VENDOR_CR
    // will never accept. These read-only Z REST catalogues are what the form
    // should populate its dropdowns from. Cached in memory: this data changes
    // about as often as SAP config does, and there's no reason to hit these on
    // every page load a supplier makes.
    vendorRegionCatalogue: async () => {
      const rows = await fetchCatalogue(config.regionCodePath || '/ZREGION_CODE/REGION', regionCache);
      return { data: { regions: rows.map((row) => ({ code: row.REGION, label: row.DESCRIPTION })) } };
    },

    vendorPaymentTermsCatalogue: async () => {
      const rows = await fetchCatalogue(config.paymentTermsPath || '/zpaym_term/PAY_TERM', paymentTermsCache);
      return { data: { paymentTerms: rows.map((row) => row.PAYMENT_TERM) } };
    },

    vendorPaymentMethodCatalogue: async () => {
      const rows = await fetchCatalogue(config.paymentMethodPath || '/ZPAYM_METHOD/PAYM_METHOD', paymentMethodCache);
      return { data: { paymentMethods: rows.map((row) => ({ code: row.PAYMENT_METHOD, label: row.DESCRIPTION })) } };
    },

    // What SAP itself has posted (MIRO) against this vendor's Business
    // Partner code — a custom Z REST POST (same family as VENDOR_CR and the
    // catalogue reads above: sap-client as a query param, no OData session
    // dance), not a per-tenant catalogue, so it is never cached. A vendor
    // with no sapVendorCode yet has nothing in SAP to look up.
    vendorMiroDisplay: async ({ vendor }) => {
      if (!vendor?.sapVendorCode) return { data: { documents: [] } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.miroDisplayPath || '/zmiro_display/MIRO';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;
      const headers = baseHeaders(config, secrets);

      const response = await getWithBody(url, {
        headers,
        body: { vendor: vendor.sapVendorCode },
        timeoutMs: Number(config.timeoutMs) || 10000,
      });

      let parsed;
      try { parsed = response.text ? JSON.parse(response.text) : []; } catch { parsed = null; }

      // Confirmed against the live sandbox: a vendor with zero MIRO documents
      // doesn't come back as an empty array — it comes back as HTTP 500 with a
      // single object of blank fields (INV_DOC_NO: ""). That's this endpoint's
      // way of saying "nothing found", not a real failure, so it's treated as
      // an empty result rather than thrown. Anything else non-2xx or
      // non-array/non-blank-object is a genuine failure.
      const isEmptySentinel = parsed && !Array.isArray(parsed) && !parsed.INV_DOC_NO;
      const rows = isEmptySentinel ? [] : parsed;

      if (!isEmptySentinel && (response.status < 200 || response.status >= 300 || !Array.isArray(rows))) {
        const error = new Error(`SAP MIRO display GET ${path} failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          documents: rows.map((row) => ({
            miroDoc: row.INV_DOC_NO,
            fiscalYear: row.FISCAL_YEAR,
            docType: row.DOC_TYPE,
            docDate: row.DOC_DATE,
            postingDate: row.POST_DATE,
            poNumber: row.REFERENCE,
            companyCode: row.COM_CODE,
            currency: row.CURRENCY,
            grossAmount: Number(row.GROSS_AMOUNT),
            taxableAmount: Number(row.TAXABLE_AMOUNT),
            taxCode: row.TAX_CODE,
            paymentTerm: row.PAYMENT_TERM,
            items: (row.ITEM || []).map((item) => ({
              poNumber: item.PO_NO,
              poItem: item.PO_ITEM,
              materialCode: item.MATERIAL,
              amount: Number(item.AMOUNT),
              quantity: Number(item.QUANTITY),
              uom: item.UNIT,
              totalValue: Number(item.TOT_VALUE),
            })),
          })),
        },
      };
    },

    // Clearing/payment detail for one MIRO document — a plain GET with
    // belnr/gjahr as query params (confirmed against the live sandbox, unlike
    // zmiro_display/MIRO this one behaves like a normal REST GET). A document
    // that isn't cleared yet, or doesn't exist, comes back 404 — that's a
    // legitimate "nothing to show yet", not a driver failure.
    invoicePaymentDetail: async ({ invoiceDocNo, fiscalYear }) => {
      if (!invoiceDocNo || !fiscalYear) return { data: { found: false } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.paymentDetailPath || '/zpayment_api/payment';
      const query = `belnr=${encodeURIComponent(invoiceDocNo)}&gjahr=${encodeURIComponent(fiscalYear)}`;
      const url = `${base}${path}?${config.sapClient ? `sap-client=${encodeURIComponent(config.sapClient)}&` : ''}${query}`;

      const response = await abortableFetch(url, { headers: baseHeaders(config, secrets) }, Number(config.timeoutMs) || 10000);
      if (response.status === 404) return { data: { found: false } };

      const text = await response.text();
      let row = {};
      try { row = text ? JSON.parse(text) : {}; } catch { row = null; }

      if (!response.ok || !row) {
        const error = new Error(`SAP payment detail GET ${path} failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          found: true,
          status: row.STATUS,
          grossAmount: Number(row.GROSS_AMOUNT),
          tdsDeducted: Number(row.TDS_DEDUCTED),
          netDisbursed: Number(row.NET_DISBURSED),
          clearingDocument: row.CLEARING_DOCUMENT || null,
          clearingDate: row.CLEARING_DATE || null,
          postingDate: row.POSTING_DATE || null,
          paymentMethod: row.PAYMENT_METHOD || null,
          utrReference: row.UTR_REFERENCE || null,
        },
      };
    },

    // Every payment SAP has made to this vendor, as one list — the ledger the
    // Payment Tracking tab shows.
    //
    // There is no vendor-keyed payment endpoint in the sandbox yet, so this is
    // assembled from the two reads that do exist: zmiro_display/MIRO lists every
    // invoice document SAP holds for the vendor, and zpayment_api/payment says
    // whether each one has cleared. Documents that have not cleared are dropped
    // — an open invoice is not a payment.
    //
    // The costs of that are real and worth naming: one call per MIRO document,
    // and a blind spot for anything SAP paid outside the MIRO chain (advances,
    // credit notes, direct FI postings). Both disappear the day the ABAP team
    // gives us a LIFNR-keyed ledger — set `paymentLedgerPath` and the
    // single-call branch below takes over, with nothing above this driver
    // noticing the difference.
    vendorPaymentDisplay: async ({ vendor }) => {
      if (!vendor?.sapVendorCode) return { data: { payments: [] } };

      if (config.paymentLedgerPath) {
        const base = String(config.baseUrl || '').replace(/\/$/, '');
        const path = config.paymentLedgerPath;
        const url = `${base}${path}?${config.sapClient ? `sap-client=${encodeURIComponent(config.sapClient)}&` : ''}LIFNR=${encodeURIComponent(vendor.sapVendorCode)}`;

        const response = await abortableFetch(url, { headers: baseHeaders(config, secrets) }, Number(config.timeoutMs) || 10000);
        if (response.status === 404) return { data: { payments: [] } };

        const text = await response.text();
        let rows;
        try { rows = text ? JSON.parse(text) : []; } catch { rows = null; }
        if (Array.isArray(rows?.data)) rows = rows.data;

        if (!response.ok || !Array.isArray(rows)) {
          const error = new Error(`SAP payment ledger GET ${path} failed: ${response.status} ${response.statusText}`);
          error.status = response.status;
          throw error;
        }

        return {
          data: {
            payments: rows.map((row) => ({
              miroDoc: row.INV_DOC_NO || null,
              fiscalYear: row.FISCAL_YEAR || null,
              poNumber: row.REFERENCE || null,
              companyCode: row.COM_CODE || null,
              currency: row.CURRENCY || null,
              status: row.STATUS || 'CLEARED',
              grossAmount: Number(row.GROSS_AMOUNT),
              tdsDeducted: Number(row.TDS_DEDUCTED),
              netDisbursed: Number(row.NET_DISBURSED),
              clearingDocument: row.CLEARING_DOCUMENT || null,
              clearingDate: row.CLEARING_DATE || null,
              postingDate: row.POSTING_DATE || null,
              paymentMethod: row.PAYMENT_METHOD || null,
              utrReference: row.UTR_REFERENCE || null,
            })),
          },
        };
      }

      const { documents } = (await driver.vendorMiroDisplay({ vendor })).data;

      const settled = await Promise.all(documents.map(async (doc) => {
        const { data: detail } = await driver.invoicePaymentDetail({
          invoiceDocNo: doc.miroDoc,
          fiscalYear: doc.fiscalYear,
        });
        if (!detail.found) return null;

        return {
          miroDoc: doc.miroDoc,
          fiscalYear: doc.fiscalYear,
          poNumber: doc.poNumber,
          companyCode: doc.companyCode,
          currency: doc.currency,
          status: detail.status,
          grossAmount: detail.grossAmount,
          tdsDeducted: detail.tdsDeducted,
          netDisbursed: detail.netDisbursed,
          clearingDocument: detail.clearingDocument,
          clearingDate: detail.clearingDate,
          postingDate: detail.postingDate,
          paymentMethod: detail.paymentMethod,
          utrReference: detail.utrReference,
        };
      }));

      return { data: { payments: settled.filter(Boolean) } };
    },

    // What SAP itself has issued (ME43 Display RFQ) to this vendor. Plain GET
    // with LIFNR as a query param — confirmed against the live sandbox. A
    // vendor with no RFQs comes back 404 with an empty data array, which is
    // "nothing yet", not a failure.
    vendorRfqDisplay: async ({ vendor }) => {
      // Same guard as vendorQuotationDisplay, and for the same reason: these
      // two endpoints are the same handler on the SAP side (note the shared
      // "Quotation fetched successfully" message), so a blank LIFNR is just as
      // dangerous here. A whitespace-only code is not a code.
      const lifnr = String(vendor?.sapVendorCode ?? '').trim();
      if (!lifnr) return { data: { documents: [] } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.rfqDisplayPath || '/ZME43/ME43';
      const url = `${base}${path}?${config.sapClient ? `sap-client=${encodeURIComponent(config.sapClient)}&` : ''}LIFNR=${encodeURIComponent(lifnr)}`;

      const response = await abortableFetch(url, { headers: baseHeaders(config, secrets) }, Number(config.timeoutMs) || 10000);
      if (response.status === 404) return { data: { documents: [] } };

      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = null; }

      if (!response.ok || !json || !Array.isArray(json.data)) {
        const error = new Error(`SAP RFQ display GET ${path} failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          documents: json.data
            // Belt and braces, as in vendorQuotationDisplay: never render
            // another supplier's documents in this vendor's portal.
            .filter((row) => !row.lifnr || String(row.lifnr).trim() === lifnr)
            .map((row) => ({
              sapRfqNumber: row.ebeln,
              // bedat arrives as the number 20260520. Stringified so this
              // field has one type across both drivers and both reads —
              // callers sort and format it as a string.
              date: row.bedat ? String(row.bedat) : null,
              currency: row.waers || null,
              purchasingOrg: row.ekorg || null,
            })),
        },
      };
    },

    // Every purchasing document SAP holds against this vendor code (ME48
    // Display Quotation). Plain GET with LIFNR as a query param, same shape
    // and row format as vendorRfqDisplay above. Confirmed against the live
    // sandbox at ZCL_ME48/vendor, where three behaviours matter:
    //
    //   1. It is NOT limited to quotations, despite the transaction name. For
    //      vendor 1120250010 it returned 37 rows — the single 6xxxxxxx
    //      document ME43 returns plus 36 45xxxxxxx purchase orders, exactly
    //      the 37 documents zpo_grn_vendor/Detail lists for the same vendor.
    //      There is no document-category filter in the ABAP behind it. So the
    //      rows are `documents`, and `documentType` below splits them on the
    //      number range rather than pretending SAP told us.
    //   2. Omitting LIFNR — or sending it empty, or misspelling the parameter
    //      — does not error. It returns EVERY purchasing document in the
    //      client (6,356 rows, ~500KB, every `lifnr` blanked out). That is
    //      other vendors' data, so the vendor-code guard below is a security
    //      boundary, not a convenience: never let this call go out without a
    //      non-empty LIFNR.
    //   3. A vendor with nothing on file answers 404 with an empty data array
    //      — "nothing yet", not a failure. Same convention as ME43.
    vendorQuotationDisplay: async ({ vendor }) => {
      // See note 2: an empty code makes SAP dump the whole client's ledger.
      const lifnr = String(vendor?.sapVendorCode ?? '').trim();
      if (!lifnr) return { data: { documents: [] } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.quotationDisplayPath || '/ZCL_ME48/vendor';
      const url = `${base}${path}?${config.sapClient ? `sap-client=${encodeURIComponent(config.sapClient)}&` : ''}LIFNR=${encodeURIComponent(lifnr)}`;

      const response = await abortableFetch(url, { headers: baseHeaders(config, secrets) }, Number(config.timeoutMs) || 10000);
      if (response.status === 404) return { data: { documents: [] } };

      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = null; }

      if (!response.ok || !json || !Array.isArray(json.data)) {
        const error = new Error(`SAP quotation display GET ${path} failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          documents: json.data
            // Belt and braces against note 2: if a blank-LIFNR response ever
            // reaches us anyway, drop rows that aren't this vendor's rather
            // than rendering another supplier's documents in their portal.
            .filter((row) => !row.lifnr || String(row.lifnr).trim() === lifnr)
            .map((row) => ({
              documentNumber: row.ebeln,
              // SAP sends no document category here, so infer it from the
              // number range: 6xxxxxxx is the RFQ/quotation range on this
              // system, everything else observed is a purchase order.
              documentType: String(row.ebeln || '').startsWith('6') ? 'Quotation' : 'Purchase Order',
              // bedat arrives as the number 20251112, not a date string.
              date: row.bedat ? String(row.bedat) : null,
              currency: row.waers || null,
              purchasingOrg: row.ekorg || null,
            })),
        },
      };
    },

    // ME47 — updates the net price of line items on a quotation document SAP
    // already holds (an `ebeln` from vendorRfqDisplay / vendorQuotationDisplay's
    // 6xxxxxxx range). Confirmed live against the sandbox: a plain POST, same
    // family as VENDOR_CR (sap-client as a query param, no OData session/CSRF
    // dance). Response shape confirmed as `{ STATUS: 'S'|'E', MESSAGE,
    // RFQ_NUMBER }` — STATUS is checked rather than just response.ok because
    // the sandbox has answered 200 with STATUS 'E' on a bad item number.
    quotationUpdatePrice: async ({ vendor, sapRfqNumber, items = [] }) => {
      const payload = {
        rfq_number: sapRfqNumber,
        items: items.map(({ item, netPrice }) => ({ item: String(item), net_price: String(netPrice) })),
      };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.quotationUpdatePricePath || '/ZQUOT_NETPR/QUOT_UPDPR';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;
      const headers = { ...baseHeaders(config, secrets), 'Content-Type': 'application/json' };

      const response = await abortableFetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        Number(config.timeoutMs) || 10000,
      );

      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

      if (!response.ok || json.STATUS !== 'S') {
        const message = json.MESSAGE || json.raw || `${response.status} ${response.statusText}`;
        const error = new Error(`SAP QUOT_UPDPR POST ${path} failed: ${message}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: { status: json.STATUS, message: json.MESSAGE, sapRfqNumber: json.RFQ_NUMBER || sapRfqNumber },
        log: {
          vendorId: vendor?.vendorId,
          payload: { request: payload, response: { STATUS: json.STATUS, MESSAGE: json.MESSAGE } },
          status: 'SUCCESS',
          documentRef: json.RFQ_NUMBER || sapRfqNumber,
        },
      };
    },

    // Every PO SAP has for a vendor, with line items and GRNs nested inside —
    // a GET whose filter travels in a JSON body (same family as
    // zmiro_display/MIRO, confirmed against the live sandbox: POST is 405,
    // GET+body is 200), so this reuses the getWithBody workaround. Unlike
    // the MIRO display, this is keyed directly on the vendor code — no
    // GSTIN-correlation guess needed.
    vendorPoGrnDisplay: async ({ vendor }) => {
      if (!vendor?.sapVendorCode) return { data: { orders: [] } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.poGrnPath || '/zpo_grn_vendor/Detail';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;

      // This payload nests line items and GRNs per PO and has come back in
      // 15s+ against the live sandbox even for a handful of orders — the
      // shared config.timeoutMs (10s default, tuned for the lighter reads
      // above) is too short for it, so it gets its own, longer default.
      const response = await getWithBody(url, {
        headers: baseHeaders(config, secrets),
        body: { vendor: vendor.sapVendorCode },
        timeoutMs: Number(config.poGrnTimeoutMs) || 120000,
      });

      let rows;
      try { rows = response.text ? JSON.parse(response.text) : []; } catch { rows = null; }

      if (response.status < 200 || response.status >= 300 || !Array.isArray(rows)) {
        const error = new Error(`SAP PO/GRN display GET ${path} failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          orders: rows.map((po) => {
            const items = (po.PO_LINE_ITEMS || []).map((item) => ({
              itemNumber: item.ITEM_NUMBER,
              materialCode: item.MATERIAL_CODE,
              description: item.DESCRIPTION,
              orderedQuantity: Number(item.ORDERED_QUANTITY),
              receivedQuantity: Number(item.RECEIVED_QUANTITY),
              invoicedQuantity: Number(item.INVOICED_QUANTITY),
              uom: item.UOM,
              unitPrice: Number(item.UNIT_PRICE),
              netAmount: Number(item.NET_AMOUNT),
              grossAmount: Number(item.GROSS_AMOUNT),
              grStatus: item.GR_EXPECTED || null,
              plant: item.PLANT,

              grns: (item.GRN || []).filter(isGoodsReceipt).map((gr) => ({
                grNumber: gr.GR_NUMBER,
                // A GR document covers several PO lines, so GR_NUMBER repeats
                // across items (159 of 410 rows in the sandbox). The item
                // number is what makes a receipt row unique.
                grItemNumber: gr.GR_ITEM_NUMBER,
                grDate: sapDayToIso(gr.GR_DATE),
                quantity: Number(gr.GR_QUANTITY),
                uom: gr.UOM,
                unitPrice: Number(gr.UNIT_PRICE),
                netAmount: Number(gr.NET_AMOUNT),
                location: gr.LOCATION || null,
              })),

              // Service lines (TYPE ZSER) are confirmed by service entry sheet,
              // not by a goods movement, so SAP returns them in the same GRN
              // array with every receipt field blank and the SSES_* fields
              // filled instead. Left in `grns` they render as empty receipts
              // with no number, date or quantity, so they are split out here.
              serviceEntries: (item.GRN || []).filter((gr) => !isGoodsReceipt(gr)).map((gr) => ({
                entrySheetNumber: gr.SSES_NO,
                fiscalYear: gr.SSES_YEAR,
                netAmount: Number(gr.SNET_AMOUNT || gr.NET_AMOUNT),
                accountCategory: gr.SACC_CAT || null,
                itemCategory: gr.SITEM_CAT || null,
              })),
            }));

            // The header NET_AMOUNT/GROSS_AMOUNT this endpoint returns cannot
            // be used. Against the live sandbox NET_AMOUNT is "0.00" for 115 of
            // 173 orders, and GROSS_AMOUNT is non-decreasing across every one
            // of the 172 row transitions — it is a running total that the ABAP
            // handler never resets per PO, not this order's gross. Both are
            // summed from the line items instead, which do reconcile.
            const sumOf = (field) => items.reduce((total, item) => total + (item[field] || 0), 0);

            return {
              poNumber: po.PO_NUMBER,
              // SAP's own report has no field naming the portal's PurchaseOrder
              // — it is keyed only on the vendor code, not on anything we sent
              // it (see this method's opening comment) — so there is no
              // correlation to offer here. `null`, honestly, rather than
              // guessing one order matches another by amount or date; see
              // mock.driver.js's vendorPoGrnDisplay for the one driver that can
              // answer this field for real.
              poId: null,
              poDate: sapDotDateToIso(po.PO_DATE),
              buyerName: po.BUYER_NAME,
              shipToCity: po.SHIP_TO_CITY,
              shipToState: po.SHIP_TO_STATE,
              companyCode: po.COM_CODE,
              currency: po.CURRENCY || null,
              netAmount: sumOf('netAmount'),
              grossAmount: sumOf('grossAmount'),
              items,
            };
          }),
        },
      };
    },

    // --- Invoicing plans (FPLA/FPLT) ------------------------------------
    //
    // CONFIRMED against the live sandbox — captured from
    //   GET /zinv_milestone/plan?sap-client=800  { "inv_planno": "0000001255" }
    // (see the live-contract test for the verbatim payload). This replaced an
    // earlier, unverified guess at a `/zpo_invplan/PLAN` endpoint keyed on the
    // PO number; the real one is keyed on the FPLA plan number instead, which
    // changes the shape of this method in a way worth spelling out:
    //
    //   - There is no "give me every plan on this PO" call. SAP answers one
    //     plan number at a time, so this reads one plan per line item that
    //     already carries a `planNumber` (assigned by poInvoicePlanUpdate, or
    //     by an earlier sync) and fans the calls out in parallel. A line whose
    //     plan number the portal does not yet know cannot be discovered through
    //     this endpoint alone — that needs the PO item's own FPLNR, which is a
    //     separate read this driver does not have yet.
    //   - The response never says which PO or line the plan belongs to (no
    //     ITEM_NUMBER, no po_number) — `line` below is supplied by this driver
    //     from the item it made the call for, not from anything SAP returned.
    //   - It never says the plan's TYPE either. Every date is its own
    //     percentage-of-value pair, which is what the portal calls a Partial
    //     plan; there is no periodic-specific shape (no FREQUENCY, no
    //     recurring amount) anywhere in it. A plan the portal already knows
    //     about keeps its own type/frequency/invoicing-rule on sync (the
    //     controller carries them forward); a plan discovered fresh, with
    //     nothing to carry forward, is recorded as Partial — the honest
    //     reading of what this endpoint actually reports.
    //
    //   FPLA header → INV_PLANNO
    //   FPLT dates  → BILLING_ITEM (FPLTR), INV_DATE (AFDAT/FKDAT — this report
    //                 does not distinguish the two), DESC (line text),
    //                 INV_PERCENTAGE (FPROZ), INV_VALUE (FAKWR), CURRENCY,
    //                 BILLING_STATUS (FKSAF), BILLLING_BLOCK (FAKSP, sic — the
    //                 sandbox's own field name doubles the "L"), BILLING_RULE
    //                 and DATE_CATEGORY, neither of which the portal has a use
    //                 for yet and both of which are kept off the normalised
    //                 shape rather than guessed at.
    //
    // FKSAF: 'A' not yet invoiced, 'B' partially, 'C' fully — confirmed by the
    // sandbox sample (every date here is 'A', matching a plan nothing has been
    // billed against). The portal's dates are all-or-nothing, so 'B' and 'C'
    // both read as Invoiced.
    //
    // BILLLING_BLOCK: the sandbox sample carries '99' on every date, including
    // the ones due today — treating that as "blocked" would make a live plan
    // look unbillable from the moment it syncs. '99' is read as SAP's "no
    // block" value here (this Z-report's default when FAKSP is not actually
    // set), and only a genuinely blank/zero value is treated the same way;
    // anything else is a real block code. This is the one field in this
    // mapping that has not been cross-checked against a blocked date, and it
    // is worth confirming with ABAP/FI before relying on it in production.
    poInvoicePlanDisplay: async ({ po }) => {
      const plannedItems = (po?.items || []).filter((item) => item.invoicePlan?.planNumber);
      if (!plannedItems.length) return { data: { poNumber: po?.sapPoNumber || null, plans: [] } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.invoicePlanPath || '/zinv_milestone/plan';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;

      const plans = await Promise.all(plannedItems.map(async (item) => {
        const planNumber = String(item.invoicePlan.planNumber).padStart(10, '0');

        const response = await getWithBody(url, {
          headers: baseHeaders(config, secrets),
          body: { inv_planno: planNumber },
          timeoutMs: Number(config.timeoutMs) || 10000,
        });

        let json;
        try { json = response.text ? JSON.parse(response.text) : null; } catch { json = null; }

        if (response.status < 200 || response.status >= 300 || !json || !Array.isArray(json.ITEM)) {
          const error = new Error(`SAP invoicing plan display GET ${path} failed for plan ${planNumber}: ${response.status} ${response.statusText}`);
          error.status = response.status;
          throw error;
        }

        const rows = json.ITEM;
        const dates = rows.map((row) => sapDayToIso(row.INV_DATE)).filter(Boolean).sort();

        return {
          line: item.line,
          planNumber: json.INV_PLANNO || planNumber,
          // Nothing in this response distinguishes Periodic from Partial —
          // both stay null here, and it is the controller's job (buildPlan /
          // syncInvoicePlan) to carry the portal's own classification forward
          // rather than have this driver invent one.
          type: null,
          frequency: null,
          invoicingRule: null,
          periodicAmount: null,
          currency: rows[0]?.CURRENCY || null,
          startDate: dates[0] || null,
          endDate: dates[dates.length - 1] || null,
          reference: null,
          lines: rows.map((row) => {
            const settlementDate = sapDayToIso(row.INV_DATE);
            const blockCode = String(row.BILLLING_BLOCK ?? row.BILLING_BLOCK ?? '').trim();
            return {
              lineNumber: Number(row.BILLING_ITEM),
              description: row.DESC || null,
              settlementDate,
              billingDate: settlementDate,
              percentage: Number(String(row.INV_PERCENTAGE ?? '0').trim()) || 0,
              amount: Number(String(row.INV_VALUE ?? '0').trim()) || 0,
              status: ['B', 'C'].includes(String(row.BILLING_STATUS || '').toUpperCase()) ? 'Invoiced' : 'Open',
              // '' and '00' are SAP's ordinary "nothing set" spellings; '99' is
              // this sandbox's own default-when-unset (see the note above).
              blocked: blockCode !== '' && blockCode !== '00' && blockCode !== '99',
            };
          }),
        };
      }));

      return { data: { poNumber: po?.sapPoNumber || null, plans } };
    },

    poInvoicePlanUpdate: async ({ po, item, plan }) => {
      const payload = {
        po_number: po.sapPoNumber,
        item: String(item.line).padStart(5, '0'),
        plan_type: plan.type === 'Periodic' ? 'PERIODIC' : 'PARTIAL',
        // SAP wants its own YYYYMMDD, not the ISO strings the portal stores.
        start_date: isoToSapDay(plan.startDate),
        end_date: isoToSapDay(plan.endDate),
        frequency: plan.frequency || '',
        invoicing_rule: plan.invoicingRule === 'Advance' ? 'A' : 'R',
        periodic_amount: plan.periodicAmount !== undefined && plan.periodicAmount !== null ? String(plan.periodicAmount) : '',
        currency: plan.currency || po.currency || 'INR',
        dates: (plan.lines || []).map((line) => ({
          date_item: String(line.lineNumber),
          settlement_date: isoToSapDay(line.settlementDate),
          percentage: String(line.percentage || 0),
          amount: String(line.amount),
          description: line.description || '',
        })),
      };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.invoicePlanUpdatePath || '/zpo_invplan/PLAN_UPD';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;
      const headers = { ...baseHeaders(config, secrets), 'Content-Type': 'application/json' };

      const response = await abortableFetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        Number(config.timeoutMs) || 10000,
      );

      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

      if (!response.ok || json.STATUS !== 'S') {
        const message = json.MESSAGE || json.raw || `${response.status} ${response.statusText}`;
        const error = new Error(`SAP ZPO_INVPLAN_UPDATE POST ${path} failed: ${message}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: { planNumber: json.PLAN_NUMBER || plan.planNumber || null, line: item.line, dates: payload.dates.length },
        log: {
          vendorId: po.vendorId,
          payload: { request: payload, response: { STATUS: json.STATUS, MESSAGE: json.MESSAGE, PLAN_NUMBER: json.PLAN_NUMBER } },
          status: 'SUCCESS',
          documentRef: `${po.sapPoNumber || po.id}/${item.line}`,
        },
      };
    },

    // Not a real SAP call — GSTIN/PAN verification runs against a third-party
    // KYC service (services/verification.service.js), same as the mock. This
    // only exists so the check appears in the same tenant SAP log as
    // everything else, which is the log's whole purpose.
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

    poAcknowledge: async ({ po }) => {
      const ackField = config.fields?.poAcknowledgeField;
      if (ackField) {
        await odata.call({
          service: svc.purchaseOrder, method: 'PATCH', secrets,
          path: `/A_PurchaseOrder('${po.sapPoNumber}')`,
          body: { [ackField]: true },
        });
      } else {
        logger.warn('[sap:s4_odata] poAcknowledge: no config.fields.poAcknowledgeField set — recording locally only, nothing written to SAP');
      }
      return {
        data: {},
        log: { vendorId: po.vendorId, payload: { poId: po.id, sapPoNumber: po.sapPoNumber, acknowledgedAt: po.acknowledgedAt }, documentRef: po.id },
      };
    },

    // --- Delivery and goods receipt ------------------------------------

    // No confirmed way to create an inbound delivery on this tenant's SAP
    // system: the standard OData write 401s — confirmed live, this instance's
    // Z REST endpoints (VENDOR_CR, the MIRO/payment/PO-GRN displays, ...) are
    // deliberately open, but its OData gateway needs a technical user this
    // tenant's SapConnection has no credentials for (see `secretFields`
    // below). Rather than throw and block every ASN submission on a step
    // nobody can complete, this records the shipment locally and skips the
    // SAP write when no credentials are configured — the real POST is still
    // here and starts running the moment credentials are added, no code
    // change required. Safe to leave local-only either way: awaitGoodsReceipt
    // below no longer needs a real inbound-delivery number to correlate
    // against — it reads GRNs off zpo_grn_vendor/Detail by PO number instead.
    // MIGO happens on SAP's own schedule; there is no push in scope here.
    // This used to poll A_MaterialDocumentItem via OData, but that gateway
    // 401s for this tenant, like every standard OData service here — it polls
    // zpo_grn_vendor/Detail instead, confirmed live and open, matching by PO
    // number rather than an inbound-delivery reference (the portal issues no
    // inbound delivery: it does not write to SAP at all). Only total received quantity is on this
    // endpoint — no rejected-quantity field exists anywhere in it, so an
    // accepted/rejected split still isn't derivable without the QM
    // inspection-lot API; until that's available everything received is
    // reported accepted (no false rejections, at the cost of not surfacing
    // real ones either — flag this to MM if quality inspection matters here).
    // `clientId` is threaded through explicitly rather than relied on
    // ambient AsyncLocalStorage propagation across the poll's recurring
    // timers: `check()` runs on its own schedule, well outside the request
    // that called submitASN, so the Vendor lookup below re-binds the tenant
    // itself instead of assuming a context that may or may not still be set.
    awaitGoodsReceipt: ({ asn, po, vendorId, clientId }, handler) => {
      poll({
        intervalMs: pollIntervalMs,
        timeoutMs: goodsReceiptTimeoutMs,
        label: `goods receipt (${asn.id})`,
        check: () => runWithTenant(clientId, async () => {
          if (!po?.sapPoNumber) return null;

          const { prisma } = require('../../db/prisma');
          const vendorDoc = await prisma.vendor.findFirst({ where: { vendorId } });
          if (!vendorDoc?.sapVendorCode) return null;

          const { orders } = (await driver.vendorPoGrnDisplay({ vendor: vendorDoc })).data;
          const order = orders.find((o) => o.poNumber === po.sapPoNumber);
          if (!order) return null;

          const matched = asn.items.map((asnItem) => ({
            asnItem,
            orderItem: order.items.find((i) => Number(i.itemNumber) === Number(asnItem.line)),
          }));
          // Not "received" until every shipped line has at least one GRN
          // posted against it in SAP — a GRN on one line while another is
          // still in transit isn't the goods receipt for this ASN yet.
          if (matched.some(({ orderItem }) => !orderItem || !orderItem.grns.length)) return null;
          return matched;
        }),
        onFound: (matched) => {
          const firstGrn = matched[0].orderItem.grns[0];
          const items = matched.map(({ asnItem, orderItem }) => {
            const received = orderItem.receivedQuantity;
            return {
              line: asnItem.line, materialCode: orderItem.materialCode, description: orderItem.description,
              receivedQuantity: received, acceptedQuantity: received, rejectedQuantity: 0,
              uom: orderItem.uom || 'EA',
            };
          });

          handler({
            data: {
              grnId: `GRN-${firstGrn.grNumber}`,
              sapMigoDoc: firstGrn.grNumber,
              // grDate already comes off vendorPoGrnDisplay as an ISO
              // "YYYY-MM-DD" string (via sapDayToIso), not raw digits.
              postingDate: firstGrn.grDate ? new Date(firstGrn.grDate) : new Date(),
              receivedBy: 'SAP',
              items,
            },
            logs: (answer, grn) => [
              { transaction: 'GOODS_RECEIPT', vendorId: vendorId || asn.vendorId, payload: grn, documentRef: grn.id },
              { transaction: 'GOODS_RECEIPT_READ', vendorId: vendorId || asn.vendorId, payload: { migoDoc: grn.sapMigoDoc, items: grn.items }, documentRef: grn.id },
            ],
          });
        },
        onTimeout: () => logger.error(`[sap:s4_odata] goods receipt poll for ASN ${asn.id} timed out — no GRN found in SAP's PO/GRN ledger for PO ${po?.sapPoNumber}`),
      });
    },

    // --- Invoice and payment --------------------------------------------

    // Two steps, both reads, because the portal never posted this invoice.
    //
    //   1. discover — find the MIRO document AP posted for it, by matching
    //      zmiro_display/MIRO on purchase order and gross amount
    //      (sap/mappings/invoice-match.js). Until AP posts, there is nothing
    //      to find and the poll simply keeps waiting.
    //   2. follow   — once discovered, poll zpayment_api/payment (confirmed
    //      live, open) for that document's clearing.
    //
    // The payment endpoint carries UTR reference, payment method and TDS
    // deducted for a cleared document. Bank name and TDS section are nowhere
    // in it, so they stay null rather than invented — those need the house
    // bank/payment-medium API and the withholding-tax reporting API.
    awaitPaymentRun: ({ invoice, vendor, vendorId }, handler) => {
      // Discovery needs the vendor's SAP code to read their MIRO ledger, and
      // the SAP purchase order number to match against. Without either there
      // is nothing to look for — and inventing a payment is exactly what this
      // redesign exists to stop, so it waits rather than simulating.
      if (!vendor?.sapVendorCode || !invoice.sapPoNumber) {
        logger.error(`[sap:s4_odata] awaitPaymentRun: invoice ${invoice.id} cannot be matched in SAP — ${!vendor?.sapVendorCode ? 'vendor has no SAP code' : 'no SAP purchase order number'}`);
        return;
      }

      let found = null; // the MIRO document, once discovery has identified it

      poll({
        intervalMs: pollIntervalMs,
        timeoutMs: paymentRunTimeoutMs,
        label: `payment run (${invoice.id})`,
        check: async () => {
          if (!found) {
            const { documents } = (await driver.vendorMiroDisplay({ vendor })).data;
            found = matchInvoiceDocument(
              { sapPoNumber: invoice.sapPoNumber, totalAmount: invoice.totalAmount },
              documents,
            );
            if (!found) return null; // AP has not posted it yet
            logger.info(`[sap:s4_odata] invoice ${invoice.id} matched SAP MIRO document ${found.miroDoc}/${found.fiscalYear}`);
          }

          const detail = (await driver.invoicePaymentDetail({
            invoiceDocNo: found.miroDoc, fiscalYear: found.fiscalYear,
          })).data;
          return detail.found && detail.status === 'CLEARED' ? { detail, document: found } : null;
        },
        onFound: ({ detail, document }) => handler({
          data: {
            paymentId: `PMT-${document.miroDoc}`,
            // The number SAP itself issued, discovered rather than minted —
            // the caller stores it on the invoice so the reconciliation view
            // stops having to re-match.
            sapMiroDoc: `${document.miroDoc}/${document.fiscalYear}`,
            sapPaymentDoc: detail.clearingDocument,
            runId: null, // not carried by this endpoint
            utrCode: detail.utrReference,
            paymentDate: parseSapYyyymmdd(detail.clearingDate) || new Date(),
            paymentMethod: detail.paymentMethod,
            bankName: null, // still needs the house bank / payment medium API
            grossAmount: detail.grossAmount,
            tdsDeducted: detail.tdsDeducted,
            netAmount: detail.netDisbursed,
            tdsSection: null, // still needs the withholding-tax reporting API
            deducteePan: vendor?.pan || null,
            deductorTan: null,
          },
          logs: (answer, payment) => [{
            transaction: 'PAYMENT_RUN', vendorId: vendorId || invoice.vendorId, payload: payment, documentRef: payment.id,
          }],
        }),
        onTimeout: () => logger.error(`[sap:s4_odata] payment run poll for invoice ${invoice.id} timed out — ${found ? `zpayment_api/payment never reported ${found.miroDoc}/${found.fiscalYear} cleared` : 'no matching MIRO document was ever posted in SAP for this invoice'}`),
      });
    },
  };

  return assertImplements(driver, 's4_odata');
};

const validateConfig = (config = {}) => {
  const errors = {};
  if (!config.baseUrl) errors.baseUrl = 'A gateway base URL is required';
  else if (!/^https?:\/\//i.test(config.baseUrl)) errors.baseUrl = 'Must be an http(s) URL';
  if (!config.sapClient) errors.sapClient = 'An SAP client number is required (e.g. 100)';
  return errors;
};

module.exports = {
  createS4ODataDriver,
  validateConfig,
  secretFields: [
    { name: 'username', label: 'Technical user' },
    { name: 'password', label: 'Password' },
  ],
  configFields: [
    { name: 'baseUrl', label: 'Gateway base URL', type: 'text', placeholder: 'https://my-s4.example.com' },
    { name: 'sapClient', label: 'SAP client', type: 'text', placeholder: '100' },
    { name: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 10000 },
    { name: 'companyCode', label: 'Company code', type: 'text', default: '1000' },
    { name: 'plant', label: 'Plant', type: 'text', default: '1000' },
    { name: 'supplierAccountGroup', label: 'Supplier account group', type: 'text', default: 'LIEF' },
    { name: 'bpGrouping', label: 'Business Partner grouping', type: 'text', default: 'BP03' },
    { name: 'vendorCrPath', label: 'VENDOR_CR endpoint path (custom Z REST, not OData — unverified)', type: 'text', default: '/zvendor_create/VENDOR_CR' },
    { name: 'regionCodePath', label: 'Region code catalogue path (custom Z REST)', type: 'text', default: '/ZREGION_CODE/REGION' },
    { name: 'paymentTermsPath', label: 'Payment terms catalogue path (custom Z REST)', type: 'text', default: '/zpaym_term/PAY_TERM' },
    { name: 'paymentMethodPath', label: 'Payment method catalogue path (custom Z REST)', type: 'text', default: '/ZPAYM_METHOD/PAYM_METHOD' },
    { name: 'miroDisplayPath', label: 'MIRO invoice display path (custom Z REST)', type: 'text', default: '/zmiro_display/MIRO' },
    { name: 'paymentDetailPath', label: 'Payment detail path (custom Z REST)', type: 'text', default: '/zpayment_api/payment' },
    { name: 'paymentLedgerPath', label: 'Vendor payment ledger path (custom Z REST, LIFNR-keyed) — leave blank to assemble the ledger from the MIRO display instead', type: 'text' },
    { name: 'rfqDisplayPath', label: 'RFQ display path (custom Z REST, ME43)', type: 'text', default: '/ZME43/ME43' },
    { name: 'quotationDisplayPath', label: 'Quotation display path (custom Z REST, ME48) — returns all purchasing documents for the vendor, not only quotations', type: 'text', default: '/ZCL_ME48/vendor' },
    { name: 'quotationUpdatePricePath', label: 'Quotation net price update path (custom Z REST, ME47)', type: 'text', default: '/ZQUOT_NETPR/QUOT_UPDPR' },
    { name: 'poGrnPath', label: 'PO/GRN detail path (custom Z REST)', type: 'text', default: '/zpo_grn_vendor/Detail' },
    { name: 'invoicePlanPath', label: 'Invoicing plan display path (custom Z REST, FPLA/FPLT — confirmed live)', type: 'text', default: '/zinv_milestone/plan' },
    { name: 'invoicePlanUpdatePath', label: 'Invoicing plan update path (custom Z REST, ME22N — unverified)', type: 'text', default: '/zpo_invplan/PLAN_UPD' },
    { name: 'poGrnTimeoutMs', label: 'PO/GRN detail request timeout (ms) — this endpoint is very slow (22–84s observed for 173 orders)', type: 'number', default: 120000 },
    { name: 'pollIntervalMs', label: 'Poll interval for deferred answers (ms)', type: 'number', default: 30000 },
    { name: 'fields.poAcknowledgeField', label: 'PO field to set on supplier acknowledgement (extension field, optional)', type: 'text' },
  ],
};
