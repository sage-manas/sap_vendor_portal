'use client';

import React, { use } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { poService } from '@/features/purchase-order/services/poService';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import InvoicePlanPanel from '@/features/purchase-order/components/InvoicePlanPanel';

// One purchase order, for the buying organisation's own staff. The items and
// status are SAP's record, read only; the invoicing plan is the one thing this
// screen lets a buyer/client_admin (po:manage) actually configure, approve or
// reject — the same InvoicePlanPanel the supplier portal renders for the
// vendor side of the same order, where a supplier may read the schedule and
// propose a change but never write SAP directly (see the panel's own header
// comment: one component, two audiences, the split enforced by `canManage`/
// `canPropose` and mirrored by the API). This page never passes `canPropose`
// — a buyer never holds po:invoice-plan:propose, only po:manage.

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(Number(value || 0));

function Section({ title, children }) {
  return (
    <section className="border-t border-border pt-5">
      <h2 className="mb-4 text-base font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

export default function WorkspacePurchaseOrderPage({ params }) {
  const { id } = use(params);
  const { can } = useWorkspaceSession();
  const { data: po, error, loading } = useResource(() => poService.getPOById(id), id);

  if (loading) return <Loading label="Loading the order" />;
  if (!po) return <Notice tone="error">{error || 'That purchase order could not be loaded.'}</Notice>;

  const currency = po.currency || 'INR';

  return (
    <div>
      <PageHeader
        breadcrumb={(
          <Link href="/workspace/purchase-orders" className="inline-flex items-center gap-1 hover:text-fg">
            <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden="true" /> All purchase orders
          </Link>
        )}
        title={<span className="mono">{po.sapPoNumber || po.id}</span>}
        caption={`${po.vendorId} · raised ${formatDate(po.createdDate)}${po.acknowledgedAt ? ` · acknowledged ${formatDate(po.acknowledgedAt)}` : ''}`}
      >
        <Status value={po.status} />
      </PageHeader>

      <Notice tone="error">{error}</Notice>

      <div className="space-y-8">
        <Section title="Line items">
          <Table
            columns={[
              { key: 'line', header: 'Line' },
              { key: 'materialCode', header: 'Material', render: (row) => (
                <div>
                  <div className="mono">{row.materialCode}</div>
                  <div className="text-xs text-fg-subtle">{row.description}</div>
                </div>
              ) },
              { key: 'quantity', header: 'Ordered', align: 'right', render: (row) => <span className="mono">{row.quantity} {row.uom}</span> },
              { key: 'grnQuantity', header: 'Received', align: 'right', render: (row) => <span className="mono">{row.grnQuantity} {row.uom}</span> },
              { key: 'unitPrice', header: 'Unit price', align: 'right', render: (row) => <span className="mono">{money(row.unitPrice, currency)}</span> },
              { key: 'netValue', header: 'Net value', align: 'right', render: (row) => <span className="mono">{money(row.netValue, currency)}</span> },
            ]}
            rows={(po.items || []).map((item) => ({ ...item, key: item.line }))}
            empty="This order has no line items."
          />
        </Section>

        {/* The panel carries its own "Invoicing plan" heading. */}
        <section className="border-t border-border pt-5">
          <InvoicePlanPanel po={po} canManage={can('po:manage')} />
        </section>
      </div>
    </div>
  );
}
