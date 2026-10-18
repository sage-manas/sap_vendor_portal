'use client';

import React, { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, ShieldAlert, Eye, EyeOff, FileText, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { documentIdOf, openDocument } from '@/lib/open-document';
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
    <dl className={`grid grid-cols-2 gap-x-6 gap-y-3 text-sm ${columns}`}>
      {rows.map(([label, value, options]) => (
        <div key={label} className="min-w-0">
          <dt className="text-fg-muted">{label}</dt>
          <dd className={`mt-0.5 break-words text-fg ${options?.plain ? '' : 'mono'}`}>
            {value === null || value === undefined || value === '' ? '—' : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// A titled group, separated by a rule rather than boxed: a profile is one
// document, not a stack of cards.
function Section({ title, action, children }) {
  return (
    <section className="border-t border-border pt-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
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
// `which` names the account in the toggle's label when a page shows more
// than one ("the current account number", "the requested account number").
function AccountNumber({ value, which = 'the account number' }) {
  const [shown, setShown] = useState(false);
  if (!value) return '—';

  return (
    <span className="inline-flex items-center gap-2">
      <span className="mono">{shown ? value : `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`}</span>
      <button
        type="button"
        onClick={() => setShown((current) => !current)}
        className="cursor-pointer rounded p-0.5 text-fg-subtle hover:text-fg"
        aria-label={`${shown ? 'Hide' : 'Show'} ${which}`}
      >
        {shown ? <EyeOff className="size-4" strokeWidth={1.5} /> : <Eye className="size-4" strokeWidth={1.5} />}
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
  const canOpen = Boolean(documentIdOf(file));
  const [error, setError] = useState('');

  // The file sits behind the session, so it opens through a signed link the API
  // issues on demand (lib/open-document.js), not a bare href.
  const open = async () => {
    setError('');
    try {
      await openDocument(file);
    } catch (err) {
      setError(err.message || 'Could not open this document.');
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm last:border-0">
      <span className="flex items-center gap-2 text-fg-muted">
        <FileText className="size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" /> {label}
      </span>
      {canOpen ? (
        <span className="flex flex-col items-end gap-0.5">
          <button type="button" onClick={open} className="inline-flex max-w-56 cursor-pointer items-center gap-1.5 text-accent-text hover:underline">
            <span className="truncate">{name || 'View'}</span> <ExternalLink className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          </button>
          {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        </span>
      ) : (
        <span className="text-fg-subtle">{name || 'Not provided'}</span>
      )}
    </div>
  );
}

// A supplier's request to change their payout account. SAP pays from its own
// vendor master, so an approval is only complete once SAP holds the new
// account: while the tenant's SAP can't take the change automatically, an
// approved request waits here for someone to confirm it was entered in SAP
// (XK02), and the Banking facts above keep showing the account SAP pays.
function PendingBankChange({ vendor, canDecide, onDone, onError }) {
  const change = vendor.pendingBankChange;
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  if (!change) return null;

  const awaitingSap = Boolean(change.sapApproval);
  const current = vendor.bankDetails || {};

  const act = async (path, body, fallback) => {
    setBusy(true);
    onError('');
    try {
      const res = await apiClient.put(`/vendors/${vendor.pk}/bank-change/${path}`, body || {});
      await onDone(res?.message || fallback);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`mt-5 rounded-lg border p-4 ${awaitingSap ? 'border-info/30 bg-info-tint' : 'border-warning/30 bg-warning-tint'}`}>
      <p className="text-sm font-medium text-fg">
        {awaitingSap ? 'Bank change approved — waiting to be updated in SAP' : 'Bank change requested by the supplier'}
      </p>
      <p className="mt-1 text-sm text-fg-muted">
        {awaitingSap
          ? `Approved by ${change.sapApproval.approvedBy || 'a reviewer'} on ${formatDate(change.sapApproval.approvedAt)}. Update vendor ${vendor.sapVendorCode}'s bank details in SAP (XK02), then confirm here. Until then SAP keeps paying the current account, and payments to this supplier stay blocked.`
          : `Requested ${formatDate(change.requestedAt)}. Verify it with the supplier through a channel you already trust before approving. Payments to this supplier are blocked until this is decided.`}
      </p>

      {/* Current beside requested, so a reviewer sees exactly what moves. */}
      <div className="mt-4 overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Current and requested bank details</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Current — what SAP pays</th>
              <th scope="col">Requested</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Bank', current.bankName, change.bankName],
              ['Branch', current.branch, change.bankBranch],
              ['Account holder', current.accountName, change.accountName],
              ['Account number', current.accountNumber, change.accountNumber, true],
              ['IFSC', current.ifscCode, change.ifscCode],
            ].map(([label, before, after, secret]) => {
              const changed = (before || '') !== (after || '');
              return (
                <tr key={label}>
                  <th scope="row" className="font-normal text-fg-muted">{label}</th>
                  <td className="text-fg-muted">{secret ? <AccountNumber value={before} which="the current account number" /> : (before || '—')}</td>
                  <td className={changed ? 'font-medium text-fg' : 'text-fg-muted'}>
                    {secret ? <AccountNumber value={after} which="the requested account number" /> : (after || '—')}
                    {changed && <span className="ml-2 text-xs font-normal text-warning">changed</span>}
                    {/* Both masks end in the same four digits: say so, or the
                        two cells read as identical. */}
                    {changed && secret && (before || '').slice(-4) === (after || '').slice(-4) && (
                      <span className="block text-xs font-normal text-fg-muted">Same last four digits — show both to compare</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canDecide && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {awaitingSap ? (
            <Button size="sm" disabled={busy}
              onClick={() => act('confirm-sap', null, 'Confirmed. The portal now shows the account SAP pays.')}>
              Confirm updated in SAP
            </Button>
          ) : (
            <Button size="sm" disabled={busy}
              onClick={() => act('approve', null, 'Bank account change approved.')}>
              Approve change
            </Button>
          )}
          {rejecting ? (
            <>
              <input
                className="h-7! min-h-7! min-w-0 flex-1 py-0.5! text-sm"
                placeholder="Reason (shared in the audit log)"
                aria-label="Reason for rejecting the bank change"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => act('reject', { reason }, 'Bank account change rejected.')}>
                Reject change
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting(true)}>
              {awaitingSap ? 'Withdraw approval' : 'Reject'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Verification({ label, verified }) {
  const Icon = verified ? ShieldCheck : ShieldAlert;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg">
      <Icon className={`size-4 ${verified ? 'text-success' : 'text-warning'}`} strokeWidth={1.5} aria-hidden="true" /> {label} {verified ? 'verified' : 'not verified'}
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
      <PageHeader
        breadcrumb={(
          <Link href="/workspace/suppliers" className="inline-flex items-center gap-1 hover:text-fg">
            <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden="true" /> All suppliers
          </Link>
        )}
        title={vendor.companyName}
        caption={`${vendor.vendorId} · ${vendor.email}${vendor.submittedAt ? ` · submitted ${formatDate(vendor.submittedAt)}` : ''}`}
      >
        <Status value={vendor.status} />
        {can('vendor:approve') && awaitingDecision && (
          <>
            <Button variant="secondary" onClick={() => setDeclining(true)} disabled={busy}>Decline</Button>
            <Button onClick={approve} disabled={busy}>Approve</Button>
          </>
        )}
      </PageHeader>

      <Notice tone="success" onDismiss={() => setDone('')}>{done}</Notice>
      <Notice onDismiss={() => setError('')}>{error}</Notice>

      {vendor.status === 'Rejected' && vendor.rejectionReason && (
        <Notice tone="error">Declined: {vendor.rejectionReason}</Notice>
      )}

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-3">
        <div className="space-y-8 lg:col-span-2">
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
              // SAP region code (e.g. "13"), resolved server-side to a display
              // name (regionLabel) against the same catalogue the registration
              // form's dropdown uses. Falls back to the raw code if the
              // catalogue lookup ever comes back empty, rather than hiding it.
              ['Region', vendor.regionLabel || vendor.region || vendor.state, { plain: true }],
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
            <PendingBankChange
              vendor={vendor}
              canDecide={can('vendor:approve')}
              onError={setError}
              onDone={async (message) => { setDone(message); await reload(); }}
            />
          </Section>

          <Section title="Recent purchase orders">
            <Table
              columns={[
                { key: 'id', header: 'Order', render: (row) => <span className="mono">{row.sapPoNumber || row.id}</span> },
                { key: 'createdDate', header: 'Raised', render: (row) => formatDate(row.createdDate) },
                { key: 'lines', header: 'Lines', align: 'right' },
                { key: 'value', header: 'Value', align: 'right', render: (row) => <span className="mono">{money(row.value, row.currency || currency)}</span> },
                { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              ]}
              rows={(recentOrders || []).map((order) => ({ ...order, key: order.id }))}
              empty="This supplier has no purchase orders yet."
            />
          </Section>
        </div>

        <div className="space-y-8">
          <Section title="Compliance">
            <div className="mb-3 flex flex-col gap-1.5">
              <Verification label="GSTIN" verified={vendor.gstinVerified} />
              <Verification label="PAN" verified={vendor.panVerified} />
              {vendor.verifiedAt && (
                <span className="text-xs text-fg-subtle">Checked {formatDate(vendor.verifiedAt)}</span>
              )}
            </div>
            <DocumentRow label="GST certificate" document={vendor.gstCertificate} />
            <DocumentRow label="PAN card" document={vendor.panCardCopy} />
            <DocumentRow label="Cancelled cheque" document={vendor.cancelledCheque} />
            <DocumentRow label="MSME certificate" document={vendor.msmeCertificate} />
          </Section>

          <Section title="Trading history">
            <dl className="text-sm">
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
                <div key={label} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
                  <dt className="text-fg-muted">{label}</dt>
                  <dd className="mono">{value}</dd>
                </div>
              ))}
            </dl>
          </Section>

          {Object.keys(activity.purchaseOrders.byStatus || {}).length > 0 && (
            <Section title="Orders by status">
              <dl className="text-sm">
                {Object.entries(activity.purchaseOrders.byStatus).map(([status, row]) => (
                  <div key={status} className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
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
