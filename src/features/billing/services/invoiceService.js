import { apiClient } from '../../../lib/api-client';

export const invoiceService = {
  async getInvoices(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiClient.get(`/invoices${qs ? `?${qs}` : ''}`).catch(() => null);
  },

  async getInvoiceById(invoiceId) {
    return apiClient.get(`/invoices/${invoiceId}`).catch(() => null);
  },

  async createInvoice(invoiceData) {
    return apiClient.post('/invoices', invoiceData).catch(() => null);
  },

  async updateInvoiceStatus(invoiceId, status) {
    return apiClient.put(`/invoices/${invoiceId}/status`, { status }).catch(() => null);
  },

  /** Cross-checks our invoice records against what SAP itself has posted (MIRO) for this vendor */
  async getSapStatus() {
    return apiClient.get('/invoices/sap-status').catch(() => null);
  }
};
