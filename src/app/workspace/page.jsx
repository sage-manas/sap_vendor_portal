'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Loading, useResource } from '@/components/console/primitives';
import Card, { Section } from '@/components/ui/Card';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';

// The tenant overview: what needs a decision today, measured against the
// thresholds this workspace set for itself. Every number is a link to the
// screen that acts on it — a count with nowhere to go is a decoration.

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// One row of "Needs a decision": the count, what it means, and where to act.
const Task = ({ count, children, href, cta }) => (
  <li>
    <Link href={href} className="group flex items-center gap-3 rounded-tile bg-surface px-4 py-3 transition-colors hover:bg-subtle">
      <span className="mono w-10 shrink-0 text-right text-lg text-fg">{count}</span>
      <span className="min-w-0 flex-1 text-sm text-fg">{children}</span>
      <span className="flex shrink-0 items-center gap-1 text-sm text-accent-text">
        {cta} <ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
      </span>
    </Link>
  </li>
);

export default function WorkspaceOverviewPage() {
  const { workspace, can } = useWorkspaceSession();
  const { data, error, loading } = useResource(() => apiClient.get('/workspace/overview'));

  if (loading) return <Loading label="Loading the workspace" />;

  const tasks = data ? [
    data.suppliers.awaitingDecision > 0 && (
      <Task key="review" count={data.suppliers.awaitingDecision} href="/workspace/suppliers?status=Under+Review" cta="Review">
        Supplier registration{data.suppliers.awaitingDecision === 1 ? '' : 's'} waiting on your decision
        {data.suppliers.overdueDecision > 0 && (
          <span className="text-danger"> · {data.suppliers.overdueDecision} past the {data.thresholds.supplierApprovalSlaHours}h SLA</span>
        )}
      </Task>
    ),
    data.finance.invoicesOverThreshold > 0 && (
      <Task key="invoices" count={data.finance.invoicesOverThreshold} href="/workspace/invoices" cta="Open invoices">
        Invoice{data.finance.invoicesOverThreshold === 1 ? '' : 's'} at or above the {money(data.finance.reviewAmount)} review amount
      </Task>
    ),
  ].filter(Boolean) : [];

  return (
    <>
      <PageHeader
        title={data?.workspace?.companyName || workspace?.companyName || 'Workspace'}
        caption={`${data?.workspace?.plan || '—'} plan · ${data?.workspace?.sapEnvironment || '—'} environment · ${data?.workspace?.clientId || ''}`}
      />

      <Notice tone="error">{error}</Notice>

      {data && (
        <div className="space-y-8">
          {/* What is waiting on you, as the page's one accent card (white
              tiles on the tenant colour). It leads alone: the headline figures
              that used to sit beside it repeated three cards from the strips
              below, word for word, and the strip versions link somewhere. */}
          <Card tone={tasks.length ? 'accent' : 'default'} className="max-w-2xl p-5">
            <h2 className="mb-3 text-lg font-medium">Needs a decision</h2>
            {tasks.length ? (
              <ul className="space-y-2">{tasks}</ul>
            ) : (
              <p className="text-sm text-fg-muted">Nothing is waiting on you.</p>
            )}
          </Card>

          <Section title="Suppliers">
            <KPIStrip>
              <KPICard label="Awaiting a decision" value={data.suppliers.awaitingDecision} hint="Submitted and waiting on you" href="/workspace/suppliers?status=Under+Review" linkLabel="Review" />
              <KPICard
                label="Past the SLA"
                value={data.suppliers.overdueDecision}
                hint={`Older than ${data.thresholds.supplierApprovalSlaHours}h`}
                delta={data.suppliers.overdueDecision > 0 ? 'Overdue' : undefined}
                deltaTone="down"
                href="/workspace/suppliers?status=Under+Review"
                linkLabel="Review"
              />
              <KPICard label="Approved" value={data.suppliers.approved} href="/workspace/suppliers?status=Approved" linkLabel="View" />
              <KPICard
                label="Directory"
                value={data.suppliers.limit ? `${data.suppliers.total} / ${data.suppliers.limit}` : data.suppliers.total}
                hint={data.suppliers.limit ? 'Used against your plan limit' : undefined}
                href="/workspace/suppliers"
                linkLabel="All suppliers"
              />
            </KPIStrip>
          </Section>

          <Section title="Sourcing">
            <KPIStrip>
              <KPICard label="RFQs open for bidding" value={data.sourcing.openRfqs} hint={`${data.sourcing.rfqsTotal} total`} href="/workspace/rfqs?status=Bidding+Open" linkLabel="RFQs" />
              <KPICard label="RFQs awarded" value={data.sourcing.awardedRfqs} href="/workspace/rfqs?status=Awarded" linkLabel="RFQs" />
              <KPICard label="Purchase orders open" value={data.sourcing.openPos} hint={`${data.sourcing.posTotal} total`} href="/workspace/purchase-orders?view=open" linkLabel="Purchase orders" />
              <KPICard label="Purchase orders, all" value={data.sourcing.posTotal} href="/workspace/purchase-orders" linkLabel="Purchase orders" />
            </KPIStrip>
          </Section>

          <Section title="Finance">
            <KPIStrip>
              {/* Each tile links to its list filtered the way the tile is
                  counted (issue #281) — `view=open` is the same INVOICE_OPEN
                  group this endpoint counts, so the list that opens states the
                  number the reader clicked rather than the whole table. */}
              <KPICard label="Invoices not yet cleared" value={data.finance.invoicesOpen} hint={money(data.finance.invoicesOpenValue)} href="/workspace/invoices?view=open" linkLabel="Invoices" />
              <KPICard
                label="Above the review amount"
                value={data.finance.invoicesOverThreshold}
                hint={`At or above ${money(data.finance.reviewAmount)}`}
                delta={data.finance.invoicesOverThreshold > 0 ? 'Needs review' : undefined}
                deltaTone="down"
                href={`/workspace/invoices?view=open&minAmount=${data.finance.reviewAmount}`}
                linkLabel="Invoices"
              />
              <KPICard label="Payments made" value={data.finance.payments.count} hint={money(data.finance.payments.netPaid)} href="/workspace/payments" linkLabel="Payments" />
              <KPICard label="TDS deducted" value={money(data.finance.payments.tdsDeducted)} href="/workspace/payments" linkLabel="Payments" />
            </KPIStrip>
          </Section>

          {/* Staff numbers belong to whoever can act on them; a buyer's link
              would only lead to a 403. */}
          {can('user:read') && (
            <Section title="People">
              <KPIStrip className="max-w-2xl">
                <KPICard label="Active staff" value={data.staff.active} href="/workspace/users" linkLabel="Users" />
                <KPICard label="Invitations outstanding" value={data.staff.pendingInvitations} href="/workspace/users" linkLabel="Users" />
              </KPIStrip>
            </Section>
          )}

          {/* Issue #116: limitStorageMb was settable in the platform console
              and shown nowhere a workspace could see how much of it was
              used. No link — like the platform health board's own Usage
              badges, this is a quota gauge, not a work queue; there is no
              per-document screen in this app to send it to yet. */}
          {data.usage?.storageMb && (
            <Section title="Plan">
              {/* One figure: a card of its own, not a strip with empty cells. */}
              <div className="max-w-sm overflow-hidden rounded-lg border border-border bg-surface">
                <KPICard
                  className="border-0!"
                  label="Storage used"
                  value={data.usage.storageMb.limit
                    ? `${data.usage.storageMb.used} / ${data.usage.storageMb.limit} MB`
                    : `${data.usage.storageMb.used} MB`}
                  delta={data.usage.storageMb.breached ? 'Over your plan limit' : undefined}
                  deltaTone="down"
                  hint={data.usage.storageMb.breached
                    ? undefined
                    : data.usage.storageMb.limit ? 'Used against your plan limit' : 'No storage limit set'}
                />
              </div>
            </Section>
          )}
        </div>
      )}
    </>
  );
}
