'use client';

import React, { useState } from 'react';
import { Landmark, ShieldCheck, Clock, AlertTriangle } from 'lucide-react';
import { validateFields } from '../validation';
// Owns the label/control association, so this form cannot forget it — see the
// header on that file for why it exists.
import FieldCard from '@/components/ui/FieldCard';

// Finding 4.2: the supplier side of the bank-account change review.
//
// The review flow has existed since issue #53 — a change to any of the five
// payout columns on an *Approved* supplier is diverted into
// `Vendor.pendingBankChange` and has to be approved by the tenant, who then
// confirms it was entered in SAP (vendor.controller.js's approveBankChange /
// confirmBankChangeInSap, and the workspace supplier detail page). Every part
// of that worked except the first one: an approved supplier's own screen was a
// read-only summary with their account masked and no way to ask for a change
// at all, so the only route was emailing someone.
//
// So this is a form over an endpoint that already does the right thing. It
// sends the five fields through the same `PUT /vendors/profile` the
// registration form uses, and the server decides they are a request rather
// than a write. Nothing here can apply a change — deliberately: the whole
// point of #53 is that the payout account is the most exploited fraud vector
// in AP, so the client is not trusted to know whether a change is pending,
// only to show what the server reports.

const FIELDS = ['accountName', 'accountNumber', 'ifscCode', 'bankName', 'bankBranch'];

const LABELS = {
  accountName: 'Account holder name',
  accountNumber: 'Bank account number',
  ifscCode: 'IFSC code',
  bankName: 'Bank name',
  bankBranch: 'Bank branch',
};

// Last four only, matching how the approved-profile summary already shows it.
// A supplier knows their own account number; printing it in full earns
// nothing and puts it on a screen in an open-plan office.
const masked = (value) => (value ? `••••${String(value).slice(-4)}` : '—');

const formFrom = (profile) => ({
  accountName: profile.accountName || '',
  accountNumber: '',
  ifscCode: profile.ifscCode || '',
  bankName: profile.bankName || '',
  bankBranch: profile.bankBranch || '',
});

/**
 * @param profile the supplier's own profile, as GET /vendors/profile returns
 *                it — including `pendingBankChange`, which the API exposes
 *                un-nested precisely so a caller can tell a pending request
 *                apart from the live account it would replace.
 * @param onSubmit (fields) => Promise<{ success, error }>, which the caller
 *                 wires to saveDraft/updateProfile.
 */
