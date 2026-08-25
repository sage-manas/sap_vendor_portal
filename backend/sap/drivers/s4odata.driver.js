const { notImplementedDriver, assertImplements } = require('../contract');
const logger = require('../../utils/logger');
const { buildVendorCreatePayload } = require('../mappings/vendor-create.map');

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
//   2. Several of this app's steps have NO standard public S/4 API at all,
//      because they model a self-service supplier *portal* flow (RFQ issued to
//      an external vendor, that vendor bidding electronically) that core S/4
//      simply doesn't expose — that's normally SAP Ariba/Business Network
//      territory. Those methods (rfqCreate/Cancel/Reissue/SubmitBid,
//      infoRecordCreate) call a `sourcing` service that MUST be a custom
//      Z-OData service ABAP builds, or a BAdI-backed equivalent. Left
//      unconfigured on purpose, so a tenant pointed at this driver without one
//      fails loudly instead of quietly doing nothing.
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
// KNOWN GAP, narrowed but not closed: awaitVendorApproval and poProvision
// below still resolve "which SAP Business Partner is this our vendor?" by
// reading back an A_BusinessPartnerTaxNumber row keyed on GSTIN. VENDOR_CR
// does take `gstin` (top level) and returns the vendor code directly, so the
// correlation *value* is no longer in doubt — what is still unconfirmed is
// whether VENDOR_CR causes a queryable A_BusinessPartnerTaxNumber row to
// exist for it. This driver does not write one itself. Until that is
// confirmed against a real system, treat those two methods as unproven: they
// will time out rather than misbehave if the row never appears. Note also
// that vendorCreate already returns the SAP vendor code on the spot, so a
// simpler correlation is available if the approval polling turns out to be
// unnecessary for this client's workflow.

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
  // No standard S/4 API — must be a custom Z-OData service confirmed with
  // MM/ABAP. Left unset by default.
  sourcing: config.services?.sourcing || null,
});

const requireSourcingService = (svc) => {
  if (!svc.sourcing) {
    throw new Error('No SAP e-sourcing (RFQ) service is configured. Standard S/4HANA has no public API for issuing an RFQ to, or capturing a bid from, an external portal vendor — this needs a custom Z-OData service (or BAdI) from the ABAP team. Set config.services.sourcing once one exists.');
  }
  return svc.sourcing;
};

// The field SAP-side records carry to identify "which of our vendors is this"
// — since the driver has no database access, it cannot look up a Business
// Partner number from our internal vendorId any other way. Confirm with
// ABAP which field is free to reuse (or get a Z-field added) before pointing
// this at a real system; GSTIN is used as the fallback correlation key
// because it is already unique per vendor in this app.
const externalIdTaxType = (config) => config.taxNumberTypes?.correlation || null;

