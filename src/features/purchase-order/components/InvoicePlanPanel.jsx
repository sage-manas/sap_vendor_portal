'use client';

import React, { useState, useEffect } from 'react';
import {
  CalendarClock, Repeat, SplitSquareHorizontal, Lock, Unlock, Check, Loader2,
  RefreshCw, Settings2, AlertTriangle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Modal from '@/components/ui/Modal';
import EmptyState from '@/components/ui/EmptyState';
import StatusBadge from '@/components/ui/StatusBadge';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';
import DataTable from '@/components/ui/DataTable';
import { poService } from '../services/poService';

// The invoicing plan on a purchase order's line items — SAP's FPLA header and
// its FPLT settlement dates, as a screen.
//
// One panel serves two audiences, because they are looking at the same schedule
// for opposite reasons. The buying organisation (`canManage`, i.e. po:manage)
// configures the plan, withholds a date, or re-reads what SAP holds — and is
// the only side that ever writes SAP. The supplier (`canPropose`, i.e.
// po:invoice-plan:propose) reads the schedule, raises an invoice against
// whichever date has come due, and may propose a change to the schedule
// itself — which is stored, not applied, until the buyer approves it (a
// PlanCard's `pendingChange` banner is where both sides see that state).
// Neither audience sees the other's write controls, and the API enforces the
// same split independently.

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
  due:       { label: 'Due now',   tone: 'action' },
  invoiced:  { label: 'Invoiced',  tone: 'done' },
  blocked:   { label: 'Blocked',   tone: 'warn' },
  scheduled: { label: 'Scheduled', tone: 'neutral' },
};

