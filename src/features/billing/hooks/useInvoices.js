'use client';

import { useState, useEffect } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { fetchAllPages } from '../../../lib/fetchAllPages';
import { invoiceService } from '../services/invoiceService';

export function useInvoices(profile) {
  const [invoices, setInvoices] = useState([]);
  // Has the first fetch finished, whatever it found? `invoices` cannot answer
  // that: [] is both "not asked yet" and "this supplier has none". A screen
  // that wants to show a skeleton needs the real signal, not a timer — the
  // Overview used to fake one for a fixed 1.2 s on every mount (issue #289).
  // Set on *settling*, so a failed fetch stops the skeleton too.
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const [sapMiroDocuments, setSapMiroDocuments] = useState(null);
  const [sapPaymentDetails, setSapPaymentDetails] = useState(null);

  const persistLocally = (updated) => {
    try {
      localStorage.setItem('sap_vendor_portal_invoices', JSON.stringify(updated));
    } catch (e) {}
  };

  const refreshInvoices = async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) {
      // Nothing will be fetched, so nothing is pending: a caller waiting on
      // this must not wait forever.
      setInvoicesLoaded(true);
      return;
    }
    try {
      // Every page: the ageing table and the account ledger are per-invoice
      // rows, and both used to cover one page of this list (issue #280).
      const result = await fetchAllPages((params) => invoiceService.getInvoices(params), 'invoices');
      if (result) {
        setInvoices(result.rows);
        persistLocally(result.rows);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setInvoicesLoaded(true);
    }
  };

  const refreshSapMiroStatus = async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await invoiceService.getSapStatus();
      if (data) {
        setSapMiroDocuments(data.documents);
        setSapPaymentDetails(data.paymentDetails || {});
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    void (async () => {
      await Promise.all([refreshInvoices(), refreshSapMiroStatus()]);
    })();
  }, [profile]);

  return {
    invoices,
    invoicesLoaded,
    sapMiroDocuments,
    sapPaymentDetails,
    refreshInvoices
  };
}
