'use client';

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { useShell } from '@/lib/shell-context';
import { useProfile } from '@/features/profile/hooks/useProfile';
import { useRFQs } from '@/features/rfq/hooks/useRFQs';
import { usePOs } from '@/features/purchase-order/hooks/usePOs';
import { useInvoices } from '@/features/billing/hooks/useInvoices';
import { usePayments } from '@/features/payments/hooks/usePayments';
import { useDashboard } from '@/features/dashboard/hooks/useDashboard';
import { usePathname, useRouter } from 'next/navigation';
import { initSocket, closeSocket } from '@/lib/socket';
import { isPlatformPath, isAuthPath } from '@/lib/planes';
import { useWhoami } from '@/lib/whoami';

// Where an account on a provisioned temporary password is sent until it is
// replaced. Not an auth path — it needs a session — so the redirect below has to
// exempt it explicitly or it would bounce against itself.
const CHANGE_PASSWORD_PATH = '/change-password';
import ToastNotification from '@/components/portal/ToastNotification';

const PortalContext = createContext(undefined);

// Every field the registration form edits that the vendor record stores.
const REGISTRATION_FORM_FIELDS = [
  'companyName', 'tradeName', 'businessType', 'incorporationDate',
  'gstin', 'gstType', 'pan', 'cin', 'msmeNumber', 'tdsSection',
  'email', 'phone', 'address', 'city', 'state', 'country', 'region', 'postalCode',
  'paymentTerms', 'paymentMethod', 'currency', 'incoterms1', 'incoterms2',
  'doubleInvoiceCheck', 'grBasedInvoiceVerification',
  'bankName', 'accountNumber', 'ifscCode', 'accountName', 'bankBranch',
  'cancelledCheque', 'panCardCopy', 'gstCertificate', 'msmeCertificate',
];

