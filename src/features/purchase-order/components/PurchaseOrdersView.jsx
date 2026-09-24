'use client';

import React, { useState, useEffect } from 'react';
import {
  ShoppingBag, Clock, CheckCircle2, Truck, ChevronRight, ChevronLeft, Search, Filter,
  Calendar, User, Download, AlertTriangle, MessageSquare, Plus, Send,
  FileText, X, ChevronDown, Check, MapPin, CreditCard, ArrowLeft,
  Building, Building2, TrendingUp, Percent, ShieldCheck, ShieldAlert, Loader2, RefreshCw, HelpCircle, Receipt, CalendarClock, AlertCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import FileUploadZone from '@/components/shared/FileUploadZone';
import ErrorBoundary from '@/components/ErrorBoundary';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import TableSkeleton from '@/components/ui/TableSkeleton';
import KPICard from '@/components/ui/KPICard';
import Modal from '@/components/ui/Modal';
import { poStatusVariant } from '@/lib/statusColors';
import { describeSyncState } from '@/lib/syncState';
import { poKind, lineKind, kindTone, lineHasInvoicePlan, hasInvoicePlan as poHasInvoicePlan, hasPendingInvoicePlanChange, invoicePlanNumbers } from '@/features/purchase-order/poKind';
import { useWhoami } from '@/lib/whoami';
import InvoicePlanPanel from './InvoicePlanPanel';

import { useLabelledControl } from '@/components/ui/FieldCard';

// The shipment form's own card. Different layout from components/ui/FieldCard
// — boxed, with an icon — but the label/control association is the same
// problem, so it comes from the same place.
function EnterpriseFieldCard({ label, required, error, children, icon: Icon }) {
  const { id, control } = useLabelledControl({ label, required, error, children });

  return (
    <div className={`h-full p-3 rounded-lg border border-border bg-surface hover:border-border-em transition-all duration-150 flex flex-col justify-between relative min-h-[76px] select-none ${error ? 'border-red-300 bg-red-50/10' : ''
      }`}>
      <div className="flex justify-between items-start w-full gap-2">
        <label htmlFor={id} className="text-[10px] font-bold text-text-secondary uppercase tracking-wider block leading-tight" title={label}>
          {label} {required && <span aria-hidden="true" className="text-red-500 font-bold select-none ml-0.5">*</span>}
        </label>
        {Icon && <Icon className="size-3.5 text-text-tertiary shrink-0" />}
      </div>
      <div className="w-full min-w-0 mt-1.5 flex flex-col justify-end text-text-secondary font-medium [&_span:not(.rounded)]:font-medium [&_span:not(.rounded)]:text-text-secondary [&_input]:font-medium [&_input]:text-text-secondary">
        {control}
        {error && (
          <span id={`${id}-error`} className="text-[10px] font-bold text-red-600 mt-1 select-none">{error}</span>
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
  const { id, control } = useLabelledControl({ label, required, children });
  return (
    <div className="flex flex-col gap-1 focus-within:outline-none">
      <label htmlFor={id} className="text-[9px] font-extrabold text-text-secondary uppercase tracking-wider flex items-center gap-1 leading-none">
        {Icon && <Icon className="size-3 text-text-tertiary shrink-0" />}
        <span>
          {label}
          {required && <span aria-hidden="true" className="text-red-500 font-bold ml-0.5">*</span>}
        </span>
      </label>
      <div className="w-fit">
        {control}
      </div>
    </div>
  );
}

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
  retrySapStatus
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

  // SAP's own PO/GRN ledger for this vendor (zpo_grn_vendor/Detail) — used
  // only to cross-check that a PO we're tracking is one SAP actually has, not
  // to drive anything. sapPoStatus says whether the question was answered at
  // all — 'loading' | 'ready' | 'error' — because an unanswered check and an
  // empty answer are different things to tell a supplier.
  const sapPoOrders = state?.sapPoOrders;
  const sapPoStatus = state?.sapPoStatus ?? 'loading';
  // Filtered: an order the portal awarded carries no SAP number until SAP's
  // ledger supplies one, and `new Set([null]).has(null)` is true — which badged
  // every unmatched order as "Confirmed by SAP".
  const sapPoNumbers = new Set((sapPoOrders || []).map(o => o.poNumber).filter(Boolean));
  const isConfirmedInSap = (po) => Boolean(po.sapPoNumber) && sapPoNumbers.has(po.sapPoNumber);

  // One list, not two. An order SAP raised directly (ME21N) becomes a real
  // PurchaseOrder row when jobs/handlers/sweepPurchaseOrders.js next runs;
  // between SAP creating it and that sweep, it exists only in SAP's own
  // ledger. That window is what the separate "All SAP Orders" tab used to
  // expose, at the cost of making a supplier look in two places to answer
  // "what have I been ordered?". These rows are merged into the same table
  // instead, carrying `sapOnly` so the row can be honest about the fact that
  // nothing here is tracking it yet.
  //
  // Field names and the status rule below are the sweep's own
  // (sweepPurchaseOrders.js's item mapping, services/poStatus.service.js's
  // derivePoStatus) so a row does not change shape or status under the
  // supplier at the moment it is finally recorded.
  const trackedSapNumbers = new Set(cleanPOs.map(po => po.sapPoNumber).filter(Boolean));
  const sapOnlyPOs = (Array.isArray(sapPoOrders) ? sapPoOrders : [])
    .filter(order => order.poNumber && !trackedSapNumbers.has(order.poNumber))
    .map(order => {
      const items = (order.items || []).filter(Boolean).map(item => ({
        line: Number(item.itemNumber) || 0,
        materialCode: item.materialCode || '',
        description: item.description || '',
        quantity: item.orderedQuantity || 0,
        grnQuantity: item.receivedQuantity || 0,
        unitPrice: item.unitPrice || 0,
        netValue: item.netAmount || 0,
        uom: item.uom || 'EA',
        plant: item.plant || null,
        // What kind of line SAP says this is, and whether it is invoiced
        // against a plan — see poKind.js. Both travel on the ledger read, so
        // an unrecorded order is classified the same way a recorded one is.
        accountAssignmentCategory: item.accountAssignmentCategory || null,
        invoicePlanNumber: item.invoicePlanNumber || null,
      }));
      // derivePoStatus's delivered/dispatched/open arm only. Invoiced and Paid
      // are deliberately not inferred from SAP's INVOICED_QUANTITY: those two
      // mean the *portal* holds a matching invoice, and for an order it has
      // never seen it holds none.
      const delivered = items.length > 0 && items.every(i => Number(i.grnQuantity) >= Number(i.quantity));
      const inFlight = items.some(i => Number(i.grnQuantity) > 0);
      return {
        id: order.poNumber,
        sapPoNumber: order.poNumber,
        sapOnly: true,
        createdDate: order.poDate || null,
        buyerName: order.buyerName || '—',
        plant: items.find(i => i.plant)?.plant || '—',
        currency: order.currency || 'INR',
        status: delivered ? 'Delivered' : inFlight ? 'Dispatched' : 'Open',
        items,
        raw: order,
      };
    });

  const allPOs = [...cleanPOs, ...sapOnlyPOs];

  // Navigation states:
  // poSubTab tracks the main top menu: 'list' (Orders Monitor), 'grn' (Goods Receipts), 'invoice' (Invoice Ready)
  const [poSubTab, setPoSubTab] = useState('list');
  // currentView tracks detail sub-states: 'list' | 'detail' | 'asn' | 'asn_success' | 'grn_detail'
  const [currentView, setCurrentView] = useState('list');
  const [activePoState, setActivePo] = useState(null);
  const [activeGrnState, setActiveGrn] = useState(null);
  // allPOs, not cleanPOs: an order SAP holds that the portal has not recorded
  // yet opens the same detail page as any other, so it has to be findable here
  // too or the page would fall back to a stale snapshot of it.
  const activePo = activePoState ? (allPOs.find(p => p.id === activePoState.id) || activePoState) : null;
  // Read-only: every write on this page (acknowledge, ASN, invoicing plan,
  // chat) addresses a PurchaseOrder row by id, and there is no such row for
  // this order until jobs/handlers/sweepPurchaseOrders.js records it.
  const activePoIsSapOnly = Boolean(activePo?.sapOnly);
  const activeGrn = activeGrnState ? (cleanGrns.find(g => g.id === activeGrnState.id) || activeGrnState) : null;
  const [localSubmissionTimes, setLocalSubmissionTimes] = useState({});
  const [activeLineIdx, setActiveLineIdx] = useState(0);
  const [asnLineIdx, setAsnLineIdx] = useState(0);
  const [grnLineIdx, setGrnLineIdx] = useState(0);

  // Selecting a different order restarts its ASN/GRN line cursors. Done as an
  // adjustment during render rather than in an effect: an effect runs *after*
  // the browser has already painted, so for one frame the new order was shown
  // with the previous order's line highlighted. Comparing against the previous
  // id and resetting inline is React's documented pattern for derived-from-prop
  // state, and it re-renders before anything reaches the screen.
  const [lineCursorPoId, setLineCursorPoId] = useState(activePo?.id);
  if (activePo?.id !== lineCursorPoId) {
    setLineCursorPoId(activePo?.id);
    setAsnLineIdx(0);
    setGrnLineIdx(0);
  }

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

  // Sliding Side Drawer for Communication Center
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPo, setDrawerPo] = useState(null);
  const [chatMessageInput, setChatMessageInput] = useState('');
  const [poIssueStatus, setPoIssueStatus] = useState({}); // poId -> 'Open' | 'In Review' | 'Resolved'
  const [poChats, setPoChats] = useState({}); // poId -> array of messages

  // Detail View Active Sub-tab ('po_detail' | 'create_asn' | 'grn_status')
  const [detailTab, setDetailTab] = useState('po_detail');

  // Invoice planning is a per-line setting, and the tab only exists for orders
  // that use it — an order invoiced against goods receipts should look exactly
  // as it did before this feature. The buying organisation's own staff see the
  // tab on every order, because they are the ones who switch planning ON.
  const { permissions } = useWhoami();
  const canManagePlans = (permissions || []).includes('po:manage');
  const canProposePlan = (permissions || []).includes('po:invoice-plan:propose');
  // An order read straight from SAP carries its plan as a bare INV_PLANNO;
  // one the portal holds carries a plan record. poKind.js knows both spellings
  // so this tab appears for either. (A plan SAP already holds is not
  // manageable from here, only visible — see the panel's own canManage.)
  const hasInvoicePlan = poHasInvoicePlan(activePo);
  const showInvoicePlanTab = hasInvoicePlan || canManagePlans;

  // A tab that disappears must not leave the panel selected — moving from a
  // planned order to an unplanned one would otherwise render a blank detail
  // body. Derived rather than corrected in an effect, so there is no render
  // where the selection and what is on screen disagree.
  // Same reasoning for an order the portal has not recorded: it offers the
  // order-details tab only, so a selection carried over from another order
  // must not survive onto it.
  const activeDetailTab = activePoIsSapOnly
    ? 'po_detail'
    : (detailTab === 'invoice_plan' && !showInvoicePlanTab ? 'po_detail' : detailTab);

  // Countdown timer for the delivery-confirmation simulation
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

  // Every PO starts with an empty thread. Nothing here seeds a message
  // attributed to Buyer — no buyer sent one, and inventing a greeting on
  // their behalf is exactly the fabrication issue #55 removed from the
  // backend's auto-reply too.
  useEffect(() => {
    cleanPOs.forEach(po => {
      if (poIssueStatus[po.id] === undefined) {
        setPoIssueStatus(prev => ({ ...prev, [po.id]: 'In Review' }));
      }
    });
  }, [cleanPOs]);

  // Prefills the shipment form the first time an order's "Send shipment" tab is
  // opened. This used to be an effect watching `detailTab`, which meant a render
  // pass that painted the empty form before a second pass filled it in, and it
  // generated tracking/e-way numbers from Math.random() and the clock — so it
  // could not simply move into the render body either.
  //
  // Opening that tab is a user action, so the initialization belongs on the
  // action. The "Send shipment" button at handleSendShipmentClick already did
  // its own prefill; this covers the other way in, the tab header. The
  // `isInitialized` guard keeps it idempotent, so re-entering the tab never
  // overwrites quantities the supplier has already edited.
  const ensureAsnPrefill = () => {
    if (!activePo || activePo.status === 'Open') return;

    const lines = (activePo.items || []).map(item => item.line);
    const isInitialized = lines.length > 0 && lines.every(line => dispatchQuantities[line] !== undefined);
    if (isInitialized) return;

    const initialQtys = {};
    const initialErrors = {};
    (activePo.items || []).forEach(item => {
      const remaining = item.quantity - (item.grnQuantity || 0);
      initialQtys[item.line] = remaining;
      initialErrors[item.line] = '';
    });
    setDispatchQuantities(initialQtys);
    setValidationErrors(initialErrors);
    // Only the dates get a default. Carrier, vehicle, tracking, invoice and
    // e-way bill references are the supplier's own documents: an invented one
    // would be submitted to the buyer as if the supplier had typed it.
    setAsnForm(prev => ({
      carrierName: prev.carrierName || '',
      trackingNumber: prev.trackingNumber || '',
      vehicleNumber: prev.vehicleNumber || '',
      invoiceReference: prev.invoiceReference || '',
      shipDate: prev.shipDate || new Date().toISOString().split('T')[0],
      estimatedDeliveryDate: prev.estimatedDeliveryDate || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      items: initialQtys
    }));
  };

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

  // Open Communication Drawer
  const handleOpenDrawer = (e, po) => {
    e.stopPropagation();
    setDrawerPo(po);
    setDrawerOpen(true);
  };

  // Send Drawer Message. Local to this screen only — nothing here reaches
  // the buyer, so nothing writes a reply on their behalf (issue #55).
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

    setChatMessageInput('');
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
    return allPOs
      .filter(po => {
        const matchesSearch = String(po.id || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
          (po.items || []).some(item => item && (String(item.description || '').toLowerCase().includes(searchQuery.toLowerCase()) || String(item.materialCode || '').toLowerCase().includes(searchQuery.toLowerCase())));

        const mappedStatus = po.status;
        const matchesStatus = statusFilter === 'all' ||
          (statusFilter === 'New' && mappedStatus === 'Open') ||
          (statusFilter === 'Acknowledged' && mappedStatus === 'Acknowledged') ||
          (statusFilter === 'Shipment Sent' && mappedStatus === 'Dispatched') ||
          (statusFilter === 'Delivery Confirmed' && (mappedStatus === 'Delivered' || mappedStatus === 'Invoiced' || mappedStatus === 'Paid'));

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
    setEwayBillNo('');
    setAsnDocs({ packingList: null, invoiceCopy: null, transportDoc: null });
    setAsnForm({
      carrierName: '',
      trackingNumber: '',
      vehicleNumber: '',
      invoiceReference: '',
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
          carrierName: asnForm.carrierName || '—',
          trackingNumber: asnForm.trackingNumber || asnForm.vehicleNumber || '—',
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
      alert('Could not send the shipment details: ' + (e.message || e));
    }
  };

  // Status Chip formatting
  const renderStatusChip = (status) => {
    const labelMap = {
      Open: 'New',
      Acknowledged: 'Acknowledged',
      Dispatched: 'Shipment Sent',
      Delivered: 'Delivery Confirmed',
      Invoiced: 'Invoice Posted',
      Paid: 'Paid'
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

        {/* ==================== PAGE HEADER ====================
            List view only — the detail view titles itself with the order it
            is showing. Without this the ledger had no page-level heading at
            all: the tab bar below is navigation within the page, not a name
            for it, so the first heading on /pos was the filter panel's. */}
        {currentView === 'list' && (
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4 select-none">
            <div className="space-y-1">
              <h2 className="page-title flex items-center gap-2">
                <ShoppingBag className="size-5 text-primary shrink-0" /> Purchase Orders
              </h2>
              <p className="text-text-tertiary text-xs font-semibold">
                Acknowledge new orders, send shipment notices, and track what your buyer has received
              </p>
            </div>
          </div>
        )}

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
                <span>Delivery Receipts</span>
                <span className="bg-surface2 text-text-secondary font-mono text-[10px] px-1.5 py-0.5 rounded-full border border-border tabular-nums">
                  {cleanGrns.length}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 1: ORDERS MONITOR TAB / PO LIST                          */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'list' && (
          <div className="space-y-6">

            {/* The SAP ledger read (zpo_grn_vendor/Detail) supplies both the
                not-yet-recorded rows merged into the table below and the
                per-row Confirmed badge. When it has not answered, say so once
                here rather than leaving a quietly short list. */}
            {sapPoStatus === 'error' ? (
              <div className="card flex items-center gap-3 py-3 px-4">
                <AlertCircle className="size-4 text-amber-500 shrink-0" />
                <p className="text-xs text-text-secondary flex-1">
                  Could not reach your buyer&rsquo;s records, so any order they raised that this
                  portal has not recorded yet is missing from this list. Everything already
                  tracked here is unaffected.
                </p>
                {retrySapStatus && (
                  <Button size="xs" variant="secondary" onClick={retrySapStatus}>Try again</Button>
                )}
              </div>
            ) : (sapPoStatus === 'loading' || !Array.isArray(sapPoOrders)) ? (
              <div className="card flex items-center gap-2 text-xs text-text-tertiary py-3 px-4">
                <Loader2 className="size-3.5 animate-spin" /> Checking your buyer&rsquo;s records for orders not yet listed here&hellip;
              </div>
            ) : null}

            {/* KPI Cards Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <KPICard
                label="Total orders"
                value={<span className="tabular-nums">{allPOs.length}</span>}
                sub="From your buyer’s system"
                icon={ShoppingBag}
              />
              <KPICard
                label="Orders awaiting acknowledgement"
                value={<span className="tabular-nums">{allPOs.filter(p => p.status === 'Open').length}</span>}
                sub="Requires attention"
                icon={Clock}
              />
              <KPICard
                label="Shipments to send"
                value={<span className="tabular-nums">{allPOs.filter(p => p.status === 'Acknowledged').length}</span>}
                sub="Ready for shipment"
                icon={Truck}
              />
              <KPICard
                label="Completed Orders"
                value={<span className="tabular-nums">{allPOs.filter(p => p.status === 'Delivered' || p.status === 'Invoiced' || p.status === 'Paid').length}</span>}
                sub="Stores receipted & post"
                icon={CheckCircle2}
              />
            </div>

            {/* Sticky Filter Bar */}
            <div className="card p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Filter className="size-4 text-text-tertiary" />
                  {/* h3, matching the other panels in this view (Delivery
                      Receipts, Deliveries ready to invoice) — it sits one
                      level under the page title above. */}
                  <h3 className="label mb-0">Search & Filter</h3>
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
                  <label htmlFor="po-filter-status" className="text-[10px] font-bold text-text-tertiary uppercase mr-2 shrink-0">Status</label>
                  <select id="po-filter-status"
                    value={statusFilter}
                    onChange={e => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                    className="w-full !border-0 !p-0 bg-transparent text-xs text-text-secondary outline-none font-semibold cursor-pointer"
                  >
                    <option value="all">All Statuses</option>
                    <option value="New">New (Open)</option>
                    <option value="Acknowledged">Acknowledged</option>
                    <option value="Shipment Sent">Shipment Sent</option>
                    <option value="Delivery Confirmed">Delivery Confirmed</option>
                  </select>
                </div>

                {/* Plant Filter */}
                <div className="flex items-center bg-base border border-border rounded-md px-2 py-1">
                  <label htmlFor="po-filter-plant" className="text-[10px] font-bold text-text-tertiary uppercase mr-2 shrink-0">Plant</label>
                  <select id="po-filter-plant"
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
                  <label htmlFor="po-filter-buyer" className="text-[10px] font-bold text-text-tertiary uppercase mr-2 shrink-0">Buyer</label>
                  <select id="po-filter-buyer"
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
                        <th className="w-28">Type</th>
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
                        <th className="text-center">Confirmed</th>
                        <th className="text-center">Row Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedPOs.map(po => {
                        if (!po) return null;
                        const totalValue = (po.items || []).reduce((s, i) => s + (i.netValue || 0), 0);
                        const plantName = po.plant || '—';
                        const buyerName = po.buyerName || 'Amit Sharma (Lead Procurement)';

                        return (
                          <tr
                            key={po.id}
                            onDoubleClick={() => handleOpenPoDetails(po)}
                            className="group cursor-pointer"
                          >
                            <td className="font-mono font-bold text-text-primary group-hover:underline whitespace-nowrap">
                              {po.id}
                              {po.sapOnly && (
                                <span
                                  className="ml-2 font-sans text-[10px] font-bold text-text-tertiary"
                                  title="Your buyer has raised this in SAP. It is not recorded in this portal yet, so there is nothing here to acknowledge or ship against."
                                >
                                  not recorded here yet
                                </span>
                              )}
                            </td>
                            <td className="font-mono whitespace-nowrap tabular-nums">{formatDate(po.createdDate)}</td>
                            <td>
                              {(() => {
                                const kind = poKind(po);
                                return (
                                  <span className="inline-flex items-center gap-1">
                                    <span
                                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider ${kindTone(kind)}`}
                                      title={kind.hint}
                                    >
                                      {kind.label}
                                    </span>
                                    {poHasInvoicePlan(po) && (
                                      <CalendarClock
                                        className="size-3 text-teal-500"
                                        title="Invoiced against an invoicing plan, not on goods receipt"
                                      />
                                    )}
                                    {/* The one signal on this list that a
                                        supplier's proposed plan change is
                                        sitting unapproved — without it, the
                                        only way to find one was to already
                                        know which order to open. */}
                                    {canManagePlans && hasPendingInvoicePlanChange(po) && (
                                      <Clock
                                        className="size-3 text-amber-500 animate-pulse"
                                        title="A supplier has proposed an invoicing-plan change here, awaiting your approval"
                                      />
                                    )}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="font-semibold text-text-primary">{buyerName}</td>
                            <td className="font-medium">{plantName}</td>
                            <td className="text-center font-mono font-bold tabular-nums">{(po.items || []).length}</td>
                            <td className="text-right font-mono font-bold text-text-primary whitespace-nowrap tabular-nums">
                              ₹ {Number(totalValue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            <td>
                              {renderStatusChip(po.status)}
                            </td>
                            <td className="text-center">
                              {/* An order carrying its own sapSyncState is
                                  answerable without this lookup — that field
                                  travels on the PO record. Only the
                                  isConfirmedInSap fallback below needs the
                                  vendorPoGrnDisplay read, so only it is left
                                  unknown when that read fails. */}
                              {!po.sapSyncState && sapPoStatus === 'error' ? (
                                <span
                                  className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400"
                                  title="Could not reach your buyer's system to check this order. Nothing about the order has changed."
                                >
                                  <AlertCircle className="size-3.5" /> Could not check
                                </span>
                              ) : !po.sapSyncState && (sapPoStatus === 'loading' || !Array.isArray(sapPoOrders)) ? (
                                <Loader2 className="size-3.5 animate-spin text-text-tertiary inline-block" />
                              ) : (() => {
                                // Dual identity / sync state (Phase 3 of
                                // docs/04-sap-runtime-engineering-plan.md,
                                // invariant I5): a number shown to a supplier
                                // is either from SAP or clearly marked as not.
                                // sapSyncState is the honest source now;
                                // isConfirmedInSap's own cross-check against
                                // the vendorPoGrnDisplay read stays as the
                                // fallback for a PO fetched before this field
                                // existed on the response shape.
                                const { label, tone, showNumber } = po.sapSyncState
                                  ? describeSyncState(po.sapSyncState)
                                  : (isConfirmedInSap(po)
                                    ? { label: 'Confirmed', tone: 'active', showNumber: true }
                                    : { label: 'Not confirmed yet', tone: 'pending', showNumber: false });
                                const toneClass = tone === 'active' ? 'text-emerald-400' : tone === 'suspended' ? 'text-rose-400' : 'text-amber-400';
                                const Icon = showNumber ? ShieldCheck : ShieldAlert;
                                return (
                                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold ${toneClass}`} title={label}>
                                    <Icon className="size-3.5" /> {label}
                                  </span>
                                );
                              })()}
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

                                {/* Shipment and chat both act on a
                                    PurchaseOrder row, which an order SAP holds
                                    but this portal has not recorded yet does
                                    not have. The detail page above opens for
                                    it either way, read-only. */}
                                {!po.sapOnly && po.status === 'Acknowledged' && (
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    onClick={() => handleOpenAsnForm(po)}
                                  >
                                    Send shipment
                                  </Button>
                                )}

                                {!po.sapOnly && (
                                  <button
                                    onClick={(e) => handleOpenDrawer(e, po)}
                                    className="p-1 text-text-tertiary hover:text-text-primary hover:bg-surface2 rounded-md transition-colors duration-150"
                                    title="Chat / Raise Issue"
                                  >
                                    <MessageSquare className="size-4" />
                                  </button>
                                )}
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
        {/* SCREEN 1: DELIVERY RECEIPTS TAB */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'grn' && (
          <div className="space-y-4">
            <div className="card p-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-text-primary">Delivery Receipts</h3>
                <p className="text-xs text-text-secondary">Every delivery your buyer has checked in and confirmed.</p>
              </div>
              <div className="text-xs text-text-secondary font-semibold font-mono tabular-nums">
                Total Inbound Documents: {cleanGrns.length}
              </div>
            </div>

            {cleanGrns.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={Truck}
                  title="No deliveries confirmed yet"
                  description="Once you send shipment details, your buyer checks the goods in and inspects them. The delivery receipt appears here shortly afterwards."
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
                          <span>Order: {grn.poId}</span>
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
                <h2 className="page-title flex items-center gap-2.5">
                  <span>Purchase Order: {activePo.id}</span>
                  {renderStatusChip(activePo.status)}
                </h2>
                {/* What kind of order this is, and whether it is invoiced to a
                    plan — two independent facts (poKind.js), so two badges
                    rather than one combined label. Asset and service orders
                    behave differently enough on the supplier's side (no stock
                    receipt for a service line; capex approval for an asset
                    one) that reading the header should answer "what am I
                    looking at" without opening a line. */}
                {(() => {
                  const kind = poKind(activePo);
                  const planNumbers = invoicePlanNumbers(activePo);
                  return (
                    <div className="flex flex-wrap items-center gap-2 mt-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${kindTone(kind)}`}
                        title={kind.hint}
                      >
                        {kind.orderLabel}
                      </span>
                      {poHasInvoicePlan(activePo) && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-teal-400/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-500"
                          title={planNumbers.length
                            ? `Invoiced against SAP invoicing plan ${planNumbers.join(', ')} — billed on the plan's dates, not on goods receipt.`
                            : 'Invoiced against an invoicing plan — billed on the plan’s dates, not on goods receipt.'}
                        >
                          <Receipt className="size-3" />
                          Invoicing plan{planNumbers.length ? ` ${planNumbers.join(', ')}` : ''}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div className="flex items-center gap-2">
                {/* Business vs technical view toggle removed */}

                {activePoIsSapOnly ? (
                  <span
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-text-tertiary"
                    title="Your buyer raised this in SAP. It is not recorded in this portal yet, so there is nothing here to acknowledge, ship against or discuss."
                  >
                    <ShieldAlert className="size-3.5" /> Read-only — not recorded in this portal yet
                  </span>
                ) : (
                  <>
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
                  </>
                )}
              </div>
            </div>

            {/* Shipment Pipeline Progress Indicator */}
            {(() => {
              const steps = [
                { key: 'Open', label: 'New PO', icon: ShoppingBag, color: 'blue' },
                { key: 'Acknowledged', label: 'Acknowledged', icon: CheckCircle2, color: 'purple' },
                { key: 'Dispatched', label: 'Shipment Sent', icon: Truck, color: 'orange' },
                { key: 'Delivered', label: 'Delivery Confirmed', icon: Check, color: 'green' },
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
              {(activePoIsSapOnly
                // Shipment, delivery status and invoicing plan all act on a
                // PurchaseOrder row this order does not have yet; offering the
                // tabs would be offering steps that cannot be taken.
                ? [{ id: 'po_detail', label: 'Order details' }]
                : [
                  { id: 'po_detail', label: '1. Order details' },
                  { id: 'create_asn', label: '2. Send shipment' },
                  { id: 'grn_status', label: '3. Delivery status' },
                  ...(showInvoicePlanTab ? [{ id: 'invoice_plan', label: 'Invoicing plan' }] : [])
                ]
              ).map(t => (
                <button
                  key={t.id}
                  onClick={() => {
                    if (t.id === 'create_asn') ensureAsnPrefill();
                    setDetailTab(t.id);
                  }}
                  className={`pb-2.5 text-xs font-bold border-b-2 transition-all duration-150 cursor-pointer focus-visible:outline-none ${activeDetailTab === t.id
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
              {activeDetailTab === 'po_detail' && (
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
                        label="Buying company"
                        value={activePo.companyCode || '1000'}
                        icon={Building2}
                        containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer"
                      />
                      <SapReadOnlyField
                        label="Buyer GSTIN"
                        value={activePo.buyerGstin || '—'}
                        icon={Receipt}
                      />
                      <SapReadOnlyField
                        label="Plant / Location"
                        value={activePo.plant || '—'}
                        isMonospace={false}
                        icon={MapPin}
                        containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer"
                      />
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                      <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                        PO Line Items
                      </h3>

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
                                {/* SAP allows one order to mix categories, so
                                    the kind belongs on the line, not only in
                                    the header badge. */}
                                <th className="w-24">Type</th>
                                <th className="w-36">Item code</th>
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
                                      {(() => {
                                        const kind = lineKind(item);
                                        return (
                                          <span
                                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider ${kindTone(kind)}`}
                                            title={kind.hint}
                                          >
                                            {kind.label}
                                          </span>
                                        );
                                      })()}
                                    </td>
                                    <td>
                                      {/* An asset or service line is text-only
                                          in SAP — no MATNR — so the column is
                                          legitimately blank on one. */}
                                      <span className="text-blue-600 font-bold hover:underline cursor-pointer">{item.materialCode || '—'}</span>
                                    </td>
                                    <td className="text-text-primary font-medium">
                                      {item.description}
                                      {item.assetNumber && (
                                        <span
                                          className="ml-2 font-mono text-[10px] font-bold text-violet-500"
                                          title="The fixed asset in SAP this capex posts to (ANLN1/ANLN2)"
                                        >
                                          asset {item.assetNumber}{item.assetSubNumber ? `-${item.assetSubNumber}` : ''}
                                        </span>
                                      )}
                                      {lineHasInvoicePlan(item) && (
                                        <button
                                          type="button"
                                          onClick={() => setDetailTab('invoice_plan')}
                                          title="This line is billed on an invoicing plan, not against a goods receipt"
                                          className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 text-[9px] font-extrabold uppercase tracking-wider cursor-pointer hover:bg-blue-100 transition-colors duration-150"
                                        >
                                          <CalendarClock className="size-2.5" />
                                          {/* The portal's own plan knows its
                                              type; a plan read from SAP is only
                                              a number until its dates are
                                              fetched. */}
                                          {item.invoicePlan?.type ? `${item.invoicePlan.type} plan` : `plan ${item.invoicePlanNumber}`}
                                        </button>
                                      )}
                                    </td>
                                    <td className="font-bold text-text-primary text-right font-mono tabular-nums">{item.quantity}</td>
                                    <td className="font-medium">{item.uom || 'EA'}</td>
                                    <td className="font-bold text-text-primary text-right font-mono tabular-nums">₹ {Number(item.unitPrice || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                    {/* Issue #113: this used to be the literal "G1 (18%)" for every
                                        line regardless of the line's real tax code. taxCode is SAP's
                                        raw MWSKZ (config/gstCodes.js's G1..G6 registry is for the RFQ
                                        bid → invoice GST path, not this field — an asset line's code
                                        like 'V0' isn't in it, so this renders the code itself rather
                                        than guessing a rate for it) and is null on every line except an
                                        asset PO's own (ADR-0042); awardRfq never carries a bid's tax
                                        code onto the PO line it creates, so null is the honest, common
                                        case here, not a display gap. */}
                                    <td className="font-medium font-mono">{item.taxCode || '—'}</td>
                                    <td className="font-medium font-mono tabular-nums">{formatDate(item.deliveryDate || activePo.createdDate)}</td>
                                    <td className="font-bold text-text-primary text-right font-mono tabular-nums">₹ {Number(item.netValue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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

              {/* TAB 2: Send shipment */}
              {activeDetailTab === 'create_asn' && (
                <div className="space-y-6 animate-fade-in">
                  {activePo.status === 'Open' ? (
                    <div className="card p-6 text-center">
                      <AlertTriangle className="size-8 text-amber-500 mx-auto mb-2" />
                      <p className="text-xs font-bold text-text-primary">PO Acknowledgement Required</p>
                      <p className="text-xs text-text-secondary mt-1">
                        You must acknowledge this purchase order before you can send shipment details.
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
                          <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">Advanced Shipping Notice Form (VL31N)</h3>
                          <p className="text-[10px] text-text-secondary font-medium mt-0.5">Provide actual shipment details and dispatch quantities</p>
                        </div>
                        <Button
                          onClick={handleAsnSubmitClick}
                          variant="default"
                        >
                          Submit Inbound Delivery
                        </Button>
                      </div>

                      {/* Shipment header fields — 3-column grid, label-on-top aligned */}
                      <div className="card overflow-hidden">
                        <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-surface2/40">
                          <div className="size-1.5 rounded-full bg-purple-500"></div>
                          <span className="text-[10px] font-extrabold text-text-secondary uppercase tracking-widest">Shipment details</span>
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

                      {/* Shipment document attachments */}
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
                                    <th className="w-36">Item code</th>
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
                                        <td className="font-bold text-text-primary text-right font-mono tabular-nums">₹ {Number(item.unitPrice || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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

              {/* TAB 3: Delivery status */}
              {activeDetailTab === 'invoice_plan' && (
                <div className="p-4">
                  <InvoicePlanPanel po={activePo} canManage={canManagePlans} canPropose={canProposePlan} />
                </div>
              )}

              {activeDetailTab === 'grn_status' && (
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
                              <p className="text-sm font-bold text-amber-800">Shipment details sent</p>
                              <p className="text-xs text-text-secondary max-w-md mx-auto leading-normal">
                                Your dispatch details have been sent to your buyer.
                              </p>
                            </div>

                            <div className="p-4 bg-surface border border-amber-200/60 rounded-xl text-xs space-y-3.5 shadow-sm">
                              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-left font-mono">
                                <div>
                                  <span className="text-[9px] text-text-tertiary font-bold uppercase block font-sans">Shipment reference</span>
                                  <span className="font-bold text-text-primary text-xs select-all">
                                    {activeAsn?.id || activeAsn?.asnId || 'N/A'}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-[9px] text-text-tertiary font-bold uppercase block font-sans">Delivery note number</span>
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
                                  <span className="font-semibold text-text-secondary font-sans">Expected delivery confirmation in:</span>
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
                          <p className="text-xs font-bold text-text-primary">No delivery confirmed yet</p>
                          <p className="text-xs text-text-secondary mt-1">
                            Send your shipment details (step 2) first — the delivery receipt appears once your buyer checks the goods in.
                          </p>
                        </div>
                      );
                    }

                    // GRN exists!
                    return (
                      <div className="space-y-6 animate-fade-in">
                        <div className="card p-4 flex items-center justify-between">
                          <div>
                            <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">Delivery receipt</h3>
                            <p className="text-[10px] text-text-secondary font-medium mt-0.5">Checked and accepted by your buyer’s receiving team</p>
                          </div>
                          <span className="px-3 py-1 rounded bg-surface2 text-text-secondary border border-border text-xs font-bold font-mono">
                            {grn.invoiceSubmitted ? 'Invoice submitted' : 'Awaiting invoice from your buyer'}
                          </span>
                        </div>

                        {/* Delivery receipt fields — 3-column grid, label-on-top aligned */}
                        <div className="card overflow-hidden">
                          <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-surface2/40">
                            <div className="size-1.5 rounded-full bg-green-500"></div>
                            <span className="text-[10px] font-extrabold text-text-secondary uppercase tracking-widest">Delivery receipt details</span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-5">
                            <SapReadOnlyField
                              label="Receipt number"
                              value={grn.sapMigoDoc}
                              icon={FileText}
                              containerClassName="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 cursor-pointer font-mono"
                            />
                            <SapReadOnlyField
                              label="Received on"
                              value={formatDate(grn.postingDate)}
                              icon={Calendar}
                            />
                            <SapReadOnlyField
                              label="Type"
                              value="Goods received"
                              isMonospace={false}
                              icon={Truck}
                              containerClassName="bg-emerald-50 text-emerald-700 border-emerald-200"
                            />
                            <SapReadOnlyField
                              label="Received By"
                              value={grn.receivedBy || 'Receiving team'}
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

                        {/* Inspection status per line item */}
                        <div className="space-y-4">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                            <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                              Items received &amp; inspection result
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
                                      <th className="w-36">Item code</th>
                                      <th className="min-w-[200px]">Description</th>
                                      <th className="w-28 text-right">Received Qty</th>
                                      <th className="w-28 text-right">Accepted Qty</th>
                                      <th className="w-28 text-right">Rejected Qty</th>
                                      <th className="w-20">UoM</th>
                                      <th className="text-center w-28">Quality Status</th>
                                      <th className="text-right w-36 font-sans">Received on</th>
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
                        {msg.sender === 'Vendor' ? 'Your Firm' : 'Buyer'}
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
