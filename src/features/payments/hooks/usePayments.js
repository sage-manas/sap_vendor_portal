'use client';

import { useState, useEffect, useCallback } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { paymentService } from '../services/paymentService';

const STORAGE_KEY = 'sap_vendor_portal_payments';

export function usePayments() {
  const [payments, setPayments] = useState([]);
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

  useEffect(() => {
    refreshPayments();
  }, [refreshPayments]);

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
    loading,
    addPayment,
    updatePaymentStatus,
    refreshPayments
  };
}
