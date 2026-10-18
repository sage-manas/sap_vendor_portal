'use client';

import { useState } from 'react';
import { Download, FileText, Inbox, Plus, Search, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/ui/StatusBadge';
import KPICard, { KPIStrip, Sparkline } from '@/components/ui/KPICard';
import Card, { CardHeader, Section } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Page';
import EmptyState from '@/components/ui/EmptyState';
import FieldCard from '@/components/ui/FieldCard';
import Modal from '@/components/ui/Modal';
import Drawer from '@/components/ui/Drawer';
import Spinner from '@/components/ui/Spinner';
import TableSkeleton from '@/components/ui/TableSkeleton';
import DataTable, { ColumnsMenu } from '@/components/ui/DataTable';
import { Avatar, Checkbox, DropdownMenu, Meter, Pagination, SegmentedControl, Switch, TabPanel, Tabs, Tooltip } from '@/components/ui/controls';
import { Notice } from '@/components/console/primitives';
import { TONE_CLASS } from '@/components/ui/status';

const ROWS = [
  { id: 'PO-2026-0080', material: 'Steel pipe 3" SCH40', plant: 'Chakan Works', due: '24 Oct 2026', value: '5,64,000.00', status: 'Open' },
  { id: 'PO-2026-0079', material: 'Gasket 3" non-asbestos', plant: 'Chakan Works', due: '22 Oct 2026', value: '41,250.00', status: 'Open' },
  { id: 'PO-2026-0077', material: 'Flange WN 4" #150', plant: 'Ranjangaon', due: '19 Oct 2026', value: '1,18,400.00', status: 'Dispatched' },
  { id: 'PO-2026-0074', material: 'Ball valve 2" CF8M', plant: 'Chakan Works', due: '12 Oct 2026', value: '2,07,936.50', status: 'Delivered' },
  { id: 'PO-2026-0071', material: 'Elbow 90° LR 3"', plant: 'Ranjangaon', due: '08 Oct 2026', value: '36,880.00', status: 'Invoiced' },
  { id: 'PO-2026-0068', material: 'Stud bolt M16×90', plant: 'Chakan Works', due: '30 Sep 2026', value: '9,412.80', status: 'Match Warning' },
  { id: 'PO-2026-0066', material: 'Reducer conc. 4"×3"', plant: 'Ranjangaon', due: '27 Sep 2026', value: '58,100.00', status: 'Paid' },
  { id: 'PO-2026-0063', material: 'Pipe support clamp', plant: 'Chakan Works', due: '21 Sep 2026', value: '12,045.00', status: 'Cancelled' },
];

const COLUMNS = [
  { key: 'id', header: 'Order', mono: true, primary: true, sortable: true },
  { key: 'material', header: 'Material' },
  { key: 'plant', header: 'Plant' },
  { key: 'due', header: 'Delivery', sortable: true },
  { key: 'value', header: 'Value (₹)', align: 'right', mono: true, sortable: true },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge label={r.status} /> },
];

const SAMPLE_STATUSES = [
  ['action', ['Open', 'Bidding Open', 'Under Review']],
  ['warn', ['Match Warning', 'needs_manual_match', 'Degraded']],
  ['danger', ['Failed', 'Rejected', 'QC Discrepancy', 'Overdue']],
  ['progress', ['Acknowledged', 'Dispatched', 'Submitted', 'Trial']],
  ['done', ['Delivered', 'Cleared', 'Paid', 'Approved', 'Synced']],
  ['neutral', ['Draft', 'Pending', 'Local', 'Invited']],
  ['ended', ['Cancelled', 'Closed', 'Terminated', 'Expired']],
];