export function BankChangeRequest({ profile, onSubmit }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => formFrom(profile));
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const pending = profile.pendingBankChange || null;
  // Approved and already in SAP's own vendor master: the buyer has accepted
  // the change and is waiting to key it into XK02. At that point the request
  // is no longer the supplier's to replace.
  const awaitingSap = Boolean(pending?.sapApproval);

  const change = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear only this field's error, so correcting one does not blank the
    // others' messages while they are still wrong.
    setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const found = validateFields(FIELDS, form);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    setBusy(true);
    setFailure('');
    try {
      const res = await onSubmit(form);
      if (res?.success === false) {
        setFailure(res.error || 'Your request could not be sent. Please try again.');
        return;
      }
      setDone(true);
      setOpen(false);
    } catch (err) {
      setFailure(err?.message || 'Your request could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 card space-y-4">
      <div className="flex items-start justify-between gap-4 border-b border-border pb-2">
        <h3 className="label mb-0 flex items-center gap-2">
          <Landmark className="size-3.5 text-text-tertiary" aria-hidden="true" />
          Bank account
        </h3>
        {!open && !awaitingSap && (
          <button type="button" className="btn btn-o h-7 text-[11px]" onClick={() => {
            setForm(formFrom(profile));
            setErrors({});
            setFailure('');
            setDone(false);
            setOpen(true);
          }}>
            {pending ? 'Replace request' : 'Request a change'}
          </button>
        )}
      </div>

      {/* What SAP will actually pay today. Stated plainly, because a pending
          request below it could otherwise read as already in effect. */}
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-xs md:grid-cols-2">
        <div className="flex justify-between gap-4 border-b border-border-subtle pb-2">
          <dt className="font-bold text-text-secondary">Paid to</dt>
          <dd className="font-mono font-semibold text-text-primary">{masked(profile.accountNumber)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border-subtle pb-2">
          <dt className="font-bold text-text-secondary">Bank</dt>
          <dd className="font-semibold text-text-primary">
            {profile.bankName || '—'}{profile.ifscCode ? ` (${profile.ifscCode})` : ''}
          </dd>
        </div>
      </dl>

      {done && !pending && (
        <p className="text-xs text-text-secondary" role="status">
          Your request has been sent. It takes effect once your buyer approves it and records it in SAP.
        </p>
      )}

      {pending && (
        <div className="space-y-2 rounded border border-border p-3" style={{ backgroundColor: 'var(--color-amber-dim, transparent)' }}>
          <p className="flex items-center gap-2 text-xs font-bold text-text-primary">
            {awaitingSap
              ? <ShieldCheck className="size-3.5 text-emerald-400" aria-hidden="true" />
              : <Clock className="size-3.5 text-text-tertiary" aria-hidden="true" />}
            {awaitingSap
              ? 'Approved — being recorded in your buyer’s SAP system'
              : 'Awaiting your buyer’s approval'}
          </p>
          <p className="text-[11px] leading-normal text-text-tertiary">
            {awaitingSap
              ? 'Your buyer has approved this change. Payments move to the new account once it is recorded in SAP, which is why the account above has not changed yet.'
              : 'Payments still go to the account above until this is approved and recorded in SAP.'}
          </p>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 pt-1 text-[11px] md:grid-cols-2">
            {FIELDS.filter((field) => field in pending).map((field) => (
              <div key={field} className="flex justify-between gap-4">
                <dt className="font-bold text-text-secondary">{LABELS[field]}</dt>
                <dd className="font-mono font-semibold text-text-primary">
                  {field === 'accountNumber' ? masked(pending[field]) : pending[field]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-4 border-t border-border pt-4" noValidate>
          {pending && !awaitingSap && (
            <p className="flex items-start gap-2 text-[11px] leading-normal text-text-secondary">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              {/* The server overwrites pendingBankChange rather than refusing a
                  second request, so saying this is the difference between a
                  supplier correcting a typo on purpose and discarding their
                  earlier request without realising. */}
              Sending this replaces the request already awaiting approval.
            </p>
          )}

          <FieldCard label={LABELS.accountName} required error={errors.accountName}>
            <input
              type="text"
              maxLength={60}
              value={form.accountName}
              onChange={(e) => change('accountName', e.target.value)}
              className="w-full"
            />
          </FieldCard>

          <FieldCard
            label={LABELS.accountNumber}
            required
            error={errors.accountNumber}
            hint="Entered in full so your buyer can verify it against your cancelled cheque."
          >
            <input
              type="text"
              inputMode="numeric"
              maxLength={18}
              // Re-typed rather than pre-filled: the whole purpose of the
              // field is to state a new account, and pre-filling the old one
              // invites a submit that changes nothing.
              value={form.accountNumber}
              onChange={(e) => change('accountNumber', e.target.value.replace(/\D/g, ''))}
              className="w-full font-mono"
            />
          </FieldCard>

          <FieldCard label={LABELS.ifscCode} required error={errors.ifscCode}>
            <input
              type="text"
              maxLength={11}
              value={form.ifscCode}
              onChange={(e) => change('ifscCode', e.target.value.toUpperCase())}
              className="w-full font-mono uppercase"
            />
          </FieldCard>

          <FieldCard label={LABELS.bankName} required error={errors.bankName}>
            <input
              type="text"
              maxLength={60}
              value={form.bankName}
              onChange={(e) => change('bankName', e.target.value)}
              className="w-full"
            />
          </FieldCard>

          <FieldCard label={LABELS.bankBranch} required error={errors.bankBranch}>
            <input
              type="text"
              maxLength={60}
              value={form.bankBranch}
              onChange={(e) => change('bankBranch', e.target.value)}
              className="w-full"
            />
          </FieldCard>

          {failure && <p className="text-[11px] text-red-600" role="alert">{failure}</p>}

          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-v h-9" disabled={busy}>
              {busy ? 'Sending…' : 'Send request'}
            </button>
            <button type="button" className="btn btn-o h-9" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default BankChangeRequest;
