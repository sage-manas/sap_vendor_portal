'use client';

import React, { useState, useEffect } from 'react';
import {
  ShoppingBag, Clock, CheckCircle2, Truck, ChevronRight, ChevronLeft, Search, Filter,
  Calendar, User, Download, AlertTriangle, MessageSquare, Plus, Send,
  FileText, X, ChevronDown, Check, MapPin, CreditCard, ArrowLeft,
  Building, Building2, TrendingUp, Percent, ShieldCheck, RefreshCw, FileCheck, HelpCircle, Receipt
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import FileUploadZone from '@/components/shared/FileUploadZone';
import ErrorBoundary from '@/components/ErrorBoundary';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import TableSkeleton from '@/components/ui/TableSkeleton';
import KPICard from '@/components/ui/KPICard';
import { poStatusVariant } from '@/lib/statusColors';

function EnterpriseFieldCard({ label, required, error, children, icon: Icon }) {
  return (
    <div className={`h-full p-3 rounded-lg border border-border bg-surface hover:border-border-em transition-all duration-150 flex flex-col justify-between relative min-h-[76px] select-none ${error ? 'border-red-300 bg-red-50/10' : ''
      }`}>
      <div className="flex justify-between items-start w-full gap-2">
        <label className="text-[10px] font-bold text-text-secondary uppercase tracking-wider block leading-tight" title={label}>
          {label} {required && <span className="text-red-500 font-bold select-none ml-0.5">*</span>}
        </label>
        {Icon && <Icon className="size-3.5 text-text-tertiary shrink-0" />}
      </div>
      <div className="w-full min-w-0 mt-1.5 flex flex-col justify-end text-text-secondary font-medium [&_span:not(.rounded)]:font-medium [&_span:not(.rounded)]:text-text-secondary [&_input]:font-medium [&_input]:text-text-secondary">
        {children}
        {error && (
          <span className="text-[10px] font-bold text-red-600 mt-1 select-none">{error}</span>
        )}
      </div>
    </div>
  );
}

// Side-by-side: label on left, value box on right
function SapReadOnlyField({ label, value, isFile, isMonospace = true, valueClassName = '', containerClassName = '', icon: Icon }) {
  return (
    <div className="flex items-center justify-start gap-2 select-none focus-within:outline-none w-full">
      <span className="w-36 text-[11px] font-extrabold text-text-secondary uppercase tracking-wider flex items-center gap-1.5 leading-none shrink-0 truncate" title={label}>
        {Icon && <Icon className="size-3 text-text-tertiary shrink-0" />}
        <span className="truncate">{label}</span>
      </span>
      <div
        className={`inline-flex items-center gap-1.5 border rounded-[3px] px-2.5 text-xs h-6.5 font-semibold cursor-default box-border w-fit max-w-full overflow-hidden text-ellipsis whitespace-nowrap focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 focus-visible:ring-offset-1 select-all transition-all duration-150 tabular-nums ${isMonospace ? 'font-mono' : 'font-sans'
          } ${containerClassName || 'bg-base text-text-primary border-border'} ${valueClassName}`}
        title={value || ''}
        tabIndex={0}
      >
        {isFile && <FileText className="size-3.5 text-text-tertiary shrink-0" />}
        <span>{value || '—'}</span>
      </div>
    </div>
  );
}

// Vertical stack: label on top, input below — mirrors SapReadOnlyField for grid alignment
function SapInputField({ label, required, children, icon: Icon }) {
  return (
    <div className="flex flex-col gap-1 focus-within:outline-none">
      <span className="text-[9px] font-extrabold text-text-secondary uppercase tracking-wider flex items-center gap-1 leading-none">
        {Icon && <Icon className="size-3 text-text-tertiary shrink-0" />}
        <span>
          {label}
          {required && <span className="text-red-500 font-bold ml-0.5">*</span>}
        </span>
      </span>
      <div className="w-fit">
        {children}
      </div>
    </div>
  );
}

const generateInvoiceNumber = () => `INV-2026-${Math.floor(100000 + Math.random() * 900000)}`;

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
};

const parseDateSafe = (dateStr) => {
  if (!dateStr) return new Date();
  let d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    const parts = String(dateStr).split(/[./-]/);
    if (parts.length === 3) {
      if (parts[2].length === 4) {
        d = new Date(parts[2], parts[1] - 1, parts[0]);
      } else if (parts[0].length === 4) {
        d = new Date(parts[0], parts[1] - 1, parts[2]);
      }
    }
  }
  return isNaN(d.getTime()) ? new Date() : d;
};

