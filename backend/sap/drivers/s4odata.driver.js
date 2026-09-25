const { notImplementedDriver, assertImplements } = require('../contract');
const logger = require('../../utils/logger');
const { buildVendorCreatePayload } = require('../mappings/vendor-create.map');
const { matchInvoiceDocument } = require('../mappings/invoice-match');
const { decodeFromSap } = require('../mappings/fields');
const { requireProductionCredentials } = require('./requireProductionCredentials');

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

// zpayment_api/payment writes an unset DATS field as a bare `00000000`
// ("POSTING_DATE":00000000 on every not-yet-cleared document, confirmed live)
// — a number with leading zeros, which is not JSON, so JSON.parse rejects the
// whole response. Strips the leading zeros from bare numeric *values* only (a
// key's closing quote, a colon, then digits), leaving string contents alone,
// so the unset date reads as 0 — which every caller already treats as null.
const parseSapJson = (text) => JSON.parse(text.replace(/((?<!\\)"\s*:\s*-?)0+(?=\d)/g, '$1'));

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

// Issue #62: a supplier can trade with several company codes in the same SAP
// client, and zpo_grn_vendor/Detail has no company-code filter of its own —
// it answers everything on the vendor code (LIFNR) alone. A tenant declares
// which company codes belong to it via config.companyCodes (comma-separated;
// falls back to the single required config.companyCode when unset, so a
// single-entity tenant only has to say it once). No default beyond that: a
// connection with neither set has declared nothing, and validateConfig below
// refuses to save one, so this only ever sees an empty list on a config that
// was never meant to reach a live tenant (a test's transient config, say).
const declaredCompanyCodes = (config = {}) => {
  if (Array.isArray(config.companyCodes)) return config.companyCodes.map(String).map((s) => s.trim()).filter(Boolean);
  const csv = String(config.companyCodes || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (csv.length) return csv;
  return config.companyCode ? [String(config.companyCode)] : [];
};

// zpo_grn_vendor/Detail carries no MJAHR (or equivalent) field — confirmed
// against the live sandbox, see the evidence in this driver's awaitGoodsReceipt
// comment. Some Z reports do expose a raw MJAHR/GR_YEAR under those names, so
// this checks for one before falling back to the calendar year of GR_DATE,
// which is the best a client with no real posting-year field can do. Ask ABAP
// to add MJAHR to this endpoint; the fallback becomes dead code the day they
// do, not a silent wrong answer before then — a material document's fiscal
// year and its posting date's calendar year agree except in the rare case a
// document is posted into a prior/future period, which this cannot detect.
const grFiscalYear = (gr) => {
  const raw = gr.MJAHR ?? gr.GR_YEAR;
  const parsed = raw != null ? Number(String(raw).trim()) : NaN;
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  const iso = sapDayToIso(gr.GR_DATE);
  return iso ? Number(iso.slice(0, 4)) : new Date().getFullYear();
};

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

// ...except zinv_plan/update, which wants MM/DD/YYYY. This asymmetry is real
// and confirmed: zinv_milestone/plan *returns* "20260901" while zinv_plan/update
// *accepts* "09/16/2026", in the same feature, for the same FPLT date. Sending
// YYYYMMDD to the update is the obvious mistake to make here, so the two
// directions get two visibly different helpers rather than one with a flag.
const isoToSapSlashDay = (value) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString().slice(0, 10);
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
};

// SAP's decimal-ish string fields on this endpoint ("25000.00", "25.00") — the
// portal holds these as numbers (or Prisma Decimals already converted by
// formatPlan), and the update rejects a bare integer where it wants two places.
const sapAmount = (value) => (value === null || value === undefined ? '' : Number(value).toFixed(2));

// The two confirmed bulk-write Z endpoints — zinv_plan/update and
// zasset_po/create — share one response envelope:
//
//   { TYPE: 'S'|'E', MESSAGE: '…', RESULTS: [ { TYPE, MESSAGE, … } ] }
//
// Both halves matter. TYPE is the envelope's verdict on the request as a whole;
// RESULTS carries a per-document outcome, and a bulk handler that accepts the
// request but rejects this document reports S at the top and E underneath.
// Checking only the envelope would record that as a clean write — the exact
// failure mode the quotation-price update's own STATUS check exists to stop.
//
// `matches` picks this call's own row out of RESULTS (the endpoints key it
// differently — zinv_plan/update by PO, zasset_po/create not at all when it is
// creating the document and does not yet have a number to key on), and a row
// that cannot be identified is not treated as someone else's success: when no
// row matches, every row must be S.
const bulkWriteFailure = (json, matches) => {
  const results = Array.isArray(json.RESULTS) ? json.RESULTS : [];
  const isError = (row) => String(row?.TYPE || '').toUpperCase() !== 'S';

  if (String(json.TYPE || '').toUpperCase() !== 'S') {
    // The envelope's MESSAGE is generic ("upload failed for one or more POs");
    // the row's MESSAGE is the actual SAP reason, so surface both.
    const rowMessage = (results.find(matches ? (row) => isError(row) && matches(row) : isError) || results.find(isError))?.MESSAGE;
    const message = [json.MESSAGE, rowMessage].filter((part, i, all) => part && all.indexOf(part) === i).join(' — ');
    return { failed: true, message: message || undefined, results };
  }

  const ours = matches ? results.filter(matches) : [];
  const offending = (ours.length ? ours : results).find(isError);
  return offending
    ? { failed: true, message: offending.MESSAGE || json.MESSAGE, results }
    : { failed: false, results };
};

const createS4ODataDriver = ({ config = {}, secrets = {} } = {}) => {
  const odata = createODataClient({ config });
  const svc = services(config);
  // Polling cadence and timeout for awaitGoodsReceipt/awaitPaymentRun used to
  // live here (pollIntervalMs, goodsReceiptTimeoutMs, paymentRunTimeoutMs) —
  // moved to jobs/kinds.js's defaultIntervalMs/defaultMaxAttempts, since
  // cadence is now a property of the job runtime shared by every driver, not
  // this one driver's own setTimeout loop (Phase 1 of
  // docs/04-sap-runtime-engineering-plan.md).
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

  // Issue #69: vendorPoGrnDisplay/vendorMiroDisplay answer for one vendor's
  // *entire* history — 22-84s and roughly half a megabyte for 173 orders —
  // and awaitGoodsReceipt/awaitPaymentRun used to call it once per ASN/
  // invoice, per job attempt. Twenty open shipments across fifty vendors on a
  // one-minute cadence is ~1,000 of these calls an hour against an endpoint
  // that can take a minute and a half to answer. This caches by vendor code
  // for a short window — long enough that every open ASN/invoice for the
  // same vendor, plus this tick's own discovery sweep, share one call instead
  // of one each; short enough that a real goods receipt still surfaces
  // within about a cadence's length of SAP posting it. Not catalogueTtlMs
  // (an hour): unlike a payment-terms list, this data is expected to change
  // during a live order's lifecycle.
  //
  // Keyed on vendor code alone, not the request body — the Z endpoint takes
  // nothing else (see vendorPoGrnDisplay's own comment) — and the cached
  // value is the in-flight *promise*, not just its resolved result, so
  // concurrent callers racing for the same vendor (this tick's several
  // watches, or a watch and a sweep) share one HTTP request rather than each
  // opening their own. A rejected call is evicted immediately: a transient
  // failure must not be remembered as "still no answer" for the rest of the
  // window.
  const vendorResponseCacheMs = Number(config.vendorResponseCacheMs) || 20_000;
  const poGrnCache = new Map(); // sapVendorCode -> { promise, expiresAt }
  const miroCache = new Map();

  const withVendorCache = (cache, vendor, fetcher) => {
    const key = vendor?.sapVendorCode;
    if (!key) return fetcher();

    const hit = cache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.promise;

    const promise = fetcher().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { promise, expiresAt: Date.now() + vendorResponseCacheMs });
    return promise;
  };

  // The actual MIRO-display HTTP call and parsing — extracted so
  // vendorMiroDisplay can share it through withVendorCache above, unchanged
  // otherwise.
  const fetchMiroDisplay = async (vendor) => {
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
  };

  // The actual PO/GRN-display HTTP call, filtering and mapping — extracted
  // so vendorPoGrnDisplay can share it through withVendorCache above,
  // unchanged otherwise.
  const fetchPoGrnDisplay = async (vendor) => {
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

    // zpo_grn_vendor/Detail has no company-code parameter of its own (see
    // the note on declaredCompanyCodes above) — filtering happens here,
    // after the fact, rather than trusting the endpoint to have scoped the
    // rows itself. An order outside the tenant's declared company codes is
    // dropped before it ever reaches a caller that might persist it (see
    // jobs/handlers/sweepPurchaseOrders.js).
    const allowed = declaredCompanyCodes(config);
    const inScope = (po) => !allowed.length || allowed.includes(String(po.COM_CODE || ''));

    // Confirmed live: this endpoint answers with a vendor's *entire*
    // purchasing-document set, RFQs (the 6xxxxxxx range) included, despite
    // being named — and behaving, for a real order — like a PO/GRN detail
    // read. sweepPurchaseOrders.js has no other signal to tell one from a
    // real order, so it created a bogus PurchaseOrder row for every RFQ it
    // saw here (₹0 value, no GRNs — nothing about a real order). Same
    // number-range rule src/lib/sapDocuments.js's documentTypeOf already
    // uses on the frontend for the same reason: SAP names no document
    // category in this response either.
    const isPurchaseOrder = (po) => !String(po.PO_NUMBER || '').startsWith('6');

    return {
      data: {
        orders: rows.filter(inScope).filter(isPurchaseOrder).map((po) => {
          const items = (po.PO_LINE_ITEMS || []).map((item) => ({
            itemNumber: item.ITEM_NUMBER,
            materialCode: item.MATERIAL_CODE,
            description: item.DESCRIPTION,
            orderedQuantity: Number(item.ORDERED_QUANTITY),
            receivedQuantity: Number(item.RECEIVED_QUANTITY),
            invoicedQuantity: Number(item.INVOICED_QUANTITY),
            // decodeFromSap('MEINS', ...) is a display decode (falls back to
            // the raw SAP code rather than throwing on an unmapped unit) —
            // this is a read, and failing a whole PO/GRN listing over one
            // unfamiliar unit code would be worse than showing it verbatim.
            // What it must never do is silently become a *different* real
            // unit — see the fixed default a few lines below in
            // awaitGoodsReceipt for the bug this replaced.
            uom: decodeFromSap('MEINS', item.UOM),
            unitPrice: Number(item.UNIT_PRICE),
            netAmount: Number(item.NET_AMOUNT),
            grossAmount: Number(item.GROSS_AMOUNT),
            grStatus: item.GR_EXPECTED || null,
            plant: item.PLANT,

            // FPLA-FPLNR. Blank means the line has no invoicing plan, which is
            // the ordinary case and not a missing field, so blank stays null
            // rather than becoming "". Added to this endpoint alongside
            // ACC_ASSIGNMNT_CAT (both were once only on the single-order
            // sibling zpo_grn/Detail), which is what lets the sweep learn a
            // plan SAP owns without a second call per order.
            invoicePlanNumber: String(item.INV_PLANNO || '').trim() || null,

            // EKPO-KNTTP: 'A' asset, 'D' service, 'K' cost centre, blank an
            // ordinary material line. Added to this endpoint after
            // ACC_ASSIGNMNT_CAT was already available on zpo_grn/Detail, so
            // unlike INV_PLANNO above this one is real here — which is what
            // lets the sweep classify an order from the ledger read alone,
            // without a second call per order.
            accountAssignmentCategory: String(item.ACC_ASSIGNMNT_CAT || '').trim().toUpperCase() || null,

            grns: (item.GRN || []).filter(isGoodsReceipt).map((gr) => ({
              grNumber: gr.GR_NUMBER,
              // A GR document covers several PO lines, so GR_NUMBER repeats
              // across items (159 of 410 rows in the sandbox). The item
              // number is what makes a receipt row unique.
              grItemNumber: gr.GR_ITEM_NUMBER,
              grDate: sapDayToIso(gr.GR_DATE),
              // MJAHR (the material document's fiscal year — GR_NUMBER
              // alone is not unique once SAP recycles a number range) is
              // nowhere in this payload; see awaitGoodsReceipt below for
              // where the year this becomes actually comes from.
              grYear: grFiscalYear(gr),
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
  };

  const driver = {
    ...notImplementedDriver('s4_odata'),
    name: 's4_odata',

    // --- Connectivity -----------------------------------------------------

    testConnection: async () => {
      const started = Date.now();
      const base = String(config.baseUrl || '').replace(/\/$/, '');
      // Pinged against a Z endpoint this driver actually depends on. The old
      // default, API_BUSINESS_PARTNER/$metadata, answers 401 on this system
      // (its OData gateway needs a technical user nobody has), so the check
      // reported "refused" while every endpoint the portal uses was fine.
      const url = `${base}${config.pingPath || config.regionCodePath || '/ZREGION_CODE/REGION'}`;

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
          documentRef: String(vendor.pk),
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
    // dance). Not a slow-changing catalogue, so not fetchCatalogue's hour-long
    // cache — but shared per vendor for vendorResponseCacheMs (issue #69),
    // since awaitPaymentRun re-reads this on every attempt for every open
    // invoice. A vendor with no sapVendorCode yet has nothing in SAP to look
    // up.
    vendorMiroDisplay: ({ vendor }) => withVendorCache(miroCache, vendor, () => fetchMiroDisplay(vendor)),

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
      try { row = text ? parseSapJson(text) : {}; } catch { row = null; }

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
        // The sandbox now answers an uncleared document 200 with STATUS
        // 'OPEN' rather than the 404 it used to — still not a payment.
        if (!detail.found || detail.status !== 'CLEARED') return null;

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
    //
    // Confirmed live 2026-09-24: this endpoint now embeds each RFQ's line
    // items directly (quotationNumber/vendorCode/quotationDate/currency/
    // purchasingOrg/items), replacing an earlier header-only shape
    // (ebeln/lifnr/bedat/waers/ekorg, no items) — and, critically, its
    // `quantity` is real (the requested quantity), unlike zpo_grn/Detail's
    // ORDERED_QUANTITY, which reports 0 for an RFQ (that field means goods
    // received against a PO, which an RFQ has none of). sweepQuotations.js
    // now sources a newly-discovered RFQ's items from here first for exactly
    // that reason, falling back to vendorRfqDetail only for a document that
    // has already closed (fallen out of this list) before the portal ever
    // saw it open.
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
            .filter((row) => !row.vendorCode || String(row.vendorCode).trim() === lifnr)
            .map((row) => ({
              sapRfqNumber: row.quotationNumber,
              // quotationDate arrives as the number 20260520. Stringified so
              // this field has one type across both drivers and both reads —
              // callers sort and format it as a string.
              date: row.quotationDate ? String(row.quotationDate) : null,
              currency: row.currency || null,
              purchasingOrg: row.purchasingOrg || null,
              items: Array.isArray(row.items) ? row.items.map((item) => ({
                line: Number(item.itemNumber),
                materialCode: item.materialCode || null,
                description: item.materialDesc || null,
                quantity: Number(item.quantity) || 0,
                uom: decodeFromSap('MEINS', item.unitOfMeasure),
                // 0 is SAP's "no target price entered yet" here, same as
                // ORDERED_QUANTITY's 0 meant "not yet quantified" before this
                // endpoint carried a real quantity — stored as null rather
                // than a price nobody quoted.
                targetPrice: Number(item.netPrice) > 0 ? Number(item.netPrice) : null,
                plant: item.plant || null,
              })) : [],
            })),
        },
      };
    },

    // Line-item detail for ONE document — an order number or an RFQ number
    // alike, confirmed live (see sweepQuotations.js for why an RFQ number is
    // the caller here). Same GET-with-body family as zmiro_display/MIRO and
    // zpo_grn_vendor/Detail (POST is 405, GET+body is 200), and the same
    // response shape as that plural sibling's rows — this is genuinely the
    // same endpoint, PO- or RFQ-keyed, not a lookalike.
    //
    // A vanished document (closed and purged, a typo'd number) answers 404
    // with an empty PO_LINE_ITEMS on the live sandbox — read as "nothing to
    // report", the same convention every other display read in this driver
    // uses, not a failure worth throwing over.
    vendorRfqDetail: async ({ rfqNumber }) => {
      if (!rfqNumber) return { data: null };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.poDetailPath || '/zpo_grn/Detail';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;

      const response = await getWithBody(url, {
        headers: baseHeaders(config, secrets),
        body: { PO: rfqNumber },
        timeoutMs: Number(config.timeoutMs) || 10000,
      });

      if (response.status === 404) return { data: null };

      let json;
      try { json = response.text ? JSON.parse(response.text) : null; } catch { json = null; }

      if (response.status < 200 || response.status >= 300 || !json || !Array.isArray(json.PO_LINE_ITEMS)) {
        const error = new Error(`SAP RFQ detail GET ${path} failed for ${rfqNumber}: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          rfqNumber: json.PO_NUMBER || rfqNumber,
          date: sapDotDateToIso(json.PO_DATE),
          buyerName: json.BUYER_NAME || null,
          buyerGstin: json.BUYER_GSTIN || null,
          shipToCity: json.SHIP_TO_CITY || null,
          shipToState: json.SHIP_TO_STATE || null,
          companyCode: json.COM_CODE || null,
          currency: json.CURRENCY || null,
          items: json.PO_LINE_ITEMS.map((item) => ({
            // "00010" is SAP's spelling of line 10 — same convention as
            // vendorPoGrnDisplay's items.
            line: Number(item.ITEM_NUMBER),
            // EKPO-PSTYP's document-type twin at header level, confirmed
            // live as "AN" on every RFQ line the sandbox holds — matches
            // Prisma's RfqType enum (AN/AB) directly, so this is passed
            // through rather than decoded.
            type: item.TYPE || null,
            materialCode: item.MATERIAL_CODE || null,
            description: item.DESCRIPTION || null,
            // Observed 0 on every line of a real RFQ in the sandbox (an RFQ
            // awaiting a supplier's own quote has nothing of its own to
            // quantify yet) — stored as-is, not substituted, since a bid still
            // needs every rfq.items line priced regardless of quantity
            // (controllers/rfq.controller.js's submitBid).
            quantity: Number(item.ORDERED_QUANTITY) || 0,
            uom: decodeFromSap('MEINS', item.UOM),
            plant: item.PLANT || null,
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
    //
    // Shared per vendor for vendorResponseCacheMs (issue #69): this is the
    // endpoint the issue is about — 22-84s and ~0.5MB for 173 orders, with
    // no date/document filter available (the body carries only the vendor
    // code; the Z endpoint accepts nothing else) — so a vendor with twenty
    // open ASNs, each running its own awaitGoodsReceipt watch, now costs one
    // call per cadence instead of twenty, and a same-tick discovery sweep
    // for the same vendor (jobs/handlers/sweepPurchaseOrders.js, which calls
    // this indirectly through the wrapped adapter) shares that same call
    // rather than opening a second one.
    vendorPoGrnDisplay: ({ vendor }) => withVendorCache(poGrnCache, vendor, () => fetchPoGrnDisplay(vendor)),

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

    // Which invoicing plan (FPLA-FPLNR) SAP holds against each line of ONE
    // purchase order.
    //
    // CONFIRMED against the live sandbox —
    //   GET /zpo_grn/Detail?sap-client=800  { "PO": "4500022789" }
    // the single-order sibling of zpo_grn_vendor/Detail: same field names, one
    // object instead of an array, keyed on the PO number instead of the vendor
    // code, and — the reason this method exists — its PO_LINE_ITEMS carry
    // INV_PLANNO.
    //
    // This closes the gap poInvoicePlanDisplay documents below. That endpoint
    // answers one plan *number* at a time and cannot be asked "what plans does
    // this order have", so until now a plan SAP owned but the portal had never
    // written was undiscoverable: the portal only knew a plan number if it had
    // assigned one itself. INV_PLANNO is SAP volunteering it, so:
    //
    //   - syncInvoicePlan can adopt a plan configured directly in ME22N, and
    //   - poInvoicePlanUpdate can learn the number SAP assigned to a plan it
    //     just pushed, which the update response does not report.
    //
    // A blank INV_PLANNO means the line has no invoicing plan — the ordinary
    // case for most order lines, not an error and not a missing field.
    poInvoicePlanNumbers: async ({ po }) => {
      if (!po?.sapPoNumber) return { data: { poNumber: null, lines: [] } };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.poDetailPath || '/zpo_grn/Detail';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;

      const response = await getWithBody(url, {
        headers: baseHeaders(config, secrets),
        body: { PO: String(po.sapPoNumber) },
        // One order, not a vendor's whole history — this does not need the
        // minutes-long ceiling poGrnTimeoutMs exists for.
        timeoutMs: Number(config.timeoutMs) || 10000,
      });

      let json;
      try { json = response.text ? JSON.parse(response.text) : null; } catch { json = null; }

      if (response.status < 200 || response.status >= 300 || !json || !Array.isArray(json.PO_LINE_ITEMS)) {
        const error = new Error(`SAP PO detail GET ${path} failed for order ${po.sapPoNumber}: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: {
          poNumber: json.PO_NUMBER || po.sapPoNumber,
          // Every line, not only the planned ones. The filter used to drop a
          // line with a blank INV_PLANNO, which was right while a plan number
          // was the only thing this read was for — but ACC_ASSIGNMNT_CAT is
          // most interesting exactly where there is no plan, and a line whose
          // category is 'A' with no invoicing plan is an ordinary asset order.
          // Callers that only want plans filter on planNumber themselves.
          lines: json.PO_LINE_ITEMS
            .map((item) => ({
              // "00010" is SAP's item number; the portal's own line numbers are
              // 10, 20, ... — the same value, differently spelled.
              line: Number(item.ITEM_NUMBER),
              planNumber: String(item.INV_PLANNO || '').trim() || null,
              // EKPO-KNTTP: 'A' asset, 'D' service, blank an ordinary material
              // line. This endpoint is the only one that reports it — see
              // vendorPoGrnDisplay above, whose response omits it entirely.
              accountAssignmentCategory: String(item.ACC_ASSIGNMNT_CAT || '').trim().toUpperCase() || null,
            }))
            .filter((row) => Number.isInteger(row.line)),
        },
      };
    },

    // CONFIRMED against the live sandbox —
    //   POST /zinv_plan/update?sap-client=800  { "DATA": [ … ] }
    // This replaced an unverified guess at a `/zpo_invplan/PLAN_UPD` endpoint
    // taking a nested {header, dates[]} document. The real contract differs in
    // every respect that matters, so it is worth being explicit:
    //
    //   - **It is flat.** There is no header. Every FPLT date is its own row in
    //     one `DATA` array and repeats the PO number, the item, and the plan's
    //     header-level customizing (CATEGORY, INV_PLAN_TYPE) on each row.
    //   - **Dates are MM/DD/YYYY**, not the YYYYMMDD zinv_milestone/plan reads
    //     back. See isoToSapSlashDay.
    //   - **Success is TYPE, not STATUS**, and the endpoint is a bulk one: the
    //     top-level TYPE is an envelope verdict and RESULTS carries a per-PO
    //     outcome. Both are checked — a partial failure that reports S at the
    //     top and E for the order would otherwise be recorded as a clean push.
    //   - **It does not report the plan number it assigned.** The response is
    //     TYPE/MESSAGE/RESULTS and nothing else, so the FPLA number is read back
    //     afterwards through poInvoicePlanNumbers rather than invented here.
    //
    // START_DATE, SETT_DATE_FROM and BILL_DATE were all the same value on every
    // row of the captured payload, which is consistent with zinv_milestone/plan
    // collapsing AFDAT and FKDAT into one INV_DATE on the way back out. The
    // portal models one date per instalment, so it sends one date three times
    // rather than pretending to a distinction neither endpoint exposes.
    //
    // The customizing keys (CATEGORY 'B', INV_PLAN_TYPE 'M2', DATE_CATG 'T1',
    // DATE_DESC '0003', BILL_RULE '1') are tenant configuration, not constants —
    // they are IMG values that differ per SAP client. The observed sandbox
    // values are the defaults, and each is a config field so a tenant whose
    // customizing differs is a connection edit rather than a code change.
    poInvoicePlanUpdate: async ({ po, item, plan }) => {
      const lines = plan.lines || [];
      if (!lines.length) {
        throw new Error(`Invoicing plan for ${po.sapPoNumber || po.id} line ${item.line} has no dates to send`);
      }
      if (!po.sapPoNumber) {
        // An order the portal awarded but SAP has not been correlated with yet
        // has no number to push against (see §5.6's note on sapPoNumber). Better
        // to refuse than to POST a null PO_NUMBER and read S back for a no-op.
        throw new Error(`Purchase order ${po.id} has no SAP order number yet — its invoicing plan cannot be pushed until SAP's own order is matched`);
      }

      // Only the partial/milestone plan type has been observed live. A periodic
      // plan uses a different INV_PLAN_TYPE in SAP's customizing and guessing
      // one would push a periodic schedule into SAP as something else, so it is
      // refused with the name of the setting that fixes it.
      const planType = plan.type === 'Periodic' ? config.invoicePlanTypePeriodic : (config.invoicePlanTypePartial || 'M2');
      if (!planType) {
        throw new Error("This SAP connection has no invoicing plan type configured for periodic plans — set 'invoicePlanTypePeriodic' to the SAP invoicing-plan type (FPLA-FPLNR customizing) your client uses for periodic plans");
      }

      const poItem = String(item.line).padStart(5, '0');
      const currency = plan.currency || po.currency || 'INR';
      // '99' is this sandbox's spelling of "no block" on the read side (see
      // poInvoicePlanDisplay), so it is what an unblocked date sends back.
      // The code for a genuinely blocked date has NOT been confirmed against a
      // blocked row — '01' is SAP's standard FAKSP block, and it is a config
      // field so FI can correct it without a deploy.
      const unblocked = config.invoicePlanUnblockedCode || '99';
      const blockCode = config.invoicePlanBlockCode || '01';

      const payload = {
        DATA: lines.map((line) => {
          const date = isoToSapSlashDay(line.settlementDate);
          return {
            PO_NUMBER: String(po.sapPoNumber),
            PO_ITEM: poItem,
            IV_PLAN_ITEM: String(line.lineNumber).padStart(6, '0'),
            CATEGORY: config.invoicePlanCategory || 'B',
            INV_PLAN_TYPE: planType,
            START_DATE: date,
            DATE_CATG: config.invoicePlanDateCategory || 'T1',
            DATE_DESC: config.invoicePlanDateDescription || '0003',
            SETT_DATE_FROM: date,
            BILL_RULE: String(config.invoicePlanBillingRule || '1'),
            INVOICE_PERCENTAGE: sapAmount(line.percentage || 0),
            CURRENCY: currency,
            BILL_VALUE: sapAmount(line.amount),
            BILLING_BLOCK: line.blocked ? blockCode : unblocked,
            // FKSAF is SAP's own billing status — it reports one, it does not
            // take one. Sent empty exactly as the captured payload does.
            BILLING_STATUS: '',
            BILL_DATE: date,
          };
        }),
      };

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.invoicePlanUpdatePath || '/zinv_plan/update';
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

      // The per-order verdict, not just the envelope's — see bulkWriteFailure.
      const { failed, message: failure, results } = bulkWriteFailure(
        json,
        (row) => String(row.PO || '') === String(po.sapPoNumber),
      );

      if (!response.ok || failed) {
        const message = failure || json.raw || `${response.status} ${response.statusText}`;
        const error = new Error(`SAP invoicing plan update POST ${path} failed for ${po.sapPoNumber} line ${item.line}: ${message}`);
        error.status = response.status;
        throw error;
      }

      // The update does not say which FPLA number it created or amended, so ask
      // the order. A failure here is deliberately not fatal: the plan IS in SAP
      // at this point, and losing the push over a follow-up read would leave the
      // portal believing a plan it successfully sent was rejected. The number
      // stays null and the next sync picks it up.
      let planNumber = plan.planNumber || null;
      try {
        const { data } = await driver.poInvoicePlanNumbers({ po });
        const discovered = (data.lines || []).find((row) => Number(row.line) === Number(item.line));
        if (discovered?.planNumber) planNumber = discovered.planNumber;
      } catch {
        // intentionally swallowed — see above
      }

      return {
        data: { planNumber, line: item.line, dates: payload.DATA.length },
        log: {
          vendorId: po.vendorId,
          payload: {
            request: payload,
            response: { TYPE: json.TYPE, MESSAGE: json.MESSAGE, RESULTS: results },
            planNumber,
          },
          status: 'SUCCESS',
          documentRef: `${po.sapPoNumber || po.id}/${item.line}`,
        },
      };
    },

    // Not a real SAP call — GSTIN/PAN verification runs against a third-party
    // KYC service (services/verification.service.js), same as the mock. This
    // only exists so the check appears in the same tenant SAP log as
    // everything else, which is the log's whole purpose. Its transaction is
    // registered with type 'KYC', not 'OData' (config/sapTransactions.js), so
    // the log itself never claims this reached SAP.
    vendorVerifyKyc: async ({ vendor, result }) => ({
      data: { gstinValid: result.gstinValid, panValid: result.panValid },
      log: {
        vendorId: vendor.vendorId,
        payload: { gstin: vendor.gstin, pan: vendor.pan, result },
        status: result.gstinValid && result.panValid ? 'SUCCESS' : 'FAILED',
        documentRef: String(vendor.pk),
      },
    }),

    // No vendorReject override here (issue #59): unlike vendorCreate's
    // VENDOR_CR, there is no confirmed Z REST/OData endpoint for rejecting a
    // vendor master in SAP, and VENDOR_REJECT is registered as a real OData
    // transaction (config/sapTransactions.js) — an entry logged from here
    // would claim an SAP call that never happened. Falls through to
    // notImplementedDriver until a real endpoint is confirmed and this can
    // make one, same as every other not-yet-built method on this driver.

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

    // Create an asset purchase order (account assignment category A) in SAP.
    //
    // CONFIRMED against the live sandbox —
    //   POST /zasset_po/create?sap-client=800
    // returning { TYPE, MESSAGE, PO_NUMBER: '4500022807', RESULTS: [...] }.
    //
    // **This is the portal's first and only document creation in SAP, and it is
    // a deliberate, narrow exception to a rule that otherwise still stands**
    // (§5.6, ADR-0042). The rule exists because `poProvision` used to *invent*
    // a PO number — `'4500' + six random digits`, indistinguishable from a real
    // one — and hand it to a supplier. This is the opposite: SAP creates the
    // document and tells us its real number, which is exactly the fabrication
    // the ban was written against. What has NOT changed: the portal still does
    // not post MIRO, does not post goods receipts, and does not create ordinary
    // material POs. ME21N for a material order remains SAP's own; the export
    // bridge (rfq.controller.js's exportAwardedPo) is still how an awarded
    // material order reaches a buyer's MM team.
    //
    // Dates are MM/DD/YYYY, the same spelling zinv_plan/update uses and the
    // opposite of what every *read* on this driver returns — see
    // isoToSapSlashDay.
    //
    // The asset number (ANLN1) and sub-number (ANLN2) are passed through
    // verbatim from the caller. This driver does not default, pad or invent
    // either: the portal holds no asset master, so a wrong number here posts
    // capex against the wrong fixed asset and no code in this repo can tell.
    // controllers/po.controller.js requires them explicitly for the same reason.
    poAssetCreate: async ({ vendor, order, items } = {}) => {
      // Checked here, before anything is sent, rather than relying on the
      // controller's validator alone. This is the one call on this driver that
      // creates a document, and the conformance runner invokes every contract
      // method with `FIXTURES[method] || {}` — so an empty-args call has to
      // fail with a sentence that says why, and crucially has to fail *before*
      // the POST, instead of TypeError-ing halfway through building a payload
      // or, worse, sending a half-built one.
      if (!vendor?.sapVendorCode) throw new Error('poAssetCreate: vendor.sapVendorCode is required — SAP cannot raise an order against a supplier it has no master record for');
      if (!order?.companyCode || !order?.purchasingOrg || !order?.purchasingGroup) {
        throw new Error('poAssetCreate: order.companyCode, order.purchasingOrg and order.purchasingGroup are all required — an asset PO has no organisational scope to fall back on');
      }
      if (!items?.length) throw new Error('poAssetCreate: at least one line item is required');
      for (const item of items) {
        if (!item.assetNumber) throw new Error('poAssetCreate: every line needs an assetNumber (ANLN1) — this driver will not default one, because a wrong asset number posts capex to the wrong fixed asset and nothing in this portal can detect it');
      }

      const base = String(config.baseUrl || '').replace(/\/$/, '');
      const path = config.assetPoCreatePath || '/zasset_po/create';
      const url = `${base}${path}${config.sapClient ? `?sap-client=${encodeURIComponent(config.sapClient)}` : ''}`;
      const headers = { ...baseHeaders(config, secrets), 'Content-Type': 'application/json' };

      const payload = {
        COMPANY_CODE: order.companyCode,
        PURCH_ORG: order.purchasingOrg,
        PURCH_GROUP: order.purchasingGroup,
        VENDOR: vendor.sapVendorCode,
        DOC_TYPE: order.docType || config.assetPoDocType || 'NB',
        PAYMENT_TERMS: order.paymentTerms || '',
        CURRENCY: order.currency || 'INR',
        DOC_DATE: isoToSapSlashDay(order.docDate || new Date()),
        ITEMS: items.map((item) => ({
          SHORT_TEXT: item.description,
          PLANT: item.plant,
          STORAGE_LOC: item.storageLocation || '',
          MATL_GROUP: item.materialGroup || '',
          // MENGE is Decimal(13,3) in this portal and SAP writes it with three
          // places; sapAmount's two would silently truncate a 0.125 quantity.
          QUANTITY: Number(item.quantity).toFixed(3),
          // Deliberately NOT encodeForSap('MEINS', …). That registry maps to
          // ISO codes (PCE, KGM, MTR) and *throws* on an unmapped unit — and
          // this sandbox does not speak ISO: the captured payload sends "EA"
          // and zpo_grn/Detail returns "LE", both SAP internal unit codes that
          // the registry has no entry for. The portal already stores "EA" as
          // its own default, so these agree; routing it through MEINS would
          // turn every asset PO into a SapFieldError for no gain.
          UNIT: String(item.uom || 'EA').trim().toUpperCase(),
          NET_PRICE: sapAmount(item.unitPrice),
          PRICE_UNIT: String(item.priceUnit || 1),
          TAX_CODE: item.taxCode || '',
          ASSET_NUMBER: item.assetNumber,
          ASSET_SUBNUM: item.assetSubNumber,
        })),
      };

      const response = await abortableFetch(
        url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        Number(config.timeoutMs) || 10000,
      );

      const text = await response.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

      // No `matches` predicate: the document does not exist until this call
      // succeeds, so there is no number to pick this call's RESULTS row out by
      // — every row has to be S. See bulkWriteFailure.
      const { failed, message: failure, results } = bulkWriteFailure(json);

      if (!response.ok || failed) {
        const message = failure || json.raw || `${response.status} ${response.statusText}`;
        const error = new Error(`SAP asset PO create POST ${path} failed: ${message}`);
        error.status = response.status;
        throw error;
      }

      // A response that reports success without a document number is a failure,
      // not a success with a blank field. The whole point of this call is to
      // come back with SAP's own number — accepting one without it would
      // recreate exactly the "order with no SAP number" state §5.6 describes,
      // except now with a local record claiming SAP has it.
      const poNumber = String(json.PO_NUMBER || '').trim();
      if (!poNumber) {
        const error = new Error(`SAP asset PO create POST ${path} reported success but returned no PO_NUMBER: ${json.MESSAGE || text}`);
        error.status = response.status;
        throw error;
      }

      return {
        data: { sapPoNumber: poNumber, message: json.MESSAGE || null, items: payload.ITEMS.length },
        log: {
          vendorId: vendor.vendorId,
          payload: { request: payload, response: { TYPE: json.TYPE, MESSAGE: json.MESSAGE, PO_NUMBER: poNumber, RESULTS: results } },
          status: 'SUCCESS',
          documentRef: poNumber,
        },
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
    // One-shot probe, called once per job attempt (jobs/worker.js) rather
    // than owning its own poll loop — see docs/04-sap-runtime-engineering-plan.md
    // Phase 1.6. The worker has already bound the tenant with runWithTenant()
    // before calling this (jobs/handlers/awaitGoodsReceipt.js), so — unlike
    // the old poll(), which ran on its own setTimeout outside any request or
    // job — the Vendor lookup below can rely on ambient AsyncLocalStorage
    // context rather than re-binding it itself. Cadence and how many attempts
    // before giving up live in jobs/kinds.js now, not in this driver.
    //
    // Returns `false` — not yet found, no error — when SAP's ledger doesn't
    // have it, and `true` once `handler` has run and persisted it. Any
    // genuine failure (network, an unreachable gateway) throws, which the
    // caller (the job handler, then jobs/worker.js) treats as an error to
    // back off and retry, distinct from "not yet".
    awaitGoodsReceipt: async ({ asn, po, vendorId }, handler) => {
      if (!po?.sapPoNumber) return false;

      const { prisma } = require('../../db/prisma');
      const vendorDoc = await prisma.vendor.findFirst({ where: { vendorId } });
      if (!vendorDoc?.sapVendorCode) return false;

      const { orders } = (await driver.vendorPoGrnDisplay({ vendor: vendorDoc })).data;
      const order = orders.find((o) => o.poNumber === po.sapPoNumber);
      if (!order) return false;

      const matched = asn.items.map((asnItem) => ({
        asnItem,
        orderItem: order.items.find((i) => Number(i.itemNumber) === Number(asnItem.line)),
      }));
      // Not "received" until every shipped line has at least one GRN posted
      // against it in SAP — a GRN on one line while another is still in
      // transit isn't the goods receipt for this ASN yet.
      if (matched.some(({ orderItem }) => !orderItem || !orderItem.grns.length)) return false;

      const firstGrn = matched[0].orderItem.grns[0];
      const docYear = firstGrn.grYear;
      const items = matched.map(({ asnItem, orderItem }) => {
        const received = orderItem.receivedQuantity;
        return {
          line: asnItem.line, materialCode: orderItem.materialCode, description: orderItem.description,
          receivedQuantity: received, acceptedQuantity: received, rejectedQuantity: 0,
          // No `|| 'EA'` default (sap/mappings/fields.js, Phase 2 of
          // docs/04-sap-runtime-engineering-plan.md): vendorPoGrnDisplay
          // already decoded this through MEINS, so it is SAP's real unit or
          // the raw code verbatim — never a guess. Silently substituting
          // "Each" for a unit we didn't recognise is exactly how a carton
          // becomes a piece in a buyer's ledger.
          uom: orderItem.uom,
        };
      });

      await handler({
        data: {
          // MBLNR alone collides once SAP recycles a number range across a
          // fiscal-year boundary — the year is part of the real SAP key, so
          // it goes into both the minted business id and its own column
          // (sapDocYear), matching how sapMiroDoc/fiscalYear is already
          // handled below for MIRO documents.
          grnId: `GRN-${docYear}-${firstGrn.grNumber}`,
          sapMigoDoc: firstGrn.grNumber,
          sapDocYear: docYear,
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
      return true;
    },

    // --- Invoice and payment --------------------------------------------

    // Two steps, both reads, because the portal never posted this invoice.
    //
    //   1. discover — find the MIRO document AP posted for it, by matching
    //      zmiro_display/MIRO on purchase order and gross amount
    //      (sap/mappings/invoice-match.js). Until AP posts, there is nothing
    //      to find and this attempt reports "not yet".
    //   2. follow   — once discovered, check zpayment_api/payment (confirmed
    //      live, open) for that document's clearing.
    //
    // One-shot probe, same shape as awaitGoodsReceipt above: called once per
    // job attempt, no owned timer. Unlike the old poll(), it cannot cache the
    // discovered MIRO document across attempts — each attempt re-discovers it
    // via step 1 before re-checking its clearing in step 2. That is more SAP
    // traffic per attempt than before, not a correctness change; Phase 2+ can
    // optimise by persisting the discovered document if this turns out to
    // matter in practice.
    //
    // The payment endpoint carries UTR reference, payment method and TDS
    // deducted for a cleared document. Bank name and TDS section are nowhere
    // in it, so they stay null rather than invented — those need the house
    // bank/payment-medium API and the withholding-tax reporting API.
    awaitPaymentRun: async ({ invoice, vendor, vendorId }, handler) => {
      // Discovery needs the vendor's SAP code to read their MIRO ledger, and
      // the SAP purchase order number to match against. Without either there
      // is nothing to look for — and inventing a payment is exactly what this
      // redesign exists to stop, so this throws rather than simulating an
      // answer; the job runtime records it as a failed attempt and backs off.
      if (!vendor?.sapVendorCode || !invoice.sapPoNumber) {
        throw new Error(`awaitPaymentRun: invoice ${invoice.id} cannot be matched in SAP — ${!vendor?.sapVendorCode ? 'vendor has no SAP code' : 'no SAP purchase order number'}`);
      }

      const { documents } = (await driver.vendorMiroDisplay({ vendor })).data;
      // Issue #64: matchInvoiceDocument throws AmbiguousInvoiceMatchError
      // rather than returning null when a periodic invoicing plan's
      // same-amount siblings can't be told apart by date either — left to
      // propagate uncaught here, since jobs/handlers/awaitPaymentRun.js is
      // what owns deciding this invoice needs a human, not this driver.
      const found = matchInvoiceDocument(
        { sapPoNumber: invoice.sapPoNumber, totalAmount: invoice.totalAmount, invoiceDate: invoice.invoiceDate },
        documents,
      );
      if (!found) return false; // AP has not posted it yet

      const detail = (await driver.invoicePaymentDetail({
        invoiceDocNo: found.miroDoc, fiscalYear: found.fiscalYear,
      })).data;
      if (!detail.found || detail.status !== 'CLEARED') return false;

      await handler({
        data: {
          paymentId: `PMT-${found.miroDoc}`,
          // The number SAP itself issued, discovered rather than minted —
          // the caller stores it on the invoice so the reconciliation view
          // stops having to re-match.
          sapMiroDoc: `${found.miroDoc}/${found.fiscalYear}`,
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
      });
      return true;
    },
  };

  return assertImplements(driver, 's4_odata');
};

const SECRET_FIELDS = [
  { name: 'username', label: 'Technical user' },
  { name: 'password', label: 'Password' },
];

// `environment`/`secrets` are optional so every existing call site
// (controllers/platformSap.controller.js's "test connection" on a
// not-yet-saved sandbox config, this driver's own tests) that only cares
// about the shape of `config` keeps working unchanged — the production-
// credentials rule only engages when a caller actually says which
// environment this is for.
const validateConfig = (config = {}, { environment, secrets = {} } = {}) => {
  const errors = {};
  if (!config.baseUrl) errors.baseUrl = 'A gateway base URL is required';
  else if (!/^https?:\/\//i.test(config.baseUrl)) errors.baseUrl = 'Must be an http(s) URL';
  if (!config.sapClient) errors.sapClient = 'An SAP client number is required (e.g. 100)';
  // Issue #62: this used to default silently to '1000' (the SAP IDES demo
  // company code), so a tenant that never configured it ran on a value
  // nobody chose. It is also the company-code filter's own fallback when
  // companyCodes isn't set (declaredCompanyCodes above) — required here
  // means that filter can never see an empty list on a live connection.
  if (!config.companyCode) errors.companyCode = 'A company code is required';
  requireProductionCredentials(errors, { environment, secrets, secretFields: SECRET_FIELDS });
  return errors;
};

module.exports = {
  createS4ODataDriver,
  validateConfig,
  secretFields: SECRET_FIELDS,
  configFields: [
    { name: 'baseUrl', label: 'Gateway base URL', type: 'text', placeholder: 'https://my-s4.example.com' },
    { name: 'sapClient', label: 'SAP client', type: 'text', placeholder: '100' },
    { name: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 10000 },
    { name: 'companyCode', label: 'Company code (required)', type: 'text', placeholder: '1000' },
    { name: 'companyCodes', label: 'All company codes this tenant covers, comma-separated (optional — defaults to just Company code)', type: 'text', placeholder: '1000, 2000' },
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
    { name: 'poDetailPath', label: 'Single order/RFQ detail path (custom Z REST — the source of each PO line\'s INV_PLANNO, and confirmed live for RFQ document numbers too)', type: 'text', default: '/zpo_grn/Detail' },
    { name: 'assetPoCreatePath', label: 'Asset purchase order create path (custom Z REST, ME21N with account assignment A — the one document the portal creates in SAP)', type: 'text', default: '/zasset_po/create' },
    { name: 'assetPoDocType', label: 'Purchasing document type (BSART) for an asset PO', type: 'text', default: 'NB' },
    { name: 'invoicePlanPath', label: 'Invoicing plan display path (custom Z REST, FPLA/FPLT — confirmed live)', type: 'text', default: '/zinv_milestone/plan' },
    { name: 'invoicePlanUpdatePath', label: 'Invoicing plan update path (custom Z REST, FPLA/FPLT — confirmed live)', type: 'text', default: '/zinv_plan/update' },
    // Invoicing-plan customizing (IMG values, per SAP client — see
    // poInvoicePlanUpdate). The defaults are the values observed on the
    // sandbox; a tenant whose customizing differs edits them here.
    { name: 'invoicePlanCategory', label: 'Invoicing plan category (FPLA CATEGORY)', type: 'text', default: 'B' },
    { name: 'invoicePlanTypePartial', label: 'Invoicing plan type for partial/milestone plans (INV_PLAN_TYPE)', type: 'text', default: 'M2' },
    { name: 'invoicePlanTypePeriodic', label: 'Invoicing plan type for periodic plans (INV_PLAN_TYPE) — no default: periodic plans have not been run against a live system, and pushing one under the partial type would misfile it', type: 'text' },
    { name: 'invoicePlanDateCategory', label: 'Invoicing plan date category (DATE_CATG)', type: 'text', default: 'T1' },
    { name: 'invoicePlanDateDescription', label: 'Invoicing plan date description key (DATE_DESC)', type: 'text', default: '0003' },
    { name: 'invoicePlanBillingRule', label: 'Invoicing plan billing rule (BILL_RULE)', type: 'text', default: '1' },
    { name: 'invoicePlanUnblockedCode', label: 'Billing block code meaning "not blocked" (FAKSP) — this sandbox uses 99, not blank', type: 'text', default: '99' },
    { name: 'invoicePlanBlockCode', label: 'Billing block code to send for a blocked date (FAKSP) — unverified, no blocked row has been observed live', type: 'text', default: '01' },
    { name: 'poGrnTimeoutMs', label: 'PO/GRN detail request timeout (ms) — this endpoint is very slow (22–84s observed for 173 orders)', type: 'number', default: 120000 },
    { name: 'fields.poAcknowledgeField', label: 'PO field to set on supplier acknowledgement (extension field, optional)', type: 'text' },
  ],
};
