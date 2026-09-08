import { apiClient } from '../../../lib/api-client';

export const paymentService = {
  async getPayments(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiClient.get(`/payments${qs ? `?${qs}` : ''}`).catch(() => null);
  },

  async getPaymentById(paymentId) {
    return apiClient.get(`/payments/${paymentId}`).catch(() => null);
  },

  async createPayment(paymentData) {
    return apiClient.post('/payments', paymentData).catch(() => null);
  },

  async updatePaymentStatus(paymentId, status) {
    return apiClient.put(`/payments/${paymentId}/status`, { status }).catch(() => null);
  },

  /** SAP's own payment ledger for this vendor — cross-checks our records */
  async getSapStatus() {
    return apiClient.get('/payments/sap-status').catch(() => null);
  },

  /**
   * TDS deducted per fiscal quarter, from recorded payments. Not a Form 16A.
   * Pass `{ byVendor: true }` for a tenant-wide finance view broken out per
   * supplier instead of blended into one tenant-wide row per quarter — see
   * the comment on getTdsSummary in backend/controllers/payment.controller.js.
   */
  async getTdsSummary(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiClient.get(`/payments/tds-summary${qs ? `?${qs}` : ''}`).catch(() => null);
  }
};
