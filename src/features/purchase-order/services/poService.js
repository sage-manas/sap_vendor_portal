import { apiClient } from '../../../lib/api-client';

export const poService = {
  async getPOs(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiClient.get(`/pos${qs ? `?${qs}` : ''}`).catch(() => null);
  },

  async getPOById(poId) {
    return apiClient.get(`/pos/${poId}`).catch(() => null);
  },

  async acknowledgePO(poId) {
    return apiClient.put(`/pos/${poId}/acknowledge`, {});
  },

  /**
   * Raise an asset purchase order (account assignment A) in SAP.
   *
   * The only call in this application that creates a document in SAP rather
   * than reading or annotating one SAP already owns — see DECISIONS.md
   * ADR-0042. Deliberately not `.catch(() => null)` like the reads above: a
   * failure here has to reach the caller so the operator learns the order was
   * not created, instead of a silent null that looks like an empty result.
   */
  async createAssetPo(payload) {
    return apiClient.post('/pos/asset', payload);
  },

  async submitASN(poId, asnData) {
    return apiClient.post(`/pos/${poId}/asn`, asnData);
  },

  async getASNs() {
    return apiClient.get('/asns').catch(() => null);
  },

  async getGRNs() {
    return apiClient.get('/grns').catch(() => null);
  },

  /** Every PO SAP itself has for this vendor, with line items and GRNs nested in */
  async getSapStatus() {
    return apiClient.get('/pos/sap-status').catch(() => null);
  },

  // --- Invoicing plans (FPLA/FPLT) -----------------------------------------
  //
  // Reading a plan is part of reading the order, so every signed-in principal
  // who can see the PO can see it. The three writes below need `po:manage`,
  // which suppliers do not hold — the UI hides them, and the API refuses them.

  /** The invoicing plans on one order, with what is billable today */
  async getInvoicePlan(poId) {
    return apiClient.get(`/pos/${poId}/invoice-plan`);
  },

  async saveInvoicePlan(poId, line, plan) {
    return apiClient.put(`/pos/${poId}/items/${line}/invoice-plan`, plan);
  },

  async removeInvoicePlan(poId, line) {
    return apiClient.delete(`/pos/${poId}/items/${line}/invoice-plan`);
  },

  async setInvoicePlanLineBlock(poId, line, planLineNumber, blocked) {
    return apiClient.put(`/pos/${poId}/items/${line}/invoice-plan/lines/${planLineNumber}/block`, { blocked });
  },

  /** Re-read the plans SAP holds for this order and adopt them */
  async syncInvoicePlan(poId) {
    return apiClient.post(`/pos/${poId}/invoice-plan/sync`, {});
  }
};
