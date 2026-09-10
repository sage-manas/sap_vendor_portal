import React, { useState, useEffect } from 'react';
import {
  Clock,
  CheckCircle2,
  Percent,
  ClipboardList,
  Search,
  ChevronsLeft,
  Menu,
  Loader2,
  FileText,
  IndianRupee
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import SkeletonLoader from '@/components/shared/SkeletonLoader';
import ErrorBoundary from '@/components/ErrorBoundary';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import Modal from '@/components/ui/Modal';
import { rfqStatusVariant } from '@/lib/statusColors';
import { mergeSapDocuments, countByType, commonPurchasingOrg } from '@/lib/sapDocuments';
import { rfqService } from '../services/rfqService';

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  // If it's a full ISO string or contains T, split by T
  if (typeof dateStr === 'string' && dateStr.includes('T')) {
    dateStr = dateStr.split('T')[0];
  }
  // SAP's date fields (EKKO-BEDAT, via the ME43/ME48 reads) arrive as a bare
  // YYYYMMDD like 20251112, which Date() rejects outright.
  const sapDate = /^(\d{4})(\d{2})(\d{2})$/.exec(String(dateStr));
  if (sapDate) return `${sapDate[3]}.${sapDate[2]}.${sapDate[1]}`;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
};

// --- Redesigned components (matching vendor registration's numbered card style) ---
const SectionHeader = ({ title, number }) => (
  <div className="flex items-center gap-2.5 px-5 py-3 border-b border-border select-none">
    {number && (
      <span className="inline-flex items-center justify-center text-[11px] font-bold font-mono text-primary bg-primary/10 rounded px-2 py-1 tabular-nums shrink-0">
        {number}
      </span>
    )}
    <h3 className="text-[15px] font-bold text-text-primary">{title}</h3>
  </div>
);

// Bordered, numbered card wrapper for a form section
const FormSection = ({ number, title, children, className = '' }) => (
  <div className={`bg-surface border border-border rounded-xl shadow-xs ${className}`}>
    <SectionHeader number={number} title={title} />
    <div className="p-4">
      {children}
    </div>
  </div>
);

const EnterpriseCard = ({ label, required, children, error }) => (
  <div className={`p-4.5 border rounded-xl shadow-xs flex flex-col justify-between min-h-[110px] transition-all duration-200 ${error ? 'border-rose-500 ring-1 ring-rose-500/50 bg-rose-50/5' : 'border-border hover:border-border-em hover:shadow-xs bg-surface'
    }`}>
    <div className="flex justify-between items-center mb-1.5">
      <span className="text-xs font-medium text-text-secondary block select-none">{label} {required && <span className="text-rose-500 font-bold select-none ml-0.5">*</span>}</span>
    </div>
    <div className="flex-1 flex items-center w-full">
      {children}
    </div>
  </div>
);

const FIELD_INPUT_OVERRIDES = "[&_input]:!rounded-md [&_input]:!border [&_input]:!border-border [&_input]:!bg-surface [&_input]:!px-2.5 [&_input]:!py-1.5 [&_input]:!text-[13px] [&_input]:placeholder:!text-text-tertiary/50 [&_input]:placeholder:!font-semibold [&_input:focus]:!border-primary [&_input:focus]:!bg-surface [&_input:focus]:!outline-none [&_select]:!rounded-md [&_select]:!border [&_select]:!border-border [&_select]:!bg-surface [&_select]:!px-2.5 [&_select]:!py-1.5 [&_select]:!text-[13px] [&_select:focus]:!border-primary [&_select:focus]:!bg-surface [&_select:focus]:!outline-none [&_textarea]:!rounded-md [&_textarea]:!border [&_textarea]:!border-border [&_textarea]:!bg-surface [&_textarea]:!px-2.5 [&_textarea]:!py-1.5 [&_textarea]:!text-[13px] [&_textarea]:placeholder:!text-text-tertiary/50 [&_textarea]:placeholder:!font-semibold [&_textarea:focus]:!border-primary [&_textarea:focus]:!bg-surface [&_textarea:focus]:!outline-none";

const EnterpriseFieldCard = ({ label, required, error, hint, children }) => (
  <div className={`flex items-start gap-1.5 select-none w-full ${FIELD_INPUT_OVERRIDES}`}>
    <label className="text-[13px] font-semibold text-text-secondary shrink-0 w-28 pt-1.5" title={label}>
      {label} {required && <span className="text-rose-500 font-bold ml-0.5">*</span>}
    </label>
    <div className="flex-1 flex flex-col min-w-0">
      {children}
      {hint && !error && (
        <span className="text-[11px] text-text-tertiary mt-1">{hint}</span>
      )}
      {error && (
        <span className="text-[11px] font-bold text-rose-500 mt-1">{error}</span>
      )}
    </div>
  </div>
);

const SkeletonCard = () => (
  <div className="p-4.5 bg-surface border border-border rounded-xl flex flex-col justify-between min-h-[140px] animate-pulse">
    <div className="flex justify-between items-center">
      <div className="h-3.5 w-24 skeleton" />
      <div className="h-3.5 w-8 skeleton" />
    </div>
    <div className="h-9 w-full skeleton rounded-lg mt-2" />
    <div className="flex justify-between items-center pt-2 mt-3 border-t border-border">
      <div className="flex gap-1.5">
        <div className="h-4.5 w-10 skeleton rounded-full" />
        <div className="h-4.5 w-10 skeleton rounded-full" />
      </div>
      <div className="h-3 w-16 skeleton" />
    </div>
  </div>
);

