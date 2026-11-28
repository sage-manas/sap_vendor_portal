'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Clock, CheckCircle2, Search, Download, FileText, Check, ArrowLeft, Loader2, CalendarClock, AlertCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import ErrorBoundary from '@/components/ErrorBoundary';
import StatusBadge from '@/components/ui/StatusBadge';
import CancelShipmentDialog from '@/features/asn/components/CancelShipmentDialog';
import { ASN_STATUS_TONE } from '@/features/asn/components/AsnDashboard';
import { openToShip } from '@/features/asn/rules';
import TableSkeleton from '@/components/ui/TableSkeleton';
import DataTable from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/Page';
import { DocumentHero } from '@/components/ui/dashboard';
import { DropdownMenu, Pagination, SegmentedControl, Tabs } from '@/components/ui/controls';
import { poStatusVariant } from '@/lib/statusColors';
import { describeSyncState } from '@/lib/syncState';
import { poKind, lineKind, lineHasInvoicePlan, hasInvoicePlan as poHasInvoicePlan, hasPendingInvoicePlanChange, invoicePlanNumbers } from '@/features/purchase-order/poKind';
import { useWhoami } from '@/lib/whoami';
import { rfqService } from '@/features/rfq/services/rfqService';
import { poService } from '@/features/purchase-order/services/poService';
import InvoicePlanPanel from './InvoicePlanPanel';

import { useLabelledControl } from '@/components/ui/FieldCard';
import { displayDate } from '@/lib/displayDate';

// A read-only value beside its label. Mono only for identifiers and amounts;
// the decorative tints callers used to pass (containerClassName) are no
// longer applied — status belongs to StatusBadge, not to a coloured box.
function SapReadOnlyField({ label, value, isFile, isMonospace = true, valueClassName = '' }) {
  return (
    // Always rendered inside a <dl>: a div grouping one dt/dd pair is valid there.
    <div className="flex min-w-0 items-baseline gap-3 text-sm">
      <dt className="w-36 shrink-0 text-fg-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-fg ${isMonospace ? 'mono' : ''} ${valueClassName}`} title={value || ''}>
        {isFile && <FileText className="mr-1 inline size-3.5 align-[-2px] text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />}
        {value || '—'}
      </dd>
    </div>
  );
}

// Label above the control, like every other field.
function SapInputField({ label, required, children }) {
  const { id, control } = useLabelledControl({ label, required, children });
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required && <span aria-hidden="true" className="text-fg-subtle"> *</span>}
      </label>
      <div className="w-fit">
        {control}
      </div>
    </div>
  );
}

// A goods-receipt line with an inspection result. SAP's receipt read carries
// none, so a receipt recorded from SAP has accepted/rejected null — "not
// inspected", which used to render as "QC Passed" (issue #351).
const isInspected = (item) => item?.acceptedQuantity != null;

// The badge for a set of inspected lines; with none, says so in plain text
// rather than claiming a result.
const inspectionBadge = (inspectedLines) => {
  if (!inspectedLines.length) return <span className="text-fg-subtle">Not inspected</span>;
  return inspectedLines.some((item) => (item.rejectedQuantity || 0) > 0)
    ? <StatusBadge label="QC Discrepancy" variant="suspended" />
    : <StatusBadge label="QC Passed" variant="active" />;
};

// Saved views over the list — groups of the same statuses the status filter
// already knows; their counts are what the old KPI cards showed.
const SAVED_VIEWS = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'ack', label: 'Needs acknowledgement', match: (s) => s === 'Open' },
  { value: 'delivery', label: 'In delivery', match: (s) => s === 'Acknowledged' || s === 'Dispatched' },
  { value: 'done', label: 'Completed', match: (s) => s === 'Delivered' || s === 'Invoiced' || s === 'Paid' },
];

