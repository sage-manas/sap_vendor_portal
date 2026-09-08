'use client';

import { useState, useEffect } from 'react';
import { hasOwnChrome } from '../../../lib/planes';
import { invoiceService } from '../services/invoiceService';

// Pure helper functions outside the hook to prevent React purity linter checks
const generateSapMiroDoc = () => `510560${Math.floor(1000 + Math.random() * 9000)}`;
const generateInvoiceId = () => `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const generatePaymentId = () => `PAY-${Math.floor(100000 + Math.random() * 900000)}`;
const generateUtrCode = () => `UTR${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 8)}${Math.floor(1000 + Math.random() * 9000)}`;
const generateSapPaymentDoc = () => `20005${Math.floor(10000 + Math.random() * 90000)}`;

export function useInvoices(profile, setInvoiceSubmittedForGrn, addPayment) {
  const [invoices, setInvoices] = useState([]);
  const [sapMiroDocuments, setSapMiroDocuments] = useState(null);
  const [sapPaymentDetails, setSapPaymentDetails] = useState(null);

  const persistLocally = (updated) => {
    try {
      localStorage.setItem('sap_vendor_portal_invoices', JSON.stringify(updated));
    } catch (e) {}
  };

  const refreshInvoices = async () => {
    if (typeof window !== 'undefined' && (!localStorage.getItem('jwt_token') || hasOwnChrome(window.location.pathname))) return;
    try {
      const data = await invoiceService.getInvoices();
      if (data && data.invoices) {
        setInvoices(data.invoices);
        persistLocally(data.invoices);
      }
    } catch (e) {
      console.error(e);
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

  const submitInvoice = async (invoiceData) => {
    try {
      await invoiceService.createInvoice(invoiceData);
      refreshInvoices();
      if (setInvoiceSubmittedForGrn) {
        setInvoiceSubmittedForGrn(invoiceData.grnId);
      }
    } catch (e) {
      console.error(e);
    }
  };

  return {
    invoices,
    sapMiroDocuments,
    sapPaymentDetails,
    submitInvoice,
    refreshInvoices
  };
}