function Block({ title, children }) {
  return (
    <section className="border-t border-border pt-5 mt-8 first:mt-0 first:border-0 first:pt-0">
      <h2 className="mb-4 text-sm font-medium text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}

function Bed({ themeName }) {
  const [sort, setSort] = useState({ key: 'due', dir: 'desc' });
  const [selected, setSelected] = useState(['PO-2026-0080', 'PO-2026-0079']);
  const [hidden, setHidden] = useState([]);
  const [seg, setSeg] = useState('comfortable');
  const [sw, setSw] = useState(true);
  const [cb, setCb] = useState(true);
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [page, setPage] = useState(1);

  return (
    <div className="min-w-0 bg-canvas p-5 text-fg">
      <p className="mb-5 mono text-xs text-fg-subtle">{themeName}</p>

      <Block title="Page header">
        <PageHeader
          breadcrumb="Nucleus Manufacturing Pvt Ltd"
          title="Purchase orders"
          description="Acknowledge new orders, send shipment notices, and track what your buyer has received."
          secondary={<DropdownMenu items={[{ label: 'Export CSV', icon: Download }, { label: 'Print' }, 'separator', { label: 'Archive', destructive: true }]} />}
          primary={<Button><Plus />New shipment notice</Button>}
        />
      </Block>

      <Block title="Type scale — 12 / 13 / 14 / 16 / 20 / 24 / 32">
        <div className="space-y-1">
          <p className="text-3xl font-semibold tracking-[-0.02em]">32 · Display</p>
          <p className="text-2xl font-semibold tracking-[-0.015em]">24 · Page title</p>
          <p className="text-xl font-semibold">20 · Section</p>
          <p className="text-lg font-semibold">16 · Card title</p>
          <p className="text-[14px] leading-5">14 · Body — the base size for dense UI.</p>
          <p className="text-sm text-fg-muted">13 · Secondary text, table cells, labels</p>
          <p className="text-xs text-fg-subtle">12 · Captions, helper text, table headers</p>
          <p className="text-sm">Mono only for <span className="mono">PO-2026-0080</span>, <span className="mono">27AACCM4519R1ZK</span> and <span className="mono">₹1,00,000.00</span>.</p>
        </div>
      </Block>

      <Block title="Buttons">
        <div className="grid grid-cols-[88px_repeat(4,max-content)] items-center gap-x-4 gap-y-3 overflow-x-auto text-xs text-fg-subtle">
          <span /> <span>Default</span><span>Disabled</span><span>Loading</span><span>Icon</span>
          {[['primary', 'Submit invoice'], ['secondary', 'Export CSV'], ['ghost', 'Cancel'], ['destructive', 'Reject bid'], ['link', 'View order']].map(([v, l]) => (
            <div key={v} className="contents">
              <span>{v}</span>
              <Button variant={v}>{l}</Button>
              <Button variant={v} disabled>{l}</Button>
              <Button variant={v} loading>{l}</Button>
              {v === 'link' ? <span /> : <Button variant={v} size="icon" aria-label="Add"><Plus /></Button>}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button><Button>Medium</Button><Button size="lg">Large</Button>
          <Button variant="secondary"><Download />With icon</Button>
          <span className="text-xs text-fg-subtle">Tab to see the 2px focus ring.</span>
        </div>
      </Block>

      <Block title="Form controls">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldCard label="Invoice number" hint="As printed on your tax invoice." required>
            <input type="text" defaultValue="MC/2026-27/0151" />
          </FieldCard>
          <FieldCard label="Invoice date">
            <input type="date" defaultValue="2026-10-16" />
          </FieldCard>
          <FieldCard label="GSTIN" error="GSTIN must be 15 characters — this one has 14.">
            <input type="text" className="mono" defaultValue="27AACCM4519R1Z" />
          </FieldCard>
          <FieldCard label="Purchase order" hint="Fixed by the goods receipt.">
            <input type="text" className="mono" defaultValue="PO-2026-0074" disabled />
          </FieldCard>
          <FieldCard label="Plant">
            <select defaultValue="1000"><option value="1000">1000 — Chakan Works</option><option value="2000">2000 — Ranjangaon</option></select>
          </FieldCard>
          <FieldCard label="Taxable value (₹)">
            <input type="text" className="mono text-right" defaultValue="4,07,936.50" />
          </FieldCard>
          <FieldCard label="Remarks" className="sm:col-span-2">
            <textarea placeholder="Anything your buyer should know about this delivery" />
          </FieldCard>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-6 text-sm">
          <label className="flex items-center gap-2"><Checkbox checked={cb} onCheckedChange={setCb} aria-label="Include TDS" /> Include TDS</label>
          <label className="flex items-center gap-2"><Checkbox indeterminate aria-label="Some lines" /> Some lines</label>
          <label className="flex items-center gap-2"><Checkbox disabled aria-label="Disabled" /> Disabled</label>
          <label className="flex items-center gap-2"><Switch checked={sw} onCheckedChange={setSw} aria-label="Email me" /> Email me on payment</label>
          <label className="flex items-center gap-2"><input type="radio" name={`r-${themeName}`} defaultChecked /> NEFT</label>
          <label className="flex items-center gap-2"><input type="radio" name={`r-${themeName}`} /> RTGS</label>
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} />
            <input type="search" placeholder="PO number or material" className="pl-8!" aria-label="Search" />
          </div>
        </div>
      </Block>

      <Block title="Status — dot + label; fill only where someone must act">
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          {SAMPLE_STATUSES.map(([tone, labels]) => (
            <div key={tone}>
              <p className="mb-2 text-xs text-fg-subtle">{tone} <span className="mono">.{TONE_CLASS[tone]}</span></p>
              <div className="flex flex-col items-start gap-2">{labels.map((l) => <StatusBadge key={l} label={l} />)}</div>
            </div>
          ))}
        </div>
      </Block>

      <Block title="KPI strip — zeros are muted">
        <KPIStrip>
          <KPICard label="Open orders" value="12" hint="5 need acknowledgement" />
          <KPICard label="To invoice" value={<span className="mono">₹4,07,936.50</span>} hint="3 goods receipts" />
          <KPICard label="Awaiting payment" value="₹0" hint="Nothing outstanding" />
          <KPICard label="Supplier score" value={<>78 <span className="text-sm font-medium text-fg-muted">/ 100 · C</span></>} spark={<Sparkline points={[70, 72, 69, 74, 73, 77, 78]} label="Score, last 7 months" />} />
        </KPIStrip>
      </Block>

      <Block title="Tabs, segmented control, pagination">
        <Tabs aria-label="Order views" items={[{ value: 'ack', label: 'Needs acknowledgement', count: 5 }, { value: 'del', label: 'In delivery', count: 4 }, { value: 'done', label: 'Completed', count: 31 }]}>
          <TabPanel value="ack"><p className="text-sm text-fg-muted">Panel: needs acknowledgement</p></TabPanel>
          <TabPanel value="del"><p className="text-sm text-fg-muted">Panel: in delivery</p></TabPanel>
          <TabPanel value="done"><p className="text-sm text-fg-muted">Panel: completed</p></TabPanel>
        </Tabs>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <SegmentedControl aria-label="Density" value={seg} onChange={setSeg} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          <Tooltip content="Last synced with SAP at 14:32"><button type="button" className="btn btn-o">Hover for tooltip</button></Tooltip>
          <Avatar name="Asha Rao" /> <Avatar name="Kabir Anand" size={24} />
        </div>
      </Block>

      <Block title="Data table">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex-1 text-sm text-fg-muted">{selected.length} selected</span>
          <ColumnsMenu columns={COLUMNS} hidden={hidden} onHiddenChange={setHidden} />
          <Button variant="secondary" size="sm" disabled={!selected.length}>Acknowledge {selected.length || ''}</Button>
        </div>
        <DataTable
          caption="Purchase orders"
          columns={COLUMNS}
          rows={ROWS}
          density={seg}
          sort={sort}
          onSortChange={setSort}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          hiddenColumns={hidden}
          onRowClick={() => setDrawer(true)}
          rowLabel={(r) => r.id}
          inlineActions={(r) => (r.status === 'Open' ? <Button variant="ghost" size="sm">Acknowledge</Button> : null)}
          rowActions={() => [{ label: 'Open order' }, { label: 'Download PDF', icon: FileText }, 'separator', { label: 'Report a problem', destructive: true }]}
          totals={{ label: '8 orders', value: '10,48,024.80' }}
        />
        <Pagination page={page} pageCount={5} total={40} pageSize={8} onPageChange={setPage} />
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <DataTable caption="Empty" columns={COLUMNS.slice(0, 4)} rows={[]} empty={<>No invoices yet — they appear once your buyer posts a goods receipt. <a href="#" className="font-medium text-accent-text">View deliveries →</a></>} />
          <DataTable caption="Loading" columns={COLUMNS.slice(0, 4)} rows={[]} loading />
        </div>
      </Block>

      <Block title="Meters — target tick; colour only once met">
        <div className="max-w-md space-y-4">
          <Meter label="On-time in full" value={66.67} target={95} format={(v) => `${v.toFixed(2)}%`} />
          <Meter label="Quality acceptance" value={95} target={98} format={(v) => `${v.toFixed(2)}%`} />
          <Meter label="Invoice accuracy" value={92.1} target={90} format={(v) => `${v.toFixed(2)}%`} />
        </div>
      </Block>

      <Block title="Empty states, notices, loading">
        <Card>
          <CardHeader title="Recent payments" description="Card + header, for a grouping that means something" />
          <EmptyState icon={Inbox} title="No payments yet" description="Payments appear once your buyer's finance team posts them." action={<Button variant="secondary" size="sm">View invoices</Button>} />
        </Card>
        <div className="mt-4"><EmptyState inline icon={Truck} title="No deliveries in transit." action={<a href="#" className="text-sm font-medium text-accent-text">Send a shipment notice →</a>} /></div>
        <div className="mt-4">
          <Notice tone="error">This workspace is making requests too quickly. Please slow down and try again shortly.</Notice>
          <Notice tone="warn">Submitting this form creates a real purchase order in SAP immediately.</Notice>
          <Notice tone="success">Supplier approved and created in SAP as vendor 100482.</Notice>
          <Notice tone="info" onDismiss={() => {}}>Reconciliation runs every 15 minutes.</Notice>
        </div>
        <div className="mt-2 flex items-center gap-3 text-sm text-fg-subtle"><Spinner /> Inline spinner</div>
        <div className="mt-3 card"><TableSkeleton rows={3} cols={5} /></div>
      </Block>

      <Block title="Section (unboxed), overlays, toast">
        <Section title="Section heading" description="Most page groupings need no box." actions={<Button variant="ghost" size="sm">Edit</Button>}>
          <p className="text-sm text-fg-muted">Content sits on the canvas.</p>
        </Section>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={() => setModal(true)}>Open modal</Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>Open drawer</Button>
        </div>
        <div role="status" className="mt-4 flex w-full max-w-[360px] items-start gap-2.5 rounded-lg border border-border bg-surface py-3 pl-3.5 pr-3 text-sm shadow-popover">
          <span className="mt-1.5 size-2 rounded-full bg-success" aria-hidden="true" />
          <div><p className="font-medium">Shipment notice sent</p><p className="text-fg-muted"><span className="mono">ASN-2026-0142</span> for <span className="mono">PO-2026-0077</span></p></div>
        </div>
      </Block>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Reject this bid?"
        footer={<><Button variant="ghost" onClick={() => setModal(false)}>Cancel</Button><Button variant="destructive" onClick={() => setModal(false)}>Reject bid</Button></>}
      >
        <p className="text-fg-muted">The supplier is told their quotation was not accepted. This cannot be undone.</p>
      </Modal>
      <Drawer
        isOpen={drawer}
        onClose={() => setDrawer(false)}
        title="Flange WN 4&quot; #150"
        description="PO-2026-0077 · Ranjangaon"
        footer={<><Button variant="ghost" onClick={() => setDrawer(false)}>Close</Button><Button>Open order</Button></>}
      >
        <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2.5">
          <dt className="text-fg-muted">Status</dt><dd><StatusBadge label="Dispatched" /></dd>
          <dt className="text-fg-muted">Delivery date</dt><dd>19 Oct 2026</dd>
          <dt className="text-fg-muted">Shipment notice</dt><dd className="mono">ASN-2026-0142</dd>
          <dt className="text-fg-muted">Value</dt><dd className="mono">₹1,18,400.00</dd>
        </dl>
      </Drawer>
    </div>
  );
}

export default function DesignBed() {
  return (
    <div className="-mx-4 -my-2.5 md:-mx-6 md:-my-4">
      <div className="border-b border-border bg-surface px-5 py-4">
        <h1 className="page-title">Design system</h1>
        <p className="text-sm text-fg-muted">Every primitive in every state. Light on the left, dark on the right (view the app in light mode to see both). Development only.</p>
      </div>
      {/* minmax(0, 1fr): a grid track's min-width is otherwise its widest
          child, which pushed the bed past a phone's viewport. */}
      <div className="grid grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Bed themeName="light (current app theme)" />
        <div className="dark min-w-0 border-t border-border xl:border-t-0 xl:border-l"><Bed themeName="dark" /></div>
      </div>
    </div>
  );
}