const createS4ODataDriver = ({ config = {}, secrets = {} } = {}) => {
  const odata = createODataClient({ config });
  const svc = services(config);
  const companyCode = config.companyCode || '1000';
  const plant = config.plant || '1000';
  const pollIntervalMs = Number(config.pollIntervalMs) || 30000;
  const goodsReceiptTimeoutMs = Number(config.goodsReceiptTimeoutMs) || 24 * 60 * 60 * 1000;
  const paymentRunTimeoutMs = Number(config.paymentRunTimeoutMs) || 30 * 24 * 60 * 60 * 1000;

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

    // XK01/BP create. There is no standard "approve and get a supplier code"
    // step in the OData API by itself — awaitVendorApproval below models
    // whatever release/approval workflow the client's SAP has on new Business
    // Partners (many do, precisely so a portal-created vendor can't transact
    // before someone reviews it).
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
          status: 'PENDING', // resolved by awaitVendorApproval once released
          documentRef: String(vendor._id),
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

    // Manual approval in this app's own workflow — mirrors what the mock
    // does, except it has no code of its own to fall back on: unlike the
    // mock, this driver never mints a sapVendorCode itself, so it can only
    // echo one VENDOR_CR already put on the vendor. If VENDOR_CR never
    // succeeded (or hasn't run yet), there is no vendor master in SAP to
    // confirm — refuse rather than let the caller approve a vendor SAP has
    // never heard of. If SAP-side release should also be forced explicitly
    // rather than left to awaitVendorApproval's poll, that call would go here.
    vendorConfirm: async ({ vendor }) => {
      if (!vendor.sapVendorCode) {
        throw new Error(
          `Cannot confirm vendor "${vendor.vendorId}": VENDOR_CR has not succeeded for it yet, so SAP has issued no vendor code to confirm.`
        );
      }
      return {
        data: { sapVendorCode: vendor.sapVendorCode },
        log: {
          vendorId: vendor.vendorId,
          payload: { sapVendorCode: vendor.sapVendorCode, status: 'Approved' },
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

    // Polls the Business Partner's purchasing/posting block flags until SAP's
    // own release workflow clears them. A client without such a workflow will
    // see this resolve on the first poll, which is correct.
    awaitVendorApproval: ({ vendor, pendingLogId }, handler) => {
      const correlationType = externalIdTaxType(config) || config.taxNumberTypes?.gstin || 'GST';

      poll({
        intervalMs: pollIntervalMs,
        timeoutMs: Number(config.vendorApprovalTimeoutMs) || 7 * 24 * 60 * 60 * 1000,
        label: `vendor approval (${vendor.vendorId})`,
        check: async () => {
          const taxRows = await odata.call({
            service: svc.businessPartner, path: '/A_BusinessPartnerTaxNumber', method: 'GET', secrets,
            query: `$filter=BpTaxType eq '${correlationType}' and BpTaxNumber eq '${vendor.gstin}'&$top=1`,
          });
          const row = (taxRows.results || [taxRows])[0];
          if (!row?.BusinessPartner) return null;

          const supplierCompany = await odata.call({
            service: svc.businessPartner,
            path: `/A_SupplierCompany(Supplier='${row.BusinessPartner}',CompanyCode='${companyCode}')`,
            method: 'GET', secrets,
          });
          if (supplierCompany.PurchasingBlock || supplierCompany.PostingBlock) return null;
          return { businessPartner: row.BusinessPartner };
        },
        onFound: ({ businessPartner }) => handler({
          data: { sapVendorCode: businessPartner },
          resolve: pendingLogId ? { id: pendingLogId, status: 'SUCCESS' } : null,
          logs: (answer, approved) => [{
            transaction: 'VENDOR_CONFIRM',
            vendorId: vendor.vendorId,
            payload: { sapVendorCode: businessPartner, status: 'Approved' },
            documentRef: String(approved._id || vendor._id),
          }],
        }),
        onTimeout: () => {
          logger.error(`[sap:s4_odata] vendor approval poll for ${vendor.vendorId} timed out without SAP releasing the Business Partner`);
          if (pendingLogId) {
            const { resolveSapCall } = require('../../utils/sapLogger');
            resolveSapCall(pendingLogId, 'FAILED', 'Timed out waiting for SAP to release the Business Partner').catch(() => {});
          }
        },
      });
    },

    // --- Sourcing (no standard API — see requireSourcingService) -----------

    rfqCreate: async ({ rfq, vendorId }) => {
      const sourcing = requireSourcingService(svc);
      const body = await odata.call({
        service: sourcing, path: config.sourcingPaths?.rfqCreate || '/RFQSet', method: 'POST', secrets,
        body: {
          Rfq: rfq.id, RfqType: rfq.rfqType, ResponseDeadline: rfq.deadlineDate,
          PurchasingGroup: rfq.purchasingGroup || '001', PaymentTerms: rfq.paymentTerms,
          Items: rfq.items,
        },
      });
      return { data: {}, log: { vendorId: vendorId || 'SYSTEM', payload: body, documentRef: rfq.id } };
    },

    rfqCancel: async ({ rfq }) => {
      const sourcing = requireSourcingService(svc);
      await odata.call({
        service: sourcing, method: 'POST', secrets,
        path: (config.sourcingPaths?.rfqCancel || ((id) => `/RFQSet('${id}')/Cancel`))(rfq.id),
      });
      return { data: {}, log: { vendorId: 'SYSTEM', payload: { rfqId: rfq.id, status: 'Closed' }, documentRef: rfq.id } };
    },

    rfqReissue: async ({ rfq }) => {
      const sourcing = requireSourcingService(svc);
      await odata.call({
        service: sourcing, method: 'POST', secrets, body: { ResponseDeadline: rfq.deadlineDate },
        path: (config.sourcingPaths?.rfqReissue || ((id) => `/RFQSet('${id}')/Reissue`))(rfq.id),
      });
      return { data: {}, log: { vendorId: 'SYSTEM', payload: { rfqId: rfq.id, deadlineDate: rfq.deadlineDate }, documentRef: rfq.id } };
    },

    rfqSubmitBid: async ({ rfq, vendorId, bid }) => {
      const sourcing = requireSourcingService(svc);
      await odata.call({
        service: sourcing, method: 'POST', secrets,
        path: (config.sourcingPaths?.rfqSubmitBid || ((id) => `/RFQSet('${id}')/Bids`))(rfq.id),
        body: { Supplier: vendorId, UnitPrices: bid.unitPrices, TaxCode: bid.taxCode, LeadTimeDays: bid.deliveryLeadTimeDays, ValidityDate: bid.validityDate },
      });
      return { data: {}, log: { vendorId, payload: { rfqId: rfq.id, bid }, documentRef: rfq.id } };
    },

    infoRecordCreate: async ({ rfq, vendorId, items }) => {
      const sourcing = requireSourcingService(svc);
      const body = await odata.call({
        service: sourcing, path: config.sourcingPaths?.infoRecordCreate || '/InfoRecordSet', method: 'POST', secrets,
        body: { Supplier: vendorId, Rfq: rfq.id, Items: items },
      });
      return { data: { infoRecord: body.InfoRecord }, log: { vendorId, payload: { supplier: vendorId, infoRecord: body.InfoRecord, items }, documentRef: rfq.id } };
    },

    // --- Purchase orders ----------------------------------------------

    // Bookkeeping only, same as the mock — the PO already came from SAP by
    // the time this runs (see poProvision).
    poInboundSync: async ({ po, vendorId }) => ({
      data: {},
      log: { vendorId, payload: po, documentRef: po.id },
    }),

    // The real analog of "a PO arrives" is polling (or being pushed, via
    // IDoc/Event Mesh — out of scope here) SAP for open POs addressed to this
    // vendor, not asking SAP to invent one on demand. This is the one method
    // whose calling convention (Public route, /pos/simulate) is itself a dev
    // convenience the mock exists for — against a real system it returns the
    // oldest not-yet-synced open PO for the vendor, or throws if there is none.
    poProvision: async ({ vendorId }) => {
      const correlationType = externalIdTaxType(config) || config.taxNumberTypes?.gstin || 'GST';
      // vendorId here is our app's vendorId, not the Business Partner number —
      // resolving it requires the same GSTIN-correlation trick vendorCreate
      // and awaitVendorApproval use. A cleaner integration would carry our
      // vendorId on the PO's supplier reference directly; confirm with ABAP.
      const Vendor = require('../../models/Vendor');
      const vendorDoc = await Vendor.findOne({ vendorId });
      if (!vendorDoc?.gstin) throw new Error(`Cannot resolve a Business Partner for vendorId "${vendorId}" — no GSTIN on file to correlate against SAP`);

      const taxRows = await odata.call({
        service: svc.businessPartner, path: '/A_BusinessPartnerTaxNumber', method: 'GET', secrets,
        query: `$filter=BpTaxType eq '${correlationType}' and BpTaxNumber eq '${vendorDoc.gstin}'&$top=1`,
      });
      const row = (taxRows.results || [taxRows])[0];
      if (!row?.BusinessPartner) throw new Error(`No SAP Business Partner is correlated to vendorId "${vendorId}" yet`);

      const pos = await odata.call({
        service: svc.purchaseOrder, path: '/A_PurchaseOrder', method: 'GET', secrets,
        query: `$filter=Supplier eq '${row.BusinessPartner}' and PurchasingProcessingStatus eq '01'&$top=1&$expand=to_PurchaseOrderItem`,
      });
      const order = (pos.results || [pos])[0];
      if (!order) throw new Error(`No open purchase order found in SAP for vendorId "${vendorId}"`);

      const items = (order.to_PurchaseOrderItem?.results || []).map((item, i) => ({
        line: Number(item.PurchaseOrderItem) || (i + 1) * 10,
        materialCode: item.Material,
        description: item.PurchaseOrderItemText,
        quantity: Number(item.OrderQuantity),
        grnQuantity: 0,
        unitPrice: Number(item.NetPriceAmount),
        netValue: Number(item.NetPriceAmount) * Number(item.OrderQuantity),
        uom: item.PurchaseOrderQuantityUnit || 'EA',
      }));

      return {
        data: {
          sapPoNumber: order.PurchaseOrder,
          buyerName: order.CreatedByUser || 'SAP',
          plant: items[0]?.plant || plant,
          paymentTerms: order.PaymentTerms || 'NET 30 Days',
          currency: order.DocumentCurrency || 'INR',
          deliveryAddress: order.SupplyingPlant || `Plant ${plant}`,
          items,
        },
        log: null, // logged once the PO has a per-tenant id, by poProvisioned
      };
    },

    poProvisioned: async ({ po, vendorId }) => ({
      data: {},
      log: { vendorId, payload: po, documentRef: po.id },
    }),

    // No standard field for "supplier acknowledged this PO" — S/4's own
    // confirmation control is buyer-side (inbound confirmations from a
    // supplier normally arrive via ASN, not a PO flag). Writes a configurable
    // field so this can point at whatever ABAP exposes for it (an extension
    // field, or nothing at all if the client is content to treat ASN
    // submission as the acknowledgement).
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

    deliveryCreate: async ({ asn, po, vendorId }) => {
      const created = await odata.call({
        service: svc.inboundDelivery, path: '/A_InboundDelivery', method: 'POST', secrets,
        body: {
          DeliveryDate: asn.shipDate,
          ShippingPoint: config.shippingPoint || plant,
          to_InboundDeliveryItem: {
            results: asn.items.map((item) => ({
              PurchaseOrder: po?.sapPoNumber, PurchaseOrderItem: String(item.line).padStart(5, '0'),
              Material: item.materialCode, DeliveryQuantity: item.shippedQuantity,
              DeliveryQuantityUnit: item.uom || 'EA',
            })),
          },
        },
      });
      const sapInboundDelivery = created.InboundDelivery;
      return {
        data: { sapInboundDelivery },
        log: {
          vendorId: vendorId || po?.vendorId,
          payload: { inboundDelivery: sapInboundDelivery, shipDate: asn.shipDate, carrier: asn.carrierName, tracking: asn.trackingNumber, items: asn.items },
          documentRef: asn.id,
        },
      };
    },

    // MIGO happens on SAP's own schedule; there is no push in scope here, so
    // this polls for a goods movement referencing the inbound delivery. Only
    // total received quantity is standard on this API — accepted/rejected
    // split needs the QM inspection-lot API (API_INSPECTIONLOT), which is a
    // separate integration; until that's wired in, everything received is
    // reported accepted (no false rejections, at the cost of not surfacing
    // real ones either — flag this to MM if quality inspection matters here).
    awaitGoodsReceipt: ({ asn, po, vendorId }, handler) => {
      poll({
        intervalMs: pollIntervalMs,
        timeoutMs: goodsReceiptTimeoutMs,
        label: `goods receipt (${asn.id})`,
        check: async () => {
          const docs = await odata.call({
            service: svc.materialDocument, path: '/A_MaterialDocumentItem', method: 'GET', secrets,
            query: `$filter=ReferenceDocument eq '${asn.sapInboundDelivery || ''}'&$top=99`,
          });
          const rows = docs.results || (docs.MaterialDocument ? [docs] : []);
          return rows.length ? rows : null;
        },
        onFound: (rows) => {
          const header = rows[0];
          const items = asn.items.map((item, i) => {
            const row = rows.find((r) => Number(r.PurchaseOrderItem) === item.line) || rows[i];
            const received = Number(row?.QuantityInEntryUnit ?? item.shippedQuantity);
            return {
              line: item.line, materialCode: item.materialCode, description: item.description,
              receivedQuantity: received, acceptedQuantity: received, rejectedQuantity: 0,
              uom: item.uom || 'EA',
            };
          });

          handler({
            data: {
              grnId: `GRN-${header.MaterialDocument}`,
              sapMigoDoc: header.MaterialDocument,
              postingDate: header.PostingDate ? new Date(header.PostingDate) : new Date(),
              receivedBy: header.EnteredByUser || 'SAP',
              items,
            },
            logs: (answer, grn) => [
              { transaction: 'GOODS_RECEIPT', vendorId: vendorId || asn.vendorId, payload: grn, documentRef: grn.id },
              { transaction: 'GOODS_RECEIPT_READ', vendorId: vendorId || asn.vendorId, payload: { migoDoc: grn.sapMigoDoc, items: grn.items }, documentRef: grn.id },
            ],
          });
        },
        onTimeout: () => logger.error(`[sap:s4_odata] goods receipt poll for ASN ${asn.id} timed out — no material document found referencing inbound delivery ${asn.sapInboundDelivery}`),
      });
    },

    // --- Invoice and payment --------------------------------------------

    // Encodes SupplierInvoice+FiscalYear (the entity's real composite key)
    // into the single sapMiroDoc string this app's schema has room for, since
    // awaitPaymentRun below needs both to look the document back up.
    invoiceCreate: async ({ invoice, vendorId }) => {
      const created = await odata.call({
        service: svc.supplierInvoice, path: '/A_SupplierInvoice', method: 'POST', secrets,
        body: {
          InvoicingParty: vendorId,
          DocumentDate: invoice.invoiceDate,
          PostingDate: new Date(),
          CompanyCode: companyCode,
          DocumentCurrency: invoice.currency,
          InvoiceGrossAmount: invoice.totalAmount,
          to_SupplierInvoiceItemPurOrdRef: {
            results: invoice.items.map((item) => ({
              PurchaseOrder: item.poId, Material: item.materialCode,
              QuantityInPurchaseOrderUnit: item.quantity, SupplierInvoiceItemAmount: item.amount,
            })),
          },
        },
      });
      const sapMiroDoc = `${created.SupplierInvoice}/${created.FiscalYear}`;
      return {
        data: { sapMiroDoc },
        log: {
          vendorId,
          payload: { supplierInvoice: created.SupplierInvoice, fiscalYear: created.FiscalYear, companyCode, currency: invoice.currency, grossAmount: invoice.totalAmount, items: invoice.items },
          documentRef: invoice.id,
        },
      };
    },

    // Polls the invoice's IsCleared flag for the F110 result. Bank-side detail
    // (UTR, bank name, payment method) isn't on the Supplier Invoice API at
    // all — it lives in the house bank / payment medium data F110 produces,
    // which needs its own API (or a bank statement feed) wired in separately.
    // TDS section/deductee detail similarly needs the withholding-tax
    // reporting API if Section 194C matters for the client's filings. Both are
    // left blank rather than invented, with a clear note for MM to size that
    // follow-up work.
    awaitPaymentRun: ({ invoice, vendor, vendorId }, handler) => {
      const [supplierInvoice, fiscalYear] = String(invoice.sapMiroDoc || '').split('/');
      if (!supplierInvoice || !fiscalYear) {
        logger.error(`[sap:s4_odata] awaitPaymentRun: invoice ${invoice.id} has no parseable SupplierInvoice/FiscalYear in sapMiroDoc ("${invoice.sapMiroDoc}")`);
        return;
      }

      poll({
        intervalMs: pollIntervalMs,
        timeoutMs: paymentRunTimeoutMs,
        label: `payment run (${invoice.id})`,
        check: async () => {
          const doc = await odata.call({
            service: svc.supplierInvoice, method: 'GET', secrets,
            path: `/A_SupplierInvoice(SupplierInvoice='${supplierInvoice}',FiscalYear='${fiscalYear}')`,
          });
          return doc.IsCleared ? doc : null;
        },
        onFound: (doc) => handler({
          data: {
            paymentId: `PMT-${supplierInvoice}`,
            sapPaymentDoc: doc.ClearingAccountingDocument || null,
            runId: doc.PaymentRun || null,
            utrCode: doc.PaymentReference || null, // not a real UTR without the payment-medium API
            paymentDate: doc.ClearingDate ? new Date(doc.ClearingDate) : new Date(),
            paymentMethod: doc.PaymentMethod || null,
            bankName: null, // needs the house bank / payment medium API
            grossAmount: Number(doc.InvoiceGrossAmount),
            tdsDeducted: null, // needs the withholding-tax reporting API
            netAmount: Number(doc.InvoiceGrossAmount),
            tdsSection: null,
            deducteePan: vendor?.pan || null,
            deductorTan: null,
          },
          logs: (answer, payment) => [{
            transaction: 'PAYMENT_RUN', vendorId: vendorId || invoice.vendorId, payload: payment, documentRef: payment.id,
          }],
        }),
        onTimeout: () => logger.error(`[sap:s4_odata] payment run poll for invoice ${invoice.id} timed out — SupplierInvoice ${supplierInvoice}/${fiscalYear} never cleared`),
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
    { name: 'pollIntervalMs', label: 'Poll interval for deferred answers (ms)', type: 'number', default: 30000 },
    { name: 'services.sourcing', label: 'Custom RFQ/sourcing OData service path (no SAP standard)', type: 'text', placeholder: '/sap/opu/odata/sap/ZVENDORPORTAL_SOURCING_SRV' },
    { name: 'fields.poAcknowledgeField', label: 'PO field to set on supplier acknowledgement (extension field, optional)', type: 'text' },
  ],
};
