'use client';

import React, { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, ShieldAlert, Eye, EyeOff, FileText, ExternalLink } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import DeclineSupplier from '@/features/profile/components/DeclineSupplier';

// One supplier, in full: who they are, what they registered with, what this
// workspace has agreed to pay them on, and how much trading has actually
// happened. The directory answers "who is waiting on a decision"; this answers
// everything somebody needs before taking that decision, and everything they
// want afterwards.
//
// Read-only by design. A supplier's own details are theirs to change — the
// portal's registration form is the one place they are edited — so nothing here
// offers to overwrite them. The only actions are the decision itself.

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(Number(value || 0));

const yesNo = (value) => (value === true ? 'Yes' : value === false ? 'No' : null);

// A definition list is the right shape for a profile — label above value,
// wrapping into as many columns as the space allows. Empty fields still show,
// as an em dash: "we do not have this" is information a reviewer needs.
function Facts({ rows, columns = 'md:grid-cols-3' }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] ${columns}`}>
      {rows.map(([label, value, options]) => (
        <div key={label}>
          <dt className="label mb-0.5">{label}</dt>
          <dd className={`text-text-primary ${options?.plain ? '' : 'mono'} break-words`}>
            {value === null || value === undefined || value === '' ? '—' : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, action, children }) {
  return (
    <section className="card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// A bank account number is the one field on this page that is worth hiding by
// default. Tenant staff are entitled to it — it is already in the directory
// payload — but this screen gets shown in review meetings and on shared
// screens, and an account number does not need to be on every one of them.
function AccountNumber({ value }) {
  const [shown, setShown] = useState(false);
  if (!value) return '—';

  return (
    <span className="inline-flex items-center gap-2">
      <span className="mono">{shown ? value : `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`}</span>
      <button
        type="button"
        onClick={() => setShown((current) => !current)}
        className="text-text-tertiary hover:text-text-primary"
        aria-label={shown ? 'Hide the account number' : 'Show the account number'}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </span>
  );
}

// The compliance documents are stored as whatever the uploads API returned, so
// a record may carry a full { originalName, url } or, on an older row, a bare
// id. Both are handled: a link when there is somewhere to go, the filename
// alone when there is not.
function DocumentRow({ label, document: file }) {
  const name = file?.originalName || (typeof file === 'string' ? file : null);
  const href = file?.url || null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <span className="flex items-center gap-2 text-[13px] text-text-secondary">
        <FileText className="size-3.5 text-text-tertiary" /> {label}
      </span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 mono text-[12px] text-text-primary hover:underline">
          {name || 'View'} <ExternalLink className="size-3" />
        </a>
      ) : (
        <span className="mono text-[12px] text-text-tertiary">{name || 'Not provided'}</span>
      )}
    </div>
  );
}

function Verification({ label, verified }) {
  const Icon = verified ? ShieldCheck : ShieldAlert;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${verified ? 'text-emerald-600' : 'text-amber-600'}`}>
      <Icon className="size-3.5" /> {label} {verified ? 'verified' : 'not verified'}
    </span>
  );
}