export default function PurchaseOrdersView({
  state,
  selectedPoId,
  setSelectedPoId,
  asnForm,
  setAsnForm,
  handleAsnSubmit,
  acknowledgePO,
  simulateIncomingPO,
  setActiveTab,
  submitInvoice
}) {
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  // -----------------------------------------------------------------
  // DATA PIPELINE SANITISATION
  // -----------------------------------------------------------------
  // Filter out any null elements or corrupt POs/GRNs/ASNs from localStorage
  const cleanPOs = (Array.isArray(state?.pos) ? state.pos : [])
    .filter(Boolean)
    .map(po => ({
      plant: 'Plant 1000 (Mumbai)',
      buyerName: 'Amit Sharma (Lead Procurement)',
      paymentTerms: 'NET 30 Days',
      currency: 'INR',
      incoterms: 'EXW',
      deliveryAddress: 'Plant Gate 2, Industrial Sector, Mumbai, India',
      status: 'Open',
      ...po,
      items: (po.items || []).filter(Boolean).map(item => ({
        quantity: 0,
        grnQuantity: 0,
        unitPrice: 0,
        netValue: 0,
        ...item
      }))
    }));

  const cleanGrns = (Array.isArray(state?.grns) ? state.grns : [])
    .filter(Boolean)
    .map(grn => ({
      postingDate: new Date().toISOString().split('T')[0],
      receivedBy: 'Stores Manager (QC Group)',
      ...grn,
      items: (grn.items || []).filter(Boolean).map(item => ({
        receivedQuantity: 0,
        acceptedQuantity: 0,
        rejectedQuantity: 0,
        ...item
      }))
    }));

  const cleanAsns = (Array.isArray(state?.asns) ? state.asns : []).filter(Boolean);

  // Navigation states:
  // poSubTab tracks the main top menu: 'list' (Orders Monitor), 'grn' (Goods Receipts), 'invoice' (Invoice Ready)
  const [poSubTab, setPoSubTab] = useState('list');
  // currentView tracks detail sub-states: 'list' | 'detail' | 'asn' | 'asn_success' | 'grn_detail' | 'invoice_detail'
  const [currentView, setCurrentView] = useState('list');
  const [activePoState, setActivePo] = useState(null);
  const [activeGrnState, setActiveGrn] = useState(null);
  const activePo = activePoState ? (cleanPOs.find(p => p.id === activePoState.id) || activePoState) : null;
  const activeGrn = activeGrnState ? (cleanGrns.find(g => g.id === activeGrnState.id) || activeGrnState) : null;
  const [localSubmissionTimes, setLocalSubmissionTimes] = useState({});
  const [isSapView, setIsSapView] = useState(false);
  const [activeLineIdx, setActiveLineIdx] = useState(0);
  const [asnLineIdx, setAsnLineIdx] = useState(0);
  const [grnLineIdx, setGrnLineIdx] = useState(0);

  useEffect(() => {
    setAsnLineIdx(0);
    setGrnLineIdx(0);
  }, [activePo?.id]);

  // Search and Filters for Screen 1
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [plantFilter, setPlantFilter] = useState('all');
  const [buyerFilter, setBuyerFilter] = useState('all');

  // Table Sorting
  const [sortField, setSortField] = useState('id');
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  // Local state for E-Way Bill uploads and validation errors
  const [ewayBillNo, setEwayBillNo] = useState('');
  const [ewayBillFile, setEwayBillFile] = useState(null);
  const [dispatchQuantities, setDispatchQuantities] = useState({});
  const [validationErrors, setValidationErrors] = useState({});

  // Local state for local uploads in ASN
  const [asnDocs, setAsnDocs] = useState({ packingList: null, invoiceCopy: null, transportDoc: null });

  // ASN Success Display state
  const [asnSuccessInfo, setAsnSuccessInfo] = useState(null);

  // local Invoice input details (Screen 5)
  const [vendorInvoiceNo, setVendorInvoiceNo] = useState('');
  const [billingDate, setBillingDate] = useState('');
  const [isPostingInvoice, setIsPostingInvoice] = useState(false);
  const [invoicePostedSuccess, setInvoicePostedSuccess] = useState(false);

  // Sliding Side Drawer for Communication Center
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPo, setDrawerPo] = useState(null);
  const [chatMessageInput, setChatMessageInput] = useState('');
  const [poIssueStatus, setPoIssueStatus] = useState({}); // poId -> 'Open' | 'In Review' | 'Resolved'
  const [poChats, setPoChats] = useState({}); // poId -> array of messages

  // Detail View Active Sub-tab ('po_detail' | 'create_asn' | 'grn_status')
  const [detailTab, setDetailTab] = useState('po_detail');

  // Countdown timer for MIGO receipt simulation
  const [countdown, setCountdown] = useState({});

  // Fetch unique plants and buyers from actual PO list for filters
  const uniquePlants = Array.from(new Set(cleanPOs.map(p => p.plant)));
  const uniqueBuyers = Array.from(new Set(cleanPOs.map(p => p.buyerName)));

  // Monitor POs that are Dispatched and track countdowns for GRN sync
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      cleanPOs.forEach(po => {
        if (po.status === 'Dispatched') {
          // Calculate elapsed time since dispatch submission.
          // Since submitASN creates the ASN and triggers GRN in 10 seconds,
          // we can simulate a countdown from 10 seconds.
          const asn = cleanAsns.find(a => a.poId === po.id);
          const submittedDate = asn?.submittedAt || asn?.createdAt || localSubmissionTimes[po.id];
          if (submittedDate) {
            const elapsed = Math.floor((now - parseDateSafe(submittedDate).getTime()) / 1000);
            const remaining = Math.max(0, 10 - elapsed);
            setCountdown(prev => ({ ...prev, [po.id]: remaining }));
          } else {
            setCountdown(prev => ({ ...prev, [po.id]: 10 }));
          }
        }
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cleanPOs, cleanAsns, localSubmissionTimes]);

  // Pre-load default chat messages for POs
  useEffect(() => {
    cleanPOs.forEach(po => {
      if (!poChats[po.id]) {
        // Initialize mock thread
        setPoChats(prev => ({
          ...prev,
          [po.id]: [
            {
              sender: 'Buyer',
              message: `Hi Team, PO ${po.id} has been released in SAP. Please review payment terms (${po.paymentTerms || 'NET 30'}) and delivery locations and confirm acknowledgement.`,
              timestamp: new Date(parseDateSafe(po.createdDate).getTime() + 10 * 60000).toISOString()
            }
          ]
        }));
        setPoIssueStatus(prev => ({ ...prev, [po.id]: 'In Review' }));
      }
    });
  }, [cleanPOs]);

  // Auto-initialize ASN form when user enters tab 2 via tab navigation
  useEffect(() => {
    if (detailTab === 'create_asn' && activePo && activePo.status !== 'Open') {
      const lines = (activePo.items || []).map(item => item.line);
      const isInitialized = lines.length > 0 && lines.every(line => dispatchQuantities[line] !== undefined);
      if (!isInitialized) {
        const initialQtys = {};
        const initialErrors = {};
        (activePo.items || []).forEach(item => {
          const remaining = item.quantity - (item.grnQuantity || 0);
          initialQtys[item.line] = remaining;
          initialErrors[item.line] = '';
        });
        setDispatchQuantities(initialQtys);
        setValidationErrors(initialErrors);
        setEwayBillNo(prev => prev || `E-WAY-${Math.floor(100000000000 + Math.random() * 900000000000)}`);
        setAsnForm(prev => ({
          carrierName: prev.carrierName || 'DHL Global Logistics',
          trackingNumber: prev.trackingNumber || `DHL-${Math.floor(1000000 + Math.random() * 9000000)}`,
          vehicleNumber: prev.vehicleNumber || 'MH-12-XY-4321',
          invoiceReference: prev.invoiceReference || `TAX-2026-${Math.floor(100 + Math.random() * 900)}`,
          shipDate: prev.shipDate || new Date().toISOString().split('T')[0],
          estimatedDeliveryDate: prev.estimatedDeliveryDate || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          items: initialQtys
        }));
      }
    }
  }, [detailTab, activePo?.id]);

  // Handle PO Row selection
  const handleOpenPoDetails = (po) => {
    setActivePo(po);
    setDetailTab('po_detail');
    setCurrentView('detail');
    setActiveLineIdx(0);
  };

  const handleOpenGrnDetails = (grn) => {
    const po = cleanPOs.find(p => p.id === grn.poId);
    setActiveGrn(grn);
    setActivePo(po);
    setDetailTab('grn_status');
    setCurrentView('detail');
    setActiveLineIdx(0);
  };

  const handleOpenInvoiceDetail = (grn) => {
    const po = cleanPOs.find(p => p.id === grn.poId);
    setActiveGrn(grn);
    setActivePo(po);
    // Prefill fields
    setVendorInvoiceNo(generateInvoiceNumber());
    setBillingDate(new Date().toISOString().split('T')[0]);
    setInvoicePostedSuccess(false);
    setCurrentView('invoice_detail');
    setActiveLineIdx(0);
  };

  // Open Communication Drawer
  const handleOpenDrawer = (e, po) => {
    e.stopPropagation();
    setDrawerPo(po);
    setDrawerOpen(true);
  };

  // Send Drawer Message
  const handleSendDrawerMessage = () => {
    if (!chatMessageInput.trim()) return;

    const newMessage = {
      sender: 'Vendor',
      message: chatMessageInput,
      timestamp: new Date().toISOString()
    };

    setPoChats(prev => ({
      ...prev,
      [drawerPo.id]: [...(prev[drawerPo.id] || []), newMessage]
    }));

    const text = chatMessageInput;
    setChatMessageInput('');

    // Trigger mock response
    setTimeout(() => {
      let reply = "We have updated the records in SAP. Let us know if you need anything else.";
      if (text.toLowerCase().includes('delivery') || text.toLowerCase().includes('date') || text.toLowerCase().includes('delay')) {
        reply = "Acknowledged. Please make sure the dispatch quantity matches the remaining quantities to avoid MIGO rejection flags.";
      } else if (text.toLowerCase().includes('price') || text.toLowerCase().includes('tax') || text.toLowerCase().includes('gst')) {
        reply = "Our finance desk uses tax code G1 (18% GST). Standard payment terms will apply upon invoice verification.";
      } else if (text.toLowerCase().includes('issue') || text.toLowerCase().includes('dented') || text.toLowerCase().includes('rejected')) {
        reply = "Quality check failures must be supported with a signed inspection sheet. Please update documentation in the Attachments tab.";
      }

      setPoChats(prev => ({
        ...prev,
        [drawerPo.id]: [
          ...(prev[drawerPo.id] || []),
          {
            sender: 'Buyer',
            message: reply,
            timestamp: new Date().toISOString()
          }
        ]
      }));
    }, 1500);
  };

  // Sort POs
  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  // Filter and sort the PO list
  const getFilteredPOs = () => {
    return cleanPOs
      .filter(po => {
        const matchesSearch = po.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (po.items || []).some(item => item && (item.description.toLowerCase().includes(searchQuery.toLowerCase()) || item.materialCode.toLowerCase().includes(searchQuery.toLowerCase())));

        const mappedStatus = po.status;
        const matchesStatus = statusFilter === 'all' ||
          (statusFilter === 'New' && mappedStatus === 'Open') ||
          (statusFilter === 'Acknowledged' && mappedStatus === 'Acknowledged') ||
          (statusFilter === 'ASN Submitted' && mappedStatus === 'Dispatched') ||
          (statusFilter === 'GRN Complete' && (mappedStatus === 'Delivered' || mappedStatus === 'Invoiced' || mappedStatus === 'Paid'));

        const matchesPlant = plantFilter === 'all' || po.plant === plantFilter;
        const matchesBuyer = buyerFilter === 'all' || po.buyerName === buyerFilter;

        return matchesSearch && matchesStatus && matchesPlant && matchesBuyer;
      })
      .sort((a, b) => {
        let fieldA = a[sortField];
        let fieldB = b[sortField];

        // Custom field comparisons for items/totals
        if (sortField === 'value') {
          fieldA = (a.items || []).reduce((s, i) => s + (i.netValue || 0), 0);
          fieldB = (b.items || []).reduce((s, i) => s + (i.netValue || 0), 0);
        } else if (sortField === 'itemsCount') {
          fieldA = (a.items || []).length;
          fieldB = (b.items || []).length;
        }

        if (fieldA < fieldB) return sortOrder === 'asc' ? -1 : 1;
        if (fieldA > fieldB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
      });
  };

  const filteredPOs = getFilteredPOs();
  const totalPages = Math.ceil(filteredPOs.length / itemsPerPage);
  const paginatedPOs = filteredPOs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  // Initialize ASN Form
  const handleOpenAsnForm = (po) => {
    setActivePo(po);
    const initialQtys = {};
    const initialErrors = {};
    (po.items || []).forEach(item => {
      // Remaining qty = Ordered Qty - GRN Quantity
      const remaining = item.quantity - (item.grnQuantity || 0);
      initialQtys[item.line] = remaining;
      initialErrors[item.line] = '';
    });
    setDispatchQuantities(initialQtys);
    setValidationErrors(initialErrors);
    setEwayBillNo(`E-WAY-${Math.floor(100000000000 + Math.random() * 900000000000)}`);
    setAsnDocs({ packingList: null, invoiceCopy: null, transportDoc: null });
    setAsnForm({
      carrierName: 'DHL Global Logistics',
      trackingNumber: `DHL-${Math.floor(1000000 + Math.random() * 9000000)}`,
      vehicleNumber: 'MH-12-XY-4321',
      invoiceReference: `TAX-2026-${Math.floor(100 + Math.random() * 900)}`,
      shipDate: new Date().toISOString().split('T')[0],
      estimatedDeliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      items: initialQtys
    });
    setDetailTab('create_asn');
    setCurrentView('detail');
  };

  // Validate and submit ASN
  const handleAsnSubmitClick = async () => {
    let hasErrors = false;
    const newErrors = {};

    (activePo?.items || []).forEach(item => {
      const qty = Number(dispatchQuantities[item.line]);
      const remaining = item.quantity - (item.grnQuantity || 0);

      if (isNaN(qty) || qty <= 0) {
        newErrors[item.line] = 'Quantity must be greater than 0';
        hasErrors = true;
      } else if (qty > remaining) {
        newErrors[item.line] = `Quantity cannot exceed remaining ordered units (${remaining})`;
        hasErrors = true;
      } else {
        newErrors[item.line] = '';
      }
    });

    setValidationErrors(newErrors);

    if (hasErrors) return;

    try {
      // Record local submission timestamp to start countdown immediately
      if (activePo) {
        setLocalSubmissionTimes(prev => ({ ...prev, [activePo.id]: new Date().toISOString() }));
      }

      // Call store dispatch
      const res = await handleAsnSubmit({
        ...activePo,
        items: activePo?.items || [],
        ewayBillNo,
        documentIds: Object.values(asnDocs).filter(Boolean).map(d => d.documentId)
      });

      if (res && res.asn) {
        // Configure the success info using the actual backend-generated IDs
        setAsnSuccessInfo({
          asnId: res.asn.id,
          sapInbound: res.asn.sapInboundDelivery,
          poId: activePo?.id || 'PO',
          carrierName: asnForm.carrierName || 'DHL Global Logistics',
          trackingNumber: asnForm.trackingNumber || `TRK-${Math.floor(100000 + Math.random() * 900000)}`,
          eta: asnForm.estimatedDeliveryDate,
          items: (activePo?.items || []).map(item => ({
            ...item,
            shippedQty: Number(dispatchQuantities[item.line])
          }))
        });
      }

      setDetailTab('grn_status');
      setCurrentView('detail');
    } catch (e) {
      console.error(e);
      alert('Failed to submit ASN: ' + (e.message || e));
    }
  };

  // Submit MIRO Invoice Posting
  const handleMiroInvoicePost = () => {
    if (!vendorInvoiceNo.trim() || !billingDate) {
      alert('Please fill in Invoice Reference and Document Date.');
      return;
    }

    setIsPostingInvoice(true);

    const items = (activeGrn?.items || []).map(item => {
      const poItem = activePo?.items?.find(pi => pi.line === item.line);
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

    setTimeout(() => {
      submitInvoice({
        grnId: activeGrn.id,
        poId: activeGrn.poId,
        invoiceNumber: vendorInvoiceNo.toUpperCase(),
        invoiceDate: billingDate,
        subTotal,
        taxAmount,
        totalAmount,
        items
      });
      setIsPostingInvoice(false);
      setInvoicePostedSuccess(true);
    }, 1500);
  };

  // Status Chip formatting
  const renderStatusChip = (status) => {
    const labelMap = {
      Open: 'New',
      Acknowledged: 'Acknowledged',
      Dispatched: 'ASN Submitted',
      Delivered: 'GRN Complete',
      Invoiced: 'Invoice Posted',
      Paid: 'Paid (F110)'
    };
    return (
      <StatusBadge label={labelMap[status] || status} variant={poStatusVariant(status)} className="w-fit" />
    );
  };

  if (isLoading) {
    return (
      <ErrorBoundary>
        <div className="p-4 space-y-4 card overflow-hidden">
          <TableSkeleton rows={6} cols={5} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="space-y-6 max-w-full mx-auto animate-fade-in pb-16 relative">

        {/* ==================== SUB-TABS NAVIGATION BAR ==================== */}
        {currentView === 'list' && (
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-border pb-2 gap-4">
            <div className="flex items-center gap-6">
              <button
                onClick={() => { setPoSubTab('list'); setCurrentPage(1); }}
                className={`pb-2.5 text-sm font-bold border-b-2 transition-all duration-150 cursor-pointer flex items-center gap-2 ${poSubTab === 'list' ? 'border-text-primary text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}`}
              >
                <ShoppingBag className="size-4.5" />
                <span>Orders Monitor</span>
                <span className="bg-surface2 text-text-secondary font-mono text-[10px] px-1.5 py-0.5 rounded-full border border-border tabular-nums">
                  {cleanPOs.length}
                </span>
              </button>
              <button
                onClick={() => { setPoSubTab('grn'); }}
                className={`pb-2.5 text-sm font-bold border-b-2 transition-all duration-150 cursor-pointer flex items-center gap-2 ${poSubTab === 'grn' ? 'border-text-primary text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}`}
              >
                <Truck className="size-4.5" />
                <span>Goods Receipts (MIGO)</span>
                <span className="bg-surface2 text-text-secondary font-mono text-[10px] px-1.5 py-0.5 rounded-full border border-border tabular-nums">
                  {cleanGrns.length}
                </span>
              </button>
              <button
                onClick={() => { setPoSubTab('invoice'); }}
                className={`pb-2.5 text-sm font-bold border-b-2 transition-all duration-150 cursor-pointer flex items-center gap-2 ${poSubTab === 'invoice' ? 'border-text-primary text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}`}
              >
                <FileCheck className="size-4.5" />
                <span>Invoice Ready (MIRO)</span>
                <span className="bg-amber-500/10 text-amber-600 font-mono text-[10px] px-1.5 py-0.5 rounded-full border border-amber-200 font-bold tabular-nums">
                  {cleanGrns.filter(g => !g.invoiceSubmitted).length}
                </span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={simulateIncomingPO}
                variant="outline"
              >
                <RefreshCw className="size-3.5" />
                <span>Simulate SAP PO (ME21N)</span>
              </Button>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 1: ORDERS MONITOR TAB / PO LIST                          */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'list' && (
          <div className="space-y-6">

            {/* KPI Cards Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard
                label="Total Contract Orders"
                value={<span className="tabular-nums">{cleanPOs.length}</span>}
                sub="Synced from ERP ledger"
                icon={ShoppingBag}
              />
              <KPICard
                label="New POs Awaiting Ack"
                value={<span className="tabular-nums">{cleanPOs.filter(p => p.status === 'Open').length}</span>}
                sub="Requires attention"
                icon={Clock}
              />
              <KPICard
                label="Pending ASN Dispatches"
                value={<span className="tabular-nums">{cleanPOs.filter(p => p.status === 'Acknowledged').length}</span>}
                sub="Ready for shipment"
                icon={Truck}
              />
              <KPICard
                label="Completed Orders"
                value={<span className="tabular-nums">{cleanPOs.filter(p => p.status === 'Delivered' || p.status === 'Invoiced' || p.status === 'Paid').length}</span>}
                sub="Stores receipted & post"
                icon={CheckCircle2}
              />
            </div>

            {/* Sticky Filter Bar */}
            <div className="card p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Filter className="size-4 text-text-tertiary" />
                  <h4 className="label mb-0">Search & Filter</h4>
                </div>
                {(searchQuery || statusFilter !== 'all' || plantFilter !== 'all' || buyerFilter !== 'all') && (
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setStatusFilter('all');
                      setPlantFilter('all');
                      setBuyerFilter('all');
                    }}
                    className="text-text-secondary hover:text-text-primary text-xs font-semibold hover:underline transition-colors duration-150"
                  >
                    Reset all filters
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3.5">
                {/* Search Bar */}
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 size-4 text-text-tertiary" />
                  <input
                    type="text"
                    placeholder="PO # or material description..."
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                    className="w-full pl-9"
                  />
                </div>

                {/* Status Filter */}
                <div className="flex items-center bg-base border border-border rounded-md px-2 py-1">
                  <label className="text-[10px] font-bold text-text-tertiary uppercase mr-2 shrink-0">Status</label>
                  <select
                    value={statusFilter}
                    onChange={e => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full !border-0 !p-0 bg-transparent text-xs text-text-secondary outline-none font-semibold cursor-pointer"
                  >
                    <option value="all">All Statuses</option>
                    <option value="New">New (Open)</option>
                    <option value="Acknowledged">Acknowledged</option>
                    <option value="ASN Submitted">ASN Submitted</option>
                    <option value="GRN Complete">GRN Complete</option>
                  </select>
                </div>

                {/* Plant Filter */}
                <div className="flex items-center bg-base border border-border rounded-md px-2 py-1">
                  <label className="text-[10px] font-bold text-text-tertiary uppercase mr-2 shrink-0">Plant</label>
                  <select
                    value={plantFilter}
                    onChange={e => { setPlantFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full !border-0 !p-0 bg-transparent text-xs text-text-secondary outline-none font-semibold cursor-pointer"
                  >
                    <option value="all">All Plants</option>
                    {uniquePlants.map((plant, idx) => (
                      <option key={idx} value={plant}>{plant}</option>
                    ))}
                  </select>
                </div>

                {/* Buyer Filter */}
                <div className="flex items-center bg-base border border-border rounded-md px-2 py-1">
                  <label className="text-[10px] font-bold text-text-tertiary uppercase mr-2 shrink-0">Buyer</label>
                  <select
                    value={buyerFilter}
                    onChange={e => { setBuyerFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full !border-0 !p-0 bg-transparent text-xs text-text-secondary outline-none font-semibold cursor-pointer"
                  >
                    <option value="all">All Buyers</option>
                    {uniqueBuyers.map((buyer, idx) => (
                      <option key={idx} value={buyer}>{buyer}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* PO List Table */}
            {cleanPOs.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={ShoppingBag}
                  title="No Purchase Orders Found"
                  description="No PO records synced yet. Complete onboarding checklist approval or bid conversion to sync your order schedule, or click the simulation button above."
                />
              </div>
            ) : (
              <div className="card overflow-hidden">
                <div className="overflow-x-auto custom-scrollbar border border-border">
                  <table className="w-full text-left border-collapse table-sticky">
                    <thead>
                      <tr>
                        <th className="cursor-pointer" onClick={() => handleSort('id')}>
                          PO Number {sortField === 'id' && (sortOrder === 'asc' ? '▲' : '▼')}
                        </th>
                        <th className="cursor-pointer" onClick={() => handleSort('createdDate')}>
                          PO Date {sortField === 'createdDate' && (sortOrder === 'asc' ? '▲' : '▼')}
                        </th>
                        <th>Buyer Group</th>
                        <th>Plant</th>
                        <th className="text-center cursor-pointer" onClick={() => handleSort('itemsCount')}>
                          Items Count {sortField === 'itemsCount' && (sortOrder === 'asc' ? '▲' : '▼')}
                        </th>
                        <th className="text-right cursor-pointer" onClick={() => handleSort('value')}>
                          Order Value {sortField === 'value' && (sortOrder === 'asc' ? '▲' : '▼')}
                        </th>
                        <th className="cursor-pointer" onClick={() => handleSort('status')}>
                          Status {sortField === 'status' && (sortOrder === 'asc' ? '▲' : '▼')}
                        </th>
                        <th className="text-center">Row Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedPOs.map(po => {
                        if (!po) return null;
                        const totalValue = (po.items || []).reduce((s, i) => s + (i.netValue || 0), 0);
                        const plantName = po.plant || 'Plant 1000 (Mumbai)';
                        const buyerName = po.buyerName || 'Amit Sharma (Lead Procurement)';

                        return (
                          <tr
                            key={po.id}
                            onDoubleClick={() => handleOpenPoDetails(po)}
                            className="group cursor-pointer"
                          >
                            <td className="font-mono font-bold text-text-primary group-hover:underline whitespace-nowrap">
                              {po.id}
                            </td>
                            <td className="font-mono whitespace-nowrap tabular-nums">{formatDate(po.createdDate)}</td>
                            <td className="font-semibold text-text-primary">{buyerName}</td>
                            <td className="font-medium">{plantName}</td>
                            <td className="text-center font-mono font-bold tabular-nums">{(po.items || []).length}</td>
                            <td className="text-right font-mono font-bold text-text-primary whitespace-nowrap tabular-nums">
                              ₹ {totalValue.toLocaleString()}.00
                            </td>
                            <td>
                              {renderStatusChip(po.status)}
                            </td>
                            <td className="text-center" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center justify-center gap-1.5">
                                <Button
                                  size="xs"
                                  variant="secondary"
                                  onClick={() => handleOpenPoDetails(po)}
                                >
                                  View PO
                                </Button>

                                {po.status === 'Acknowledged' && (
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    onClick={() => handleOpenAsnForm(po)}
                                  >
                                    Create ASN
                                  </Button>
                                )}

                                <button
                                  onClick={(e) => handleOpenDrawer(e, po)}
                                  className="p-1 text-text-tertiary hover:text-text-primary hover:bg-surface2 rounded-md transition-colors duration-150"
                                  title="Chat / Raise Issue"
                                >
                                  <MessageSquare className="size-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination footer */}
                {totalPages > 1 && (
                  <div className="px-6 py-4 border-t border-border flex items-center justify-between bg-surface2/50 text-text-secondary text-xs font-semibold">
                    <div>
                      Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, filteredPOs.length)} of {filteredPOs.length} purchase orders
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={currentPage === 1}
                        onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      >
                        Previous
                      </Button>
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`size-7 rounded-md font-bold text-xs flex items-center justify-center transition-colors duration-150 border tabular-nums ${currentPage === page ? 'bg-[rgb(var(--color-emerald-default-rgb))] text-white border-transparent' : 'bg-surface border-border hover:bg-surface2 text-text-secondary'}`}
                        >
                          {page}
                        </button>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={currentPage === totalPages}
                        onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 1: GOODS RECEIPTS (MIGO) MONITOR TAB                      */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'grn' && (
          <div className="space-y-4">
            <div className="card p-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-text-primary">Goods Receipt Notes (GRN) Registry</h3>
                <p className="text-xs text-text-secondary">View and track MIGO post logs synchronized automatically from stores inspections.</p>
              </div>
              <div className="text-xs text-text-secondary font-semibold font-mono tabular-nums">
                Total Inbound Documents: {cleanGrns.length}
              </div>
            </div>

            {cleanGrns.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={Truck}
                  title="No Goods Receipts Registered"
                  description="Once you submit an ASN, the warehouse team performs check-ins and quality inspections (Movement Type 101). The synced GRN will appear here within 10 seconds."
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5">
                {cleanGrns.map(grn => {
                  if (!grn) return null;
                  const po = cleanPOs.find(p => p.id === grn.poId);
                  const hasRejections = (grn.items || []).some(i => i.rejectedQuantity > 0);
                  const acceptedCount = (grn.items || []).reduce((s, i) => s + (i.acceptedQuantity || 0), 0);
                  const rejectedCount = (grn.items || []).reduce((s, i) => s + (i.rejectedQuantity || 0), 0);

                  return (
                    <div
                      key={grn.id}
                      onClick={() => handleOpenGrnDetails(grn)}
                      className="card p-4 hover:border-border-em cursor-pointer transition-colors duration-150 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-text-primary font-mono bg-base border border-border px-2 py-0.5 rounded">
                            {grn.id}
                          </span>
                          <span className="text-[10px] text-text-tertiary font-mono">
                            SAP Doc: {grn.sapMigoDoc}
                          </span>
                          {hasRejections ? (
                            <StatusBadge label="QC Discrepancy" variant="suspended" />
                          ) : (
                            <StatusBadge label="QC Passed" variant="active" />
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-[10px] text-text-tertiary font-bold">
                          <span>PO Ref: {grn.poId}</span>
                          <span>&bull;</span>
                          <span className="tabular-nums">Posting Date: {grn.postingDate}</span>
                          <span>&bull;</span>
                          <span>Inspector: {grn.receivedBy}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-6 self-stretch sm:self-auto justify-between border-t border-border pt-3 sm:border-t-0 sm:pt-0">
                        <div className="text-right">
                          <p className="text-[10px] text-text-tertiary font-bold uppercase">Accepted / Rejected</p>
                          <p className="text-xs font-bold text-text-primary font-mono tabular-nums">
                            {acceptedCount} units / <span className={rejectedCount > 0 ? 'text-red-600 font-extrabold' : 'text-text-tertiary'}>{rejectedCount} rejected</span>
                          </p>
                        </div>
                        <ChevronRight className="size-5 text-text-tertiary" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 1: INVOICE READY (MIRO) MONITOR TAB                       */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'invoice' && (
          <div className="space-y-4">
            <div className="card p-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-text-primary">MIRO Invoice Eligibility Portal</h3>
                <p className="text-xs text-text-secondary">Select verified warehouse receipts that are pending financial billing. Pre-fills lines automatically.</p>
              </div>
              <div className="text-xs text-text-secondary font-semibold font-mono bg-base border border-border px-2.5 py-1 rounded tabular-nums">
                Awaiting Billing: {cleanGrns.filter(g => !g.invoiceSubmitted).length} docs
              </div>
            </div>

            {cleanGrns.filter(g => !g.invoiceSubmitted).length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={FileCheck}
                  title="No Pending Receipts for Invoicing"
                  description={'Once goods receipts are posted by the warehouse and accepted, they will show up here as "Invoice Ready". If all are billed, verify under Invoices Registry.'}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5">
                {cleanGrns.filter(g => !g.invoiceSubmitted).map(grn => {
                  if (!grn) return null;
                  const po = cleanPOs.find(p => p.id === grn.poId);
                  const itemsCount = (grn.items || []).length;
                  const acceptedTotal = (grn.items || []).reduce((s, i) => s + (i.acceptedQuantity || 0), 0);

                  return (
                    <div
                      key={grn.id}
                      onClick={() => handleOpenInvoiceDetail(grn)}
                      className="card p-4 hover:border-amber-300 cursor-pointer transition-colors duration-150 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-amber-700 font-mono bg-amber-500/10 border border-amber-200 px-2 py-0.5 rounded">
                            {grn.id}
                          </span>
                          <span className="text-[10px] text-text-tertiary font-mono">
                            MIGO reference: {grn.sapMigoDoc}
                          </span>
                          <StatusBadge label="Ready for MIRO Posting" variant="warn" />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-[10px] text-text-tertiary font-bold">
                          <span>PO Ref: {grn.poId}</span>
                          <span>&bull;</span>
                          <span className="tabular-nums">Receipt Date: {grn.postingDate}</span>
                          <span>&bull;</span>
                          <span>Billed To: Plant {po?.plant || '1000'}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-6 self-stretch sm:self-auto justify-between border-t border-border pt-3 sm:border-t-0 sm:pt-0">
                        <div className="text-right">
                          <p className="text-[10px] text-text-tertiary font-bold uppercase">Accepted Quantity</p>
                          <p className="text-xs font-bold text-text-primary font-mono tabular-nums">
                            {acceptedTotal} units ({itemsCount} lines)
                          </p>
                        </div>
                        <Button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenInvoiceDetail(grn);
                          }}
                          variant="default"
                          size="sm"
                        >
                          <span>MIRO Invoice</span>
                          <ChevronRight className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 2: PO DETAIL / OBJECT PAGE                                */}
        {/* ================================================================= */}
        {currentView === 'detail' && activePo && (
          <div className="space-y-6 animate-fade-in">
            {/* Header Block & Back button */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
              <div className="space-y-1.5">
                <button
                  onClick={() => setCurrentView('list')}
                  className="flex items-center gap-2 text-text-secondary hover:text-text-primary text-xs font-bold transition-colors duration-150 cursor-pointer w-fit"
                >
                  <ArrowLeft className="size-4" />
                  <span>Back to PO Ledger</span>
                </button>
                <h2 className="text-[22px] font-bold tracking-tight text-text-primary flex items-center gap-2.5">
                  <span>Purchase Order: {activePo.id}</span>
                  {renderStatusChip(activePo.status)}
                </h2>
              </div>

              <div className="flex items-center gap-2">
                {/* Business vs SAP View toggle removed */}

                <Button
                  onClick={(e) => handleOpenDrawer(e, activePo)}
                  variant="outline"
                >
                  <MessageSquare className="size-4" />
                  <span>Chat</span>
                </Button>
                {activePo.status === 'Open' && (
                  <Button
                    onClick={() => acknowledgePO(activePo.id)}
                    variant="default"
                  >
                    Acknowledge Purchase Order
                  </Button>
                )}
              </div>
            </div>

            {/* Shipment Pipeline Progress Indicator */}
            {(() => {
              const steps = [
                { key: 'Open', label: 'New PO', icon: ShoppingBag, color: 'blue' },
                { key: 'Acknowledged', label: 'Acknowledged', icon: CheckCircle2, color: 'purple' },
                { key: 'Dispatched', label: 'ASN Submitted', icon: Truck, color: 'orange' },
                { key: 'Delivered', label: 'GRN Complete', icon: Check, color: 'green' },
                { key: 'Invoiced', label: 'Invoiced', icon: Receipt, color: 'teal' },
              ];
              const statusOrder = ['Open', 'Acknowledged', 'Dispatched', 'Delivered', 'Invoiced', 'Paid'];
              const currentIdx = statusOrder.indexOf(activePo.status);
              return (
                <div className="flex items-center card px-5 py-3.5 overflow-x-auto gap-0 select-none">
                  {steps.map((step, idx) => {
                    const stepIdx = statusOrder.indexOf(step.key);
                    const isPast = stepIdx < currentIdx;
                    const isActive = stepIdx === currentIdx;
                    const StepIcon = step.icon;
                    const colorMap = {
                      blue: { ring: 'border-blue-500 bg-blue-50 text-blue-600', text: 'text-blue-700', dot: 'bg-blue-500' },
                      purple: { ring: 'border-purple-500 bg-purple-50 text-purple-600', text: 'text-purple-700', dot: 'bg-purple-500' },
                      orange: { ring: 'border-orange-500 bg-orange-50 text-orange-600', text: 'text-orange-700', dot: 'bg-orange-400 animate-pulse' },
                      green: { ring: 'border-green-500 bg-green-50 text-green-600', text: 'text-green-700', dot: 'bg-green-500' },
                      teal: { ring: 'border-teal-500 bg-teal-50 text-teal-600', text: 'text-teal-700', dot: 'bg-teal-500' },
                    };
                    const c = colorMap[step.color];
                    return (
                      <React.Fragment key={step.key}>
                        <div className="flex flex-col items-center gap-1 flex-shrink-0">
                          <div className={`size-7 rounded-full flex items-center justify-center border-2 transition-all duration-150 ${isPast ? 'border-green-500 bg-green-500 text-white' :
                            isActive ? `${c.ring} shadow-sm` :
                              'border-border bg-base text-text-tertiary'
                            }`}>
                            {isPast ? <Check className="size-3.5" /> : <StepIcon className="size-3.5" />}
                          </div>
                          <span className={`text-[8px] font-extrabold uppercase tracking-wider whitespace-nowrap ${isPast ? 'text-green-600' : isActive ? c.text : 'text-text-tertiary'
                            }`}>{step.label}</span>
                        </div>
                        {idx < steps.length - 1 && (
                          <div className={`h-0.5 flex-1 min-w-6 mx-1 mb-3.5 rounded-full transition-all duration-150 ${isPast ? 'bg-green-400' : 'bg-border'
                            }`} />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })()}

            {/* TAB HEADERS */}
            <div className="flex items-center gap-6 border-b border-border">
              {[
                { id: 'po_detail', label: '1. PO Detail View' },
                { id: 'create_asn', label: '2. Create ASN' },
                { id: 'grn_status', label: '3. GRN Status' }
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setDetailTab(t.id)}
                  className={`pb-2.5 text-xs font-bold border-b-2 transition-all duration-150 cursor-pointer focus-visible:outline-none ${detailTab === t.id
                    ? 'border-text-primary text-text-primary'
                    : 'border-transparent text-text-tertiary hover:text-text-secondary'
                    }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* TAB CONTENT */}
            <div className="bg-base/30 p-1 rounded-xl">
              {/* TAB 1: PO Detail View */}
              {detailTab === 'po_detail' && (
                <div className="space-y-6 animate-fade-in">
                  {/* PO Header Fields */}
                  <div className="card overflow-hidden">
                    <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-surface2/40">
                      <div className="size-1.5 rounded-full bg-blue-500"></div>
                      <span className="text-[10px] font-extrabold text-text-secondary uppercase tracking-widest">Purchase Order Header Data</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4 p-5">
                      <SapReadOnlyField
                        label="PO Number"
                        value={activePo.id}
                        icon={ShoppingBag}
                        containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer font-mono"
                      />
                      <SapReadOnlyField
                        label="PO Date"
                        value={formatDate(activePo.createdDate)}
                        icon={Calendar}
                      />
                      <SapReadOnlyField
                        label="PO Status"
                        value={activePo.status === 'Open' ? 'Open' : activePo.status === 'Acknowledged' ? 'Acknowledged' : activePo.status}
                        isMonospace={false}
                        icon={CheckCircle2}
                        containerClassName={
                          activePo.status === 'Acknowledged'
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : activePo.status === 'Open'
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : 'bg-surface2 text-text-secondary border-border'
                        }
                      />
                      <SapReadOnlyField
                        label="Buyer Company Code"
                        value={activePo.companyCode || '1000'}
                        icon={Building2}
                        containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer"
                      />
                      <SapReadOnlyField
                        label="Buyer GSTIN"
                        value={activePo.buyerGstin || '27AABCB1234F1Z5'}
                        icon={Receipt}
                      />
                      <SapReadOnlyField
                        label="Plant / Location"
                        value={activePo.plant ? (activePo.plant.includes('Mumbai') ? activePo.plant : `${activePo.plant} (Mumbai)`) : '1000 (Mumbai)'}
                        isMonospace={false}
                        icon={MapPin}
                        containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer"
                      />
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                      <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                        PO Line Items
                      </h4>

                      {/* Carousel Navigation Controls */}
                      {activePo.items && activePo.items.length > 0 && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={activeLineIdx === 0}
                            onClick={() => setActiveLineIdx(prev => Math.max(0, prev - 1))}
                            className="p-1.5 border border-border rounded-lg hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent text-text-secondary cursor-pointer transition-colors duration-150"
                          >
                            <ChevronLeft className="size-4" />
                          </button>
                          <span className="text-xs font-semibold text-text-secondary font-mono select-none tabular-nums">
                            Page {activeLineIdx + 1} of {Math.max(1, Math.ceil(activePo.items.length / 5))}
                          </span>
                          <button
                            type="button"
                            disabled={activeLineIdx >= Math.ceil(activePo.items.length / 5) - 1}
                            onClick={() => setActiveLineIdx(prev => Math.min(Math.ceil(activePo.items.length / 5) - 1, prev + 1))}
                            className="p-1.5 border border-border rounded-lg hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent text-text-secondary cursor-pointer transition-colors duration-150"
                          >
                            <ChevronRight className="size-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {activePo.items && activePo.items.length > 0 && (
                      <div className="w-full space-y-4">
                        {/* Responsive Table Container */}
                        <div className="w-full overflow-x-auto card">
                          <table className="w-full text-left border-collapse min-w-[900px]">
                            <thead>
                              <tr>
                                <th className="w-16">Line</th>
                                <th className="w-36">Material Code</th>
                                <th className="min-w-[200px]">Description</th>
                                <th className="w-28 text-right">Ordered Qty</th>
                                <th className="w-20">UoM</th>
                                <th className="w-32 text-right">Net Price</th>
                                <th className="w-28">GST Tax Code</th>
                                <th className="w-36">Delivery Date</th>
                                <th className="text-right w-36">Line Net Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {activePo.items.slice(activeLineIdx * 5, activeLineIdx * 5 + 5).map((item, idx) => {
                                return (
                                  <tr key={item.line || idx}>
                                    <td className="font-semibold font-mono">{item.line}</td>
                                    <td>
                                      <span className="text-blue-600 font-bold hover:underline cursor-pointer">{item.materialCode}</span>
                                    </td>
                                    <td className="text-text-primary font-medium">{item.description}</td>
                                    <td className="font-bold text-text-primary text-right font-mono tabular-nums">{item.quantity}</td>
                                    <td className="font-medium">{item.uom || 'EA'}</td>
                                    <td className="font-bold text-text-primary text-right font-mono tabular-nums">₹ {item.unitPrice.toLocaleString()}.00</td>
                                    <td className="font-medium">G1 (18%)</td>
                                    <td className="font-medium font-mono tabular-nums">{formatDate(item.deliveryDate || activePo.createdDate)}</td>
                                    <td className="font-bold text-text-primary text-right font-mono tabular-nums">₹ {item.netValue.toLocaleString()}.00</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Bullet page indicators */}
                        {Math.ceil(activePo.items.length / 5) > 1 && (
                          <div className="flex justify-center items-center gap-1.5 mt-3 select-none">
                            {Array.from({ length: Math.ceil(activePo.items.length / 5) }).map((_, dotIdx) => (
                              <button
                                key={dotIdx}
                                type="button"
                                onClick={() => setActiveLineIdx(dotIdx)}
                                className={`size-2 rounded-full transition-all duration-150 cursor-pointer ${activeLineIdx === dotIdx
                                  ? 'bg-text-primary w-4.5'
                                  : 'bg-border-em hover:bg-text-tertiary'
                                  }`}
                                title={`Go to page ${dotIdx + 1}`}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: Create ASN */}
              {detailTab === 'create_asn' && (
                <div className="space-y-6 animate-fade-in">
                  {activePo.status === 'Open' ? (
                    <div className="card p-6 text-center">
                      <AlertTriangle className="size-8 text-amber-500 mx-auto mb-2" />
                      <h4 className="text-xs font-bold text-text-primary">PO Acknowledgement Required</h4>
                      <p className="text-xs text-text-secondary mt-1">
                        You must acknowledge this purchase order before you can create an Inbound ASN Delivery.
                      </p>
                      <Button
                        onClick={() => acknowledgePO(activePo.id)}
                        variant="outline"
                        className="mt-4"
                      >
                        Acknowledge PO
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="card p-4 flex items-center justify-between">
                        <div>
                          <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">Advanced Shipping Notice Form (VL31N)</h4>
                          <p className="text-[10px] text-text-secondary font-medium mt-0.5">Provide actual shipment details and dispatch quantities</p>
                        </div>
                        <Button
                          onClick={handleAsnSubmitClick}
                          variant="default"
                        >
                          Submit Inbound Delivery
                        </Button>
                      </div>

                      {/* ASN Header Fields — 3-column grid, label-on-top aligned */}
                      <div className="card overflow-hidden">
                        <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-surface2/40">
                          <div className="size-1.5 rounded-full bg-purple-500"></div>
                          <span className="text-[10px] font-extrabold text-text-secondary uppercase tracking-widest">ASN Shipment Header</span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-5">
                          <SapInputField label="Linked PO Number" icon={ShoppingBag}>
                            <input
                              type="text"
                              readOnly
                              value={activePo.id}
                              className="w-36 bg-surface border border-border rounded-[3px] px-2.5 h-6.5 text-xs outline-none text-text-primary font-mono font-bold tabular-nums cursor-not-allowed select-all"
                            />
                          </SapInputField>

                          <SapInputField label="Dispatch Date" required icon={Calendar}>
                            <input
                              type="date"
                              required
                              value={asnForm.shipDate}
                              onChange={e => setAsnForm({ ...asnForm, shipDate: e.target.value })}
                              className="w-36 bg-surface border border-border focus:border-[rgb(var(--color-emerald-default-rgb))] rounded-[3px] px-2.5 h-6.5 text-xs outline-none text-text-primary font-mono font-bold tabular-nums transition-all duration-150"
                            />
                          </SapInputField>

                          <SapInputField label="Expected Delivery" required icon={Calendar}>
                            <input
                              type="date"
                              required
                              value={asnForm.estimatedDeliveryDate}
                              onChange={e => setAsnForm({ ...asnForm, estimatedDeliveryDate: e.target.value })}
                              className="w-36 bg-surface border border-border focus:border-[rgb(var(--color-emerald-default-rgb))] rounded-[3px] px-2.5 h-6.5 text-xs outline-none text-text-primary font-mono font-bold tabular-nums transition-all duration-150"
                            />
                          </SapInputField>

                          <SapInputField label="Carrier / Transporter" required icon={Truck}>
                            <input
                              type="text"
                              required
                              maxLength={10}
                              value={asnForm.carrierName}
                              onChange={e => setAsnForm({ ...asnForm, carrierName: e.target.value })}
                              placeholder="DHL Express"
                              className="w-[14ch] bg-surface border border-border focus:border-[rgb(var(--color-emerald-default-rgb))] rounded-[3px] px-2.5 h-6.5 text-xs outline-none text-text-primary font-bold transition-all duration-150"
                            />
                          </SapInputField>

                          <SapInputField label="Vehicle / Tracking No." icon={Truck}>
                            <input
                              type="text"
                              maxLength={20}
                              value={asnForm.vehicleNumber}
                              onChange={e => setAsnForm({ ...asnForm, vehicleNumber: e.target.value })}
                              placeholder="MH-12-XY-4321"
                              className="w-[24ch] bg-surface border border-border focus:border-[rgb(var(--color-emerald-default-rgb))] rounded-[3px] px-2.5 h-6.5 text-xs outline-none text-text-primary font-mono font-bold uppercase transition-all duration-150"
                            />
                          </SapInputField>

                          <SapInputField label="E-Way Bill Number" icon={Receipt}>
                            <input
                              type="text"
                              maxLength={12}
                              value={ewayBillNo}
                              onChange={e => setEwayBillNo(e.target.value.replace(/\D/g, ''))}
                              placeholder="12-digit numeric code"
                              className="w-[16ch] bg-surface border border-border focus:border-[rgb(var(--color-emerald-default-rgb))] rounded-[3px] px-2.5 h-6.5 text-xs outline-none text-text-primary font-mono font-bold tabular-nums transition-all duration-150"
                            />
                          </SapInputField>
                        </div>
                      </div>

                      {/* ASN Document Attachments */}
                      <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                          <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                            Shipment Document Attachments
                          </h4>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <FileUploadZone
                            label="Packing List (Optional)"
                            value={asnDocs.packingList}
                            onUploadComplete={result => setAsnDocs(prev => ({ ...prev, packingList: result }))}
                            onFileRemoved={() => setAsnDocs(prev => ({ ...prev, packingList: null }))}
                            linkedTo="ASN"
                            accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                          />
                          <FileUploadZone
                            label="Invoice Copy (Optional)"
                            value={asnDocs.invoiceCopy}
                            onUploadComplete={result => setAsnDocs(prev => ({ ...prev, invoiceCopy: result }))}
                            onFileRemoved={() => setAsnDocs(prev => ({ ...prev, invoiceCopy: null }))}
                            linkedTo="ASN"
                            accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                          />
                          <FileUploadZone
                            label="Transport Bill / LR (Optional)"
                            value={asnDocs.transportDoc}
                            onUploadComplete={result => setAsnDocs(prev => ({ ...prev, transportDoc: result }))}
                            onFileRemoved={() => setAsnDocs(prev => ({ ...prev, transportDoc: null }))}
                            linkedTo="ASN"
                            accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                          />
                        </div>
                      </div>

                      {/* Dispatch quantities allocation */}
                      <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                          <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                            Dispatch Qty Allocation
                          </h4>

                          {/* Carousel Navigation Controls */}
                          {activePo.items && activePo.items.length > 0 && (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={asnLineIdx === 0}
                                onClick={() => setAsnLineIdx(prev => Math.max(0, prev - 1))}
                                className="p-1.5 border border-border rounded-lg hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent text-text-secondary cursor-pointer transition-colors duration-150"
                              >
                                <ChevronLeft className="size-4" />
                              </button>
                              <span className="text-xs font-semibold text-text-secondary font-mono select-none tabular-nums">
                                Page {asnLineIdx + 1} of {Math.max(1, Math.ceil(activePo.items.length / 5))}
                              </span>
                              <button
                                type="button"
                                disabled={asnLineIdx >= Math.ceil(activePo.items.length / 5) - 1}
                                onClick={() => setAsnLineIdx(prev => Math.min(Math.ceil(activePo.items.length / 5) - 1, prev + 1))}
                                className="p-1.5 border border-border rounded-lg hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent text-text-secondary cursor-pointer transition-colors duration-150"
                              >
                                <ChevronRight className="size-4" />
                              </button>
                            </div>
                          )}
                        </div>

                        {activePo.items && activePo.items.length > 0 && (
                          <div className="w-full space-y-4">
                            {/* Responsive Table Container */}
                            <div className="w-full overflow-x-auto card">
                              <table className="w-full text-left border-collapse min-w-[900px]">
                                <thead>
                                  <tr>
                                    <th className="w-16">Line</th>
                                    <th className="w-36">Material Code</th>
                                    <th className="min-w-[200px]">Description</th>
                                    <th className="w-28 text-right">Ordered Qty</th>
                                    <th className="w-28 text-right">Remaining Qty</th>
                                    <th className="w-36 text-center">Dispatched Qty</th>
                                    <th className="w-20">UoM</th>
                                    <th className="w-32 text-right">Net Price</th>
                                    <th className="text-right w-36">Delivery Date</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {activePo.items.slice(asnLineIdx * 5, asnLineIdx * 5 + 5).map((item, idx) => {
                                    const remaining = item.quantity - (item.grnQuantity || 0);
                                    const error = validationErrors[item.line];
                                    return (
                                      <tr key={item.line || idx}>
                                        <td className="font-semibold font-mono">{item.line}</td>
                                        <td>
                                          <span className="text-blue-600 font-bold hover:underline cursor-pointer">{item.materialCode}</span>
                                        </td>
                                        <td className="text-text-primary font-medium">{item.description}</td>
                                        <td className="font-bold text-text-primary text-right font-mono tabular-nums">{item.quantity}</td>
                                        <td className="font-bold text-amber-700 text-right font-mono tabular-nums">{remaining}</td>
                                        <td className="text-center">
                                          <div className="flex flex-col items-center justify-center gap-0.5">
                                            <input
                                              type="number"
                                              value={dispatchQuantities[item.line] || ''}
                                              onChange={e => {
                                                const val = e.target.value;
                                                setDispatchQuantities(prev => ({
                                                  ...prev,
                                                  [item.line]: val
                                                }));
                                                setAsnForm(prev => ({
                                                  ...prev,
                                                  items: {
                                                    ...prev.items,
                                                    [item.line]: val
                                                  }
                                                }));
                                              }}
                                              className={`w-24 bg-surface border focus:border-[rgb(var(--color-emerald-default-rgb))] rounded-[3px] px-2 py-0.5 text-xs text-right font-mono font-semibold outline-none tabular-nums transition-all duration-150 ${error ? 'border-red-500 focus:border-red-500 bg-red-50/30' : 'border-border-em'
                                                }`}
                                              placeholder="0"
                                            />
                                            {error && (
                                              <span className="text-[9px] text-red-600 font-bold block max-w-24 leading-tight truncate" title={error}>
                                                {error}
                                              </span>
                                            )}
                                          </div>
                                        </td>
                                        <td className="font-medium">{item.uom || 'EA'}</td>
                                        <td className="font-bold text-text-primary text-right font-mono tabular-nums">₹ {item.unitPrice.toLocaleString()}.00</td>
                                        <td className="font-medium font-mono tabular-nums text-right">{formatDate(item.deliveryDate || activePo.createdDate)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>

                            {/* Bullet page indicators */}
                            {Math.ceil(activePo.items.length / 5) > 1 && (
                              <div className="flex justify-center items-center gap-1.5 mt-3 select-none">
                                {Array.from({ length: Math.ceil(activePo.items.length / 5) }).map((_, dotIdx) => (
                                  <button
                                    key={dotIdx}
                                    type="button"
                                    onClick={() => setAsnLineIdx(dotIdx)}
                                    className={`size-2 rounded-full transition-all duration-150 cursor-pointer ${asnLineIdx === dotIdx
                                      ? 'bg-text-primary w-4.5'
                                      : 'bg-border-em hover:bg-text-tertiary'
                                      }`}
                                    title={`Go to page ${dotIdx + 1}`}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: GRN Status */}
              {detailTab === 'grn_status' && (
                <div className="space-y-6 animate-fade-in">
                  {(() => {
                    const grn = cleanGrns.find(g => g.poId === activePo.id);
                    const activeAsn = cleanAsns.find(a => a.poId === activePo.id) || (asnSuccessInfo?.poId === activePo.id ? asnSuccessInfo : null);
                    if (!grn) {
                      if (activePo.status === 'Dispatched') {
                        return (
                          <div className="p-6 border border-amber-200 bg-amber-50 rounded-xl space-y-4 max-w-xl mx-auto shadow-sm animate-fade-in text-amber-900">
                            <div className="text-center space-y-2">
                              <div className="size-12 bg-green-50 border border-green-200 text-green-600 rounded-full flex items-center justify-center mx-auto shadow-xs">
                                <Check className="size-6 animate-pulse" />
                              </div>
                              <h4 className="text-sm font-bold text-amber-800">ASN Dispatch Submitted Successfully</h4>
                              <p className="text-xs text-text-secondary max-w-md mx-auto leading-normal">
                                Logistics dispatch details successfully transmitted via SAP BAPI (`BAPI_DELIVERY_CREATE_DN`).
                              </p>
                            </div>

                            <div className="p-4 bg-surface border border-amber-200/60 rounded-xl text-xs space-y-3.5 shadow-sm">
                              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-left font-mono">
                                <div>
                                  <span className="text-[9px] text-text-tertiary font-bold uppercase block font-sans">ASN Reference ID</span>
                                  <span className="font-bold text-text-primary text-xs select-all">
                                    {activeAsn?.id || activeAsn?.asnId || 'N/A'}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] text-text-tertiary font-bold uppercase block font-sans">SAP Delivery Note ID</span>
                                  <span className="font-bold text-text-primary text-xs select-all">
                                    {activeAsn?.sapInboundDelivery || activeAsn?.sapInbound || 'N/A'}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] text-text-tertiary font-bold uppercase block font-sans">Carrier / Transporter</span>
                                  <span className="font-bold text-text-secondary text-xs font-sans">
                                    {activeAsn?.carrierName || 'N/A'}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] text-text-tertiary font-bold uppercase block font-sans">Tracking / Vehicle No</span>
                                  <span className="font-bold text-text-secondary text-xs">
                                    {activeAsn?.trackingNumber || activeAsn?.vehicleNumber || 'N/A'}
                                  </span>
                                </div>
                              </div>

                              <div className="border-t border-border pt-3 flex items-center justify-between bg-surface2/50 p-2.5 rounded-lg">
                                <div className="flex items-center gap-2">
                                  <Truck className="size-4.5 text-amber-500 animate-pulse" />
                                  <span className="font-semibold text-text-secondary font-sans">Warehouse MIGO receipt simulation:</span>
                                </div>
                                <span className="text-amber-600 animate-pulse font-bold font-mono text-sm tabular-nums">
                                  {countdown[activePo.id] !== undefined ? `${countdown[activePo.id]}s` : '10s'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div className="card p-6 text-center">
                          <AlertTriangle className="size-8 text-text-tertiary mx-auto mb-2" />
                          <h4 className="text-xs font-bold text-text-primary">Goods Receipt Not Synced</h4>
                          <p className="text-xs text-text-secondary mt-1">
                            Please prepare and submit ASN shipment dispatch (Tab 2) first to initiate delivery sync.
                          </p>
                        </div>
                      );
                    }

                    // GRN exists!
                    return (
                      <div className="space-y-6 animate-fade-in">
                        <div className="card p-4 flex items-center justify-between">
                          <div>
                            <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">SAP Goods Receipt Note (MIGO 101)</h4>
                            <p className="text-[10px] text-text-secondary font-medium mt-0.5">Inspected & cleared by warehouse stores division</p>
                          </div>
                          {!grn.invoiceSubmitted ? (
                            <Button
                              onClick={() => handleOpenInvoiceDetail(grn)}
                              variant="default"
                            >
                              <span>Proceed with Invoice</span>
                              <ChevronRight className="size-3.5" />
                            </Button>
                          ) : (
                            <span className="px-3 py-1 rounded bg-surface2 text-text-secondary border border-border text-xs font-bold font-mono">
                              Invoice Posted (MIRO complete)
                            </span>
                          )}
                        </div>

                        {/* GRN Header Fields — 3-column grid, label-on-top aligned */}
                        <div className="card overflow-hidden">
                          <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-surface2/40">
                            <div className="size-1.5 rounded-full bg-green-500"></div>
                            <span className="text-[10px] font-extrabold text-text-secondary uppercase tracking-widest">Goods Receipt (MIGO) Header Data</span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-5">
                            <SapReadOnlyField
                              label="GRN Document Number"
                              value={grn.sapMigoDoc}
                              icon={FileText}
                              containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer font-mono"
                            />
                            <SapReadOnlyField
                              label="Posting Date"
                              value={formatDate(grn.postingDate)}
                              icon={Calendar}
                            />
                            <SapReadOnlyField
                              label="Movement Type"
                              value="101 — Goods Receipt"
                              isMonospace={false}
                              icon={Truck}
                              containerClassName="bg-emerald-50 text-emerald-700 border-emerald-200"
                            />
                            <SapReadOnlyField
                              label="Received By"
                              value={grn.receivedBy || 'Stores Manager (QC Group)'}
                              isMonospace={false}
                              icon={User}
                            />
                            <SapReadOnlyField
                              label="Linked PO Number"
                              value={activePo.id}
                              icon={ShoppingBag}
                              containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer font-mono"
                            />
                            <SapReadOnlyField
                              label="QC Inspection Status"
                              value={(grn.items || []).some(i => i.rejectedQuantity > 0) ? 'Discrepancy Found' : 'All Items Accepted'}
                              isMonospace={false}
                              icon={ShieldCheck}
                              containerClassName={(grn.items || []).some(i => i.rejectedQuantity > 0) ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}
                            />
                          </div>
                        </div>

                        {/* QC Line Status Table Itemization (Create ASN Style) */}
                        <div className="space-y-4">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                            <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                              GRN Line Items &amp; QC Status
                            </h4>

                            {/* Carousel Navigation Controls */}
                            {grn.items && grn.items.length > 0 && (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={grnLineIdx === 0}
                                  onClick={() => setGrnLineIdx(prev => Math.max(0, prev - 1))}
                                  className="p-1.5 border border-border rounded-lg hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent text-text-secondary cursor-pointer transition-colors duration-150"
                                >
                                  <ChevronLeft className="size-4" />
                                </button>
                                <span className="text-xs font-semibold text-text-secondary font-mono select-none tabular-nums">
                                  Page {grnLineIdx + 1} of {Math.max(1, Math.ceil(grn.items.length / 5))}
                                </span>
                                <button
                                  type="button"
                                  disabled={grnLineIdx >= Math.ceil(grn.items.length / 5) - 1}
                                  onClick={() => setGrnLineIdx(prev => Math.min(Math.ceil(grn.items.length / 5) - 1, prev + 1))}
                                  className="p-1.5 border border-border rounded-lg hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent text-text-secondary cursor-pointer transition-colors duration-150"
                                >
                                  <ChevronRight className="size-4" />
                                </button>
                              </div>
                            )}
                          </div>

                          {grn.items && grn.items.length > 0 && (
                            <div className="w-full space-y-4">
                              {/* Responsive Table Container */}
                              <div className="w-full overflow-x-auto card">
                                <table className="w-full text-left border-collapse min-w-[900px] whitespace-nowrap">
                                  <thead>
                                    <tr>
                                      <th className="w-16">Line</th>
                                      <th className="w-36">Material Code</th>
                                      <th className="min-w-[200px]">Description</th>
                                      <th className="w-28 text-right">Received Qty</th>
                                      <th className="w-28 text-right">Accepted Qty</th>
                                      <th className="w-28 text-right">Rejected Qty</th>
                                      <th className="w-20">UoM</th>
                                      <th className="text-center w-28">Quality Status</th>
                                      <th className="text-right w-36 font-sans">Posting Date</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {grn.items.slice(grnLineIdx * 5, grnLineIdx * 5 + 5).map((item, idx) => {
                                      const isRejected = (item.rejectedQuantity || 0) > 0;
                                      return (
                                        <tr key={item.line || idx}>
                                          <td className="font-semibold font-mono">{item.line}</td>
                                          <td>
                                            <span className="text-blue-600 font-bold hover:underline cursor-pointer">{item.materialCode}</span>
                                          </td>
                                          <td className="font-sans font-medium text-text-primary">{item.description}</td>
                                          <td className="font-bold text-text-primary text-right font-mono tabular-nums">{item.receivedQuantity || (item.acceptedQuantity + (item.rejectedQuantity || 0))}</td>
                                          <td className="font-bold text-emerald-700 text-right font-mono tabular-nums">{item.acceptedQuantity}</td>
                                          <td className={`font-bold text-right font-mono tabular-nums ${isRejected ? 'text-rose-600' : 'text-text-tertiary'}`}>{item.rejectedQuantity || 0}</td>
                                          <td className="font-medium">{item.uom || 'EA'}</td>
                                          <td className="text-center">
                                            {isRejected ? (
                                              <StatusBadge label="QC FAIL" variant="suspended" />
                                            ) : (
                                              <StatusBadge label="QC PASS" variant="active" />
                                            )}
                                          </td>
                                          <td className="text-right font-mono font-medium tabular-nums">{formatDate(grn.postingDate)}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>

                              {/* Bullet page indicators */}
                              {Math.ceil(grn.items.length / 5) > 1 && (
                                <div className="flex justify-center items-center gap-1.5 mt-3 select-none">
                                  {Array.from({ length: Math.ceil(grn.items.length / 5) }).map((_, dotIdx) => (
                                    <button
                                      key={dotIdx}
                                      type="button"
                                      onClick={() => setGrnLineIdx(dotIdx)}
                                      className={`size-2 rounded-full transition-all duration-150 cursor-pointer ${grnLineIdx === dotIdx
                                        ? 'bg-text-primary w-4.5'
                                        : 'bg-border-em hover:bg-text-tertiary'
                                        }`}
                                      title={`Go to page ${dotIdx + 1}`}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ==================== SCREEN 5: INVOICE ELIGIBILITY PAGE (MIRO PREFILLED VIEW) ==================== */}
        {currentView === 'invoice_detail' && activeGrn && activePo && (
          <div className="space-y-6">
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setCurrentView('list'); setPoSubTab('invoice'); }}
                className="flex items-center gap-2 text-text-secondary hover:text-text-primary text-xs font-bold transition-colors duration-150 cursor-pointer w-fit"
              >
                <ArrowLeft className="size-4" />
                <span>Back to Invoice Ready List</span>
              </button>
            </div>

            {/* Success Post view */}
            {invoicePostedSuccess ? (
              <div className="card p-8 text-center max-w-md mx-auto space-y-6">
                <div className="size-16 bg-green-50 border-2 border-green-500 rounded-full flex items-center justify-center text-green-600 mx-auto">
                  <Check className="size-8" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-base font-bold text-text-primary">MIRO Invoice Posted Successfully</h3>
                  <p className="text-xs text-text-secondary">BAPI_INCOMINGINVOICE_CREATE matched &amp; posted in SAP ledger</p>
                </div>

                <div className="p-3 bg-base border border-border rounded-lg text-xs font-mono font-bold text-text-secondary text-left space-y-1">
                  <p>PO Reference: {activePo.id}</p>
                  <p>GRN Reference: {activeGrn.id}</p>
                  <p>Invoice Doc Reference: {vendorInvoiceNo.toUpperCase()}</p>
                  <p>SAP MIRO Doc: 510560{String(activeGrn?.id || '').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 9000 + 1000}</p>
                </div>

                <div className="p-3 bg-amber-500/10 border border-amber-200 rounded-lg text-[10px] text-amber-800 leading-normal font-semibold text-left">
                  💳 The invoice is now posted. SAP payment run (F110 RTGS/NEFT batch) is simulated weekly. The invoice status will update to Paid within 12 seconds automatically.
                </div>

                <div className="flex justify-center gap-3">
                  <Button
                    onClick={() => {
                      setActiveTab('invoices');
                    }}
                    variant="default"
                  >
                    Go to Invoices Registry
                  </Button>
                  <Button
                    onClick={() => {
                      setCurrentView('list');
                      setPoSubTab('list');
                    }}
                    variant="outline"
                  >
                    Close
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">

                {/* Notice Banner */}
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
                  <ShieldCheck className="size-5 text-emerald-600 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-bold text-emerald-800 text-xs uppercase tracking-wider">3-Way Match Verification Complete</h4>
                    <p className="text-emerald-700 text-xs mt-1 leading-normal font-semibold">
                      Purchase Order quantities, Unit prices, and Warehouse Goods Receipt (MIGO) accepted counts match perfectly. You are eligible to post MIRO billing for this receipt.
                    </p>
                  </div>
                </div>

                {/* Prefilled Fields Section */}
                <div className="card p-5 space-y-4">
                  <h3 className="text-xs font-bold text-text-primary uppercase border-b border-border pb-2">Prefilled Header Parameters</h3>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 text-xs">
                    <div>
                      <span className="text-[10px] text-text-tertiary font-bold uppercase block">Vendor Code</span>
                      <span className="font-semibold text-text-secondary">{state?.profile?.sapVendorCode || 'VND-4001'}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-text-tertiary font-bold uppercase block">Vendor Name</span>
                      <span className="font-semibold text-text-secondary">{state?.profile?.companyName || 'Your Firm'}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-text-tertiary font-bold uppercase block">PO Reference</span>
                      <span className="font-mono font-bold text-text-secondary">{activePo.id}</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-text-tertiary font-bold uppercase block">GRN Document</span>
                      <span className="font-mono font-bold text-text-secondary">{activeGrn.id} (SAP MIGO: {activeGrn.sapMigoDoc})</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-text-tertiary font-bold uppercase block">Tax Scheme</span>
                      <span className="font-semibold text-text-secondary">GST 18% (G1 code)</span>
                    </div>
                    <div>
                      <span className="text-[10px] text-text-tertiary font-bold uppercase block">Payment Terms</span>
                      <span className="font-semibold text-text-secondary">{activePo.paymentTerms}</span>
                    </div>
                  </div>
                </div>

                {/* Form Entry Block */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

                  {/* Billing items grid (8 cols) */}
                  <div className="lg:col-span-8 card p-5 space-y-4">
                    <h3 className="text-xs font-bold text-text-primary uppercase border-b border-border pb-2">Billed Line Allocation</h3>

                    <div className="border border-border rounded-lg overflow-hidden">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr>
                            <th>Line</th>
                            <th>Material & Description</th>
                            <th className="text-right">Billed Qty</th>
                            <th className="text-right font-mono">Unit Price</th>
                            <th className="text-right">GST Tax</th>
                            <th className="text-right">Total Net Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(activeGrn.items || []).map(item => {
                            const poItem = activePo?.items?.find(pi => pi.line === item.line);
                            const unitPrice = poItem?.unitPrice || 0;
                            const netValue = item.acceptedQuantity * unitPrice;

                            return (
                              <tr key={item.line}>
                                <td className="font-mono text-text-tertiary">{item.line}</td>
                                <td>
                                  <p className="font-semibold text-text-primary">{item.description}</p>
                                  <p className="text-[10px] text-text-tertiary font-mono mt-0.5">{item.materialCode}</p>
                                </td>
                                <td className="text-right font-mono font-bold text-emerald-700 bg-emerald-50/20 tabular-nums">
                                  {item.acceptedQuantity} {poItem?.uom || 'EA'}
                                </td>
                                <td className="text-right font-mono tabular-nums">₹ {unitPrice.toLocaleString()}.00</td>
                                <td className="text-right font-mono">18% (G1)</td>
                                <td className="text-right font-mono font-bold text-text-primary tabular-nums">
                                  ₹ {netValue.toLocaleString()}.00
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Manual Billing Inputs */}
                    <div className="border-t border-border pt-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <EnterpriseFieldCard label="Vendor Tax Invoice No." required icon={FileText}>
                          <input
                            type="text"
                            maxLength={16}
                            value={vendorInvoiceNo}
                            onChange={e => setVendorInvoiceNo(e.target.value)}
                            placeholder="INV-2026-8890"
                            className="w-[20ch] uppercase h-8"
                          />
                        </EnterpriseFieldCard>

                        <EnterpriseFieldCard label="Invoice Date" required icon={Calendar}>
                          <input
                            type="date"
                            value={billingDate}
                            onChange={e => setBillingDate(e.target.value)}
                            className="w-[15ch] h-8"
                          />
                        </EnterpriseFieldCard>
                      </div>
                    </div>
                  </div>

                  {/* Summary calculation card (4 cols) */}
                  <div className="lg:col-span-4 card p-5 space-y-4">
                    <h3 className="text-xs font-bold text-text-primary uppercase border-b border-border pb-2">Invoice Summary</h3>

                    {(() => {
                      const subtotal = (activeGrn.items || []).reduce((sum, item) => {
                        const poItem = activePo?.items?.find(pi => pi.line === item.line);
                        const unitPrice = poItem?.unitPrice || 0;
                        return sum + item.acceptedQuantity * unitPrice;
                      }, 0);
                      const gst = Number((subtotal * 0.18).toFixed(2));
                      const total = subtotal + gst;

                      return (
                        <div className="space-y-4 text-xs">
                          <div className="space-y-2 text-text-secondary font-semibold">
                            <div className="flex justify-between">
                              <span>Subtotal</span>
                              <span className="font-mono text-text-secondary tabular-nums">₹ {subtotal.toLocaleString()}.00</span>
                            </div>
                            <div className="flex justify-between">
                              <span>GST Tax (18% G1)</span>
                              <span className="font-mono text-text-secondary tabular-nums">₹ {gst.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Freight charges</span>
                              <span className="font-mono text-text-secondary tabular-nums">₹ 0.00</span>
                            </div>
                          </div>

                          <div className="border-t border-border pt-3 flex justify-between items-baseline">
                            <span className="font-bold text-text-primary text-sm">Grand Gross Value</span>
                            <span className="text-lg font-bold text-text-primary font-mono tabular-nums">
                              ₹ {total.toLocaleString()}
                            </span>
                          </div>

                          <div className="pt-2">
                            <Button
                              disabled={isPostingInvoice}
                              onClick={handleMiroInvoicePost}
                              variant="default"
                              className="w-full"
                            >
                              {isPostingInvoice ? (
                                <>
                                  <RefreshCw className="size-3.5 animate-spin" />
                                  <span>Verifying in SAP...</span>
                                </>
                              ) : (
                                <>
                                  <FileCheck className="size-4" />
                                  <span>Post MIRO Logistics Invoice</span>
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* COLLAPSIBLE RIGHT DRAWER: COMMUNICATION CENTER                   */}
        {/* ================================================================= */}
        {drawerOpen && drawerPo && (
          <div className="fixed inset-0 z-50 overflow-hidden" onClick={() => setDrawerOpen(false)}>
            <div className="absolute inset-0 bg-black/20 backdrop-blur-xs transition-opacity animate-fade-in" />

            <div className="absolute inset-y-0 right-0 pl-10 max-w-full flex" onClick={e => e.stopPropagation()}>
              <div className="w-screen max-w-md bg-surface shadow-xl flex flex-col h-full border-l border-border animate-slide-left">

                {/* Drawer Header */}
                <div className="p-5 border-b border-border bg-surface2/40 flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-sm text-text-primary flex items-center gap-2">
                      <MessageSquare className="size-4.5 text-text-tertiary" />
                      <span>Communication Desk</span>
                    </h3>
                    <p className="text-[10px] text-text-tertiary font-mono mt-0.5">PO Ref: {drawerPo.id}</p>
                  </div>
                  <button
                    onClick={() => setDrawerOpen(false)}
                    className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface2 rounded-md transition-colors duration-150"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                {/* Status control */}
                <div className="px-5 py-3 border-b border-border flex items-center justify-between text-xs bg-surface2/30">
                  <span className="font-bold text-text-secondary uppercase text-[9px] tracking-wider">Issue Status Tag:</span>
                  <div className="flex items-center gap-1.5">
                    {['Open', 'In Review', 'Resolved'].map(st => (
                      <button
                        key={st}
                        onClick={() => setPoIssueStatus(prev => ({ ...prev, [drawerPo.id]: st }))}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors duration-150 ${poIssueStatus[drawerPo.id] === st
                          ? st === 'Open' ? 'bg-red-50 text-red-700 border-red-200'
                            : st === 'In Review' ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : 'bg-green-50 text-green-700 border-green-200'
                          : 'bg-surface border-border text-text-secondary hover:bg-surface2'
                          }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Messages Body */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar bg-base/20">
                  {(poChats[drawerPo.id] || []).map((msg, idx) => (
                    <div key={idx} className={`flex flex-col gap-1 max-w-[85%] ${msg.sender === 'Vendor' ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
                      <span className="text-[8px] font-bold text-text-tertiary uppercase tracking-widest font-mono">
                        {msg.sender === 'Vendor' ? 'Your Firm' : 'Amit Sharma (Buyer)'}
                      </span>
                      <div className={`p-3 rounded-2xl border text-xs ${msg.sender === 'Vendor' ? 'bg-[rgb(var(--color-emerald-default-rgb))] border-transparent text-white rounded-tr-none' : 'bg-surface border-border text-text-primary rounded-tl-none shadow-xs'}`}>
                        <p className="leading-relaxed">{msg.message}</p>
                      </div>
                      <span className="text-[8px] text-text-tertiary font-mono mt-0.5 tabular-nums">
                        {parseDateSafe(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Message Input Footer */}
                <div className="p-4 border-t border-border bg-surface flex gap-2">
                  <input
                    type="text"
                    placeholder="Ask buyer a question..."
                    value={chatMessageInput}
                    onChange={e => setChatMessageInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSendDrawerMessage()}
                    className="flex-1"
                  />
                  <button
                    onClick={handleSendDrawerMessage}
                    className="px-3 bg-[rgb(var(--color-emerald-default-rgb))] hover:opacity-90 text-white rounded-lg transition-all duration-150 cursor-pointer flex items-center justify-center"
                  >
                    <Send className="size-4" />
                  </button>
                </div>

              </div>
            </div>
          </div>
        )}

      </div>
    </ErrorBoundary>
  );
}