function Notice({ tone, children }) {
  const error = tone === 'error';
  const Icon = error ? AlertTriangle : Check;
  return (
    <div role={error ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-md border px-3.5 py-3 text-sm ${error
      ? 'border-danger/30 bg-danger-tint text-danger'
      : 'border-success/30 bg-success-tint text-success'}`}>
      <Icon className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-fg">{children}</p>
    </div>
  );
}

// --- The configure dialog ---------------------------------------------------

// `mode`: 'manage' (the buying organisation moving dates on the live plan) or
// 'propose' (a supplier proposing a date change to it) — the same form
// either way, since both are held to the same dates-only rule
// (assertDatesOnlyChange, backend/services/invoicePlan.service.js) and SAP
// needs the same shape; only the submit target differs (saveInvoicePlan vs.
// proposeInvoicePlanChange, the latter never touching the live schedule
// directly). `existingPlan` is always the current LIVE plan in both modes —
// never null: there is no path here that creates a plan from nothing, only
// one that moves the dates on a plan SAP already holds.
function ConfigureDialog({ po, item, existingPlan, mode = 'manage', onClose, onSaved }) {
  const isPeriodic = (existingPlan?.type || 'Periodic') === 'Periodic';
  // Dates only, for both audiences — the plan type is fixed to whatever it
  // already is; neither gets to restructure the plan.
  const type = existingPlan?.type || 'Periodic';
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
      ? [...existingPlan.lines].sort((a, b) => a.lineNumber - b.lineNumber).map((line) => ({
        description: line.description || '',
        settlementDate: day(line.settlementDate),
        percentage: String(line.percentage ?? ''),
      }))
      : [
        { description: 'On order', settlementDate: todayIso(), percentage: '50' },
        { description: 'On delivery', settlementDate: '', percentage: '50' },
      ],
  );

  // Not editable here (dates only) — carried through unchanged on save.
  const reference = existingPlan?.reference || '';

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

      const result = mode === 'propose'
        ? await poService.proposeInvoicePlanChange(po.id, item.line, body)
        : await poService.saveInvoicePlan(po.id, item.line, body);
      onSaved(result);
    } catch (err) {
      // The API's messages are written to be read by whoever is looking at
      // this form — "the instalments total 90.00 but the line item is
      // 100.00" — so they are shown as-is rather than replaced with a
      // generic failure.
      setError(err?.message || 'The invoicing plan could not be saved');
      setSaving(false);
    }
  };

  const inputClass = 'w-full';
  const labelClass = 'mb-1.5 block text-sm font-medium text-fg';

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'propose' ? `Propose a change — line ${item.line}` : `Move invoicing dates — line ${item.line}`}
      className="max-w-3xl"
    >
      <div className="space-y-5 p-5 overflow-y-auto">
        <div className="rounded-md border border-border bg-subtle px-4 py-3">
          <div className="text-sm font-medium text-fg">{item.materialCode} · {item.description}</div>
          <div className="mono mt-0.5 text-sm text-fg-muted">
            Line value {money(netValue, po.currency)} · {item.quantity} {item.uom || 'EA'}
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info-tint px-3.5 py-3">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-info" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-sm text-fg">
            {mode === 'propose'
              ? 'You can propose new dates only — descriptions, percentages and amounts stay as they are. Your buyer must approve the new dates before anything reaches SAP, and nothing below is billable until then.'
              : 'Only the dates can be changed here — descriptions, percentages, amounts and the plan type stay as they are. This saves straight to SAP.'}
          </p>
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
              <select id="plan-frequency" disabled className={inputClass} value={periodic.frequency} onChange={() => {}}>
                {FREQUENCIES.map((frequency) => <option key={frequency} value={frequency}>{frequency}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="plan-invoiced">Invoiced</label>
              <select id="plan-invoiced" disabled className={inputClass} value={periodic.invoicingRule} onChange={() => {}}>
                <option value="Arrears">In arrears — at the end of each period</option>
                <option value="Advance">In advance — at the start of each period</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="plan-amount">Amount per period</label>
              <input id="plan-amount" disabled type="number" min="0" step="0.01" className={inputClass}
                placeholder={`Defaults to the line value, ${money(netValue, po.currency)}`}
                value={periodic.periodicAmount} onChange={() => {}} />
              <p className="mt-1.5 text-xs text-fg-subtle">
                A periodic plan invoices this amount on every date — the plan total is the amount times the number of periods, not the line value.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className={labelClass + ' mb-0'} htmlFor="plan-instalments">Instalments</label>
              <span className={`mono text-sm ${Math.abs(milestoneTotal - 100) < 0.01 ? 'text-success' : 'text-warning'}`}>
                {milestoneTotal.toFixed(2)}% of 100%
              </span>
            </div>

            {milestones.map((milestone, index) => (
              <div key={index} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                <input id="plan-instalments" disabled className={inputClass + ' sm:flex-1'} placeholder="Milestone" value={milestone.description} onChange={() => {}} />
                <input type="date" className={inputClass + ' sm:w-40'} value={milestone.settlementDate}
                  onChange={(e) => updateMilestone(index, { settlementDate: e.target.value })} />
                <div className="relative sm:w-28">
                  <input type="number" disabled min="0" max="100" step="0.01" className={inputClass + ' pr-7'} value={milestone.percentage} onChange={() => {}} />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">%</span>
                </div>
                <div className="mono self-center text-right text-sm text-fg-muted sm:w-28">
                  {money((netValue * (Number(milestone.percentage) || 0)) / 100, po.currency)}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving
              ? <><Loader2 className="mr-2 size-4 animate-spin" /> {mode === 'propose' ? 'Sending…' : 'Saving to SAP…'}</>
              : (mode === 'propose' ? 'Send proposal to buyer' : 'Save invoicing plan')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- Reject a proposal, with a reason ---------------------------------------

function RejectProposalDialog({ po, entry, onClose, onRejected }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!reason.trim()) {
      setError('A reason is required — the supplier only sees this, not the rest of your workspace');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await poService.rejectInvoicePlanChange(po.id, entry.line, reason.trim());
      onRejected(result);
    } catch (err) {
      setError(err?.message || 'The proposal could not be rejected');
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Reject proposed change — line ${entry.line}`} className="max-w-lg">
      <div className="space-y-4 p-5">
        <p className="text-sm text-fg-muted">
          The live invoicing plan is left exactly as it is. Your reason is shown to the supplier so they know what to change if they resubmit.
        </p>
        <textarea
          aria-label="Reason for rejecting"
          className="min-h-24 w-full"
          placeholder="Why this proposal is being rejected…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? <><Loader2 className="mr-2 size-4 animate-spin" /> Rejecting…</> : 'Reject proposal'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// --- One line item's plan ---------------------------------------------------

function PlanCard({
  po, entry, canManage, canPropose, busy,
  onConfigure, onToggleBlock, onPropose, onApproveProposal, onRejectProposal,
}) {
  const { plan, summary } = entry;
  const currency = plan.currency || po.currency || 'INR';
  const PlanIcon = plan.type === 'Periodic' ? Repeat : SplitSquareHorizontal;
  const progress = summary?.totalValue ? (summary.invoicedValue / summary.totalValue) * 100 : 0;
  const pending = plan.pendingChange;

  const columns = [
    { key: 'lineNumber', header: 'Date', mono: true, primary: true },
    { key: 'description', header: 'Description', wrap: true, render: (line) => line.description || '—' },
    { key: 'settlementDate', header: 'Settlement', render: (line) => prettyDay(line.settlementDate) },
    { key: 'percentage', header: '%', align: 'right', mono: true, render: (line) => (line.percentage ? `${line.percentage}%` : '—') },
    { key: 'amount', header: `Amount (${currency === 'INR' ? '₹' : currency})`, align: 'right', mono: true, render: (line) => money(line.amount, currency) },
    {
      key: 'status',
      header: 'Status',
      render: (line) => {
        const chip = STATE_CHIP[lineState(line)];
        return (
          <span className="flex flex-col items-start gap-0.5">
            <StatusBadge label={chip.label} tone={chip.tone} />
            {line.invoiceNumber && <span className="mono text-xs text-fg-subtle">{line.invoiceNumber}</span>}
          </span>
        );
      },
    },
    {
      key: 'action',
      header: canManage ? 'Billing block' : 'Invoice',
      align: 'right',
      render: (line) => {
        const state = lineState(line);
        if (canManage) {
          if (state === 'invoiced') return <span className="text-sm text-fg-subtle">Billed</span>;
          return (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onToggleBlock(entry, line, !line.blocked)}>
              {line.blocked
                ? <><Unlock className="mr-1.5 size-3.5" strokeWidth={1.5} /> Release</>
                : <><Lock className="mr-1.5 size-3.5" strokeWidth={1.5} /> Block</>}
            </Button>
          );
        }
        if (state === 'due') return <span className="text-sm font-medium text-fg">Due — awaiting invoice</span>;
        return (
          <span className="text-sm text-fg-subtle">
            {state === 'invoiced' ? (line.sapMiroDoc ? `MIRO ${line.sapMiroDoc}` : 'Submitted') : STATE_CHIP[state].label}
          </span>
        );
      },
    },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 items-start gap-2.5">
          <PlanIcon className="mt-1 size-4 shrink-0 text-fg-muted" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-fg">
              Line {entry.line} · <span className="mono">{entry.materialCode}</span> — {entry.description}
            </h3>
            <p className="mt-0.5 text-sm text-fg-muted">
              {plan.type} plan
              {plan.frequency ? ` · ${plan.frequency}` : ''}
              {plan.invoicingRule ? ` · in ${plan.invoicingRule.toLowerCase()}` : ''}
              {plan.planNumber ? <> · plan <span className="mono">{plan.planNumber}</span></> : null}
            </p>
          </div>
        </div>

        {canManage && (
          <Button variant="secondary" size="sm" onClick={() => onConfigure(entry)} disabled={busy}>
            <Settings2 className="mr-1.5 size-3.5" strokeWidth={1.5} /> Move dates
          </Button>
        )}

        {canPropose && !canManage && (
          <Button variant="secondary" size="sm" onClick={() => onPropose(entry)} disabled={busy}>
            <Settings2 className="mr-1.5 size-3.5" strokeWidth={1.5} /> {pending ? 'Update your proposal' : 'Propose a change'}
          </Button>
        )}
      </div>

      {/* A supplier's proposed change, awaiting the buyer's decision. Neither
          audience acts on the live schedule below until this is resolved —
          the buyer approves or rejects it here; the supplier just sees that
          it is pending, since a re-propose already overwrites it. */}
      {pending && (
        <div className="rounded-md border border-warning/30 bg-warning-tint px-4 py-3.5">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <CalendarClock className="size-4 text-warning" strokeWidth={1.5} aria-hidden="true" /> Proposed change awaiting approval
              </p>
              <p className="mt-1 text-sm text-fg-muted">
                {canManage
                  ? `Proposed by ${pending.requestedBy} on ${prettyDay(pending.requestedAt)}. The schedule below is still what SAP holds — nothing changes until you approve or reject it.`
                  : `Sent ${prettyDay(pending.requestedAt)}. Your buyer has not decided yet — the schedule below is still what is actually billable.`}
              </p>
              <ul className="mt-2 space-y-0.5">
                {(pending.input.type === 'Periodic'
                  ? [`Periodic · ${pending.input.frequency} · ${day(pending.input.startDate)} to ${day(pending.input.endDate)}${pending.input.periodicAmount ? ` · ${money(pending.input.periodicAmount, currency)}/period` : ''}`]
                  : (pending.input.milestones || []).map((m, i) =>
                    `${m.description || `Instalment ${i + 1}`} · ${day(m.settlementDate)} · ${m.percentage}%`)
                ).map((line, i) => (
                  <li key={i} className="mono text-sm text-fg">{line}</li>
                ))}
              </ul>
            </div>
            {canManage && (
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRejectProposal(entry)}>
                  Reject
                </Button>
                <Button size="sm" disabled={busy} onClick={() => onApproveProposal(entry)}>
                  <Check className="mr-1.5 size-3.5" strokeWidth={1.5} /> Approve & save to SAP
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <KPIStrip>
        <KPICard label="Plan total" value={money(summary?.totalValue, currency)} hint={`${summary?.totalLines || 0} invoicing dates`} />
        <KPICard label="Invoiced" value={money(summary?.invoicedValue, currency)} hint={`${summary?.invoicedLines || 0} of ${summary?.totalLines || 0}`} />
        <KPICard label="Outstanding" value={money(summary?.openValue, currency)} hint={summary?.blockedLines ? `${summary.blockedLines} blocked` : 'Not yet invoiced'} />
        <KPICard
          label={summary?.dueLines ? 'Billable now' : 'Next date'}
          value={summary?.dueLines ? money(summary.dueValue, currency) : prettyDay(summary?.nextDueDate)}
          hint={summary?.dueLines ? `${summary.dueLines} date${summary.dueLines === 1 ? '' : 's'} open` : (summary?.complete ? 'Plan complete' : 'Not yet due')}
          empty={false}
        />
      </KPIStrip>

      <div
        className="h-1 overflow-hidden rounded-full bg-subtle"
        role="progressbar"
        aria-label={`Line ${entry.line} invoiced`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(100, progress))}
      >
        <div className="h-full bg-accent-solid" style={{ width: `${Math.min(100, progress)}%` }} />
      </div>

      <DataTable
        caption={`Invoicing dates for line ${entry.line}`}
        columns={columns}
        rows={plan.lines || []}
        getRowId={(line) => line.lineNumber}
        rowLabel={(line) => `date ${line.lineNumber}`}
        empty="No invoicing dates on this plan."
      />
    </section>
  );
}

// --- The panel --------------------------------------------------------------

export default function InvoicePlanPanel({ po, canManage = false, canPropose = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [configuring, setConfiguring] = useState(null); // { item, plan, mode }
  const [rejecting, setRejecting] = useState(null); // entry

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

  return (
    <div className="space-y-8">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold text-fg">Invoicing plan</h2>
          <p className="mt-1 text-sm text-fg-muted">
            {canManage
              ? 'Line items billed on a schedule rather than against a goods receipt, as SAP configured it. You can move a plan\'s dates and sync what SAP holds — the schedule itself is set in SAP.'
              : canPropose
                ? 'These line items are billed on a schedule agreed with your buyer, not against a delivery. Raise an invoice on each date as it comes due, or propose a change if the schedule needs to move.'
                : 'These line items are billed on a schedule agreed with your buyer, not against a delivery. Raise an invoice on each date as it comes due.'}
          </p>
        </div>
        {canManage && (
          <Button variant="secondary" size="sm" disabled={busy}
            onClick={() => run(() => poService.syncInvoicePlan(po.id))}>
            <RefreshCw className={`mr-1.5 size-3.5 ${busy ? 'animate-spin' : ''}`} strokeWidth={1.5} /> Sync from SAP
          </Button>
        )}
      </div>

      {notice?.text && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {loading ? (
        <div className="flex items-center justify-center py-14 text-fg-subtle" role="status" aria-label="Loading the invoicing plan">
          <Loader2 className="size-5 animate-spin" strokeWidth={1.5} />
        </div>
      ) : !data?.items?.length ? (
        <EmptyState
          icon={CalendarClock}
          title="No invoicing plan on this order"
          description="Every line on this order is invoiced against its goods receipt or delivery. A plan reaches a line only through SAP — raise one there, then Sync from SAP to adopt it."
        />
      ) : (
        data.items.map((entry) => (
          <PlanCard
            key={entry.line}
            po={po}
            entry={entry}
            canManage={canManage}
            canPropose={canPropose}
            busy={busy}
            onConfigure={(target) => setConfiguring({ item: target, plan: target.plan, mode: 'manage' })}
            onToggleBlock={(target, line, blocked) =>
              run(() => poService.setInvoicePlanLineBlock(po.id, target.line, line.lineNumber, blocked))}
            onPropose={(target) => setConfiguring({ item: target, plan: target.plan, mode: 'propose' })}
            onApproveProposal={(target) =>
              run(() => poService.approveInvoicePlanChange(po.id, target.line), 'Proposed change approved and saved to SAP')}
            onRejectProposal={(target) => setRejecting(target)}
          />
        ))
      )}

      {configuring && (
        <ConfigureDialog
          po={po}
          item={configuring.item}
          existingPlan={configuring.plan}
          mode={configuring.mode}
          onClose={() => setConfiguring(null)}
          onSaved={(result) => {
            setConfiguring(null);
            setNotice({ tone: 'success', text: result?.message });
            reload();
          }}
        />
      )}

      {rejecting && (
        <RejectProposalDialog
          po={po}
          entry={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={(result) => {
            setRejecting(null);
            setNotice({ tone: 'success', text: result?.message });
            reload();
          }}
        />
      )}
    </div>
  );
}
