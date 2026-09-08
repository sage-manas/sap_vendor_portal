'use client';

import { useState, useEffect, useCallback } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { paymentService } from '../services/paymentService';

const STORAGE_KEY = 'sap_vendor_portal_payments';

export function usePayments() {
  const [payments, setPayments] = useState([]);
  // null until the first SAP read answers, so the UI can tell "still loading"
  // apart from "SAP has nothing for this vendor" — same convention useInvoices
  // uses for sapMiroDocuments.
  const [sapPayments, setSapPayments] = useState(null);
  // Same null-means-loading convention: a supplier with no deductions yet and a
  // supplier whose summary has not arrived are different empty states.
  const [tdsSummary, setTdsSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const persistLocally = useCallback((updated) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch (_) {}
  }, []);

  const refreshPayments = useCallback(async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) {
      setLoading(false);
      return;
    }
    try {
      const data = await paymentService.getPayments();
      const paymentList = data && Array.isArray(data.payments) ? data.payments : (Array.isArray(data) ? data : null);
      if (paymentList) {
        setPayments(paymentList);
        persistLocally(paymentList);
      }
    } catch (_) {
      try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (cached) setPayments(JSON.parse(cached));
      } catch (_) {}
    } finally {
      setLoading(false);
    }
  }, [persistLocally]);

  const refreshSapPayments = useCallback(async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await paymentService.getSapStatus();
      if (data && Array.isArray(data.payments)) setSapPayments(data.payments);
    } catch (_) {}
  }, []);

  const refreshTdsSummary = useCallback(async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await paymentService.getTdsSummary();
      if (data && Array.isArray(data.quarters)) setTdsSummary(data);
    } catch (_) {}
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshPayments(), refreshSapPayments(), refreshTdsSummary()]);
    })();
  }, [refreshPayments, refreshSapPayments, refreshTdsSummary]);

  const addPayment = useCallback((newPayment) => {
    setPayments(prev => {
      const updated = [newPayment, ...prev];
      persistLocally(updated);
      paymentService.createPayment(newPayment).catch(() => {});
      return updated;
    });
  }, [persistLocally]);

  const updatePaymentStatus = useCallback((paymentId, status) => {
    setPayments(prev => {
      const updated = prev.map(p =>
        p.id === paymentId ? { ...p, status, updatedAt: new Date().toISOString() } : p
      );
      persistLocally(updated);
      paymentService.updatePaymentStatus(paymentId, status).catch(() => {});
      return updated;
    });
  }, [persistLocally]);

  return {
    payments,
    sapPayments,
    tdsSummary,
    loading,
    addPayment,
    updatePaymentStatus,
    refreshPayments,
    refreshSapPayments,
    refreshTdsSummary
  };
}
