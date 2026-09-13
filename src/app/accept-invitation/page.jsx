'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Building2, KeyRound, User, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

// Where an invited colleague or supplier lands from their email. The backend
// decides which of the two they are: `POST /auth/invitations/accept` creates the
// account outright for tenant staff, and answers `next: 'register'` for a
// supplier, who still has to fill in the onboarding form (the invitation only
// buys them entry into a workspace that has closed self-registration).

const apiUrl = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

const readError = (data) =>
  data?.error || Object.values(data?.errors || {})[0] || 'Something went wrong';

function AcceptInvitationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [invitation, setInvitation] = useState(null);
  const [fetchError, setFetchError] = useState('');

  // A link with no token at all is a property of the URL, not something that
  // has to be discovered by asking the server — so it is derived here rather
  // than pushed into state from an effect, which is both a wasted render and a
  // rule React Compiler enforces. `loadError` is what the page renders: this
  // message when the link is malformed, otherwise whatever the preview failed
  // with.
  const missingToken = token
    ? ''
    : 'This invitation link is missing its token. Ask for a new invitation.';
  const loadError = missingToken || fetchError;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  // Preview the invitation before asking for a password, so an expired or
  // revoked link says so rather than failing after the form is filled in.
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${apiUrl()}/auth/invitations/${encodeURIComponent(token)}`);
        const data = await response.json();
        if (cancelled) return;
        if (!response.ok) throw new Error(readError(data));
        setInvitation(data.invitation);
        setName(data.invitation.name || '');
      } catch (err) {
        if (!cancelled) setFetchError(err.message);
      }
    })();

    return () => { cancelled = true; };
  }, [token]);

  const submit = async (event) => {
    event.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`${apiUrl()}/auth/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(readError(data));

      // A supplier is handed off to registration: the invitation admits them,
      // the onboarding form is still theirs to complete.
      if (data.next === 'register') {
        setDone('Invitation accepted. Taking you to registration…');
        const query = new URLSearchParams({ email: data.email || '' });
        if (data.workspace?.slug) query.set('workspace', data.workspace.slug);
        setTimeout(() => router.push(`/sign-up?${query}`), 1200);
        return;
      }

      localStorage.setItem('jwt_token', data.token);
      setDone('Account created. Taking you to your workspace…');
      setTimeout(() => router.push('/workspace'), 1200);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
      <div className="flex flex-col items-center mb-8">
        <div className="size-12 rounded-none flex items-center justify-center text-white mb-3 shrink-0" style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}>
          <Building2 className="size-6" />
        </div>
        <h2 className="text-xl font-bold text-text-primary tracking-wide">Accept Your Invitation</h2>
        <p className="text-[10px] text-text-tertiary font-mono tracking-wider uppercase mt-1">
          SUPPLIER PARTNER PORTAL
        </p>
      </div>

      {loadError && (
        <div className="p-3 mb-5 rounded-none bg-rose-900/20 border border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-400">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {!loadError && !invitation && (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-text-tertiary">
          <Loader2 className="size-4 animate-spin" />
          <span>Checking your invitation…</span>
        </div>
      )}

      {invitation && (
        <>
          <div className="mb-5 p-3 border border-border bg-surface2 text-xs space-y-1">
            <p className="text-text-secondary">
              <span className="text-text-tertiary">Joining</span>{' '}
              <span className="font-bold text-text-primary">{invitation.companyName}</span>
            </p>
            <p className="text-text-secondary">
              <span className="text-text-tertiary">As</span>{' '}
              <span className="mono text-text-primary">{invitation.role}</span>
            </p>
            <p className="text-text-secondary">
              <span className="text-text-tertiary">Email</span>{' '}
              <span className="mono text-text-primary">{invitation.email}</span>
            </p>
          </div>

          {error && (
            <div className="p-3 mb-5 rounded-none bg-rose-900/20 border border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-400">
              <AlertCircle className="size-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {done ? (
            <div className="p-4 rounded-none bg-emerald-900/10 border border-emerald-900/40 flex items-start gap-2.5 text-xs text-emerald-400">
              <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
              <span>{done}</span>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label" htmlFor="invite-1">Your Name</label>
                <div className="relative">
                  <input id="invite-1"
                    type="text"
                    required
                    disabled={busy}
                    placeholder="Full name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="pl-9 disabled:opacity-55"
                  />
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="invite-2">Choose a Password</label>
                <div className="relative">
                  <input id="invite-2"
                    type="password"
                    required
                    disabled={busy}
                    placeholder="Min 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9 disabled:opacity-55"
                  />
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="invite-3">Confirm Password</label>
                <div className="relative">
                  <input id="invite-3"
                    type="password"
                    required
                    disabled={busy}
                    placeholder="Re-enter password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="pl-9 disabled:opacity-55"
                  />
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="btn btn-v w-full h-10 justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    <span>Creating Your Account…</span>
                  </>
                ) : (
                  <>
                    <span>Accept Invitation</span>
                    <ArrowRight className="size-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </>
      )}

      <div className="mt-8 pt-6 border-t border-border text-center">
        <p className="text-[11px] text-text-tertiary">
          Already have an account?{' '}
          <Link href="/sign-in" className="text-emerald-400 hover:underline transition-colors duration-150 font-medium">
            Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={null}>
      <AcceptInvitationForm />
    </Suspense>
  );
}