export function PortalProvider({ children }) {
  const shell = useShell();
  const profileHook = useProfile();
  const poHook = usePOs(profileHook.profile);
  const paymentHook = usePayments(profileHook.profile);
  const invoiceHook = useInvoices(profileHook.profile);
  const rfqHook = useRFQs(profileHook.profile);
  const dashboardHook = useDashboard(profileHook.profile);

  const [toasts, setToasts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const addToast = (type, message) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message }]);
    setNotifications(prev => [
      { id, type, message, timestamp: new Date().toISOString(), read: false },
      ...prev
    ].slice(0, 30));
  };
  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };
  const markNotificationsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };
  const clearNotifications = () => {
    setNotifications([]);
  };

  const pathname = usePathname();
  const router = useRouter();
  const { mustChangePassword } = useWhoami();

  // Redirect to sign-in if no token is found and not on auth pages
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('jwt_token');
      const isAuthPage = isAuthPath(pathname);
      // The platform console has its own session and its own sign-in flow;
      // bouncing an operator to the supplier login would be nonsense.
      if (!token && !isAuthPage && !isPlatformPath(pathname)) {
        router.push('/sign-in');
      }
    }
  }, [pathname, router]);

  // An account still on the temporary password it was provisioned with finishes
  // that before anything else. The platform console enforces the same rule in
  // its own gate; this covers the supplier portal and the tenant workspace,
  // which share this provider and this session.
  useEffect(() => {
    if (!mustChangePassword) return;
    if (isPlatformPath(pathname) || isAuthPath(pathname)) return;
    if (pathname === CHANGE_PASSWORD_PATH) return;
    router.push(CHANGE_PASSWORD_PATH);
  }, [mustChangePassword, pathname, router]);

  // Multi-tab storage sync: logout if jwt_token is removed in another tab
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleStorageChange = (e) => {
      if (e.key === 'jwt_token' && !e.newValue) {
        router.push('/sign-in');
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [router]);

  const logout = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('jwt_token');
      localStorage.removeItem('clerk_user_id');
      localStorage.removeItem('sap_vendor_profile_data');
    }
    router.push('/sign-in');
  };

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('jwt_token') : null;
    const vendorId = profileHook.profile?.vendorId;
    if (!token || !vendorId) return;

    console.log('[PortalContext] Initializing WebSockets connection for vendor:', vendorId);
    const socket = initSocket(token, vendorId);

    socket.on('po:new', (po) => {
      poHook.refreshPOs();
      addToast('info', `New Purchase Order received! ID: ${po.id}`);
    });

    socket.on('grn:received', (grn) => {
      poHook.refreshGRNs();
      poHook.refreshPOs();
      poHook.refreshASNs();
      addToast('success', `Delivery confirmed for order ${grn.poId}. Your buyer has accepted the goods.`);
    });

    socket.on('payment:cleared', (pmt) => {
      paymentHook.refreshPayments();
      paymentHook.refreshSapPayments();
      invoiceHook.refreshInvoices();
      addToast('success', `Payment cleared! UTR: ${pmt.utrCode} · Net Amount: ₹${pmt.netAmount.toLocaleString('en-IN')}`);
    });

    return () => {
      closeSocket();
    };
  }, [profileHook.profile?.vendorId]);

  // Determine active tab from pathname
  const activeTab = pathname === '/' ? 'dashboard' : pathname.replace(/^\//, '');

  const setActiveTab = (tabId) => {
    if (tabId === 'dashboard') {
      router.push('/');
    } else {
      router.push(`/${tabId}`);
    }
  };

  // Legacy state object syntax mapping for component compatibility
  const state = {
    profile: profileHook.profile,
    rfqs: rfqHook.rfqs,
    sapRfqDocuments: rfqHook.sapRfqDocuments,
    sapQuotationDocuments: rfqHook.sapQuotationDocuments,
    pos: poHook.pos,
    sapPoOrders: poHook.sapPoOrders,
    sapPoStatus: poHook.sapPoStatus,
    asns: poHook.asns,
    grns: poHook.grns,
    invoices: invoiceHook.invoices,
    sapMiroDocuments: invoiceHook.sapMiroDocuments,
    sapPaymentDetails: invoiceHook.sapPaymentDetails,
    payments: paymentHook.payments,
    sapPayments: paymentHook.sapPayments,
    tdsSummary: paymentHook.tdsSummary,
    performance: dashboardHook.performance
  };

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [selectedRfqId, setSelectedRfqId] = useState(null);
  const [selectedPoId, setSelectedPoId] = useState(null);
  // Forms states managed locally
  const [companyForm, setCompanyForm] = useState({
    companyName: '', tradeName: '', businessType: '', incorporationDate: '',
    gstin: '', gstType: '', pan: '', cin: '', msmeNumber: '', tdsSection: '',
    email: '', phone: '', address: '', city: '', state: '', country: '', region: '', postalCode: '',
    paymentTerms: '', paymentMethod: '', currency: '', incoterms1: '', incoterms2: '',
    doubleInvoiceCheck: false, grBasedInvoiceVerification: false,
    bankName: '', accountNumber: '', ifscCode: '', accountName: '', bankBranch: '',
    cancelledCheque: null, panCardCopy: null, gstCertificate: null, msmeCertificate: null
  });

  const [bidPrices, setBidPrices] = useState({});
  const [bidLeadTime, setBidLeadTime] = useState(7);
  const [bidRemarks, setBidRemarks] = useState('');

  const [asnForm, setAsnForm] = useState({
    carrierName: '', trackingNumber: '', vehicleNumber: '',
    invoiceReference: '', shipDate: '', estimatedDeliveryDate: '',
    items: {}
  });

  // Seed the registration form from the stored profile — once per supplier.
  //
  // This used to run on every change to `state.profile` and replace the whole
  // form. Every autosave and every profile refresh therefore threw away
  // whatever had been typed since the save left, and — because the replacement
  // listed only some fields — wiped country, region and the trade terms each
  // time, so a supplier who picked India / Maharashtra watched both blank out
  // again a second later. Now the form is seeded when a supplier's profile
  // first arrives and merged over what is already there; after that the form
  // is the source of truth until it is submitted.
  const seededFormFor = useRef(null);
  useEffect(() => {
    const profile = state.profile;
    if (!profile.companyName || !profile.vendorId || seededFormFor.current === profile.vendorId) return;
    seededFormFor.current = profile.vendorId;

    const seeded = Object.fromEntries(
      REGISTRATION_FORM_FIELDS
        .filter((field) => profile[field] !== undefined && profile[field] !== null && profile[field] !== '')
        .map((field) => [field, profile[field]])
    );
    Promise.resolve().then(() => {
      setCompanyForm((prev) => ({ ...prev, ...seeded }));
    });
  }, [state.profile]);

  // Form Submit Handlers
  const handleCompanySubmit = (e) => {
    e.preventDefault();
    if (!companyForm.companyName || !companyForm.gstin || !companyForm.email) {
      alert('Please fill in all required fields (Company Name, GSTIN, and Contact Email).');
      return;
    }
    profileHook.submitRegistration(companyForm);
    setActiveTab('registration');
  };

  const handleBidSubmit = async (rfqId, prices, leadTime, remarks, gstRate, validityDate, freight, moq, docs) => {
    const result = await rfqHook.submitBid(rfqId, prices, leadTime, remarks, gstRate, validityDate, freight, moq, docs);
    setSelectedRfqId(null);
    if (result.success) {
      // sapSync.attempted is false for an RFQ with no SAP document to push
      // to (a portal-only RFQ) — the quote submission is exactly as
      // successful either way, so that case gets the plain message, not a
      // warning about something that was never possible.
      const { sapSync } = result;
      if (sapSync?.attempted && !sapSync.success) {
        addToast('warning', `Your quote for ${rfqId} has been submitted, but it could not be pushed to SAP: ${sapSync.message || 'unknown error'}.`);
      } else if (sapSync?.attempted && sapSync.success) {
        addToast('success', `Your quote for ${rfqId} has been submitted and pushed to SAP.`);
      } else {
        addToast('success', `Your quote for ${rfqId} has been submitted.`);
      }
    } else {
      addToast('error', result.error || `Failed to submit quotation for ${rfqId}.`);
    }
    return result;
  };

  const handleSapQuotePriceUpdate = async (rfqId, sapRfqNumber, items) => {
    const result = await rfqHook.updateSapQuotationPrice(rfqId, sapRfqNumber, items);
    if (result.success) {
      addToast('success', `Net price for ${sapRfqNumber} updated in SAP.`);
    } else {
      addToast('error', result.error || `Failed to update the price for ${sapRfqNumber} in SAP.`);
    }
    return result;
  };

  const handleCreateRFQ = async (rfqData) => {
    const result = await rfqHook.createRFQ(rfqData);
    if (result.success) {
      addToast('success', `Request for quotation ${rfqData.id} has been created and sent to suppliers.`);
    } else {
      addToast('error', result.error || 'Failed to create RFQ.');
    }
    return result;
  };

  const handleReissueRFQ = async (rfqId, newDeadline) => {
    const result = await rfqHook.reissueRFQ(rfqId, newDeadline);
    if (result.success) {
      addToast('success', `RFQ ${rfqId} successfully re-issued with new deadline: ${newDeadline}. Bids have been reset.`);
    } else {
      addToast('error', result.error || `Failed to reissue RFQ ${rfqId}.`);
    }
    return result;
  };

  const handleCancelRFQ = async (rfqId) => {
    const result = await rfqHook.cancelRFQ(rfqId);
    if (result.success) {
      addToast('success', `RFQ ${rfqId} has been cancelled.`);
    } else {
      addToast('error', result.error || `Failed to cancel RFQ ${rfqId}.`);
    }
    return result;
  };

  const handleAsnSubmit = async (po) => {
    const items = po.items.map(item => ({
      line: item.line,
      shippedQuantity: Number(asnForm.items[item.line] || item.quantity)
    }));

    const res = await poHook.submitASN({
      poId: po.id,
      shipDate: asnForm.shipDate || new Date().toISOString().split('T')[0],
      estimatedDeliveryDate: asnForm.estimatedDeliveryDate || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      // Blank stays blank: these are the supplier's document references, and
      // the API accepts every one of them as optional.
      carrierName: asnForm.carrierName || undefined,
      trackingNumber: asnForm.trackingNumber || undefined,
      vehicleNumber: asnForm.vehicleNumber || undefined,
      invoiceReference: asnForm.invoiceReference || undefined,
      ewayBillNo: po.ewayBillNo || '',
      documentIds: po.documentIds || [],
      items
    });

    setSelectedPoId(null);
    setAsnForm({
      carrierName: '', trackingNumber: '', vehicleNumber: '',
      invoiceReference: '', shipDate: '', estimatedDeliveryDate: '',
      items: {}
    });

    // MOCK — replace with real GRN/MIGO poll/webhook when SAP integration lands.
    // Backend (backend/controllers/po.controller.js submitASN) fakes goods receipt via a
    // 10s setTimeout ([SIMULATOR] logs); this just refreshes state 1s after that fires.
    setTimeout(() => {
      console.log('[PortalContext] Fallback refresh for GRN/MIGO simulation...');
      poHook.refreshPOs();
      poHook.refreshASNs();
      poHook.refreshGRNs();
    }, 11000);

    return res;
  };

  const handleResetDatabase = () => {
    if (confirm('Reset the portal back to its default demo data? This will clear all transactions.')) {
      dashboardHook.clearAllState();
      setActiveTab('dashboard');
    }
  };

  const awardVendorBidWrapper = async (rfqId, vendorId) => {
    const result = await rfqHook.awardVendorBid(rfqId, vendorId);
    if (result.success && result.po) {
      poHook.addPO(result.po);
      poHook.refreshPOs();
      addToast('success', `BAPI_PO_CREATE sync complete — RFQ ${rfqId} converted to Purchase Order ${result.po.id}.`);
    } else {
      addToast('error', result.error || `Failed to award bid and convert RFQ ${rfqId} to a Purchase Order.`);
    }
    return result;
  };

  return (
    <PortalContext.Provider
      value={{
        activeTab,
        setActiveTab,
        sidebarCollapsed,
        setSidebarCollapsed,
        state,
        profileHook,
        poHook,
        paymentHook,
        invoiceHook,
        rfqHook,
        dashboardHook,
        selectedRfqId,
        setSelectedRfqId,
        selectedPoId,
        setSelectedPoId,
        companyForm,
        setCompanyForm,
        bidPrices,
        setBidPrices,
        bidLeadTime,
        setBidLeadTime,
        bidRemarks,
        setBidRemarks,
        asnForm,
        setAsnForm,
        handleCompanySubmit,
        handleBidSubmit,
        handleSapQuotePriceUpdate,
        handleCreateRFQ,
        handleReissueRFQ,
        handleCancelRFQ,
        handleAsnSubmit,
        handleResetDatabase,
        logout,
        awardVendorBidWrapper,
        addToast,
        notifications,
        markNotificationsRead,
        clearNotifications
      }}
    >
      {children}
      <ToastNotification toasts={toasts} removeToast={removeToast} />
    </PortalContext.Provider>
  );
}

export function usePortal() {
  const context = useContext(PortalContext);
  if (context === undefined) {
    throw new Error('usePortal must be used within a PortalProvider');
  }
  return context;
}
