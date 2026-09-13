'use client';

import React, { useState, useEffect } from 'react';
import {
  CalendarClock, Repeat, SplitSquareHorizontal, Lock, Unlock, Check, Loader2,
  RefreshCw, Receipt, Settings2, Trash2, Plus, X, AlertTriangle, CircleDot
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Modal from '@/components/ui/Modal';
import EmptyState from '@/components/ui/EmptyState';
import { poService } from '../services/poService';

// The invoicing plan on a purchase order's line items — SAP's FPLA header and
// its FPLT settlement dates, as a screen.
//
// One panel serves two audiences, because they are looking at the same schedule
// for opposite reasons. The buying organisation (`canManage`, i.e. po:manage)
// configures the plan, withholds a date, or re-reads what SAP holds. The
// supplier reads the schedule and raises an invoice against whichever date has
// come due. Neither ever sees the other's controls, and the API enforces the
// same split independently.

const PLAN_TYPES = [
  {
    value: 'Periodic',
    icon: Repeat,
    title: 'Periodic',
    blurb: 'The same amount, invoiced every period — a retainer, a lease, a maintenance contract. The dates are generated from a range and a frequency.',
  },
  {
    value: 'Partial',
    icon: SplitSquareHorizontal,
    title: 'Partial',
    blurb: 'One line value split across dated milestones — a down payment, a progress schedule. The instalments must add up to the whole line.',
  },
];

const FREQUENCIES = ['Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'];

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 })
    .format(Number(value || 0));

const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '—');

const prettyDay = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const todayIso = () => new Date().toISOString().slice(0, 10);

// A settlement date is in exactly one of four states, and they are what the
// supplier is really asking about: can I bill this, and if not, why not?
const lineState = (line) => {
  if (line.status === 'Invoiced') return 'invoiced';
  if (line.blocked) return 'blocked';
  return new Date(line.settlementDate) <= new Date() ? 'due' : 'scheduled';
};

const STATE_CHIP = {
  due:       { label: 'Due now',   className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  invoiced:  { label: 'Invoiced',  className: 'bg-blue-50 text-blue-700 border-blue-200' },
  blocked:   { label: 'Blocked',   className: 'bg-amber-50 text-amber-700 border-amber-200' },
  scheduled: { label: 'Scheduled', className: 'bg-surface2 text-text-secondary border-border' },
};

function Stat({ label, value, hint, accent = '' }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] font-extrabold text-text-tertiary uppercase tracking-widest">{label}</div>
      <div className={`text-sm font-bold font-mono tabular-nums mt-1 ${accent || 'text-text-primary'}`}>{value}</div>
      {hint && <div className="text-[10px] text-text-tertiary mt-0.5">{hint}</div>}
    </div>
  );
}

// --- The configure dialog ---------------------------------------------------

