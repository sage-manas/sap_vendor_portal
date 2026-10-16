import React from 'react';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Card';
import { Meter } from '@/components/ui/controls';

// The three measures GET /vendors/performance computes, and the targets they
// are scored against.
const MEASURES = [
  { key: 'deliveryOTIF', name: 'On-time in full (OTIF)', target: 95 },
  { key: 'qualityAcceptance', name: 'Quality acceptance', target: 98 },
  { key: 'invoiceAccuracy', name: 'Invoice accuracy', target: 90 },
];

const pct = (v) => `${Number(v).toFixed(2)}%`;

export default function PerformanceView({ state }) {
  const perf = state.performance || {};
  // Only the measures the API returned. A score it has not computed shows as
  // "—", never as a stand-in number.
  const hasScore = perf.weightedScore != null;

  return (
    <div className="max-w-3xl pb-12">
      <PageHeader
        title="Performance"
        description="Your quality and delivery scores, calculated from your order, delivery and invoice history."
      />

      <Section title="Supplier score">
        <div className="card flex flex-wrap items-baseline gap-x-4 gap-y-1 p-5">
          <span className={hasScore ? 'text-3xl font-semibold tracking-[-0.02em] text-fg' : 'text-xl text-fg-subtle'}>
            {hasScore ? perf.weightedScore : '—'}
            {hasScore && <span className="text-lg font-normal text-fg-muted"> / 100</span>}
          </span>
          <span className="text-sm text-fg-muted">
            {perf.grade ? <>Grade <span className="font-semibold text-fg">{perf.grade}</span></> : 'Not graded yet'}
          </span>
          <span className="basis-full text-sm text-fg-subtle">
            Delivery, quality and invoicing combined.
          </span>
        </div>
      </Section>

      <Section className="mt-8" title="Measures" description="Each bar shows your result; the tick is the target. A bar turns green once you meet it.">
        <div className="card space-y-5 p-5">
          {MEASURES.map((m) => (perf[m.key] != null ? (
            <Meter key={m.key} label={m.name} value={Number(perf[m.key])} target={m.target} format={pct} />
          ) : (
            <div key={m.key} className="flex items-baseline gap-3 text-sm">
              <span className="flex-1 text-fg">{m.name}</span>
              <span className="text-fg-subtle">— <span className="text-xs">/ target {m.target}%</span></span>
            </div>
          )))}
        </div>
      </Section>

      <details className="group mt-8">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-fg hover:text-accent-text">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" strokeWidth={1.5} aria-hidden="true" />
          How your score is calculated
        </summary>
        <dl className="mt-4 grid gap-5 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium text-fg">Rejections on delivery</dt>
            <dd className="mt-1 text-fg-muted">
              Items your buyer rejects when checking a delivery lower your quality score. Check and pack goods carefully to avoid rejections.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-fg">Lead-time compliance</dt>
            <dd className="mt-1 text-fg-muted">
              Your delivery score compares when you dispatched against the delivery date agreed on the order. Shipping on time keeps your preferred-supplier standing.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-fg">Invoice accuracy</dt>
            <dd className="mt-1 text-fg-muted">
              The quantities and prices on your invoices are checked against the order and the delivery receipt. Invoices that match exactly get paid faster.
            </dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