const getInitialQuoteForm = () => ({
  rfqId: '',
  selectedLine: 10,
  quoteRef: '',
  quoteDate: new Date().toISOString().split('T')[0],
  validityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  unitPrice: '',
  gstRate: '18%',
  discount: '0',
  deliveryLeadTime: '7',
  freight: '0',
  incoterms: 'EXW'
});

const QUOTE_DRAFT_KEY = 'sap_vendor_portal_quote_draft';

const loadDraft = (key) => {
  if (typeof window === 'undefined') return null;
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : null;
  } catch (e) {
    return null;
  }
};

export default function RfqView({
  state,
  selectedRfqId,
  setSelectedRfqId,
  handleBidSubmit,
  handleSapQuotePriceUpdate,
  addToast
}) {
  const [isPageLoading, setIsPageLoading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsPageLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  const isApproved = state.profile.status === 'Approved';
  const currentVendorCode = state.profile.sapVendorCode || 'VND-CURRENT';

  // Tab selector: 'monitor' (RFQ list & history), 'me47' (Submit Quotation),
  // or 'me48' (what SAP itself holds against this vendor's code).
  const [activeProcTab, setActiveProcTab] = useState('monitor');
  const [listSearch, setListSearch] = useState('');
  const [showRfqList, setShowRfqList] = useState(true);

  const [isLoading, setIsLoading] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);

  // The export bridge (Phase 5.2): downloads the awarded PO as a file for
  // the buyer's own MM team to import into SAP on their own schedule — not
  // a live SAP write. `exportingFormat` tracks which of the four buttons is
  // in flight so only that one shows a spinner.
  const [exportingFormat, setExportingFormat] = useState(null);
  const handleExportPo = async (rfqId, format) => {
    setExportingFormat(format);
    try {
      await rfqService.downloadPoExport(rfqId, format);
    } catch (err) {
      addToast('error', err.message || 'Failed to export purchase order.');
    } finally {
      setExportingFormat(null);
    }
  };

  // Submit Quotation form states
  const [quoteForm, setQuoteForm] = useState(getInitialQuoteForm);

  const [quoteErrors, setQuoteErrors] = useState({});

  // The merged SAP ledger holds quotations and purchase orders together, so
  // the tab offers the same split (see lib/sapDocuments.js).
  const [documentTypeFilter, setDocumentTypeFilter] = useState('all');

  // "Update Price (ME47)" modal — pushes a net price for a SAP-native
  // quotation document. Line numbers/materials come from a portal RFQ the
  // vendor picks (the ones they already see in RFQ Monitor & History), since
  // SAP's own quotation display returns no line items to price against.
  const [priceUpdateDoc, setPriceUpdateDoc] = useState(null);
  const [priceUpdateRfqId, setPriceUpdateRfqId] = useState('');
  const [priceUpdatePrices, setPriceUpdatePrices] = useState({});
  const [priceUpdateLoading, setPriceUpdateLoading] = useState(false);

  const openPriceUpdate = (doc) => {
    setPriceUpdateDoc(doc);
    setPriceUpdateRfqId('');
    setPriceUpdatePrices({});
  };

  const closePriceUpdate = () => {
    if (priceUpdateLoading) return;
    setPriceUpdateDoc(null);
    setPriceUpdateRfqId('');
    setPriceUpdatePrices({});
  };

  const priceUpdateRfq = state.rfqs.find((r) => r.id === priceUpdateRfqId);

  const handlePriceUpdateRfqChange = (rfqId) => {
    setPriceUpdateRfqId(rfqId);
    const rfq = state.rfqs.find((r) => r.id === rfqId);
    if (!rfq) {
      setPriceUpdatePrices({});
      return;
    }
    // Pre-fill from this vendor's own bid on the RFQ, if one exists, else the
    // target reference price — either way the vendor edits before submitting.
    const ownBid = rfq.bids?.find((b) => b.vendorId === state.profile.vendorId);
    const prices = {};
    rfq.items.forEach((item) => {
      const existing = ownBid?.unitPrices?.[item.line] ?? ownBid?.unitPrices?.get?.(String(item.line));
      prices[item.line] = existing ?? item.targetPrice ?? '';
    });
    setPriceUpdatePrices(prices);
  };

  const submitPriceUpdate = async () => {
    if (!priceUpdateDoc || !priceUpdateRfq) return;
    const items = priceUpdateRfq.items
      .map((item) => ({ line: item.line, netPrice: Number(priceUpdatePrices[item.line]) }))
      .filter((item) => item.netPrice > 0);

    if (items.length === 0) {
      addToast('error', 'Enter a net price for at least one line item.');
      return;
    }

    setPriceUpdateLoading(true);
    const result = await handleSapQuotePriceUpdate(priceUpdateRfq.id, priceUpdateDoc.documentNumber, items);
    setPriceUpdateLoading(false);

    if (result?.success) {
      closePriceUpdate();
    }
  };

  useEffect(() => {
    if (activeProcTab === 'me47') {
      Promise.resolve().then(() => {
        setTabLoading(true);
      });
      const timer = setTimeout(() => setTabLoading(false), 800);
      return () => clearTimeout(timer);
    }
  }, [activeProcTab]);

  // Restore any locally saved draft after mount (client-only, so it can't
  // cause a server/client render mismatch during hydration).
  useEffect(() => {
    const quoteDraft = loadDraft(QUOTE_DRAFT_KEY);
    // Restoring a saved draft into the live form state. It cannot be the
    // initial useState value (localStorage is absent during the server render,
    // so hydration would mismatch) and it cannot be derived, because the form
    // is edited from fourteen other places afterwards. One extra render on
    // mount, not a cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (quoteDraft?.quoteForm) setQuoteForm(quoteDraft.quoteForm);
  }, []);

  // Submit the quotation (Submit Quotation tab)
  const handleQuotationSubmit = async (e) => {
    if (e) e.preventDefault();

    const errors = {};
    if (!quoteForm.rfqId) errors.rfqId = true;
    if (!quoteForm.quoteDate) errors.quoteDate = true;
    if (!quoteForm.validityDate) errors.validityDate = true;
    if (!quoteForm.unitPrice || Number(quoteForm.unitPrice) <= 0) errors.unitPrice = true;
    if (!quoteForm.gstRate) errors.gstRate = true;
    if (!quoteForm.deliveryLeadTime || Number(quoteForm.deliveryLeadTime) <= 0) errors.deliveryLeadTime = true;

    if (Object.keys(errors).length > 0) {
      setQuoteErrors(errors);
      alert('Please fill in all required fields correctly.');
      return;
    }

    setIsLoading(true);

    // Structure prices object mapping selected line number to unit price
    const prices = {
      [quoteForm.selectedLine]: Number(quoteForm.unitPrice)
    };

    // Formulate comments/remarks
    const remarks = `Quote Ref: ${quoteForm.quoteRef || 'N/A'} | Discount: ${quoteForm.discount || '0'}% | Incoterms: ${quoteForm.incoterms}`;

    const result = await handleBidSubmit(
      quoteForm.rfqId,
      prices,
      Number(quoteForm.deliveryLeadTime),
      remarks,
      quoteForm.gstRate,
      quoteForm.validityDate,
      Number(quoteForm.freight),
      1, // MOQ default
      [] // docs empty
    );

    setIsLoading(false);

    if (!result.success) {
      // Keep the form and draft intact so the user can retry without re-entering data.
      return;
    }

    try {
      localStorage.removeItem(QUOTE_DRAFT_KEY);
    } catch (err) {}

    // Reset form
    setQuoteForm(getInitialQuoteForm());
    setQuoteErrors({});
    setActiveProcTab('monitor');
  };


  if (isPageLoading) {
    return (
      <ErrorBoundary>
        <div className="card p-4 space-y-4">
          <SkeletonLoader type="table" rows={6} cols={5} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="space-y-4 max-w-full animate-fade-in pb-16">

      {/* PAGE HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4 select-none">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="page-title">RFQ Management</h2>
          </div>
          <div className="flex items-center gap-2 text-text-tertiary text-xs font-semibold">
            <span className="bg-surface2 border border-border text-text-secondary px-2 py-0.5 rounded font-mono uppercase tracking-wide">
              Procurement
            </span>
          </div>
        </div>
      </div>

      {/* PROCUREMENT SUB NAVIGATION */}
      <div className="flex items-center justify-between border-b border-border select-none bg-surface p-1 rounded-md shadow-xs">
        <div className="flex">
          <button
            onClick={() => { setActiveProcTab('monitor'); setListSearch(''); }}
            className={`pb-2.5 px-5 text-xs font-bold border-b-2 transition-colors duration-150 cursor-pointer flex items-center gap-2 ${activeProcTab === 'monitor'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-tertiary hover:text-text-primary'
              }`}
          >
            <ClipboardList className="size-4" /> RFQ Monitor &amp; History
          </button>
          <button
            onClick={() => { setActiveProcTab('me47'); setListSearch(''); }}
            className={`pb-2.5 px-5 text-xs font-bold border-b-2 transition-colors duration-150 cursor-pointer flex items-center gap-2 ${activeProcTab === 'me47'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-tertiary hover:text-text-primary'
              }`}
          >
            <Percent className="size-4" /> Submit Quotation
          </button>
          <button
            onClick={() => { setActiveProcTab('me48'); setListSearch(''); }}
            className={`pb-2.5 px-5 text-xs font-bold border-b-2 transition-colors duration-150 cursor-pointer flex items-center gap-2 ${activeProcTab === 'me48'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-tertiary hover:text-text-primary'
              }`}
          >
            <FileText className="size-4" /> My Documents
          </button>
        </div>
        {activeProcTab === 'monitor' && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRfqList(!showRfqList)}
            className="mr-2"
          >
            {showRfqList ? <ChevronsLeft className="size-3.5" /> : <Menu className="size-3.5" />}
            <span>{showRfqList ? 'Hide List' : 'Show List'}</span>
          </Button>
        )}
      </div>

      {activeProcTab === 'monitor' ? (
        <div className="card flex overflow-hidden min-h-[500px]">
          {/* LEFT SIDEBAR PANEL: RFQ LIST */}
          <div className={`shrink-0 bg-surface flex flex-col h-[calc(100vh-13.5rem)] transition-all duration-300 ease-in-out overflow-hidden ${
            showRfqList ? 'w-80 border-r border-border opacity-100' : 'w-0 opacity-0 border-r-0'
          }`}>
            <div className="p-3 border-b border-border bg-surface2/40">
              <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider mb-2">RFQ List</h3>
              <div className="relative">
                <Search className="absolute left-2.5 top-2 size-3.5 text-text-tertiary" />
                <input
                  type="text"
                  placeholder="Search RFQs..."
                  value={listSearch}
                  onChange={e => setListSearch(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-border">
              {state.rfqs
                .filter(r => r.id.toLowerCase().includes(listSearch.toLowerCase()) || r.description.toLowerCase().includes(listSearch.toLowerCase()))
                .map(rfq => {
                  const isSelected = selectedRfqId === rfq.id || (!selectedRfqId && state.rfqs[0]?.id === rfq.id);
                  
                  return (
                    <button
                      key={rfq.id}
                      type="button"
                      onClick={() => {
                        setSelectedRfqId(rfq.id);
                      }}
                      className={`w-full text-left p-3.5 transition-colors duration-150 cursor-pointer block ${
                        isSelected
                          ? 'bg-surface2 border-l-4 border-primary'
                          : 'hover:bg-surface2/60'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs font-bold text-text-primary">{rfq.id}</span>
                        <StatusBadge label={rfq.status} variant={rfqStatusVariant(rfq.status)} />
                      </div>
                      <p className="text-xs font-bold text-text-primary truncate" title={rfq.description}>{rfq.description}</p>
                      <div className="flex items-center justify-between mt-2 text-[10px] text-text-tertiary font-mono">
                        <span>Org: {rfq.purchasingOrg}</span>
                        <span className="whitespace-nowrap">Date: {formatDate(rfq.createdDate)}</span>
                      </div>
                    </button>
                  );
                })}
              {state.rfqs.filter(r => r.id.toLowerCase().includes(listSearch.toLowerCase()) || r.description.toLowerCase().includes(listSearch.toLowerCase())).length === 0 && (
                <EmptyState title="No RFQ records found" className="py-8" />
              )}
            </div>
          </div>

          {/* RIGHT SIDE DETAILS PANEL */}
          <div className="flex-1 flex flex-col min-w-0 bg-base/40 overflow-hidden h-[calc(100vh-13.5rem)]">

            {/* TABS: MONITOR VIEW */}
            {activeProcTab === 'monitor' && (() => {
              const activeRfq = state.rfqs.find(r => r.id === selectedRfqId) || state.rfqs[0];
              if (!activeRfq) {
                return (
                  <div className="flex-1 flex items-center justify-center p-8">
                    <EmptyState title="Select an RFQ from the left list to view details" />
                  </div>
                );
              }
              return (
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* Detail Header */}
                  <div className="p-4 border-b border-border bg-surface2/40 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowRfqList(!showRfqList)}
                        className="shrink-0 border border-border"
                        title={showRfqList ? "Hide RFQ List" : "Show RFQ List"}
                      >
                        {showRfqList ? <ChevronsLeft className="size-4" /> : <Menu className="size-4" />}
                      </Button>
                      <div>
                        <h3 className="text-xs font-bold text-text-primary uppercase">
                          (RFQ-{activeRfq.id}) / (Cat.-{activeRfq.description}) / (Typ-{activeRfq.rfqType})
                        </h3>
                        <p className="text-[10px] text-text-secondary font-mono mt-0.5 whitespace-nowrap">
                          Vendor: {currentVendorCode} &bull; Created: {formatDate(activeRfq.createdDate)} &bull; Org: {activeRfq.purchasingOrg}
                        </p>
                      </div>
                    </div>
                    <StatusBadge label={activeRfq.status} variant={rfqStatusVariant(activeRfq.status)} />
                  </div>

                  {/* Scrollable Content */}
                  <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-6 bg-surface">
                    {/* RAW DETAILS */}
                    <FormSection number="01" title="RAW details">
                      <div className="overflow-x-auto -m-4">
                        <table className="w-full text-left border-collapse table-sticky">
                          <thead>
                            <tr>
                              <th className="w-12">Line</th>
                              <th className="whitespace-nowrap">Material Code</th>
                              <th>Description</th>
                              <th className="text-right">Qty Required</th>
                              <th className="text-center">UoM</th>
                              <th className="text-right whitespace-nowrap">Target Ref Price</th>
                              <th className="font-mono whitespace-nowrap">Delivery Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {activeRfq.items.map((item, idx) => (
                              <tr key={idx}>
                                <td className="font-mono font-bold text-text-tertiary">{(idx + 1) * 10}</td>
                                <td className="font-mono font-bold text-text-primary whitespace-nowrap">{item.materialCode}</td>
                                <td className="font-semibold text-text-primary">{item.description}</td>
                                <td className="text-right font-mono font-bold tabular-nums">{item.quantity.toLocaleString()}</td>
                                <td className="text-center font-bold">{item.uom}</td>
                                <td className="text-right font-mono text-text-secondary whitespace-nowrap tabular-nums">₹{item.targetPrice ? item.targetPrice.toFixed(2) : '0.00'}</td>
                                <td className="font-mono text-text-tertiary whitespace-nowrap">{formatDate(item.deliveryDate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </FormSection>

                    {/* OTHER DETAILS (INVITED VENDORS) */}
                    <FormSection number="02" title="Invited vendors">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {activeRfq.invitedVendors?.map(v => {
                           const ratingVal = Number(v.rating || 0);
                           let ratingColorClass = "bg-surface2 text-text-secondary border-border-em";
                           if (ratingVal >= 90) {
                             ratingColorClass = "bg-emerald-900/20 text-emerald-400 border-emerald-900/50";
                           } else if (ratingVal >= 80) {
                             ratingColorClass = "bg-amber-500/20 text-amber-400 border-amber-500/30";
                           } else if (ratingVal > 0) {
                             ratingColorClass = "bg-rose-900/20 text-rose-400 border-rose-900/50";
                           }

                           return (
                             <div key={v.id} className="p-4 bg-surface2/30 border border-border rounded-xl flex flex-col justify-between gap-3 text-xs shadow-xs hover:shadow-sm transition-all duration-200 relative min-h-[90px]">
                               <div className="flex justify-between items-start gap-4 w-full">
                                 <p className="font-bold text-text-primary text-[11px] leading-tight break-words flex-1 pr-6">{v.name}</p>
                                 <span className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${ratingColorClass} absolute top-4.5 right-4.5`} title={`Vendor Rating: ${v.rating}`}>
                                   {v.rating}
                                 </span>
                               </div>
                               <div>
                                 <p className="text-[10px] text-text-secondary font-mono break-all">Code: {v.id}</p>
                               </div>
                             </div>
                           );
                         })}
                      </div>
                    </FormSection>

                    {/* PROCESS DETAILS (AUDIT WORKFLOW STATUS) */}
                    <FormSection number="03" title="Progress of this request">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div className="p-3 border border-border rounded-md bg-surface2/30">
                          <span className="text-[9px] text-text-tertiary uppercase block font-bold">Request published</span>
                          <span className="font-bold text-text-primary flex items-center gap-1.5 mt-1.5">
                            <CheckCircle2 className="size-3.5 text-green-600" /> Published
                          </span>
                          <span className="text-[9px] font-mono text-text-tertiary block mt-1 whitespace-nowrap">{formatDate(activeRfq.createdDate)}</span>
                        </div>

                        <div className="p-3 border border-border rounded-md bg-surface2/30">
                          <span className="text-[9px] text-text-tertiary uppercase block font-bold">Quotes received</span>
                          <span className={`font-bold mt-1.5 flex items-center gap-1.5 ${activeRfq.bids?.length > 0 ? 'text-text-primary' : 'text-text-tertiary'}`}>
                            {activeRfq.bids?.length > 0 ? (
                              <>
                                <CheckCircle2 className="size-3.5 text-green-600" /> {activeRfq.bids.length} Bid(s) Recd
                              </>
                            ) : (
                              <>
                                <Clock className="size-3.5 text-text-tertiary animate-pulse" /> Pending Bids
                              </>
                            )}
                          </span>
                          <span className="text-[9px] font-mono text-text-tertiary block mt-1 whitespace-nowrap">Deadline: {formatDate(activeRfq.deadlineDate)}</span>
                        </div>

                        <div className="p-3 border border-border rounded-md bg-surface2/30">
                          <span className="text-[9px] text-text-tertiary uppercase block font-bold">Evaluation</span>
                          <span className={`font-bold mt-1.5 flex items-center gap-1.5 ${activeRfq.status === 'Awarded' || activeRfq.status === 'Under Review' ? 'text-text-primary' : 'text-text-tertiary'}`}>
                            {activeRfq.status === 'Awarded' ? (
                              <>
                                <CheckCircle2 className="size-3.5 text-green-600" /> Evaluated
                              </>
                            ) : activeRfq.bids?.length > 0 ? (
                              <>
                                <Clock className="size-3.5 text-amber-500 animate-pulse" /> Review Ready
                              </>
                            ) : (
                              'Pending Review'
                            )}
                          </span>
                          <span className="text-[9px] text-text-tertiary block mt-1">Score weights active</span>
                        </div>

                        <div className="p-3 border border-border rounded-md bg-surface2/30">
                          <span className="text-[9px] text-text-tertiary uppercase block font-bold">Order raised</span>
                          <span className={`font-bold mt-1.5 flex items-center gap-1.5 ${activeRfq.status === 'Awarded' ? 'text-text-primary' : 'text-text-tertiary'}`}>
                            {activeRfq.status === 'Awarded' ? (
                              <>
                                <CheckCircle2 className="size-3.5 text-green-600" /> Order raised
                              </>
                            ) : (
                              'PO Pending'
                            )}
                          </span>
                          <span className="text-[9px] font-mono text-text-tertiary block mt-1">
                            {activeRfq.status === 'Awarded' ? 'Conversion Completed' : 'Pending Award'}
                          </span>
                        </div>
                      </div>
                    </FormSection>

                    <div className="flex justify-between items-center pt-3 border-t border-border text-xs text-text-secondary">
                      <p className="font-semibold flex items-center gap-1.5">
                        Delivery Location: {activeRfq.deliveryLocation}
                        <span
                          className="text-text-tertiary font-normal cursor-help"
                          title="Sourcing (RFQs, bids, awards) is managed in VendorConnect. SAP has no inbound API for issuing an RFQ or capturing a bid, so this stays portal-internal — optionally reconciled against SAP once the resulting PO is matched (see the ledger tab)."
                        >
                          &middot; managed in VendorConnect
                        </span>
                      </p>
                      <div className="flex items-center gap-2">
                        {activeRfq.status === 'Awarded' && (
                          <>
                            <span className="font-mono text-[10px] text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded font-bold">
                              Awarded to {activeRfq.awardedVendorName || 'Synced Vendor'}
                            </span>
                            <div className="flex items-center gap-1" title="Download the PO for your buyer's SAP team to import — a file, not a live sync.">
                              {['csv', 'xlsx', 'json', 'idoc'].map((format) => (
                                <button
                                  key={format}
                                  type="button"
                                  disabled={exportingFormat !== null}
                                  onClick={() => handleExportPo(activeRfq.id, format)}
                                  className="font-mono text-[10px] uppercase text-text-secondary bg-surface2/50 border border-border px-2 py-1 rounded font-bold hover:bg-surface2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {exportingFormat === format ? <Loader2 className="size-3 animate-spin" /> : format}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      ) : activeProcTab === 'me48' ? (
        /* TAB: EVERY PURCHASING DOCUMENT SAP HOLDS ON THIS VENDOR CODE.
           Two reads, one list — ME43 (ZME43/ME43) reports the RFQ/quotation
           documents, ME48 (ZCL_ME48/vendor) the whole purchasing set including
           those same quotations. Both are vendor-scoped, neither takes an RFQ
           id, and the overlap is deduplicated in lib/sapDocuments.js. */
        (() => {
          const documents = mergeSapDocuments({
            rfqDocuments: state.sapRfqDocuments,
            quotationDocuments: state.sapQuotationDocuments,
          });

          return (
            <div className="card p-5 space-y-4 animate-fade-in">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-bold text-text-primary">My purchasing documents</h3>
                  <p className="text-[11px] text-text-tertiary mt-1 max-w-3xl">
                    Read straight from your buyer&rsquo;s system for supplier ID{' '}
                    <span className="font-mono font-bold text-text-secondary">{currentVendorCode}</span>.
                    These are your buyer&rsquo;s own records, so they are listed separately from the
                    requests shown in the monitor.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="label mb-0 whitespace-nowrap">Type</span>
                  <select className="h-9" value={documentTypeFilter} onChange={(e) => setDocumentTypeFilter(e.target.value)}>
                    <option value="all">All documents</option>
                    <option value="Quotation">Quotations</option>
                    <option value="Purchase Order">Purchase orders</option>
                  </select>
                </div>
              </div>

              {documents === null ? (
                <div className="flex items-center gap-2 text-xs text-text-tertiary py-6 justify-center">
                  <Loader2 className="size-3.5 animate-spin" /> Loading your buyer&rsquo;s records for your company...
                </div>
              ) : documents.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title="Nothing on file yet"
                  description="Your buyer has no documents on file for your company yet. Quotations and purchase orders appear here once they do."
                />
              ) : (() => {
                const counts = countByType(documents);
                const org = commonPurchasingOrg(documents);
                const shown = documentTypeFilter === 'all'
                  ? documents
                  : documents.filter((doc) => doc.documentType === documentTypeFilter);

                return (
                  <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
                      <span><span className="font-bold text-text-secondary tabular-nums">{counts.quotations}</span> quotation(s)</span>
                      <span><span className="font-bold text-text-secondary tabular-nums">{counts.purchaseOrders}</span> purchase order(s)</span>
                      {/* Shown once as context rather than repeated down a
                          column: it is the same value on every row. */}
                      {org && <span>Buying unit <span className="font-mono font-bold text-text-secondary">{org}</span></span>}
                    </div>

                    {shown.length === 0 ? (
                      <EmptyState
                        icon={FileText}
                        title="No documents of this type"
                        description="Your buyer has documents for your company, but none of the selected type."
                      />
                    ) : (
                      <div className="overflow-x-auto overflow-y-auto max-h-[520px] custom-scrollbar border border-border">
                        <table className="w-full text-left border-collapse table-sticky">
                          <thead className="sticky top-0 z-10">
                            <tr>
                              <th>Document No.</th>
                              <th>Type</th>
                              <th>Date</th>
                              <th>Currency</th>
                              {!org && <th>Buying unit</th>}
                              <th className="text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {shown.map((doc, index) => (
                              <tr key={`${doc.documentNumber || 'unnumbered'}-${index}`}>
                                <td className="font-mono font-bold text-text-primary select-all">{doc.documentNumber || '—'}</td>
                                <td>
                                  <StatusBadge
                                    label={doc.documentType}
                                    variant={doc.documentType === 'Quotation' ? 'info' : 'pending'}
                                  />
                                </td>
                                <td className="font-mono text-text-tertiary tabular-nums whitespace-nowrap">{formatDate(doc.date)}</td>
                                <td className="font-mono text-text-secondary">{doc.currency || '—'}</td>
                                {!org && <td className="font-mono text-text-secondary">{doc.purchasingOrg || '—'}</td>}
                                <td className="text-right">
                                  {doc.documentType === 'Quotation' && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => openPriceUpdate(doc)}
                                      className="gap-1.5"
                                    >
                                      <IndianRupee className="size-3.5" /> Update Price
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <p className="text-[10px] text-text-tertiary">
                      Showing {shown.length} of {documents.length} document(s), newest first.
                    </p>
                  </>
                );
              })()}
            </div>
          );
        })()
      ) : (
        /* TAB: SUBMIT QUOTATION FORM */
        <div className="space-y-6">
          {tabLoading ? (
            <div className="card space-y-6 animate-fade-in p-6">
              <div>
                <div className="h-4.5 w-48 skeleton mb-1.5" />
                <div className="h-3 w-80 skeleton" />
              </div>
              <div className="space-y-3">
                <div className="h-4.5 w-28 skeleton" />
                <div className="flex flex-col border border-border rounded-md divide-y divide-border bg-surface overflow-hidden">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="py-2.5 px-3 flex items-center gap-3">
                      <div className="h-3.5 w-40 skeleton shrink-0" />
                      <div className="h-8 flex-1 skeleton" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleQuotationSubmit} className="card space-y-6 relative p-6">
              {isLoading && (
                <div className="absolute inset-0 bg-surface/85 backdrop-blur-xs flex flex-col items-center justify-center z-30 min-h-[400px]">
                  <div className="size-10 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4" />
                  <p className="text-xs font-bold text-text-primary uppercase tracking-widest font-mono">Submitting your quote...</p>
                  <p className="text-[10px] text-text-secondary mt-1">Sending your prices and delivery terms to your buyer...</p>
                </div>
              )}

              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-sm font-bold text-text-primary">Submit Quotation</h3>
                  <p className="text-[11px] text-text-secondary mt-0.5">Send your prices, discounts and delivery timelines to your buyer</p>
                </div>
              </div>

              {/* RFQ Selection Dropdown and Details */}
              {(() => {
                const selectedRfq = state.rfqs.find(r => r.id === quoteForm.rfqId);
                return (
                  <div className={`p-4 bg-surface2/30 border rounded-md space-y-4 ${quoteErrors.rfqId ? 'border-rose-500 ring-1 ring-rose-500/50 bg-rose-50/5' : 'border-border'}`}>
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h4 className="text-[11px] font-bold text-text-secondary uppercase tracking-wider font-mono">Choose a request</h4>
                        <p className="text-[10px] text-text-tertiary mt-0.5 font-semibold">Pick one of the open requests you have been invited to quote for</p>
                      </div>
                      <div>
                        <select
                          value={quoteForm.rfqId}
                          onChange={e => {
                            const selectedId = e.target.value;
                            const rfq = state.rfqs.find(r => r.id === selectedId);
                            setQuoteForm({
                              ...quoteForm,
                              rfqId: selectedId,
                              selectedLine: rfq && rfq.items.length > 0 ? rfq.items[0].line : 10
                            });
                            if (quoteErrors.rfqId) setQuoteErrors(prev => ({ ...prev, rfqId: false }));
                          }}
                          className={`w-[25ch] max-w-full font-semibold ${
                            quoteErrors.rfqId ? 'border-rose-500' : ''
                          }`}
                        >
                          <option value="">-- Choose RFQ Document --</option>
                          {state.rfqs.map(r => (
                            <option key={r.id} value={r.id}>
                              {r.id} - {r.description} ({r.status})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {selectedRfq && (
                      <div className="border-t border-border pt-3 space-y-3">
                        <div className="flex items-center justify-between">
                          <h5 className="text-[9px] font-bold text-text-tertiary uppercase tracking-wider">RFQ Line Item Details (Selected for Quotation)</h5>
                          <span className="font-mono text-[9px] text-text-secondary font-bold bg-surface2 px-2 py-0.5 rounded">
                            Status: {selectedRfq.status}
                          </span>
                        </div>

                        {/* Line Item selector if multiple items */}
                        {selectedRfq.items.length > 1 && (
                          <div className="flex flex-wrap items-center gap-2 py-1">
                            <span className="text-[9px] font-bold text-text-tertiary uppercase tracking-wider mr-1">Select Line Item:</span>
                            {selectedRfq.items.map(item => (
                              <button
                                key={item.line}
                                type="button"
                                onClick={() => setQuoteForm({ ...quoteForm, selectedLine: item.line })}
                                className={`px-3 py-1 text-xs font-mono font-bold rounded-md border transition-colors duration-150 cursor-pointer ${
                                  Number(quoteForm.selectedLine) === item.line
                                    ? 'bg-primary text-white border-primary'
                                    : 'bg-surface text-text-secondary border-border hover:bg-surface2'
                                }`}
                              >
                                Line {item.line}: {item.materialCode}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Selected Item Info Card */}
                        {(() => {
                          const selectedItem = selectedRfq.items.find(item => item.line === Number(quoteForm.selectedLine)) || selectedRfq.items[0];
                          if (!selectedItem) return null;
                          return (
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1 text-xs font-sans text-text-secondary">
                              <div>
                                <span className="text-[9px] text-text-tertiary block font-bold uppercase">Material Code</span>
                                <span className="font-bold text-text-primary font-mono">{selectedItem.materialCode}</span>
                              </div>
                              <div>
                                <span className="text-[9px] text-text-tertiary block font-bold uppercase">Description</span>
                                <span className="font-bold text-text-primary truncate block max-w-[200px]">{selectedItem.description}</span>
                              </div>
                              <div>
                                <span className="text-[9px] text-text-tertiary block font-bold uppercase">Required Quantity</span>
                                <span className="font-bold text-text-primary font-mono tabular-nums">{selectedItem.quantity.toLocaleString()} {selectedItem.uom}</span>
                              </div>
                              <div>
                                <span className="text-[9px] text-text-tertiary block font-bold uppercase">Target Price Reference</span>
                                <span className="font-bold text-text-primary font-mono tabular-nums">₹{selectedItem.targetPrice?.toFixed(2)}</span>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 1. QUOTATION HEADER */}
              <FormSection number="01" title="Quotation header">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                  <EnterpriseFieldCard
                    label="Your quote reference"
                    error={quoteErrors.quoteRef}
                  >
                    <input
                      type="text"
                      maxLength={12}
                      placeholder="QT-2026-001"
                      value={quoteForm.quoteRef}
                      onChange={e => setQuoteForm({ ...quoteForm, quoteRef: e.target.value })}
                      className="w-[14ch] max-w-full font-mono uppercase font-semibold"
                    />
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard
                    label="Quotation date"
                    required
                    error={quoteErrors.quoteDate}
                  >
                    <input
                      type="date"
                      required
                      value={quoteForm.quoteDate}
                      onChange={e => {
                        setQuoteForm({ ...quoteForm, quoteDate: e.target.value });
                        if (quoteErrors.quoteDate) setQuoteErrors(prev => ({ ...prev, quoteDate: false }));
                      }}
                      className="w-full font-mono font-semibold"
                    />
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard
                    label="Validity date"
                    required
                    error={quoteErrors.validityDate}
                  >
                    <input
                      type="date"
                      required
                      value={quoteForm.validityDate}
                      onChange={e => {
                        setQuoteForm({ ...quoteForm, validityDate: e.target.value });
                        if (quoteErrors.validityDate) setQuoteErrors(prev => ({ ...prev, validityDate: false }));
                      }}
                      className="w-full font-mono font-semibold"
                    />
                  </EnterpriseFieldCard>
                </div>
              </FormSection>


              {/* 2. LINE ITEM PRICING */}
              <FormSection number="02" title="Line item pricing">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                  <EnterpriseFieldCard
                    label="Unit price (₹)"
                    required
                    error={quoteErrors.unitPrice}
                  >
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      placeholder="0.00"
                      value={quoteForm.unitPrice}
                      onChange={e => {
                        setQuoteForm({ ...quoteForm, unitPrice: e.target.value });
                        if (quoteErrors.unitPrice) setQuoteErrors(prev => ({ ...prev, unitPrice: false }));
                      }}
                      className="w-[13ch] max-w-full font-mono font-semibold"
                    />
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard
                    label="GST rate (%)"
                    required
                    error={quoteErrors.gstRate}
                  >
                    <select
                      value={quoteForm.gstRate}
                      onChange={e => {
                        setQuoteForm({ ...quoteForm, gstRate: e.target.value });
                        if (quoteErrors.gstRate) setQuoteErrors(prev => ({ ...prev, gstRate: false }));
                      }}
                      className="w-[25ch] max-w-full font-semibold"
                    >
                      <option value="18%">18% - G1</option>
                      <option value="12%">12% - G2</option>
                      <option value="5%">5% - G3</option>
                      <option value="28%">28% - G4</option>
                      <option value="Exempt">Exempt - G0</option>
                    </select>
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard label="Discount (%)">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      placeholder="0"
                      value={quoteForm.discount}
                      onChange={e => setQuoteForm({ ...quoteForm, discount: e.target.value })}
                      className="w-[9ch] max-w-full font-mono font-semibold"
                    />
                  </EnterpriseFieldCard>
                </div>
              </FormSection>


              {/* 3. DELIVERY TERMS */}
              <FormSection number="03" title="Delivery terms">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                  <EnterpriseFieldCard
                    label="Delivery lead time (days)"
                    required
                    error={quoteErrors.deliveryLeadTime}
                  >
                    <input
                      type="number"
                      min="1"
                      required
                      placeholder="7"
                      value={quoteForm.deliveryLeadTime}
                      onChange={e => {
                        setQuoteForm({ ...quoteForm, deliveryLeadTime: e.target.value });
                        if (quoteErrors.deliveryLeadTime) setQuoteErrors(prev => ({ ...prev, deliveryLeadTime: false }));
                      }}
                      className="w-[9ch] max-w-full font-mono font-semibold"
                    />
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard label="Freight / packing (₹)">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0"
                      value={quoteForm.freight}
                      onChange={e => setQuoteForm({ ...quoteForm, freight: e.target.value })}
                      className="w-[13ch] max-w-full font-mono font-semibold"
                    />
                  </EnterpriseFieldCard>

                  <EnterpriseFieldCard label="Incoterms">
                    <select
                      value={quoteForm.incoterms}
                      onChange={e => setQuoteForm({ ...quoteForm, incoterms: e.target.value })}
                      className="w-[25ch] max-w-full font-semibold"
                    >
                      <option value="EXW">EXW - Ex Works</option>
                      <option value="FOB">FOB - Free on Board</option>
                      <option value="CIF">CIF - Cost, Insurance &amp; Freight</option>
                      <option value="FOR">FOR - Free on Rail</option>
                      <option value="DDP">DDP - Delivered Duty Paid</option>
                    </select>
                  </EnterpriseFieldCard>
                </div>
              </FormSection>


              {/* STICKY BOTTOM ACTION BAR */}
              <footer className="sticky bottom-0 z-30 -mx-6 bg-surface border-t border-border py-3.5 px-4 md:px-6 select-none">
                <div className="flex items-center justify-between gap-4">
                  <Button
                    type="button"
                    onClick={() => {
                      try {
                        localStorage.setItem(QUOTE_DRAFT_KEY, JSON.stringify({ quoteForm }));
                        addToast('success', 'Quotation draft saved. It will be restored next time you open this form.');
                      } catch (e) {
                        addToast('error', 'Failed to save quotation draft.');
                      }
                    }}
                    variant="outline"
                  >
                    Save Draft
                  </Button>
                  <Button
                    type="submit"
                    variant="default"
                  >
                    Submit Quotation
                  </Button>
                </div>
              </footer>
            </form>
          )}
        </div>
      )}

      {/* UPDATE PRICE (ME47) MODAL — pushes a net price to a SAP-native
          quotation document, sourced from a portal RFQ's own line items. */}
      <Modal
        open={!!priceUpdateDoc}
        onClose={closePriceUpdate}
        title={`Update Price (ME47) — ${priceUpdateDoc?.documentNumber || ''}`}
        footer={
          <>
            <Button type="button" variant="outline" onClick={closePriceUpdate} disabled={priceUpdateLoading}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={submitPriceUpdate}
              disabled={priceUpdateLoading || !priceUpdateRfq}
              className="gap-1.5"
            >
              {priceUpdateLoading && <Loader2 className="size-3.5 animate-spin" />}
              Send to SAP
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-[11px] text-text-tertiary">
            Pick the request in RFQ Monitor &amp; History whose line items this SAP document corresponds to,
            then enter the net price per line to send to your buyer&rsquo;s system.
          </p>

          <div className="space-y-1.5">
            <label className="text-[11px] font-bold text-text-secondary uppercase tracking-wide">Linked RFQ</label>
            <select
              value={priceUpdateRfqId}
              onChange={(e) => handlePriceUpdateRfqChange(e.target.value)}
              className="w-full font-semibold"
              disabled={priceUpdateLoading}
            >
              <option value="">-- Choose RFQ --</option>
              {state.rfqs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} - {r.description}
                </option>
              ))}
            </select>
          </div>

          {priceUpdateRfq && (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Material</th>
                    <th className="text-right">Net Price (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {priceUpdateRfq.items.map((item) => (
                    <tr key={item.line}>
                      <td className="font-mono font-bold text-text-tertiary">{item.line}</td>
                      <td className="font-mono font-bold text-text-primary whitespace-nowrap">{item.materialCode}</td>
                      <td className="text-right">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={priceUpdatePrices[item.line] ?? ''}
                          onChange={(e) =>
                            setPriceUpdatePrices((prev) => ({ ...prev, [item.line]: e.target.value }))
                          }
                          disabled={priceUpdateLoading}
                          className="w-[12ch] text-right font-mono font-semibold"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>

      </div>
    </ErrorBoundary>
  );
}
