'use client';

import React, { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { Notice, Field } from '@/components/platform/primitives';

// Where an operator's reset email lands. No session is involved: the token in
// the link is the only credential, and it is single-use.

function ResetForm() {
  const token = useSearchParams().get('token') || '';
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (form.password !== form.confirm) throw new Error('The two passwords do not match.');
      await platformApi.resetPassword(token, form.password);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-[440px] card p-8">
      <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">VendorConnect Platform</p>
      <h1 className="mb-6 mt-2 text-xl font-semibold tracking-tight text-text-primary">Choose a new password</h1>

      <Notice onDismiss={() => setError('')}>{error}</Notice>

      {done ? (
        <div className="flex items-start gap-2.5 text-[13px] text-text-secondary">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-text" />
          <span>
            Your password has been reset.{' '}
            <Link href="/platform" className="text-emerald-text hover:underline">Sign in</Link> — you will still need your authenticator.
          </span>
        </div>
      ) : !token ? (
        <p className="text-[13px] text-text-secondary">This link is missing its token. Request a new reset email from the sign-in screen.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" type="password" required minLength={6} autoComplete="new-password" disabled={busy}
            hint="At least six characters."
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <Field label="Confirm password" type="password" required autoComplete="new-password" disabled={busy}
            value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          <button type="submit" className="btn btn-v h-10 w-full justify-center disabled:opacity-50" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Set password'}
          </button>
        </form>
      )}
    </div>
  );
}

export default function PlatformResetPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4 py-10">
      {/* useSearchParams needs a suspense boundary when the page is prerendered. */}
      <Suspense fallback={<Loader2 className="size-5 animate-spin text-text-tertiary" />}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