export default function PurchaseOrdersView({
  state,
  selectedPoId,
  setSelectedPoId,
  acknowledgePO,
  cancelASN,
  retrySapStatus
}) {
  const router = useRouter();
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
      // No buyer, plant, terms or address defaults (issue #315): a missing
      // party detail renders as "—", never as an invented name or place that
      // makes an incomplete order look complete.
      currency: 'INR',
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
    // No invented defaults (issue #351): a missing posting date is not today,
    // nobody named "Stores Manager (QC Group)" checked anything, and a missing
    // accepted/rejected quantity is "not inspected", not 0.
    .map(grn => ({
      ...grn,
      items: (grn.items || []).filter(Boolean).map(item => ({
        receivedQuantity: 0,
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
  // allPOs, not cleanPOs: an order SAP holds that the portal has not recorded
  // yet opens the same detail page as any other, so it has to be findable here
  // too or the page would fall back to a stale snapshot of it.
  const activePo = activePoState ? (allPOs.find(p => p.id === activePoState.id) || activePoState) : null;
  // Read-only: every write on this page (acknowledge, ASN, invoicing plan)
  // addresses a PurchaseOrder row by id, and there is no such row for this
  // order until jobs/handlers/sweepPurchaseOrders.js records it.
  const activePoIsSapOnly = Boolean(activePo?.sapOnly);
  // The export bridge (Phase 5.2): downloads the awarded PO as a file for
  // the buyer's own MM team to import into SAP on their own schedule — not
  // a live SAP write. Keyed by rfqId (the export endpoint is RFQ-scoped) so
  // `exportingFormat` tracks which of the four buttons is in flight, but
  // only for the order currently open.
  const [exportingFormat, setExportingFormat] = useState(null);
  const handleExportPo = async (rfqId, format) => {
    setExportingFormat(format);
    try {
      await rfqService.downloadPoExport(rfqId, format);
    } catch (err) {
      alert('Failed to export purchase order: ' + (err.message || err));
    } finally {
      setExportingFormat(null);
    }
  };
  // Search and Filters for Screen 1
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [plantFilter, setPlantFilter] = useState('all');
  const [buyerFilter, setBuyerFilter] = useState('all');
  const [savedView, setSavedView] = useState('all');

  // Table Sorting
  const [sortField, setSortField] = useState('id');
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  // Detail View Active Sub-tab ('po_detail' | 'create_asn' | 'grn_status')
  const [detailTab, setDetailTab] = useState('po_detail');

  // The shipment whose cancel dialog is open, or null.
  const [cancellingAsn, setCancellingAsn] = useState(null);

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

  // Fetch unique plants and buyers from actual PO list for filters
  // A PO with no plant or buyer has nothing to filter by, so it adds no option.
  const uniquePlants = Array.from(new Set(cleanPOs.map(p => p.plant).filter(Boolean)));
  const uniqueBuyers = Array.from(new Set(cleanPOs.map(p => p.buyerName).filter(Boolean)));


  // A shipment notice is created in the ASN module (src/features/asn), starting
  // from this order's open lines.
  const openAsnWizard = (po) => router.push(`/asn?new=1&po=${encodeURIComponent(po.id)}`);

  // Handle PO Row selection
  const handleOpenPoDetails = (po) => {
    setActivePo(po);
    setDetailTab('po_detail');
    setCurrentView('detail');
  };

  const handleOpenGrnDetails = (grn) => {
    const po = cleanPOs.find(p => p.id === grn.poId);
    setActivePo(po);
    setDetailTab('grn_status');
    setCurrentView('detail');
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

  const filteredPOs = getFilteredPOs().filter((po) => SAVED_VIEWS.find((v) => v.value === savedView).match(po.status));
  const totalPages = Math.ceil(filteredPOs.length / itemsPerPage);
  const paginatedPOs = filteredPOs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

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

  const money2 = (value) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const lineColumns = [
    { key: 'line', header: 'Line', mono: true, primary: true },
    // SAP allows one order to mix categories, so the kind belongs on the
    // line, not only in the header.
    { key: 'kind', header: 'Type', render: (item) => { const kind = lineKind(item); return <span className="text-fg-muted" title={kind.hint}>{kind.label}</span>; } },
    // An asset or service line is text-only in SAP — no MATNR — so the
    // column is legitimately blank on one.
    { key: 'materialCode', header: 'Item code', render: (item) => <span className="mono">{item.materialCode || '—'}</span> },
    {
      key: 'description',
      header: 'Description',
      wrap: true,
      render: (item) => (
        <span>
          {item.description}
          {item.assetNumber && (
            <span className="mono ml-2 text-xs text-fg-subtle" title="The fixed asset in SAP this capex posts to (ANLN1/ANLN2)">
              asset {item.assetNumber}{item.assetSubNumber ? `-${item.assetSubNumber}` : ''}
            </span>
          )}
          {lineHasInvoicePlan(item) && (
            <button
              type="button"
              onClick={() => setDetailTab('invoice_plan')}
              title="This line is billed on an invoicing plan, not against a goods receipt"
              className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-accent-text hover:underline cursor-pointer"
            >
              <CalendarClock className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
              {/* The portal's own plan knows its type; a plan read from SAP is
                  only a number until its dates are fetched. */}
              {item.invoicePlan?.type ? `${item.invoicePlan.type} plan` : `plan ${item.invoicePlanNumber}`}
            </button>
          )}
          {/* Issue #313: a service line is confirmed by entry sheet, not by a
              goods receipt; this is what counts towards its delivery. */}
          {item.serviceEntries?.length > 0 && (
            <span
              className="mono ml-2 text-xs text-fg-subtle"
              title={`Service entry sheets: ${item.serviceEntries.map(entry => entry.entrySheetNumber).join(', ')}`}
            >
              {item.serviceEntries.length} entry {item.serviceEntries.length === 1 ? 'sheet' : 'sheets'} · ₹{money2(item.serviceEntries.reduce((sum, entry) => sum + Number(entry.netAmount || 0), 0))} confirmed
            </span>
          )}
        </span>
      ),
    },
    { key: 'quantity', header: 'Quantity', align: 'right', render: (item) => <span className="mono">{item.quantity}</span> },
    { key: 'uom', header: 'Unit', render: (item) => item.uom || 'EA' },
    { key: 'unitPrice', header: 'Net price (₹)', align: 'right', render: (item) => <span className="mono">{money2(item.unitPrice)}</span> },
    // Issue #113: this used to be the literal "G1 (18%)" for every line
    // regardless of the line's real tax code. taxCode is SAP's raw MWSKZ
    // (config/gstCodes.js's G1..G6 registry is for the RFQ bid → invoice GST
    // path, not this field — an asset line's code like 'V0' isn't in it, so
    // this renders the code itself rather than guessing a rate for it) and is
    // null on every line except an asset PO's own (ADR-0042); awardRfq never
    // carries a bid's tax code onto the PO line it creates, so null is the
    // honest, common case here, not a display gap.
    { key: 'taxCode', header: 'Tax code', render: (item) => <span className="mono">{item.taxCode || '—'}</span> },
    { key: 'deliveryDate', header: 'Delivery', render: (item) => displayDate(item.deliveryDate) },
    { key: 'netValue', header: 'Net value (₹)', align: 'right', render: (item) => <span className="mono">{money2(item.netValue)}</span> },
  ];

  const receivedColumns = (grn) => [
    { key: 'line', header: 'Line', mono: true, primary: true },
    { key: 'materialCode', header: 'Item code', render: (item) => <span className="mono">{item.materialCode || '—'}</span> },
    { key: 'description', header: 'Description', wrap: true },
    { key: 'received', header: 'Received', align: 'right', render: (item) => <span className="mono">{item.receivedQuantity || ((item.acceptedQuantity || 0) + (item.rejectedQuantity || 0))}</span> },
    // "—", not a number, for a line nobody inspected (issue #351).
    { key: 'accepted', header: 'Accepted', align: 'right', render: (item) => (isInspected(item) ? <span className="mono">{item.acceptedQuantity}</span> : <span className="text-fg-subtle">—</span>) },
    { key: 'rejected', header: 'Rejected', align: 'right', render: (item) => (isInspected(item) ? <span className={`mono ${(item.rejectedQuantity || 0) > 0 ? 'text-danger' : 'text-fg-subtle'}`}>{item.rejectedQuantity || 0}</span> : <span className="text-fg-subtle">—</span>) },
    { key: 'uom', header: 'Unit', render: (item) => item.uom || 'EA' },
    { key: 'qc', header: 'Inspection', render: (item) => inspectionBadge(isInspected(item) ? [item] : []) },
    { key: 'date', header: 'Received on', render: () => displayDate(grn.postingDate) },
  ];

  // ── List columns ──────────────────────────────────────────────────────
  const poAmount = (po) => Number((po.items || []).reduce((s, i) => s + (i.netValue || 0), 0) || 0)
    .toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const confirmedCell = (po) => {
    // An order carrying its own sapSyncState is answerable without this
    // lookup — that field travels on the PO record. Only the
    // isConfirmedInSap fallback below needs the vendorPoGrnDisplay read, so
    // only it is left unknown when that read fails.
    if (!po.sapSyncState && sapPoStatus === 'error') {
      return (
        <span className="text-fg-muted" title="Could not reach your buyer's system to check this order. Nothing about the order has changed.">
          Could not check
        </span>
      );
    }
    if (!po.sapSyncState && (sapPoStatus === 'loading' || !Array.isArray(sapPoOrders))) {
      return <Loader2 className="inline-block size-4 animate-spin text-fg-subtle" strokeWidth={1.5} aria-label="Checking" />;
    }
    // Dual identity / sync state (Phase 3 of
    // docs/04-sap-runtime-engineering-plan.md, invariant I5): a number shown
    // to a supplier is either from SAP or clearly marked as not.
    // sapSyncState is the honest source now; isConfirmedInSap's own
    // cross-check against the vendorPoGrnDisplay read stays as the fallback
    // for a PO fetched before this field existed on the response shape.
    const { label, tone } = po.sapSyncState
      ? describeSyncState(po.sapSyncState)
      : (isConfirmedInSap(po)
        ? { label: 'Confirmed', tone: 'active' }
        : { label: 'Not confirmed yet', tone: 'pending' });
    const toneClass = tone === 'active' ? 'text-success' : tone === 'suspended' ? 'text-danger' : 'text-fg-muted';
    return (
      <span className={`inline-flex items-center gap-1.5 ${toneClass}`} title={label}>
        {tone === 'active' && <CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden="true" />}
        {tone === 'suspended' && <AlertCircle className="size-4" strokeWidth={1.5} aria-hidden="true" />}
        {label}
      </span>
    );
  };

  const poColumns = [
    {
      key: 'id',
      header: 'Order',
      sortable: true,
      primary: true,
      render: (po) => (
        <span className="mono text-fg">
          {po.id}
          {po.sapOnly && (
            <span
              className="ml-2 font-sans text-xs text-fg-subtle"
              title="Your buyer has raised this in SAP. It is not recorded in this portal yet, so there is nothing here to acknowledge or ship against."
            >
              not recorded here yet
            </span>
          )}
        </span>
      ),
    },
    { key: 'createdDate', header: 'Raised', sortable: true, render: (po) => displayDate(po.createdDate) },
    {
      key: 'type',
      header: 'Type',
      render: (po) => {
        const kind = poKind(po);
        return (
          <span className="inline-flex items-center gap-1.5 text-fg-muted" title={kind.hint}>
            {kind.label}
            {poHasInvoicePlan(po) && (
              <CalendarClock className="size-4 text-fg-subtle" strokeWidth={1.5} aria-label="Invoiced against an invoicing plan, not on goods receipt" />
            )}
            {/* The one signal on this list that a supplier's proposed plan
                change is sitting unapproved — without it, the only way to
                find one was to already know which order to open. */}
            {canManagePlans && hasPendingInvoicePlanChange(po) && (
              <Clock className="size-4 text-warning" strokeWidth={1.5} aria-label="A supplier has proposed an invoicing-plan change here, awaiting your approval" />
            )}
          </span>
        );
      },
    },
    { key: 'buyerName', header: 'Buyer', wrap: true, render: (po) => po.buyerName || '—' },
    { key: 'plant', header: 'Plant', wrap: true, render: (po) => po.plant || '—' },
    { key: 'itemsCount', header: 'Lines', align: 'right', sortable: true, render: (po) => <span className="mono">{(po.items || []).length}</span> },
    { key: 'value', header: 'Value (₹)', align: 'right', sortable: true, render: (po) => <span className="mono">{poAmount(po)}</span> },
    { key: 'status', header: 'Status', sortable: true, render: (po) => renderStatusChip(po.status) },
    { key: 'confirmed', header: 'In buyer’s system', render: confirmedCell },
  ];

  const grnColumns = [
    { key: 'id', header: 'Receipt', mono: true, primary: true },
    { key: 'sapMigoDoc', header: 'Buyer’s document', render: (grn) => <span className="mono">{grn.sapMigoDoc || '—'}</span> },
    { key: 'poId', header: 'Order', mono: true },
    { key: 'postingDate', header: 'Posted', render: (grn) => displayDate(grn.postingDate) },
    { key: 'receivedBy', header: 'Checked by', render: (grn) => grn.receivedBy || '—' },
    // Totals over inspected lines only. A receipt read from SAP has no
    // inspection result (accepted/rejected null), and must not read as
    // "QC Passed" or as all rejected (issue #351).
    {
      key: 'accepted',
      header: 'Accepted',
      align: 'right',
      render: (grn) => {
        const inspected = (grn.items || []).filter(isInspected);
        if (!inspected.length) return <span className="text-fg-subtle">—</span>;
        return <span className="mono">{inspected.reduce((s, i) => s + (i.acceptedQuantity || 0), 0)}</span>;
      },
    },
    {
      key: 'rejected',
      header: 'Rejected',
      align: 'right',
      render: (grn) => {
        const inspected = (grn.items || []).filter(isInspected);
        if (!inspected.length) return <span className="text-fg-subtle">—</span>;
        const rejected = inspected.reduce((s, i) => s + (i.rejectedQuantity || 0), 0);
        return <span className={`mono ${rejected > 0 ? 'text-danger' : 'text-fg-subtle'}`}>{rejected}</span>;
      },
    },
    {
      key: 'qc',
      header: 'Inspection',
      render: (grn) => inspectionBadge((grn.items || []).filter(isInspected)),
    },
  ];

  if (isLoading) {
    return (
      <ErrorBoundary>
        <div className="card">
          <TableSkeleton rows={6} cols={5} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="pb-16">

        {/* PAGE HEADER — list view only; the detail view titles itself with
            the order it is showing. */}
        {currentView === 'list' && (
          <PageHeader
            title="Purchase orders"
            description="Acknowledge new orders, send shipment notices, and track what your buyer has received."
          />
        )}

        {currentView === 'list' && (
          <Tabs
            aria-label="Purchase order screens"
            value={poSubTab}
            onValueChange={(tab) => { setPoSubTab(tab); setCurrentPage(1); }}
            items={[
              { value: 'list', label: 'Orders', count: allPOs.length },
              { value: 'grn', label: 'Delivery receipts', count: cleanGrns.length },
            ]}
          />
        )}

        {/* ================================================================= */}
        {/* SCREEN 1: ORDERS                                                  */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'list' && (
          <div className="space-y-4 pt-4">

            {/* The SAP ledger read (zpo_grn_vendor/Detail) supplies both the
                not-yet-recorded rows merged into the table below and the
                per-row Confirmed badge. When it has not answered, say so once
                here rather than leaving a quietly short list. */}
            {sapPoStatus === 'error' ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-tint px-3 py-2.5 text-sm text-warning" role="status">
                <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <p className="flex-1">
                  Could not reach your buyer&rsquo;s records, so any order they raised that this
                  portal has not recorded yet is missing from this list. Everything already
                  tracked here is unaffected.
                </p>
                {retrySapStatus && (
                  <Button size="sm" variant="secondary" onClick={retrySapStatus}>Try again</Button>
                )}
              </div>
            ) : (sapPoStatus === 'loading' || !Array.isArray(sapPoOrders)) ? (
              <p className="flex items-center gap-2 text-sm text-fg-subtle" role="status">
                <Loader2 className="size-4 animate-spin" strokeWidth={1.5} /> Checking your buyer&rsquo;s records for orders not yet listed here&hellip;
              </p>
            ) : null}

            {/* Saved views: the counts carry what the four KPI cards used to. */}
            <SegmentedControl
              aria-label="Show orders"
              value={savedView}
              onChange={(view) => { setSavedView(view); setCurrentPage(1); }}
              options={SAVED_VIEWS.map((view) => ({
                value: view.value,
                label: <>{view.label} <span className="mono text-xs text-fg-subtle">{allPOs.filter((po) => view.match(po.status)).length}</span></>,
              }))}
            />

            {/* One toolbar row: search and compact filters. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search orders"
                  placeholder="PO number or material"
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  className="pl-8!"
                />
              </div>
              <label htmlFor="po-filter-status" className="sr-only">Status</label>
              <select id="po-filter-status" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setCurrentPage(1); }} className="w-44!">
                <option value="all">Any status</option>
                <option value="New">New</option>
                <option value="Acknowledged">Acknowledged</option>
                <option value="Shipment Sent">Shipment sent</option>
                <option value="Delivery Confirmed">Delivery confirmed</option>
              </select>
              <label htmlFor="po-filter-plant" className="sr-only">Plant</label>
              <select id="po-filter-plant" value={plantFilter} onChange={e => { setPlantFilter(e.target.value); setCurrentPage(1); }} className="w-36!">
                <option value="all">Any plant</option>
                {uniquePlants.map((plant, idx) => (
                  <option key={idx} value={plant}>{plant}</option>
                ))}
              </select>
              <label htmlFor="po-filter-buyer" className="sr-only">Buyer</label>
              <select id="po-filter-buyer" value={buyerFilter} onChange={e => { setBuyerFilter(e.target.value); setCurrentPage(1); }} className="w-44!">
                <option value="all">Any buyer</option>
                {uniqueBuyers.map((buyer, idx) => (
                  <option key={idx} value={buyer}>{buyer}</option>
                ))}
              </select>
              {(searchQuery || statusFilter !== 'all' || plantFilter !== 'all' || buyerFilter !== 'all') && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                    setPlantFilter('all');
                    setBuyerFilter('all');
                  }}
                >
                  Reset filters
                </Button>
              )}
            </div>

            <DataTable
              caption="Purchase orders"
              columns={poColumns}
              rows={paginatedPOs.filter(Boolean)}
              sort={{ key: sortField, dir: sortOrder }}
              onSortChange={({ key, dir }) => { setSortField(key); setSortOrder(dir); }}
              onRowClick={handleOpenPoDetails}
              rowLabel={(po) => po.id}
              // Dispatched too: an order can ship in parts, and stays
              // shippable while any line has quantity left open.
              inlineActions={(po) => (!po.sapOnly
                && (po.status === 'Acknowledged' || po.status === 'Dispatched')
                && (po.items || []).some(item => openToShip(item) > 0) ? (
                // Shipment acts on a PurchaseOrder row, which an order SAP
                // holds but this portal has not recorded yet does not have.
                // The detail page opens for it either way, read-only.
                <Button size="sm" variant="secondary" onClick={() => openAsnWizard(po)}>Send shipment</Button>
              ) : null)}
              empty={allPOs.length
                ? 'No orders match these filters.'
                : 'No purchase orders yet — they appear here as soon as your buyer issues one to your company.'}
            />
            {totalPages > 1 && (
              <Pagination
                page={currentPage}
                pageCount={totalPages}
                total={filteredPOs.length}
                pageSize={itemsPerPage}
                onPageChange={setCurrentPage}
              />
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 1: DELIVERY RECEIPTS TAB */}
        {/* ================================================================= */}
        {currentView === 'list' && poSubTab === 'grn' && (
          <div className="pt-4">
            <p className="mb-3 text-sm text-fg-muted">Every delivery your buyer has checked in and confirmed.</p>
            <DataTable
              caption="Delivery receipts"
              columns={grnColumns}
              rows={cleanGrns.filter(Boolean)}
              onRowClick={handleOpenGrnDetails}
              rowLabel={(grn) => grn.id}
              empty="No deliveries confirmed yet — once you send shipment details, your buyer checks the goods in and the receipt appears here."
            />
          </div>
        )}

        {/* ================================================================= */}
        {/* SCREEN 2: PO DETAIL / OBJECT PAGE                                */}
        {/* ================================================================= */}
        {currentView === 'detail' && activePo && (
          <div>
            {/* What kind of order this is, and whether it is invoiced to a
                plan — two independent facts (poKind.js). Asset and service
                orders behave differently enough on the supplier's side (no
                stock receipt for a service line; capex approval for an asset
                one) that the header should answer "what am I looking at"
                without opening a line. */}
            {(() => {
              const kind = poKind(activePo);
              const planNumbers = invoicePlanNumbers(activePo);
              return (
                <PageHeader
                  breadcrumb={(
                    <button type="button" onClick={() => setCurrentView('list')} className="inline-flex items-center gap-1 hover:text-fg cursor-pointer">
                      <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden="true" /> Purchase orders
                    </button>
                  )}
                  className="mb-4"
                  description={(
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span title={kind.hint}>{kind.orderLabel}</span>
                      {poHasInvoicePlan(activePo) && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span
                            className="inline-flex items-center gap-1"
                            title={planNumbers.length
                              ? `Invoiced against SAP invoicing plan ${planNumbers.join(', ')} — billed on the plan's dates, not on goods receipt.`
                              : 'Invoiced against an invoicing plan — billed on the plan’s dates, not on goods receipt.'}
                          >
                            <CalendarClock className="size-4" strokeWidth={1.5} aria-hidden="true" />
                            Invoicing plan{planNumbers.length ? <span className="mono"> {planNumbers.join(', ')}</span> : null}
                          </span>
                        </>
                      )}
                    </span>
                  )}
                  secondary={!activePoIsSapOnly && activePo.fromRfqId ? (
                    <DropdownMenu
                      label="Download for SAP import"
                      items={['csv', 'xlsx', 'json', 'idoc'].map((format) => ({
                        label: exportingFormat === format ? `Preparing ${format.toUpperCase()}…` : `Download ${format.toUpperCase()}`,
                        icon: Download,
                        disabled: exportingFormat !== null,
                        onClick: () => handleExportPo(activePo.fromRfqId, format),
                      }))}
                    />
                  ) : null}
                  primary={activePoIsSapOnly ? (
                    <span
                      className="text-sm text-fg-muted"
                      title="Your buyer raised this in SAP. It is not recorded in this portal yet, so there is nothing here to acknowledge, ship against or discuss."
                    >
                      Read-only — not recorded in this portal yet
                    </span>
                  ) : activePo.status === 'Open' ? (
                    <Button onClick={() => acknowledgePO(activePo.id)}>Acknowledge purchase order</Button>
                  ) : null}
                />
              );
            })()}

            {/* Reference header (redesign v2 §3 Phase E): status, the order
                number and when it was raised, and the order's value — the sum
                of its own lines, the same figure as the line-items total. */}
            <DocumentHero
              className="mb-6"
              status={renderStatusChip(activePo.status)}
              id={activePo.id}
              idAs="h1"
              age={`Raised ${displayDate(activePo.createdDate)}`}
              amount={`${!activePo.currency || activePo.currency === 'INR' ? '₹' : `${activePo.currency} `}${money2((activePo.items || []).reduce((s, i) => s + (Number(i?.netValue) || 0), 0))}`}
              amountLabel={`Order value · ${(activePo.items || []).filter(Boolean).length} ${(activePo.items || []).filter(Boolean).length === 1 ? 'line' : 'lines'}`}
            />

            {/* Where the order is: created → paid. */}
            {(() => {
              const steps = [
                { key: 'Open', label: 'Created' },
                { key: 'Acknowledged', label: 'Acknowledged' },
                { key: 'Dispatched', label: 'Shipped' },
                { key: 'Delivered', label: 'Received' },
                { key: 'Invoiced', label: 'Invoiced' },
                { key: 'Paid', label: 'Paid' },
              ];
              const statusOrder = steps.map((s) => s.key);
              const currentIdx = statusOrder.indexOf(activePo.status);
              return (
                <ol className="mb-6 flex gap-1 overflow-x-auto no-scrollbar" aria-label="Order progress">
                  {steps.map((step, idx) => {
                    const state = idx < currentIdx ? 'done' : idx === currentIdx ? 'now' : 'todo';
                    return (
                      <li
                        key={step.key}
                        aria-current={state === 'now' ? 'step' : undefined}
                        className={`min-w-24 flex-1 border-t-2 pt-2 text-xs ${
                          state === 'done' ? 'border-fg text-fg'
                            : state === 'now' ? 'border-accent-solid font-medium text-accent-text'
                              : 'border-border text-fg-subtle'
                        }`}
                      >
                        {state === 'done' && <Check className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={2} aria-hidden="true" />}
                        {step.label}
                      </li>
                    );
                  })}
                </ol>
              );
            })()}

            <Tabs
              aria-label="Order sections"
              value={activeDetailTab}
              onValueChange={(tab) => {
                setDetailTab(tab);
              }}
              items={activePoIsSapOnly
                // Shipment, delivery status and invoicing plan all act on a
                // PurchaseOrder row this order does not have yet; offering the
                // tabs would be offering steps that cannot be taken.
                ? [{ value: 'po_detail', label: 'Order details' }]
                : [
                  { value: 'po_detail', label: 'Order details' },
                  { value: 'create_asn', label: 'Send shipment' },
                  { value: 'grn_status', label: 'Delivery status' },
                  ...(showInvoicePlanTab ? [{ value: 'invoice_plan', label: 'Invoicing plan' }] : []),
                ]}
            />

            <div className="pt-6">
              {/* TAB 1: PO Detail View */}
              {activeDetailTab === 'po_detail' && (
                <div className="space-y-8">
                  <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    <SapReadOnlyField label="Order number" value={activePo.id} />
                    <SapReadOnlyField label="Raised" value={displayDate(activePo.createdDate)} isMonospace={false} />
                    <SapReadOnlyField label="Buying company" value={activePo.companyCode || '—'} />
                    <SapReadOnlyField label="Buyer GSTIN" value={activePo.buyerGstin || '—'} />
                    <SapReadOnlyField label="Plant" value={activePo.plant || '—'} isMonospace={false} />
                    <SapReadOnlyField label="Buyer" value={activePo.buyerName || '—'} isMonospace={false} />
                  </dl>

                  <section>
                    <h2 className="mb-3 text-lg font-semibold text-fg">Line items</h2>
                    <DataTable
                      caption="Line items"
                      columns={lineColumns}
                      rows={(activePo.items || []).filter(Boolean)}
                      getRowId={(item, i) => item.line || i}
                      rowLabel={(item) => `line ${item.line}`}
                      maxHeight="560px"
                      empty="This order has no lines."
                      totals={(activePo.items || []).length > 1 ? {
                        label: `${activePo.items.length} lines`,
                        netValue: <span className="mono">{money2((activePo.items || []).reduce((s, i) => s + (Number(i?.netValue) || 0), 0))}</span>,
                      } : undefined}
                    />
                  </section>
                </div>
              )}

              {/* TAB 2: Send shipment */}
              {activeDetailTab === 'create_asn' && (
                <div>
                  {activePo.status === 'Open' ? (
                    <div className="card flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-fg">Acknowledge the order first</p>
                        <p className="text-sm text-fg-muted">You must acknowledge this purchase order before you can send shipment details.</p>
                      </div>
                      <Button variant="secondary" onClick={() => acknowledgePO(activePo.id)}>Acknowledge PO</Button>
                    </div>
                  ) : (
                    <div className="card flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-fg">Shipment notices are created in ASN</p>
                        <p className="text-sm text-fg-muted">
                          Lines of this order that are still open start selected. You can add other orders&apos; lines for the same plant to the same shipment.
                        </p>
                      </div>
                      <Button onClick={() => openAsnWizard(activePo)}>Create ASN for this order</Button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB: Invoicing plan */}
              {activeDetailTab === 'invoice_plan' && (
                <InvoicePlanPanel po={activePo} canManage={canManagePlans} canPropose={canProposePlan} />
              )}

              {/* TAB 3: Delivery status */}
              {activeDetailTab === 'grn_status' && (
                <div className="space-y-8">
                  {(() => {
                    // Every shipment sent against this order, newest first —
                    // an order can ship in parts, and a cancelled shipment
                    // stays in the list as history.
                    // A shipment can carry lines of several orders, so it is
                    // this order's if any of its lines is.
                    const onThisOrder = (a) => a.poId === activePo.id || (a.items || []).some(item => item.poId === activePo.id);
                    const poAsns = cleanAsns.filter(onThisOrder);
                    if (!poAsns.length) return null;
                    // A line of another order on the same shipment is named
                    // with its order, so the quantities are not read as this one's.
                    const lineSummary = (asn, field) => (asn.items || [])
                      .map(item => `${item.poId && item.poId !== activePo.id ? `${item.poId}/` : ''}${item.line}: ${item[field] ?? '—'}`)
                      .join(' · ');
                    const shipmentColumns = [
                      { key: 'id', header: 'Shipment', mono: true, primary: true },
                      { key: 'status', header: 'Status', render: (asn) => <StatusBadge label={asn.status} tone={ASN_STATUS_TONE[asn.status]} /> },
                      { key: 'shipDate', header: 'Dispatched', render: (asn) => displayDate(asn.shipDate) },
                      // SAP's own inbound delivery number, once SAP has made
                      // one (ADR-0049). Blank is the honest answer on a
                      // connection that does not create deliveries.
                      {
                        key: 'sapInboundDelivery',
                        header: 'SAP delivery',
                        render: (asn) => (asn.sapInboundDelivery
                          ? <span className="mono">{asn.sapInboundDelivery}</span>
                          : <span className="text-fg-subtle" title="SAP has no inbound delivery for this shipment">—</span>),
                      },
                      { key: 'shipped', header: 'Shipped (line: qty)', render: (asn) => <span className="mono">{lineSummary(asn, 'shippedQuantity')}</span> },
                      {
                        key: 'received',
                        header: 'Received',
                        render: (asn) => {
                          if (asn.status !== 'Received') return <span className="text-fg-subtle">—</span>;
                          const short = (asn.items || []).some(item => (item.receiptVariance || 0) !== 0);
                          return (
                            <span className={`mono ${short ? 'text-danger' : ''}`} title={short ? 'SAP received a different quantity from what was shipped' : undefined}>
                              {lineSummary(asn, 'receivedQuantity')}
                            </span>
                          );
                        },
                      },
                      { key: 'ewayBillNo', header: 'E-way bill', render: (asn) => <span className="mono">{asn.ewayBillNo || '—'}</span> },
                      { key: 'documents', header: 'Files', align: 'right', render: (asn) => <span className="mono">{(asn.documents || []).length || '—'}</span> },
                    ];
                    return (
                      <section>
                        <h2 className="mb-3 text-lg font-semibold text-fg">Shipments</h2>
                        <DataTable
                          caption="Shipments"
                          columns={shipmentColumns}
                          rows={poAsns}
                          getRowId={(asn) => asn.id}
                          rowLabel={(asn) => asn.id}
                          inlineActions={(asn) => (cancelASN && (asn.status === 'Submitted' || asn.status === 'In Transit') ? (
                            <Button size="sm" variant="ghost" onClick={() => setCancellingAsn(asn)}>Cancel</Button>
                          ) : null)}
                        />
                        {poAsns.some(a => a.status === 'Cancelled' && a.cancelReason) && (
                          <ul className="mt-2 space-y-1 text-xs text-fg-subtle">
                            {poAsns.filter(a => a.status === 'Cancelled' && a.cancelReason).map(a => (
                              <li key={a.id}><span className="mono">{a.id}</span> cancelled: {a.cancelReason}</li>
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })()}
                  {cancellingAsn && (
                    <CancelShipmentDialog
                      asn={cancellingAsn}
                      onClose={() => setCancellingAsn(null)}
                      onCancel={(reason) => cancelASN(activePo.id, cancellingAsn.id, reason)}
                    />
                  )}
                  {(() => {
                    const grn = cleanGrns.find(g => g.poId === activePo.id);
                    if (!grn) {
                      if (activePo.status === 'Dispatched') {
                        return (
                          <p className="max-w-2xl text-sm text-fg-muted">
                            Your buyer confirms the delivery once the goods are checked in. The delivery receipt appears here then.
                          </p>
                        );
                      }
                      if (['Delivered', 'Invoiced', 'Paid'].includes(activePo.status)) {
                        return (
                          <p className="text-sm text-fg-muted">
                            <span className="font-medium text-fg">Goods received — receipt details not synced yet.</span>{' '}
                            Your buyer has received this order in SAP. The delivery receipt appears here once it has synced.
                          </p>
                        );
                      }
                      return (
                        <p className="text-sm text-fg-muted">
                          <span className="font-medium text-fg">No delivery confirmed yet.</span>{' '}
                          Send your shipment details first — the delivery receipt appears once your buyer checks the goods in.
                        </p>
                      );
                    }

                    // Inspected lines only: a receipt read from SAP carries no
                    // inspection result, and must not say it was checked and
                    // accepted (issue #351).
                    const inspectedLines = (grn.items || []).filter(isInspected);
                    return (
                      <section className="space-y-8">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="flex-1">
                            <h2 className="text-lg font-semibold text-fg">Delivery receipt</h2>
                            <p className="text-sm text-fg-muted">
                              {inspectedLines.length
                                ? 'Checked by your buyer’s receiving team.'
                                : 'Received by your buyer. No inspection result has been reported.'}
                            </p>
                          </div>
                          <StatusBadge label={grn.invoiceSubmitted ? 'Invoiced' : 'Awaiting invoice'} tone={grn.invoiceSubmitted ? 'done' : 'progress'} />
                        </div>

                        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                          <SapReadOnlyField label="Receipt number" value={grn.sapMigoDoc} />
                          <SapReadOnlyField label="Received on" value={displayDate(grn.postingDate)} isMonospace={false} />
                          <SapReadOnlyField label="Received by" value={grn.receivedBy || 'Receiving team'} isMonospace={false} />
                          <SapReadOnlyField label="Purchase order" value={activePo.id} />
                          <div className="flex min-w-0 items-baseline gap-3 text-sm">
                            <dt className="w-36 shrink-0 text-fg-muted">Inspection</dt>
                            <dd>{inspectionBadge(inspectedLines)}</dd>
                          </div>
                        </dl>

                        <section>
                          <h3 className="mb-3 text-base font-semibold text-fg">Items received and inspection result</h3>
                          <DataTable
                            caption="Items received"
                            columns={receivedColumns(grn)}
                            rows={(grn.items || []).filter(Boolean)}
                            getRowId={(item, i) => item.line || i}
                            rowLabel={(item) => `line ${item.line}`}
                            maxHeight="560px"
                            empty="No lines on this receipt."
                          />
                        </section>
                      </section>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </ErrorBoundary>
  );
}
