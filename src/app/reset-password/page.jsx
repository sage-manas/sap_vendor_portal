'use client';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { KeyRound, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AuthHeader } from '@/components/portal/WorkspaceBrand';
import PasswordChecklist from '@/components/ui/PasswordChecklist';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('This reset link is missing its token. Please request a new one.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${apiUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || Object.values(data.errors || {})[0] || 'Reset failed');
      }

      setSuccess(true);
      setTimeout(() => router.push('/sign-in'), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
      <AuthHeader title="Set a new password" />

      {error && (
        <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-fg">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {success ? (
        <div role="status" className="flex items-start gap-2.5 rounded-md border border-success/30 bg-success-tint p-4 text-sm text-fg">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />
          <span>Password reset. Taking you to sign in…</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="reset-1">
              New password
            </label>
            <div className="relative">
              <input id="reset-1"
                aria-describedby="reset-1-rules"
                type="password"
                required
                minLength={10}
                disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <PasswordChecklist value={password} id="reset-1-rules" />
          </div>

          <div>
            <label className="label" htmlFor="reset-2">
              Confirm new password
            </label>
            <div className="relative">
              <input id="reset-2"
                type="password"
                required
                disabled={loading}
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
            disabled={loading}
            className="btn btn-v w-full h-10 justify-center disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Resetting…</span>
              </>
            ) : (
              <>
                <span>Reset password</span>
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      )}

      {/* Footer nav */}
      <div className="mt-8 border-t border-border pt-6 text-center">
        <p className="text-sm text-fg-muted">
          <Link
            href="/sign-in"
            className="text-accent-text hover:underline transition-colors duration-150 font-medium"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
