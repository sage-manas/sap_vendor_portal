'use client';

import { useState, useEffect } from 'react';
import { useShell } from '../../../lib/shell-context';
import { hasOwnChrome } from '../../../lib/planes';
import { rfqService } from '../services/rfqService';

export function useRFQs(profile) {
  const { addSapLog } = useShell();
  const [rfqs, setRfqs] = useState([]);

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

  useEffect(() => {
    refreshRFQs();
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
    submitBid,
    createRFQ,
    awardVendorBid,
    reissueRFQ,
    cancelRFQ,
    refreshRFQs
  };
}
