import React from 'react';
import { Award, CheckCircle2, TrendingUp, AlertTriangle, Activity } from 'lucide-react';

export default function PerformanceView({ state }) {
  const perf = state.performance;
  const metrics = [
    { name: 'On-Time In-Full (OTIF)', val: `${perf.deliveryOTIF}%`, target: 'Target: >95.0%', style: 'border-border' },
    { name: 'QC Acceptance Rate', val: `${perf.qualityAcceptance}%`, target: 'Target: >98.0%', style: 'border-border' },
    { name: 'Pricing Index Competitiveness', val: `${perf.priceIndex}/100`, target: 'Target: >85.0', style: 'border-border' },
    { name: 'AP Response Window', val: `${perf.responseTimeHours} hrs`, target: 'Target: <4.0 hrs', style: 'border-border' }
  ];

  return (
    <div className="space-y-6 max-w-full mx-auto animate-fade-in pb-12">
      {/* Title Header */}
      <div className="card p-4 flex items-center justify-between">
        <div>
          <h2 className="page-title flex items-center gap-2">
            <Activity className="size-4.5 text-text-secondary" /> Supplier Performance scorecard
          </h2>
          <p className="text-[11px] text-text-secondary mt-1 font-semibold">
            Your quality and delivery scores, calculated from your order, delivery, and invoice history
          </p>
        </div>
        <div className="size-14 rounded-md border border-border bg-surface2 flex flex-col items-center justify-center shrink-0 select-none">
          <span className="text-[8px] text-text-tertiary font-bold uppercase tracking-wider">GRADE</span>
          <span className="text-xl font-bold font-mono text-text-primary leading-none mt-1">{perf.grade}</span>
        </div>
      </div>

      {/* METRICS CARDS PANEL */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.map(m => (
          <div key={m.name} className={`metric-panel justify-between min-h-[115px] ${m.style} hover:border-border-em transition-colors duration-150`}>
            <div>
              <span className="label mb-0 leading-tight">{m.name}</span>
              <span className="text-2xl font-mono font-bold block mt-2.5 text-text-primary tabular-nums">{m.val}</span>
            </div>
            <span className="text-[10px] text-text-tertiary font-semibold mt-2.5">{m.target}</span>
          </div>
        ))}
      </div>

      {/* PERFORMANCE CRITERIA BARS SECTION */}
      <div className="card p-5 space-y-4">
        <h3 className="text-xs font-extrabold text-text-primary uppercase tracking-wider border-b border-border pb-2 flex items-center gap-2">
          <TrendingUp className="size-4 text-text-secondary" /> Operational Metrics Timeline Check
        </h3>

        <div className="space-y-4.5 max-w-2xl">
          {[
            { name: 'On-Time Delivery (OTIF)', val: perf.deliveryOTIF, target: 95 },
            { name: 'Quality acceptance rate', val: perf.qualityAcceptance, target: 98 },
            { name: 'Invoice accuracy', val: 83, target: 90 },
            { name: 'Response speed', val: 92, target: 85 }
          ].map((bar, idx) => {
            const isTargetMet = bar.val >= bar.target;
            const barColor = isTargetMet ? 'bg-emerald-500' : 'bg-amber-500';
            return (
              <div key={idx} className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-text-primary">{bar.name}</span>
                  <span className={isTargetMet ? 'text-emerald-text font-bold tabular-nums' : 'text-amber-600 font-bold tabular-nums'}>
                    {bar.val}% <span className="text-text-tertiary font-normal">/ target {bar.target}%</span>
                  </span>
                </div>
                <div className="w-full bg-surface2 h-2 rounded-full border border-border overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                    style={{ width: `${bar.val}%` }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* COMPLIANCE GUIDANCE CARD */}
      <div className="card p-5 space-y-3.5">
        <h3 className="text-xs font-extrabold text-text-primary uppercase tracking-wider border-b border-border pb-2">
          Operational Compliance Guidelines &amp; Protocol Rules
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-text-secondary leading-relaxed">
          <div className="space-y-1 border-r border-border pr-4 last:border-r-0 last:pr-0">
            <h4 className="font-extrabold text-text-primary uppercase text-[10px] tracking-wider mb-1">Rejections on delivery</h4>
            <p className="text-text-secondary leading-normal">
              Items your buyer rejects when checking a delivery lower your quality score. Check and pack goods carefully to avoid rejections.
            </p>
          </div>
          <div className="space-y-1 border-r border-border pr-4 last:border-r-0 last:pr-0">
            <h4 className="font-extrabold text-text-primary uppercase text-[10px] tracking-wider mb-1">Lead-Time Compliance</h4>
            <p className="text-text-secondary leading-normal">
              Your delivery score compares when you dispatched against the delivery date agreed on the order. Shipping on time keeps your preferred-supplier standing.
            </p>
          </div>
          <div className="space-y-1 border-r border-border pr-4 last:border-r-0 last:pr-0">
            <h4 className="font-extrabold text-text-primary uppercase text-[10px] tracking-wider mb-1">Invoice accuracy</h4>
            <p className="text-text-secondary leading-normal">
              The quantities and prices on your invoices are checked against the order and the delivery receipt. Invoices that match exactly get paid faster.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
