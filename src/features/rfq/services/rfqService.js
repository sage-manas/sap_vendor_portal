import { apiClient } from '../../../lib/api-client';

export const rfqService = {
  async getRFQs(params = {}) {
    const qs = new URLSearchParams({ all: 'true', ...params }).toString();
    return apiClient.get(`/rfqs?${qs}`).catch(() => null);
  },

  async getRFQById(rfqId) {
    return apiClient.get(`/rfqs/${rfqId}`).catch(() => null);
  },

  async createRFQ(rfqData) {
    return apiClient.post('/rfqs', rfqData);
  },

  async submitBid(rfqId, bidData) {
    return apiClient.post(`/rfqs/${rfqId}/bid`, bidData);
  },

  async awardBid(rfqId, vendorId) {
    return apiClient.post(`/rfqs/${rfqId}/award`, { vendorId });
  },

  async reissueRFQ(rfqId, newDeadline) {
    return apiClient.put(`/rfqs/${rfqId}/reissue`, { deadlineDate: newDeadline });
  },

  async cancelRFQ(rfqId) {
    return apiClient.put(`/rfqs/${rfqId}/cancel`, {});
  },

  /** What SAP itself has issued to this vendor (ME43 Display RFQ) */
  async getSapStatus() {
    return apiClient.get('/rfqs/sap-status').catch(() => null);
  },

  /**
   * Every purchasing document SAP holds on this vendor's code (ME48). The
   * endpoint is named for quotations but returns POs too, so each row carries
   * a documentType; pass one to filter server-side.
   */
  async getSapQuotations(documentType) {
    const query = documentType ? `?type=${encodeURIComponent(documentType)}` : '';
    return apiClient.get(`/rfqs/sap-quotations${query}`).catch(() => null);
  },

  /**
   * Push an updated net price for a SAP-native quotation document (ME47,
   * ZQUOT_NETPR/QUOT_UPDPR) — a real SAP write. `rfqId` is the portal RFQ
   * whose line numbers the prices are keyed against; `sapRfqNumber` is the
   * SAP document (ebeln) from the My Documents tab.
   */
  async updateSapQuotationPrice(rfqId, sapRfqNumber, items) {
    return apiClient.post(`/rfqs/${rfqId}/sap-quote-price`, { sapRfqNumber, items });
  },

  /**
   * The export bridge (Phase 5.2): a downloadable file for the awarded PO —
   * csv | xlsx | json | idoc — for the buyer's own team to import into SAP
   * on their own schedule. Not a live SAP write.
   */
  async downloadPoExport(rfqId, format = 'csv') {
    const { blob, filename } = await apiClient.getBlob(`/rfqs/${rfqId}/export?format=${format}`);
    if (typeof window === 'undefined') return;
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }
};
