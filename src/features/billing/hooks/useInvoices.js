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
  // Whether the MIRO cross-check was answered at all — 'loading' | 'ready' |
  // 'error' — because an unanswered check and an empty answer are different
  // things to tell a supplier. The same signal usePOs.js already keeps for
  // the PO/GRN ledger; without it `sapMiroDocuments === null` means both
  // "still asking" and "the ask failed", and the Confirmed column spins
  // forever on a failure (issue #300).
  const [sapMiroStatus, setSapMiroStatus] = useState('loading');

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
    setSapMiroStatus('loading');
    try {
      const data = await invoiceService.getSapStatus();
      // `data` is null for a connectivity error (api-client's convention) and
      // for anything invoiceService's own catch swallowed. A body without
      // `documents` is a contract change, not an empty ledger — say so rather
      // than rendering it as "nothing on file". Mirrors usePOs.js.
      if (!data || !Array.isArray(data.documents)) {
        setSapMiroStatus('error');
        return;
      }
      setSapMiroDocuments(data.documents);
      setSapPaymentDetails(data.paymentDetails || {});
      setSapMiroStatus('ready');
    } catch (e) {
      console.error('Failed to fetch SAP MIRO status', e);
      setSapMiroStatus('error');
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
    sapMiroStatus,
    sapPaymentDetails,
    refreshInvoices,
    retrySapMiroStatus: refreshSapMiroStatus
  };
}
