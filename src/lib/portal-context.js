'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
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

export function PortalProvider({ children }) {
  const shell = useShell();
  const profileHook = useProfile();
  const poHook = usePOs(profileHook.profile);
  const paymentHook = usePayments();
  const invoiceHook = useInvoices(profileHook.profile, poHook.setInvoiceSubmittedForGrn, paymentHook.addPayment);
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

    socket.on('chat:message', (msg) => {
      if (dashboardHook?.refreshChats) {
        dashboardHook.refreshChats();
      }
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
    chats: dashboardHook.chats,
    performance: dashboardHook.performance
  };

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [selectedRfqId, setSelectedRfqId] = useState(null);
  const [selectedPoId, setSelectedPoId] = useState(null);
  const [selectedGrnId, setSelectedGrnId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const [invoiceForm, setInvoiceForm] = useState({
    invoiceNumber: '', invoiceDate: ''
  });

  // Sync profile values
  useEffect(() => {
    if (state.profile.companyName) {
      Promise.resolve().then(() => {
        setCompanyForm({
          companyName: state.profile.companyName || '',
          tradeName: state.profile.tradeName || '',
          businessType: state.profile.businessType || '',
          incorporationDate: state.profile.incorporationDate || '',
          gstin: state.profile.gstin || '',
          gstType: state.profile.gstType || '',
          pan: state.profile.pan || '',
          cin: state.profile.cin || '',
          msmeNumber: state.profile.msmeNumber || '',
          tdsSection: state.profile.tdsSection || '',
          email: state.profile.email || '',
          phone: state.profile.phone || '',
          address: state.profile.address || '',
          city: state.profile.city || '',
          state: state.profile.state || '',
          postalCode: state.profile.postalCode || '',
          bankName: state.profile.bankName || '',
          accountNumber: state.profile.accountNumber || '',
          ifscCode: state.profile.ifscCode || '',
          accountName: state.profile.accountName || '',
          bankBranch: state.profile.bankBranch || '',
          cancelledCheque: state.profile.cancelledCheque || null,
          panCardCopy: state.profile.panCardCopy || null,
          gstCertificate: state.profile.gstCertificate || null,
          msmeCertificate: state.profile.msmeCertificate || null
        });
      });
    }
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
      addToast('success', `Your quote for ${rfqId} has been submitted.`);
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
      carrierName: asnForm.carrierName || 'BlueDart Express',
      trackingNumber: asnForm.trackingNumber || `BD-${Math.floor(100000 + Math.random() * 900000)}`,
      vehicleNumber: asnForm.vehicleNumber || `DL-01-CA-${Math.floor(1000 + Math.random() * 9000)}`,
      invoiceReference: asnForm.invoiceReference || `INV-${Math.floor(100000 + Math.random() * 900000)}`,
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

  const handleInvoiceSubmit = (grn) => {
    if (!invoiceForm.invoiceNumber || !invoiceForm.invoiceDate) {
      alert('Please enter Invoice Number and Billing Date.');
      return;
    }

    const items = grn.items.map(item => {
      const po = state.pos.find(p => p.id === grn.poId);
      const poItem = po?.items.find(pi => pi.line === item.line);
      const unitPrice = poItem?.unitPrice || 0;
      return {
        line: item.line,
        materialCode: item.materialCode,
        description: item.description,
        quantity: item.acceptedQuantity,
        unitPrice,
        amount: item.acceptedQuantity * unitPrice
      };
    });

    const subTotal = items.reduce((sum, item) => sum + item.amount, 0);
    const taxAmount = Number((subTotal * 0.18).toFixed(2));
    const totalAmount = Number((subTotal + taxAmount).toFixed(2));

    setIsSubmitting(true);

    setTimeout(() => {
      invoiceHook.submitInvoice({
        grnId: grn.id,
        poId: grn.poId,
        invoiceNumber: invoiceForm.invoiceNumber,
        invoiceDate: invoiceForm.invoiceDate,
        subTotal,
        taxAmount,
        totalAmount,
        items
      });
      setIsSubmitting(false);
      setSelectedGrnId(null);
      setInvoiceForm({ invoiceNumber: '', invoiceDate: '' });
      setActiveTab('invoices');

      // MOCK — replace with real SAP payment-run polling/webhook when SAP integration lands.
      // Backend (backend/controllers/invoice.controller.js submitInvoice) fakes the payment run
      // via a 12s setTimeout ([SIMULATOR] logs); this just refreshes state 1s after that fires.
      setTimeout(() => {
        console.log('[PortalContext] Fallback refresh for Payment simulation...');
        paymentHook.refreshPayments();
        invoiceHook.refreshInvoices();
        poHook.refreshPOs();
      }, 13000);
    }, 1500);
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
      dashboardHook.addSystemMessage(`Purchase Order ${result.po.id} has been created and dispatched to the awarded vendor.`);
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
        selectedGrnId,
        setSelectedGrnId,
        isSubmitting,
        setIsSubmitting,
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
        invoiceForm,
        setInvoiceForm,
        handleCompanySubmit,
        handleBidSubmit,
        handleSapQuotePriceUpdate,
        handleCreateRFQ,
        handleReissueRFQ,
        handleCancelRFQ,
        handleAsnSubmit,
        handleInvoiceSubmit,
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
