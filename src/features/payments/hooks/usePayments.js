'use client';

import { useState, useEffect, useCallback } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { paymentService } from '../services/paymentService';

const STORAGE_KEY = 'sap_vendor_portal_payments';

export function usePayments(profile) {
  // null until the first fetch answers, so the dashboard can tell "still
  // loading" apart from "this vendor really has no payments" — the same
  // convention as sapPayments/tdsSummary below. Rendering [] as the initial
  // value made the first paint after sign-in indistinguishable from a
  // confirmed empty history (issue #111).
  const [payments, setPayments] = useState(null);
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
    // profile is the trigger, not an input to the fetch itself: it goes from
    // null to the signed-in vendor's profile once sign-in completes and
    // PortalProvider re-renders with it, which is the only thing that changes
    // here (the useCallbacks above are stable). Without it in the dependency
    // list this effect ran exactly once, on the /sign-in mount, before a
    // token existed — and never again (issue #111).
  }, [profile, refreshPayments, refreshSapPayments, refreshTdsSummary]);

  const addPayment = useCallback((newPayment) => {
    setPayments(prev => {
      const updated = [newPayment, ...(prev || [])];
      persistLocally(updated);
      paymentService.createPayment(newPayment).catch(() => {});
      return updated;
    });
  }, [persistLocally]);

  return {
    payments,
    sapPayments,
    tdsSummary,
    loading,
    addPayment,
    refreshPayments,
    refreshSapPayments,
    refreshTdsSummary
  };
}