function ConfigureDialog({ po, item, existingPlan, onClose, onSaved }) {
  const isPeriodic = (existingPlan?.type || 'Periodic') === 'Periodic';
  const [type, setType] = useState(existingPlan?.type || 'Periodic');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [periodic, setPeriodic] = useState({
    startDate: existingPlan?.startDate ? day(existingPlan.startDate) : todayIso(),
    endDate: existingPlan?.endDate ? day(existingPlan.endDate) : '',
    frequency: existingPlan?.frequency || 'Monthly',
    invoicingRule: existingPlan?.invoicingRule || 'Arrears',
    // Blank means "the line's own value recurs", which is SAP's default and the
    // right answer for a PO line that already carries the per-period price.
    periodicAmount: isPeriodic && existingPlan?.periodicAmount ? String(existingPlan.periodicAmount) : '',
  });

  const [milestones, setMilestones] = useState(
    !isPeriodic && existingPlan?.lines?.length
      ? existingPlan.lines.map((line) => ({
        description: line.description || '',
        settlementDate: day(line.settlementDate),
        percentage: String(line.percentage ?? ''),
      }))
      : [
        { description: 'On order', settlementDate: todayIso(), percentage: '50' },
        { description: 'On delivery', settlementDate: '', percentage: '50' },
      ],
  );

  const [reference, setReference] = useState(existingPlan?.reference || '');

  const milestoneTotal = milestones.reduce((sum, m) => sum + (Number(m.percentage) || 0), 0);
  const netValue = Number(item?.netValue || 0);

  const updateMilestone = (index, patch) =>
    setMilestones((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = type === 'Periodic'
        ? {
          type,
          startDate: periodic.startDate,
          endDate: periodic.endDate,
          frequency: periodic.frequency,
          invoicingRule: periodic.invoicingRule,
          ...(periodic.periodicAmount ? { periodicAmount: Number(periodic.periodicAmount) } : {}),
          ...(reference ? { reference } : {}),
        }
        : {
          type,
          milestones: milestones.map((m) => ({
            description: m.description || undefined,
            settlementDate: m.settlementDate,
            percentage: Number(m.percentage),
          })),
          ...(reference ? { reference } : {}),
        };

      const result = await poService.saveInvoicePlan(po.id, item.line, body);
      onSaved(result);
    } catch (err) {
      // The API's messages are written to be read by a buyer — "the instalments
      // total 90.00 but the line item is 100.00" — so they are shown as-is
      // rather than replaced with a generic failure.
      setError(err?.message || 'The invoicing plan could not be saved');
      setSaving(false);
    }
  };

  const inputClass = 'w-full px-3 py-2 text-xs font-medium bg-base border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all duration-150';
  const labelClass = 'block text-[10px] font-extrabold text-text-secondary uppercase tracking-widest mb-1.5';

  return (
    <Modal
      open
      onClose={onClose}
      title={`Invoicing plan — line ${item.line}`}
      className="max-w-3xl"
    >
      <div className="space-y-5 p-5 overflow-y-auto">
        <div className="card px-4 py-3 bg-surface2/40">
          <div className="text-xs font-bold text-text-primary">{item.materialCode} · {item.description}</div>
          <div className="text-[11px] text-text-secondary mt-0.5 font-mono tabular-nums">
            Line value {money(netValue, po.currency)} · {item.quantity} {item.uom || 'EA'}
          </div>
        </div>

        {/* Plan type — the one choice everything else follows from, so it is a
            pair of explained cards rather than a dropdown. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PLAN_TYPES.map((option) => {
            const OptionIcon = option.icon;
            const selected = type === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setType(option.value)}
                className={`text-left p-3.5 rounded-xl border-2 transition-all duration-150 cursor-pointer ${selected
                  ? 'border-blue-500 bg-blue-50/60'
                  : 'border-border bg-base hover:border-border-em'
                  }`}
              >
                <div className="flex items-center gap-2">
                  <OptionIcon className={`size-4 ${selected ? 'text-blue-600' : 'text-text-tertiary'}`} />
                  <span className={`text-xs font-bold ${selected ? 'text-blue-700' : 'text-text-primary'}`}>{option.title}</span>
                </div>
                <p className="text-[11px] leading-snug text-text-secondary mt-1.5">{option.blurb}</p>
              </button>
            );
          })}
        </div>

        {type === 'Periodic' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="plan-start-date">Start date</label>
              <input id="plan-start-date" type="date" className={inputClass} value={periodic.startDate}
                onChange={(e) => setPeriodic({ ...periodic, startDate: e.target.value })} />
            </div>
            <div>
              <label className={labelClass} htmlFor="plan-end-date">End date</label>
              <input id="plan-end-date" type="date" className={inputClass} value={periodic.endDate}
                onChange={(e) => setPeriodic({ ...periodic, endDate: e.target.value })} />
            </div>
            <div>
              <label className={labelClass} htmlFor="plan-frequency">Frequency</label>
              <select id="plan-frequency" className={inputClass} value={periodic.frequency}
                onChange={(e) => setPeriodic({ ...periodic, frequency: e.target.value })}>
                {FREQUENCIES.map((frequency) => <option key={frequency} value={frequency}>{frequency}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="plan-invoiced">Invoiced</label>
              <select id="plan-invoiced" className={inputClass} value={periodic.invoicingRule}
                onChange={(e) => setPeriodic({ ...periodic, invoicingRule: e.target.value })}>
                <option value="Arrears">In arrears — at the end of each period</option>
                <option value="Advance">In advance — at the start of each period</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="plan-amount">Amount per period</label>
              <input id="plan-amount" type="number" min="0" step="0.01" className={inputClass}
                placeholder={`Defaults to the line value, ${money(netValue, po.currency)}`}
                value={periodic.periodicAmount}
                onChange={(e) => setPeriodic({ ...periodic, periodicAmount: e.target.value })} />
              <p className="text-[10px] text-text-tertiary mt-1.5">
                A periodic plan invoices this amount on every date — the plan total is the amount times the number of periods, not the line value.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className={labelClass + ' mb-0'} htmlFor="plan-instalments">Instalments</label>
              <span className={`text-[11px] font-bold font-mono tabular-nums ${Math.abs(milestoneTotal - 100) < 0.01 ? 'text-emerald-600' : 'text-amber-600'
                }`}>
                {milestoneTotal.toFixed(2)}% of 100%
              </span>
            </div>

            {milestones.map((milestone, index) => (
              <div key={index} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                <input id="plan-instalments" className={inputClass + ' sm:flex-1'} placeholder="Milestone" value={milestone.description}
                  onChange={(e) => updateMilestone(index, { description: e.target.value })} />
                <input type="date" className={inputClass + ' sm:w-40'} value={milestone.settlementDate}
                  onChange={(e) => updateMilestone(index, { settlementDate: e.target.value })} />
                <div className="relative sm:w-28">
                  <input type="number" min="0" max="100" step="0.01" className={inputClass + ' pr-7'} value={milestone.percentage}
                    onChange={(e) => updateMilestone(index, { percentage: e.target.value })} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-text-tertiary">%</span>
                </div>
                <div className="sm:w-28 text-right text-[11px] font-mono tabular-nums text-text-secondary self-center">
                  {money((netValue * (Number(milestone.percentage) || 0)) / 100, po.currency)}
                </div>
                <button type="button" onClick={() => setMilestones((rows) => rows.filter((_, i) => i !== index))}
                  disabled={milestones.length === 1}
                  className="p-2 text-text-tertiary hover:text-red-600 disabled:opacity-30 cursor-pointer transition-colors duration-150">
                  <X className="size-4" />
                </button>
              </div>
            ))}

            <Button variant="outline" size="sm"
              onClick={() => setMilestones((rows) => [...rows, { description: '', settlementDate: '', percentage: '' }])}>
              <Plus className="size-3.5 mr-1.5" /> Add instalment
            </Button>
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="plan-reference">Reference (optional)</label>
          <input id="plan-reference" className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder="Contract number, agreement reference…" />
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3.5 py-3 rounded-lg bg-red-50 border border-red-200">
            <AlertTriangle className="size-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs font-medium text-red-700">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <><Loader2 className="size-4 mr-2 animate-spin" /> Saving to SAP…</> : 'Save invoicing plan'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- One line item's plan ---------------------------------------------------

function PlanCard({ po, entry, canManage, busy, onConfigure, onRemove, onToggleBlock, onBill }) {
  const { plan, summary } = entry;
  const currency = plan.currency || po.currency || 'INR';
  const PlanIcon = plan.type === 'Periodic' ? Repeat : SplitSquareHorizontal;
  const progress = summary?.totalValue ? (summary.invoicedValue / summary.totalValue) * 100 : 0;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-3.5 border-b border-border bg-surface2/40">
        <div className="flex items-center gap-2.5 min-w-0">
          <PlanIcon className="size-4 text-blue-600 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-bold text-text-primary truncate">
              Line {entry.line} · {entry.materialCode} — {entry.description}
            </div>
            <div className="text-[10px] font-semibold text-text-tertiary uppercase tracking-widest mt-0.5">
              {plan.type} plan
              {plan.frequency ? ` · ${plan.frequency}` : ''}
              {plan.invoicingRule ? ` · in ${plan.invoicingRule.toLowerCase()}` : ''}
              {plan.planNumber ? ` · FPLA ${plan.planNumber}` : ''}
            </div>
          </div>
        </div>

        {canManage && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={() => onConfigure(entry)} disabled={busy}>
              <Settings2 className="size-3.5 mr-1.5" /> Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onRemove(entry)} disabled={busy || summary?.invoicedLines > 0}
              title={summary?.invoicedLines > 0 ? 'Dates on this plan have already been invoiced' : 'Switch invoice planning off for this line'}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-border border-b border-border">
        <Stat label="Plan total" value={money(summary?.totalValue, currency)} hint={`${summary?.totalLines || 0} invoicing dates`} />
        <Stat label="Invoiced" value={money(summary?.invoicedValue, currency)} hint={`${summary?.invoicedLines || 0} of ${summary?.totalLines || 0}`} accent="text-blue-700" />
        <Stat label="Outstanding" value={money(summary?.openValue, currency)} hint={summary?.blockedLines ? `${summary.blockedLines} blocked` : 'Not yet invoiced'} />
        <Stat
          label={summary?.dueLines ? 'Billable now' : 'Next date'}
          value={summary?.dueLines ? money(summary.dueValue, currency) : prettyDay(summary?.nextDueDate)}
          hint={summary?.dueLines ? `${summary.dueLines} date${summary.dueLines === 1 ? '' : 's'} open` : (summary?.complete ? 'Plan complete' : 'Not yet due')}
          accent={summary?.dueLines ? 'text-emerald-700' : ''}
        />
      </div>

      <div className="h-1 bg-surface2">
        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${Math.min(100, progress)}%` }} />
      </div>

      <div className="w-full overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[720px]">
          <thead>
            <tr>
              <th className="w-16">Date</th>
              <th className="min-w-[180px]">Description</th>
              <th className="w-36">Settlement</th>
              <th className="w-20 text-right">%</th>
              <th className="w-36 text-right">Amount</th>
              <th className="w-32">Status</th>
              <th className="w-44 text-right">{canManage ? 'Billing block' : 'Invoice'}</th>
            </tr>
          </thead>
          <tbody>
            {(plan.lines || []).map((line) => {
              const state = lineState(line);
              const chip = STATE_CHIP[state];
              return (
                <tr key={line.lineNumber}>
                  <td className="font-semibold font-mono tabular-nums">{line.lineNumber}</td>
                  <td className="text-text-primary font-medium">{line.description || '—'}</td>
                  <td className="font-medium font-mono tabular-nums">{prettyDay(line.settlementDate)}</td>
                  <td className="text-right font-mono tabular-nums">{line.percentage ? `${line.percentage}%` : '—'}</td>
                  <td className="text-right font-bold text-text-primary font-mono tabular-nums">{money(line.amount, currency)}</td>
                  <td>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold ${chip.className}`}>
                      {state === 'invoiced' ? <Check className="size-3" /> : state === 'blocked' ? <Lock className="size-3" /> : <CircleDot className="size-3" />}
                      {chip.label}
                    </span>
                    {line.invoiceNumber && (
                      <div className="text-[10px] text-text-tertiary font-mono mt-0.5">{line.invoiceNumber}</div>
                    )}
                  </td>
                  <td className="text-right">
                    {canManage ? (
                      state === 'invoiced' ? (
                        <span className="text-[11px] text-text-tertiary">Billed</span>
                      ) : (
                        <Button variant="ghost" size="sm" disabled={busy}
                          onClick={() => onToggleBlock(entry, line, !line.blocked)}>
                          {line.blocked
                            ? <><Unlock className="size-3.5 mr-1.5" /> Release</>
                            : <><Lock className="size-3.5 mr-1.5" /> Block</>}
                        </Button>
                      )
                    ) : state === 'due' ? (
                      <Button size="sm" disabled={busy} onClick={() => onBill(entry, line)}>
                        <Receipt className="size-3.5 mr-1.5" /> Create invoice
                      </Button>
                    ) : (
                      <span className="text-[11px] text-text-tertiary">
                        {state === 'invoiced' ? (line.sapMiroDoc ? `MIRO ${line.sapMiroDoc}` : 'Submitted') : chip.label}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- The panel --------------------------------------------------------------

export default function InvoicePlanPanel({ po, canManage = false, onInvoiceRaised }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [configuring, setConfiguring] = useState(null); // { line, item, plan }

  // A counter rather than a callback the effect calls: every write below asks
  // for a reload by bumping it, and the effect itself only ever starts the
  // request — no state is set synchronously inside it.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!po?.id) return undefined;
    let cancelled = false;

    poService.getInvoicePlan(po.id)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setNotice({ tone: 'error', text: err?.message || 'The invoicing plan could not be loaded' });
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [po?.id, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  // Every write goes through here so that one place owns the busy flag, the
  // reload, and turning an API error into something a person can read.
  const run = async (action, successText) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      reload();
      setNotice({ tone: 'success', text: successText || result?.message });
      return result;
    } catch (err) {
      setNotice({ tone: 'error', text: err?.message || 'That did not work' });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const billPlanLine = (entry, line) =>
    run(
      () => poService.submitPlanInvoice({
        poId: po.id,
        line: entry.line,
        planLineNumber: line.lineNumber,
        // The supplier's own invoice number. Generated here the same way the
        // GRN-based invoice form does, so the two flows produce comparable
        // references rather than one of them looking hand-typed.
        invoiceNumber: `INV-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`,
        invoiceDate: todayIso(),
      }),
      `Invoice raised for ${money(line.amount, entry.currency || po.currency)} against date ${line.lineNumber}`,
    ).then((result) => {
      if (result && onInvoiceRaised) onInvoiceRaised(result.invoice);
    });

  const plannedLines = new Set((data?.items || []).map((entry) => entry.line));
  const unplannedItems = (po?.items || []).filter((item) => !plannedLines.has(item.line));

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
        <div>
          <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider flex items-center gap-2">
            <CalendarClock className="size-4 text-blue-600" /> Invoicing plan
          </h4>
          <p className="text-[11px] text-text-secondary mt-1">
            {canManage
              ? 'Line items billed on a schedule rather than against a goods receipt. Periodic plans recur; partial plans split the line across milestones.'
              : 'These line items are billed on a schedule agreed with your buyer, not against a delivery. Raise an invoice on each date as it comes due.'}
          </p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" disabled={busy}
            onClick={() => run(() => poService.syncInvoicePlan(po.id))}>
            <RefreshCw className={`size-3.5 mr-1.5 ${busy ? 'animate-spin' : ''}`} /> Sync from SAP
          </Button>
        )}
      </div>

      {notice && (
        <div className={`flex items-start gap-2 px-3.5 py-3 rounded-lg border ${notice.tone === 'error'
          ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-emerald-50 border-emerald-200 text-emerald-700'
          }`}>
          {notice.tone === 'error' ? <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" /> : <Check className="size-4 flex-shrink-0 mt-0.5" />}
          <p className="text-xs font-medium">{notice.text}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-14 text-text-tertiary">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !data?.items?.length ? (
        <EmptyState
          icon={CalendarClock}
          title="No invoicing plan on this order"
          description={canManage
            ? 'Every line on this order is invoiced against its goods receipt. Add a plan to a line to bill it on a schedule instead.'
            : 'Every line on this order is invoiced against its delivery. Nothing here is billed on a schedule.'}
        />
      ) : (
        data.items.map((entry) => (
          <PlanCard
            key={entry.line}
            po={po}
            entry={entry}
            canManage={canManage}
            busy={busy}
            onConfigure={(target) => setConfiguring({ item: target, plan: target.plan })}
            onRemove={(target) => run(() => poService.removeInvoicePlan(po.id, target.line))}
            onToggleBlock={(target, line, blocked) =>
              run(() => poService.setInvoicePlanLineBlock(po.id, target.line, line.lineNumber, blocked))}
            onBill={billPlanLine}
          />
        ))
      )}

      {/* Lines still invoiced the ordinary way. Only the buying organisation is
          offered the switch, and only when there is a line left to switch. */}
      {canManage && !loading && unplannedItems.length > 0 && (
        <div className="card px-5 py-4">
          <div className="text-[10px] font-extrabold text-text-secondary uppercase tracking-widest mb-3">
            Lines invoiced against goods receipt
          </div>
          <div className="space-y-2">
            {unplannedItems.map((item) => (
              <div key={item.line} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text-primary truncate">
                    Line {item.line} · {item.materialCode} — {item.description}
                  </div>
                  <div className="text-[11px] text-text-tertiary font-mono tabular-nums">
                    {money(item.netValue, po.currency)}
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={busy}
                  onClick={() => setConfiguring({ item, plan: null })}>
                  <Plus className="size-3.5 mr-1.5" /> Add invoicing plan
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {configuring && (
        <ConfigureDialog
          po={po}
          item={configuring.item}
          existingPlan={configuring.plan}
          onClose={() => setConfiguring(null)}
          onSaved={(result) => {
            setConfiguring(null);
            setNotice({ tone: 'success', text: result?.message });
            reload();
          }}
        />
      )}
    </div>
  );
}
