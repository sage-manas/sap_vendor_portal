'use client';

import { useState, useEffect } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { rfqService } from '../services/rfqService';

export function useRFQs(profile) {
  const [rfqs, setRfqs] = useState([]);
  const [sapRfqDocuments, setSapRfqDocuments] = useState(null);
  const [sapQuotationDocuments, setSapQuotationDocuments] = useState(null);

  const persistLocally = (updated) => {
    try {
      localStorage.setItem('sap_vendor_portal_rfqs', JSON.stringify(updated));
    } catch (e) {}
  };

  const refreshRFQs = async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await rfqService.getRFQs();
      if (data) {
        const rfqList = Array.isArray(data) ? data : (data.rfqs || []);
        setRfqs(rfqList);
        persistLocally(rfqList);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const refreshSapRfqStatus = async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await rfqService.getSapStatus();
      if (data) setSapRfqDocuments(data.documents);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshSapQuotations = async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await rfqService.getSapQuotations();
      if (data) setSapQuotationDocuments(data.documents);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshRFQs(), refreshSapRfqStatus(), refreshSapQuotations()]);
    })();
  }, [profile]);

  const submitBid = async (rfqId, unitPrices, leadTime, remarks, gstRate, validityDate, freight = 0, moq = 1, uploadedDocs = []) => {
    try {
      const bidData = {
        unitPrices,
        deliveryLeadTimeDays: leadTime,
        gstRate,
        freight,
        moq,
        validityDate,
        remarks,
        uploadedDocs
      };
      await rfqService.submitBid(rfqId, bidData);
      await refreshRFQs();
      return { success: true };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  };

  const updateSapQuotationPrice = async (rfqId, sapRfqNumber, items) => {
    try {
      const res = await rfqService.updateSapQuotationPrice(rfqId, sapRfqNumber, items);
      return { success: true, data: res };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  };

  const createRFQ = async (rfqData) => {
    try {
      const res = await rfqService.createRFQ(rfqData);
      await refreshRFQs();
      return { success: true, data: res };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  };

  const awardVendorBid = async (rfqId, vendorId) => {
    try {
      const res = await rfqService.awardBid(rfqId, vendorId);
      await refreshRFQs();
      return { success: true, po: res?.po || null };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message, po: null };
    }
  };

  const reissueRFQ = async (rfqId, newDeadline) => {
    try {
      await rfqService.reissueRFQ(rfqId, newDeadline);
      await refreshRFQs();
      return { success: true };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  };

  const cancelRFQ = async (rfqId) => {
    try {
      await rfqService.cancelRFQ(rfqId);
      await refreshRFQs();
      return { success: true };
    } catch (e) {
      console.error(e);
      return { success: false, error: e.message };
    }
  };

  return {
    rfqs,
    sapRfqDocuments,
    sapQuotationDocuments,
    submitBid,
    updateSapQuotationPrice,
    createRFQ,
    awardVendorBid,
    reissueRFQ,
    cancelRFQ,
    refreshRFQs
  };
}
