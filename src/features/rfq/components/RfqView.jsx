import React, { useState, useEffect } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Download,
  Search,
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
import DataTable from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/Page';
import { Avatar, DropdownMenu, Tabs } from '@/components/ui/controls';

import FieldCard from '@/components/ui/FieldCard';
import { displayDate } from '@/lib/displayDate';
import { rfqStatusVariant } from '@/lib/statusColors';
import { mergeSapDocuments, countByType, commonPurchasingOrg, DOCUMENT_TYPE } from '@/lib/sapDocuments';
import { rfqService } from '../services/rfqService';

// Dates here read the same as everywhere else in the app, in the reader's own
// local time. This screen used to carry its own formatDate, which split the
// `T` off an ISO timestamp and so reported its UTC calendar day: an RFQ raised
// at 01:00 IST was shown as raised the day before (issue #289). displayDate
// keeps the date-only and SAP YYYYMMDD parsing that formatter needed.
const formatDate = (dateStr) => (dateStr ? displayDate(dateStr) : '');

// One titled group of the quotation form or the request detail.
const FormSection = ({ title, children }) => (
  <section className="space-y-4">
    <h3 className="text-base font-semibold text-fg">{title}</h3>
    {children}
  </section>
);

const getInitialQuoteForm = () => ({
  rfqId: '',
  // Keyed by line number — every line on the chosen RFQ needs its own price
  // before submitBid will accept the bid (rfq.controller.js: "Missing unit
  // price for line N" for whichever line is left out). A single unitPrice
  // field used to exist here, sent for whichever one line happened to be
  // "selected" — which meant a multi-line RFQ could never actually be quoted
  // through this form at all.
  unitPrices: {},
  quoteRef: '',
  quoteDate: new Date().toISOString().split('T')[0],
  validityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
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
  // No placeholder. This used to fall back to 'VND-CURRENT', which rendered on
  // the My documents tab as though SAP had issued it (issue #287) — a code a
  // supplier could quote back at their buyer. An unassigned code is '—'.
  const currentVendorCode = state.profile.sapVendorCode || null;

  // Tab selector: 'monitor' (RFQ list & history), 'me47' (Submit Quotation),
  // or 'me48' (what SAP itself holds against this vendor's code).
  const [activeProcTab, setActiveProcTab] = useState('monitor');
  const [listSearch, setListSearch] = useState('');

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
  // the tab offers the same split (see lib/sapDocuments.js). Defaults to RFQs
  // only — DOCUMENT_TYPE.QUOTATION is SAP's own name for the 6xxxxxxx range
  // this system uses for RFQ/quotation documents, open or closed alike (SAP
  // reports no status on either read, so there is nothing to filter further
  // on) — "My Documents" is reached from inside RFQ management, so an RFQ is
  // what a visitor is here for; "All documents" (including purchase orders)
  // is one click away in the selector below, not removed.
  const [documentTypeFilter, setDocumentTypeFilter] = useState(DOCUMENT_TYPE.QUOTATION);

  // The sealed-tender rule (rfq.controller.js's rfqIncludeFor) already scopes
  // GET /rfqs to return only this vendor's own bid, never a rival's — so
  // "the bid in rfq.bids" and "this vendor's bid" are the same thing here,
  // but the lookup is still explicit rather than assuming `bids` has exactly
  // one entry, since a workspace/buyer view of the same RFQ shape carries
  // every vendor's bid.
  const ownBidFor = (rfq) => rfq?.bids?.find((b) => b.vendorId === state.profile.vendorId);

  // The default list is requests still waiting on this vendor's quote — once
  // they've placed a bid, that RFQ's own line items and price are reached from
  // My Documents (Update Price / ME47) instead, so it drops out of this list
  // rather than appearing in both places.
  const openRfqs = state.rfqs.filter((r) => !ownBidFor(r));
  const quotedRfqs = state.rfqs.filter((r) => ownBidFor(r));

  // ...but a quoted request still has an outcome, and the supplier is the one
  // waiting on it. "Quoted" brings those back into the same detail pane (their
  // own quotation and the Outcome step), without putting them back in the
  // list of requests still needing a quote. Defaults to 'open', which is what
  // this screen is for.
  const [listScope, setListScope] = useState('open');

  // "Update Price (ME47)" modal — pushes a net price for a SAP-native
  // quotation document. Line numbers/materials come from a portal RFQ the
  // vendor picks (the ones they already see in RFQ Monitor & History), since
  // SAP's own quotation display returns no line items to price against.
  const [priceUpdateDoc, setPriceUpdateDoc] = useState(null);
  const [priceUpdateRfqId, setPriceUpdateRfqId] = useState('');
  const [priceUpdatePrices, setPriceUpdatePrices] = useState({});
  const [priceUpdateLoading, setPriceUpdateLoading] = useState(false);

  // Every RFQ now carries the real sapDocNumber the discovery sweep matched
  // it to (jobs/handlers/sweepQuotations.js) — so "which portal RFQ do these
  // line items belong to" is no longer a question a human has to answer by
  // picking from every RFQ in the workspace. It used to be: the dropdown
  // below let ANY RFQ's items be priced under ANY SAP document's number,
  // and nothing stopped the two from disagreeing — the exact bug that sent
  // RFQ-2026-007's items to document 6000000072's number instead of its own
  // 6000000074. Restricting the option list to a document-number match makes
  // that mismatch structurally impossible rather than trusting the picker.
  const priceUpdateCandidates = (doc) => state.rfqs.filter((r) => r.sapDocNumber === doc?.documentNumber);

  const openPriceUpdate = (doc) => {
    setPriceUpdateDoc(doc);
    const [onlyMatch] = priceUpdateCandidates(doc);
    setPriceUpdateRfqId(onlyMatch ? onlyMatch.id : '');
    setPriceUpdatePrices({});
    if (onlyMatch) handlePriceUpdateRfqChange(onlyMatch.id);
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
    const ownBid = ownBidFor(rfq);
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

    const selectedRfq = state.rfqs.find(r => r.id === quoteForm.rfqId);

    const errors = {};
    if (!quoteForm.rfqId) errors.rfqId = true;
    if (!quoteForm.quoteDate) errors.quoteDate = true;
    if (!quoteForm.validityDate) errors.validityDate = true;
    // submitBid refuses a bid missing a price for ANY of the RFQ's lines
    // (rfq.controller.js) — checked per line here so the form can point at
    // exactly which ones are missing, rather than one generic "unit price"
    // flag that only ever meant one (arbitrary) line.
    const unitPriceErrors = {};
    (selectedRfq?.items || []).forEach((item) => {
      if (!quoteForm.unitPrices[item.line] || Number(quoteForm.unitPrices[item.line]) <= 0) {
        unitPriceErrors[item.line] = true;
      }
    });
    if (Object.keys(unitPriceErrors).length > 0) errors.unitPrices = unitPriceErrors;
    if (!quoteForm.gstRate) errors.gstRate = true;
    if (!quoteForm.deliveryLeadTime || Number(quoteForm.deliveryLeadTime) <= 0) errors.deliveryLeadTime = true;

    if (Object.keys(errors).length > 0) {
      setQuoteErrors(errors);
      alert('Please fill in all required fields correctly.');
      return;
    }

    setIsLoading(true);

    // Every line on the RFQ, priced — not just whichever one was last
    // selected.
    const prices = Object.fromEntries(
      selectedRfq.items.map((item) => [item.line, Number(quoteForm.unitPrices[item.line])])
    );

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

  const quotedCount = quotedRfqs.length;
  const matchesSearch = (r) =>
    r.id.toLowerCase().includes(listSearch.toLowerCase()) || r.description.toLowerCase().includes(listSearch.toLowerCase());
  const scopedRfqs = listScope === 'quoted' ? quotedRfqs : listScope === 'all' ? state.rfqs : openRfqs;
  const listedRfqs = scopedRfqs.filter(matchesSearch);
  const activeRfq = scopedRfqs.find(r => r.id === selectedRfqId) || scopedRfqs[0];

  // What this supplier actually knows about the award, and nothing more.
  //
  // The API names the awarded vendor only when it is the caller (formatRfqFor
  // in backend/controllers/rfq.controller.js) — so for a supplier, a present
  // `awardedVendorId` means "you won", and an Awarded tender without one means
  // the buyer chose someone else, with nothing said about who, at what price,
  // or against which order. The `=== profile.vendorId` check is belt and
  // braces on top of that, not the thing doing the sealing.
  const ownActiveBid = ownBidFor(activeRfq);
  const isAwarded = activeRfq?.status === 'Awarded';
  const awardedToMe = isAwarded
    && !!activeRfq.awardedVendorId
    && activeRfq.awardedVendorId === state.profile.vendorId;
  // An award is a decision, not an order: the PO exists only once awardBid has
  // actually created and linked one (issue #287 — "Conversion completed" used
  // to render off the status alone).
  const hasLinkedPo = awardedToMe && !!activeRfq.convertedPoId;

  const rfqLineColumns = [
    { key: 'lineNo', header: 'Line', mono: true, primary: true },
    { key: 'materialCode', header: 'Item code', render: (item) => <span className="mono">{item.materialCode}</span> },
    { key: 'description', header: 'Description', wrap: true },
    { key: 'quantity', header: 'Quantity', align: 'right', mono: true, render: (item) => item.quantity.toLocaleString() },
    { key: 'uom', header: 'Unit' },
    { key: 'targetPrice', header: 'Target price (₹)', align: 'right', mono: true, render: (item) => (item.targetPrice ? item.targetPrice.toFixed(2) : '0.00') },
    { key: 'deliveryDate', header: 'Delivery', render: (item) => formatDate(item.deliveryDate) },
  ];

  return (
    <ErrorBoundary>
      <div className="space-y-6 pb-16">

      <PageHeader
        title="RFQs"
        description={(
          <>
            Quote on requests you have been invited to, and track them through to a purchase order.{' '}
            <span className="whitespace-nowrap text-fg-subtle">{openRfqs.length} open &middot; {quotedCount} quoted</span>
          </>
        )}
      />

      <Tabs
        aria-label="RFQ screens"
        value={activeProcTab}
        onValueChange={(tab) => { setActiveProcTab(tab); setListSearch(''); }}
        items={[
          { value: 'monitor', label: 'Open requests', count: openRfqs.length },
          { value: 'me47', label: 'Submit quotation' },
          { value: 'me48', label: 'My documents' },
        ]}
      />

      {activeProcTab === 'monitor' ? (
        <>
        <div className="flex items-center gap-2">
          <label htmlFor="rfq-list-scope" className="text-sm text-fg-muted">Show</label>
          <select
            id="rfq-list-scope"
            value={listScope}
            onChange={(e) => { setListScope(e.target.value); setListSearch(''); }}
            className="w-56 max-w-full"
          >
            <option value="open">Awaiting your quotation ({openRfqs.length})</option>
            <option value="quoted">Quoted by you ({quotedRfqs.length})</option>
            <option value="all">All requests ({state.rfqs.length})</option>
          </select>
        </div>
        {/* One empty state when there is nothing to show — never an empty list
            beside an empty detail pane. */}
        {!activeRfq ? (
          listScope === 'quoted' ? (
            <EmptyState
              icon={ClipboardList}
              title="No quoted RFQs to show"
              description="Requests you have quoted appear here, with your quotation and its outcome."
            />
          ) : listScope === 'all' ? (
            <EmptyState
              icon={ClipboardList}
              title="No RFQs to show"
              description="Requests you are invited to quote for appear here."
            />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="No open RFQs to show"
              description="RFQs you've already quoted move to Quoted by you, where you can see your quotation and its outcome."
            />
          )
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
            {/* LIST */}
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              <div className="border-b border-border p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="Search open requests"
                    placeholder="Search requests"
                    value={listSearch}
                    onChange={e => setListSearch(e.target.value)}
                    className="w-full pl-8!"
                  />
                </div>
              </div>
              <ul
                className="max-h-[32rem] divide-y divide-border overflow-y-auto"
                aria-label={listScope === 'open' ? 'Open requests' : listScope === 'quoted' ? 'Quoted requests' : 'All requests'}
              >
                {listedRfqs.map(rfq => {
                  const isSelected = activeRfq.id === rfq.id;
                  return (
                    <li key={rfq.id}>
                      <button
                        type="button"
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={() => setSelectedRfqId(rfq.id)}
                        className={`block w-full cursor-pointer px-3.5 py-3 text-left transition-colors ${isSelected
                          ? 'bg-accent-tint shadow-[inset_2px_0_0_var(--accent-solid)]'
                          : 'hover:bg-subtle'}`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="mono text-sm text-fg">{rfq.id}</span>
                          <StatusBadge label={rfq.status} variant={rfqStatusVariant(rfq.status)} />
                        </span>
                        <span className="mt-1 block truncate text-sm text-fg" title={rfq.description}>{rfq.description}</span>
                        <span className="mt-1 flex items-center justify-between gap-2 text-xs text-fg-subtle">
                          {/* '—' when nobody chose one (issue #125). This used to
                              read "Org: 1000" on every RFQ in the list, chosen or not,
                              because the column defaulted to SAP's IDES demo value. */}
                          <span>Buying unit {rfq.purchasingOrg || '—'}</span>
                          <span className="whitespace-nowrap">{formatDate(rfq.createdDate)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {listedRfqs.length === 0 && (
                  <li className="px-3.5 py-6 text-sm text-fg-muted">No requests match “{listSearch}”.</li>
                )}
              </ul>
            </div>

            {/* DETAIL */}
            <article className="min-w-0 space-y-8 rounded-lg border border-border bg-surface p-5 md:p-6">
              <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-fg">
                    <span className="mono">{activeRfq.id}</span> · {activeRfq.description}
                  </h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    Raised {formatDate(activeRfq.createdDate)}
                    {' · '}Buying unit <span className="mono">{activeRfq.purchasingOrg || '—'}</span>
                    {activeRfq.rfqType ? <> · Type <span className="mono">{activeRfq.rfqType}</span></> : null}
                  </p>
                </div>
                <StatusBadge label={activeRfq.status} variant={rfqStatusVariant(activeRfq.status)} />
              </header>

              <FormSection title="Line items">
                <DataTable
                  caption="Requested line items"
                  columns={rfqLineColumns}
                  rows={activeRfq.items.map((item, idx) => ({ ...item, lineNo: (idx + 1) * 10 }))}
                  getRowId={(item) => item.lineNo}
                  rowLabel={(item) => `line ${item.lineNo}`}
                  empty="This request has no lines."
                />
              </FormSection>

              {/* The API withholds the invitee list from suppliers (a sealed
                  tender does not name the competition); it is only present
                  for staff. */}
              {activeRfq.invitedVendors && (
                <FormSection title="Invited vendors">
                  <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {activeRfq.invitedVendors?.map(v => (
                      <li key={v.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                        <Avatar name={v.name || '?'} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-fg" title={v.name}>{v.name}</span>
                          <span className="mono block truncate text-xs text-fg-subtle">{v.id}</span>
                        </span>
                        <span className="mono text-sm text-fg-muted" title={`Vendor rating: ${v.rating}`}>{v.rating}</span>
                      </li>
                    ))}
                  </ul>
                </FormSection>
              )}

              <FormSection title="Progress of this request">
                {(() => {
                  // Every step here is something this supplier actually knows
                  // (issue #287). The previous version counted `bids.length`
                  // as "N bid(s) received" — but the sealed-tender rule means
                  // a supplier receives only their own bid, so a whole tender
                  // read as having exactly one quote in it, theirs. The count
                  // belongs to the staff view, and is gone from here; what is
                  // left is their own quotation and the buyer's decision on it.
                  const steps = [
                    { label: 'Request published', value: 'Published', note: formatDate(activeRfq.createdDate), done: true },
                    {
                      label: 'Your quotation',
                      value: ownActiveBid ? 'Submitted' : 'Not submitted',
                      // An RFQ SAP raised directly carries no deadline
                      // (schema.prisma's RFQ.deadlineDate comment) — said
                      // plainly, not as a bare "—" that reads like a gap.
                      note: ownActiveBid
                        ? `Submitted ${formatDate(ownActiveBid.submittedAt)}`
                        : `Deadline: ${activeRfq.deadlineDate ? formatDate(activeRfq.deadlineDate) : 'No deadline set by buyer'}`,
                      done: !!ownActiveBid,
                      active: !ownActiveBid && !isAwarded,
                    },
                    {
                      label: 'Buyer evaluation',
                      value: isAwarded ? 'Closed' : 'In progress',
                      note: isAwarded
                        ? 'Your buyer has decided this request'
                        : 'Your buyer is reviewing the quotations',
                      done: isAwarded,
                      active: !isAwarded && !!ownActiveBid,
                    },
                    {
                      label: 'Outcome',
                      value: awardedToMe
                        ? 'Awarded to you'
                        : isAwarded
                          ? 'Your quotation was not accepted'
                          : 'Pending',
                      // A linked purchase order is the only thing that makes
                      // "Order raised" true; an award on its own does not.
                      note: awardedToMe
                        ? (hasLinkedPo ? `Order raised: ${activeRfq.convertedPoId}` : 'Order pending')
                        : isAwarded
                          ? (ownActiveBid ? 'This request is now closed' : 'You did not quote on this request')
                          : 'Awaiting your buyer’s decision',
                      done: isAwarded,
                    },
                  ];
                  return (
                    <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                      {steps.map((step) => (
                        <li
                          key={step.label}
                          aria-current={step.active ? 'step' : undefined}
                          className={`border-t-2 pt-2.5 ${step.done ? 'border-fg' : step.active ? 'border-accent-solid' : 'border-border'}`}
                        >
                          <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                            {step.done && <CheckCircle2 className="size-3.5 text-success" strokeWidth={1.5} aria-hidden="true" />}
                            {step.label}
                          </span>
                          <span className={`mt-1 block text-sm ${step.done || step.active ? 'font-medium text-fg' : 'text-fg-subtle'}`}>{step.value}</span>
                          <span className="mt-0.5 block text-xs text-fg-subtle">{step.note}</span>
                        </li>
                      ))}
                    </ol>
                  );
                })()}
              </FormSection>

              <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm text-fg-muted">
                <p>
                  Delivery location: <span className="text-fg">{activeRfq.deliveryLocation || '—'}</span>
                  <span
                    className="ml-1 cursor-help text-fg-subtle"
                    title="Sourcing (RFQs, bids, awards) is managed in VendorConnect. SAP has no inbound API for issuing an RFQ or capturing a bid, so this stays portal-internal — optionally reconciled against SAP once the resulting PO is matched (see the ledger tab)."
                  >
                    &middot; managed in VendorConnect
                  </span>
                </p>
                {/* Only a winner is told there is an order, and only a winner
                    is offered it. This used to render on `status === 'Awarded'`
                    alone — so a supplier who lost saw "Awarded to <rival>" and
                    an Export order button that could only 404 (issue #287).
                    The export itself needs a PO to export, which an award does
                    not by itself produce. */}
                {awardedToMe && (
                  <div className="flex items-center gap-3">
                    <StatusBadge label="Awarded to you" tone="done" />
                    {hasLinkedPo && (
                      <DropdownMenu
                        label="Download the order for SAP import"
                        trigger={<Button variant="secondary" size="sm"><Download className="mr-1.5 size-3.5" strokeWidth={1.5} /> Export order</Button>}
                        items={['csv', 'xlsx', 'json', 'idoc'].map((format) => ({
                          label: exportingFormat === format ? `Preparing ${format.toUpperCase()}…` : `Download ${format.toUpperCase()}`,
                          icon: Download,
                          disabled: exportingFormat !== null,
                          onClick: () => handleExportPo(activeRfq.id, format),
                        }))}
                      />
                    )}
                  </div>
                )}
              </footer>
            </article>
          </div>
        )}
        </>
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
            <section className="space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="max-w-3xl">
                  <h2 className="text-lg font-semibold text-fg">Your buyer&rsquo;s records</h2>
                  <p className="mt-1 text-sm text-fg-muted">
                    Read straight from your buyer&rsquo;s system for supplier ID{' '}
                    <span className="mono text-fg">{currentVendorCode || '—'}</span>.{' '}
                    {currentVendorCode
                      ? <>These are your buyer&rsquo;s own records, so they are listed separately from the open requests.</>
                      : <>Your SAP vendor code is assigned after approval, so your buyer has nothing on file to read yet.</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="sap-document-type" className="text-sm text-fg-muted">Type</label>
                  <select id="sap-document-type" value={documentTypeFilter} onChange={(e) => setDocumentTypeFilter(e.target.value)}>
                    {/* DOCUMENT_TYPE.QUOTATION is SAP's own name for the
                        RFQ/quotation range (lib/sapDocuments.js) — labelled
                        "RFQs" here, which is this screen's own vocabulary. */}
                    <option value={DOCUMENT_TYPE.QUOTATION}>RFQs</option>
                    <option value={DOCUMENT_TYPE.PURCHASE_ORDER}>Purchase orders</option>
                    <option value="all">All documents</option>
                  </select>
                </div>
              </div>

              {documents === null ? (
                <p className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted" role="status">
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} aria-hidden="true" /> Loading your buyer&rsquo;s records for your company…
                </p>
              ) : documents.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title="Nothing on file yet"
                  description="Your buyer has no documents on file for your company yet. RFQs and purchase orders appear here once they do."
                />
              ) : (() => {
                const counts = countByType(documents);
                const org = commonPurchasingOrg(documents);
                const shown = documentTypeFilter === 'all'
                  ? documents
                  : documents.filter((doc) => doc.documentType === documentTypeFilter);

                const documentColumns = [
                  { key: 'documentNumber', header: 'Document', mono: true, primary: true, render: (doc) => doc.documentNumber || '—' },
                  {
                    key: 'documentType',
                    header: 'Type',
                    // The data value stays SAP's own name (DOCUMENT_TYPE.QUOTATION)
                    // — only the label shown here uses this screen's vocabulary.
                    render: (doc) => (
                      <StatusBadge
                        label={doc.documentType === DOCUMENT_TYPE.QUOTATION ? 'RFQ' : doc.documentType}
                        variant={doc.documentType === DOCUMENT_TYPE.QUOTATION ? 'info' : 'pending'}
                      />
                    ),
                  },
                  { key: 'date', header: 'Date', render: (doc) => formatDate(doc.date) },
                  { key: 'currency', header: 'Currency', mono: true, render: (doc) => doc.currency || '—' },
                  ...(!org ? [{ key: 'purchasingOrg', header: 'Buying unit', mono: true, render: (doc) => doc.purchasingOrg || '—' }] : []),
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    align: 'right',
                    render: (doc) => (doc.documentType === DOCUMENT_TYPE.QUOTATION ? (
                      <Button type="button" variant="secondary" size="sm" onClick={() => openPriceUpdate(doc)}>
                        <IndianRupee className="mr-1.5 size-3.5" strokeWidth={1.5} /> Update price
                      </Button>
                    ) : null),
                  },
                ];

                return (
                  <>
                    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
                      <span><span className="mono text-fg">{counts.quotations}</span> RFQ(s)</span>
                      <span><span className="mono text-fg">{counts.purchaseOrders}</span> purchase order(s)</span>
                      {/* Shown once as context rather than repeated down a
                          column: it is the same value on every row. */}
                      {org && <span>Buying unit <span className="mono text-fg">{org}</span></span>}
                    </p>

                    {shown.length === 0 ? (
                      <EmptyState
                        icon={FileText}
                        title="No documents of this type"
                        description="Your buyer has documents for your company, but none of the selected type."
                      />
                    ) : (
                      <DataTable
                        caption="Purchasing documents on file"
                        columns={documentColumns}
                        rows={shown}
                        getRowId={(doc, index) => `${doc.documentNumber || 'unnumbered'}-${index}`}
                        rowLabel={(doc) => `document ${doc.documentNumber || ''}`}
                        maxHeight="520px"
                      />
                    )}

                    <p className="text-xs text-fg-subtle">
                      Showing {shown.length} of {documents.length} document(s), newest first.
                    </p>
                  </>
                );
              })()}
            </section>
          );
        })()
      ) : (
        /* TAB: SUBMIT QUOTATION FORM */
        tabLoading ? (
          <div className="card space-y-4 p-6" aria-busy="true">
            <div className="h-4.5 w-48 skeleton" />
            <div className="h-3 w-80 skeleton" />
            {[1, 2, 3].map(i => <div key={i} className="h-9 w-full skeleton" />)}
          </div>
        ) : (
          <form onSubmit={handleQuotationSubmit} className="relative space-y-8">
            {isLoading && (
              <div className="absolute inset-0 z-30 flex min-h-[400px] flex-col items-center justify-center bg-canvas/85" role="status">
                <Loader2 className="mb-3 size-6 animate-spin text-fg-muted" strokeWidth={1.5} aria-hidden="true" />
                <p className="text-sm font-medium text-fg">Submitting your quote…</p>
                <p className="mt-1 text-sm text-fg-muted">Sending your prices and delivery terms to your buyer.</p>
              </div>
            )}

            <div>
              <h2 className="text-lg font-semibold text-fg">Submit quotation</h2>
              <p className="mt-1 text-sm text-fg-muted">Send your prices, discounts and delivery timelines to your buyer.</p>
            </div>

            {/* RFQ selection and its lines */}
            {(() => {
              const selectedRfq = state.rfqs.find(r => r.id === quoteForm.rfqId);
              const priceColumns = [
                { key: 'line', header: 'Line', mono: true, primary: true },
                { key: 'materialCode', header: 'Item code', render: (item) => <span className="mono">{item.materialCode}</span> },
                { key: 'description', header: 'Description', wrap: true },
                { key: 'quantity', header: 'Quantity', align: 'right', mono: true, render: (item) => `${item.quantity.toLocaleString()} ${item.uom}` },
                { key: 'targetPrice', header: 'Target price (₹)', align: 'right', mono: true, render: (item) => (item.targetPrice ? item.targetPrice.toFixed(2) : '—') },
                {
                  key: 'unitPrice',
                  header: 'Your unit price (₹) *',
                  align: 'right',
                  render: (item) => (
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      aria-label={`Unit price (₹) for line ${item.line}`}
                      aria-invalid={quoteErrors.unitPrices?.[item.line] ? true : undefined}
                      placeholder="0.00"
                      value={quoteForm.unitPrices[item.line] ?? ''}
                      onChange={e => {
                        setQuoteForm({
                          ...quoteForm,
                          unitPrices: { ...quoteForm.unitPrices, [item.line]: e.target.value },
                        });
                        if (quoteErrors.unitPrices?.[item.line]) {
                          setQuoteErrors(prev => {
                            const rest = { ...prev.unitPrices };
                            delete rest[item.line];
                            return { ...prev, unitPrices: Object.keys(rest).length ? rest : undefined };
                          });
                        }
                      }}
                      className="mono w-[12ch]! min-h-8! py-1! text-right"
                    />
                  ),
                },
              ];
              return (
                <section className="space-y-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <h3 id="quote-rfq-label" className="text-base font-semibold text-fg">Choose a request</h3>
                      <p className="text-sm text-fg-muted">Pick one of the open requests you have been invited to quote for.</p>
                    </div>
                    {/* Named by the heading beside it rather than by a <label>
                        — pointed at rather than duplicated, so the two cannot
                        drift. */}
                    <select
                      id="quote-rfq"
                      aria-labelledby="quote-rfq-label"
                      aria-required="true"
                      aria-invalid={quoteErrors.rfqId ? true : undefined}
                      value={quoteForm.rfqId}
                      onChange={e => {
                        const selectedId = e.target.value;
                        const rfq = state.rfqs.find(r => r.id === selectedId);
                        // A quotation already submitted for this RFQ shows its
                        // own numbers back rather than a blank form — the gap
                        // that left an earlier submission with nowhere to
                        // confirm it had gone in at all.
                        const ownBid = ownBidFor(rfq);
                        const unitPrices = {};
                        (rfq?.items || []).forEach((item) => {
                          unitPrices[item.line] = ownBid ? String(ownBid.unitPrices?.[item.line] ?? '') : '';
                        });
                        setQuoteForm({
                          ...quoteForm,
                          rfqId: selectedId,
                          unitPrices,
                          gstRate: ownBid?.gstRate || quoteForm.gstRate,
                          deliveryLeadTime: ownBid ? String(ownBid.deliveryLeadTimeDays ?? '') : quoteForm.deliveryLeadTime,
                          freight: ownBid ? String(ownBid.freight ?? '0') : quoteForm.freight,
                          validityDate: ownBid?.validityDate
                            ? new Date(ownBid.validityDate).toISOString().split('T')[0]
                            : quoteForm.validityDate,
                        });
                        setQuoteErrors(prev => ({ ...prev, rfqId: false, unitPrices: undefined }));
                      }}
                      className="w-full max-w-md"
                    >
                      <option value="">Choose a request…</option>
                      {state.rfqs.map(r => (
                        <option key={r.id} value={r.id}>
                          {r.id} - {r.description} ({r.status})
                        </option>
                      ))}
                    </select>
                  </div>
                  {quoteErrors.rfqId && (
                    <p className="flex items-center gap-1.5 text-sm text-danger">
                      <AlertCircle className="size-4" strokeWidth={1.5} aria-hidden="true" /> Choose the request you are quoting for.
                    </p>
                  )}

                  {selectedRfq && (
                    // Every line, priced together — submitBid refuses a bid
                    // that leaves any line unpriced, so a single "pick one
                    // line" selector could never actually quote a multi-line RFQ.
                    <div className="space-y-2">
                      <p className="flex items-center gap-2 text-sm text-fg-muted">
                        Lines to price <StatusBadge label={selectedRfq.status} variant={rfqStatusVariant(selectedRfq.status)} />
                      </p>
                      <DataTable
                        caption="Lines to price"
                        columns={priceColumns}
                        rows={selectedRfq.items}
                        getRowId={(item) => item.line}
                        rowLabel={(item) => `line ${item.line}`}
                      />
                    </div>
                  )}
                </section>
              );
            })()}

            <FormSection title="Quotation header">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 lg:grid-cols-3">
                <FieldCard label="Your quote reference" error={quoteErrors.quoteRef}>
                  <input
                    type="text"
                    maxLength={12}
                    placeholder="QT-2026-001"
                    value={quoteForm.quoteRef}
                    onChange={e => setQuoteForm({ ...quoteForm, quoteRef: e.target.value })}
                    className="mono w-[16ch] max-w-full uppercase"
                  />
                </FieldCard>

                <FieldCard label="Quotation date" required error={quoteErrors.quoteDate}>
                  <input
                    type="date"
                    required
                    value={quoteForm.quoteDate}
                    onChange={e => {
                      setQuoteForm({ ...quoteForm, quoteDate: e.target.value });
                      if (quoteErrors.quoteDate) setQuoteErrors(prev => ({ ...prev, quoteDate: false }));
                    }}
                    className="w-48 max-w-full"
                  />
                </FieldCard>

                <FieldCard label="Validity date" required error={quoteErrors.validityDate}>
                  <input
                    type="date"
                    required
                    value={quoteForm.validityDate}
                    onChange={e => {
                      setQuoteForm({ ...quoteForm, validityDate: e.target.value });
                      if (quoteErrors.validityDate) setQuoteErrors(prev => ({ ...prev, validityDate: false }));
                    }}
                    className="w-48 max-w-full"
                  />
                </FieldCard>
              </div>
            </FormSection>

            {/* Per-line unit price is entered in the line table above; these
                apply to the whole quotation. */}
            <FormSection title="GST and discount">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 lg:grid-cols-3">
                <FieldCard label="GST rate (%)" required error={quoteErrors.gstRate}>
                  <select
                    value={quoteForm.gstRate}
                    onChange={e => {
                      setQuoteForm({ ...quoteForm, gstRate: e.target.value });
                      if (quoteErrors.gstRate) setQuoteErrors(prev => ({ ...prev, gstRate: false }));
                    }}
                    className="w-56 max-w-full"
                  >
                    <option value="18%">18% - G1</option>
                    <option value="12%">12% - G2</option>
                    <option value="5%">5% - G3</option>
                    <option value="28%">28% - G4</option>
                    <option value="Exempt">Exempt - G0</option>
                  </select>
                </FieldCard>

                <FieldCard label="Discount (%)">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    placeholder="0"
                    value={quoteForm.discount}
                    onChange={e => setQuoteForm({ ...quoteForm, discount: e.target.value })}
                    className="mono w-[10ch] max-w-full"
                  />
                </FieldCard>
              </div>
            </FormSection>

            <FormSection title="Delivery terms">
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 lg:grid-cols-3">
                <FieldCard label="Delivery lead time (days)" required error={quoteErrors.deliveryLeadTime}>
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
                    className="mono w-[10ch] max-w-full"
                  />
                </FieldCard>

                <FieldCard label="Freight / packing (₹)">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={quoteForm.freight}
                    onChange={e => setQuoteForm({ ...quoteForm, freight: e.target.value })}
                    className="mono w-[14ch] max-w-full"
                  />
                </FieldCard>

                <FieldCard label="Incoterms">
                  <select
                    value={quoteForm.incoterms}
                    onChange={e => setQuoteForm({ ...quoteForm, incoterms: e.target.value })}
                    className="w-56 max-w-full"
                  >
                    <option value="EXW">EXW - Ex Works</option>
                    <option value="FOB">FOB - Free on Board</option>
                    <option value="CIF">CIF - Cost, Insurance &amp; Freight</option>
                    <option value="FOR">FOR - Free on Rail</option>
                    <option value="DDP">DDP - Delivered Duty Paid</option>
                  </select>
                </FieldCard>
              </div>
            </FormSection>

            {/* Sticky action bar: the one primary action on this tab. */}
            <div className="sticky bottom-0 z-20 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-canvas px-4 py-3 md:-mx-6 md:px-6">
              <p className="mr-auto hidden text-sm text-fg-muted sm:block">Your buyer sees the quotation as soon as you submit it.</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  try {
                    localStorage.setItem(QUOTE_DRAFT_KEY, JSON.stringify({ quoteForm }));
                    addToast('success', 'Quotation draft saved. It will be restored next time you open this form.');
                  } catch (e) {
                    addToast('error', 'Failed to save quotation draft.');
                  }
                }}
              >
                Save draft
              </Button>
              <Button type="submit">Submit quotation</Button>
            </div>
          </form>
        )
      )}

      {/* UPDATE PRICE (ME47) MODAL — pushes a net price to a SAP-native
          quotation document, sourced from a portal RFQ's own line items. */}
      <Modal
        open={!!priceUpdateDoc}
        onClose={closePriceUpdate}
        title={`Update price — ${priceUpdateDoc?.documentNumber || ''}`}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={closePriceUpdate} disabled={priceUpdateLoading}>
              Cancel
            </Button>
            <Button
              type="button"
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
          {(() => {
            const candidates = priceUpdateCandidates(priceUpdateDoc);
            if (!candidates.length) {
              return (
                <p className="flex items-start gap-2 text-sm text-danger">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <span>
                    No RFQ in this workspace is matched to SAP document {priceUpdateDoc?.documentNumber} — there is
                    nothing to price yet. This document may not have been discovered as a portal RFQ (or was
                    discovered on an earlier sweep before an SAP correlation existed).
                  </span>
                </p>
              );
            }
            return (
              <>
                <p className="text-sm text-fg-muted">
                  Line items below are RFQ {candidates[0].id}&rsquo;s own — the one SAP has matched to this document
                  ({priceUpdateDoc?.documentNumber}). Enter the net price per line to send to your buyer&rsquo;s system.
                </p>
                {/* Restricted to the matching RFQ(s) only — see priceUpdateCandidates
                    above for why this can no longer be any RFQ in the workspace. A
                    document with more than one match (shouldn't happen; sapDocNumber
                    is meant to be unique per document) still lets a human pick, rather
                    than silently guessing one. */}
                {candidates.length > 1 && (
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-fg" htmlFor="quote-linked-rfq">Linked RFQ</label>
                    <select id="quote-linked-rfq"
                      value={priceUpdateRfqId}
                      onChange={(e) => handlePriceUpdateRfqChange(e.target.value)}
                      className="w-full"
                      disabled={priceUpdateLoading}
                    >
                      <option value="">Choose an RFQ…</option>
                      {candidates.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id} - {r.description}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            );
          })()}

          {priceUpdateRfq && (
            <DataTable
              caption="Net price per line"
              columns={[
                { key: 'line', header: 'Line', mono: true, primary: true },
                { key: 'materialCode', header: 'Item code', render: (item) => <span className="mono">{item.materialCode}</span> },
                {
                  key: 'netPrice',
                  header: 'Net price (₹)',
                  align: 'right',
                  render: (item) => (
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      aria-label={`Net price (₹) for line ${item.line}`}
                      value={priceUpdatePrices[item.line] ?? ''}
                      onChange={(e) =>
                        setPriceUpdatePrices((prev) => ({ ...prev, [item.line]: e.target.value }))
                      }
                      disabled={priceUpdateLoading}
                      className="mono w-[12ch]! min-h-8! py-1! text-right"
                    />
                  ),
                },
              ]}
              rows={priceUpdateRfq.items}
              getRowId={(item) => item.line}
              rowLabel={(item) => `line ${item.line}`}
            />
          )}
        </div>
      </Modal>

      </div>
    </ErrorBoundary>
  );
}