export default function SupplierDetailPage({ params }) {
  const { id } = use(params);
  const { can } = useWorkspaceSession();
  const { data, error, loading, reload, setError } = useResource(() => apiClient.get(`/vendors/${id}`), id);

  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);

  if (loading) return <Loading label="Loading the supplier" />;
  if (!data) return <Notice tone="error">{error || 'That supplier could not be loaded.'}</Notice>;

  const { vendor, activity, recentOrders, awaitingDecision } = data;
  const currency = vendor.currency || 'INR';

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      await apiClient.put(`/vendors/${vendor.pk}/approve`, {});
      setDone(`${vendor.companyName} was approved and issued a supplier ID.`);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Link href="/workspace/suppliers" className="mb-3 inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-primary">
        <ArrowLeft className="size-3.5" /> All suppliers
      </Link>

      <PageHeader
        title={vendor.companyName}
        caption={`${vendor.vendorId} · ${vendor.email}${vendor.submittedAt ? ` · submitted ${formatDate(vendor.submittedAt)}` : ''}`}
      >
        <Status value={vendor.status} />
        {can('vendor:approve') && awaitingDecision && (
          <>
            <button type="button" className="btn btn-v h-8" onClick={approve} disabled={busy}>Approve</button>
            <button type="button" className="btn btn-o h-8" onClick={() => setDeclining(true)} disabled={busy}>Decline</button>
          </>
        )}
      </PageHeader>

      <Notice tone="success" onDismiss={() => setDone('')}>{done}</Notice>
      <Notice onDismiss={() => setError('')}>{error}</Notice>

      {vendor.status === 'Rejected' && vendor.rejectionReason && (
        <Notice tone="error">Declined: {vendor.rejectionReason}</Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title="Registration">
            <Facts rows={[
              ['Legal name', vendor.companyName, { plain: true }],
              ['Trading as', vendor.tradeName, { plain: true }],
              ['Business type', vendor.businessType, { plain: true }],
              ['Incorporated', vendor.incorporationDate],
              ['GSTIN', vendor.gstin],
              ['GST registration type', vendor.gstType, { plain: true }],
              ['PAN', vendor.pan],
              ['CIN', vendor.cin],
              ['MSME number', vendor.msmeNumber],
              ['TDS section', vendor.tdsSection],
              ['Category', vendor.vendorCategory, { plain: true }],
              ['SAP vendor code', vendor.sapVendorCode],
            ]} />
          </Section>

          <Section title="Contact and address">
            <Facts rows={[
              ['Email', vendor.email],
              ['Phone', vendor.phone],
              ['Address', vendor.address, { plain: true }],
              ['City', vendor.city, { plain: true }],
              // Older records wrote a free-text state; newer ones write a
              // country-scoped region code. Both are shown rather than one
              // being presented as the truth.
              ['Region', vendor.region || vendor.state, { plain: true }],
              ['Country', vendor.country, { plain: true }],
              ['Postal code', vendor.postalCode],
            ]} />
          </Section>

          <Section title="Purchasing and payment terms">
            <Facts rows={[
              ['Payment terms', vendor.paymentTerms, { plain: true }],
              ['Payment method', vendor.paymentMethod, { plain: true }],
              ['Currency', vendor.currency],
              ['Incoterms', [vendor.incoterms1, vendor.incoterms2].filter(Boolean).join(' · '), { plain: true }],
              ['Duplicate invoice check', yesNo(vendor.doubleInvoiceCheck), { plain: true }],
              ['GR-based invoice verification', yesNo(vendor.grBasedInvoiceVerification), { plain: true }],
            ]} />
          </Section>

          <Section title="Banking">
            <Facts columns="md:grid-cols-3" rows={[
              ['Bank', vendor.bankDetails?.bankName, { plain: true }],
              ['Branch', vendor.bankDetails?.branch, { plain: true }],
              ['Account holder', vendor.bankDetails?.accountName, { plain: true }],
              ['Account number', <AccountNumber key="acct" value={vendor.bankDetails?.accountNumber} />, { plain: true }],
              ['IFSC', vendor.bankDetails?.ifscCode],
            ]} />
          </Section>

          <Section title="Recent purchase orders">
            <Table
              columns={[
                { key: 'id', header: 'Order', render: (row) => <span className="mono">{row.sapPoNumber || row.id}</span> },
                { key: 'createdDate', header: 'Raised', render: (row) => <span className="mono text-[11px]">{formatDate(row.createdDate)}</span> },
                { key: 'lines', header: 'Lines' },
                { key: 'value', header: 'Value', render: (row) => <span className="mono">{money(row.value, row.currency || currency)}</span> },
                { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              ]}
              rows={(recentOrders || []).map((order) => ({ ...order, key: order.id }))}
              empty="This supplier has no purchase orders yet."
            />
          </Section>
        </div>

        <div className="space-y-5">
          <Section title="Compliance">
            <div className="mb-3 flex flex-col gap-1.5">
              <Verification label="GSTIN" verified={vendor.gstinVerified} />
              <Verification label="PAN" verified={vendor.panVerified} />
              {vendor.verifiedAt && (
                <span className="mono text-[11px] text-text-tertiary">Checked {formatDate(vendor.verifiedAt)}</span>
              )}
            </div>
            <DocumentRow label="GST certificate" document={vendor.gstCertificate} />
            <DocumentRow label="PAN card" document={vendor.panCardCopy} />
            <DocumentRow label="Cancelled cheque" document={vendor.cancelledCheque} />
            <DocumentRow label="MSME certificate" document={vendor.msmeCertificate} />
          </Section>

          <Section title="Trading history">
            <dl className="space-y-1.5 text-[13px]">
              {[
                ['RFQs invited to', activity.rfqInvitations],
                ['Purchase orders', activity.purchaseOrders.total],
                ['Ordered value', money(activity.purchaseOrders.value, currency)],
                ['Shipments notified', activity.shipments],
                ['Goods receipts', activity.goodsReceipts],
                ['Invoices', activity.invoices.total],
                ['Invoiced value', money(activity.invoices.value, currency)],
                ['Payments', activity.payments.total],
                ['Paid (net of TDS)', money(activity.payments.netPaid, currency)],
                ['TDS deducted', money(activity.payments.tdsDeducted, currency)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 border-b border-border pb-1.5 last:border-0">
                  <dt className="text-text-secondary">{label}</dt>
                  <dd className="mono">{value}</dd>
                </div>
              ))}
            </dl>
          </Section>

          {Object.keys(activity.purchaseOrders.byStatus || {}).length > 0 && (
            <Section title="Orders by status">
              <dl className="space-y-1.5 text-[13px]">
                {Object.entries(activity.purchaseOrders.byStatus).map(([status, row]) => (
                  <div key={status} className="flex items-center justify-between gap-3 border-b border-border pb-1.5 last:border-0">
                    <dt><Status value={status} /></dt>
                    <dd className="mono">{row.count} · {money(row.value, currency)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          <Section title="Account">
            <Facts columns="md:grid-cols-1" rows={[
              ['Registered', formatDate(vendor.createdAt)],
              ['Submitted for approval', formatDate(vendor.submittedAt)],
              ['Approved', formatDate(vendor.approvedAt)],
              ['Last updated', formatDate(vendor.updatedAt)],
            ]} />
          </Section>
        </div>
      </div>

      {declining && (
        <DeclineSupplier
          supplier={vendor}
          onClose={() => setDeclining(false)}
          onDone={(message) => { setDeclining(false); setDone(message); reload(); }}
        />
      )}
    </div>
  );
}
