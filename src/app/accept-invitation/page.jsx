'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Building2, KeyRound, User, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { forgetWhoami } from '@/lib/whoami';
import { AuthHeader } from '@/components/portal/WorkspaceBrand';
import PasswordChecklist from '@/components/ui/PasswordChecklist';

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
        // A POST for a read, deliberately: the token is a credential and must
        // not sit in a URL that every access log on the way keeps (#248).
        const response = await fetch(`${apiUrl()}/auth/invitations/lookup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
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
      forgetWhoami();
      setDone('Account created. Taking you to your workspace…');
      setTimeout(() => router.push('/workspace'), 1200);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
      <AuthHeader title="Accept your invitation" />

      {loadError && (
        <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-fg">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
          <span>{loadError}</span>
        </div>
      )}

      {!loadError && !invitation && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted" role="status">
          <Loader2 className="size-4 animate-spin" />
          <span>Checking your invitation…</span>
        </div>
      )}

      {invitation && (
        <>
          <div className="mb-5 space-y-1 rounded-md border border-border bg-subtle p-3 text-sm">
            <p className="text-fg-muted">
              <span className="text-fg-subtle">Joining</span>{' '}
              <span className="font-bold text-fg">{invitation.companyName}</span>
            </p>
            <p className="text-fg-muted">
              <span className="text-fg-subtle">As</span>{' '}
              <span className="mono text-fg">{invitation.role}</span>
            </p>
            <p className="text-fg-muted">
              <span className="text-fg-subtle">Email</span>{' '}
              <span className="mono text-fg">{invitation.email}</span>
            </p>
          </div>

          {error && (
            <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-fg">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {done ? (
            <div role="status" className="flex items-start gap-2.5 rounded-md border border-success/30 bg-success-tint p-4 text-sm text-fg">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />
              <span>{done}</span>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label" htmlFor="invite-1">Your name</label>
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
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="invite-2">Choose a password</label>
                <div className="relative">
                  <input id="invite-2"
                aria-describedby="invite-2-rules"
                    type="password"
                    required
                    minLength={10}
                    disabled={busy}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9 disabled:opacity-55"
                  />
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                </div>
                <PasswordChecklist value={password} id="invite-2-rules" />
              </div>

              <div>
                <label className="label" htmlFor="invite-3">Confirm password</label>
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
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
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
                    <span>Creating your account…</span>
                  </>
                ) : (
                  <>
                    <span>Accept invitation</span>
                    <ArrowRight className="size-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </>
      )}

      <div className="mt-8 border-t border-border pt-6 text-center">
        <p className="text-sm text-fg-muted">
          Already have an account?{' '}
          <Link href="/sign-in" className="text-accent-text hover:underline transition-colors duration-150 font-medium">
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
