'use client';

import React, { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Building2, KeyRound, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

// Where a supplier lands from the confirmation email sent when they register.
// The link carries the token; the password they chose at registration is asked
// for as well, so that a link can only finish the registration for the person
// who started it (POST /api/auth/confirm-email).
function ConfirmEmailForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('This link is missing its token. Open the link from your email again.');
      return;
    }

    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${apiUrl}/auth/confirm-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || Object.values(data.errors || {})[0] || 'Confirmation failed');
      }

      setConfirmed(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
      <div className="flex flex-col items-center mb-8">
        <div className="size-12 rounded-none flex items-center justify-center text-white mb-3 shrink-0" style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}>
          <Building2 className="size-6" />
        </div>
        <h1 className="text-xl font-bold text-text-primary tracking-wide">Confirm Your Email</h1>
        <p className="text-[10px] text-text-tertiary font-mono tracking-wider uppercase mt-1">
          SUPPLIER PARTNER PORTAL
        </p>
      </div>

      {error && (
        <div className="p-3 mb-5 rounded-none bg-rose-900/20 border border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-400">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {confirmed ? (
        <div className="p-4 rounded-none bg-emerald-900/10 border border-emerald-900/40 flex items-start gap-2.5 text-xs text-emerald-400">
          <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
          <span>Email confirmed. You can now sign in.</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-xs text-text-secondary leading-relaxed">
            Enter the password you chose when you registered to finish creating your account.
          </p>
          <div>
            <label className="label" htmlFor="confirm-password">
              Your password
            </label>
            <div className="relative">
              <input id="confirm-password"
                type="password"
                required
                disabled={loading}
                placeholder="The password you registered with"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn btn-v w-full h-10 justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Confirming...</span>
              </>
            ) : (
              <>
                <span>Confirm email</span>
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      )}

      <div className="mt-8 pt-6 border-t border-border text-center">
        <p className="text-[11px] text-text-tertiary">
          <Link
            href="/sign-in"
            className="text-emerald-400 hover:underline transition-colors duration-150 font-medium"
          >
            Go to Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmEmailForm />
    </Suspense>
  );
}
