'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Mail, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { AuthHeader } from '@/components/portal/WorkspaceBrand';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${apiUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || Object.values(data.errors || {})[0] || 'Request failed');
      }

      setSubmitted(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
      <AuthHeader title="Reset your password" />

      {error && (
        <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-fg">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {submitted ? (
        <div role="status" className="flex items-start gap-2.5 rounded-md border border-success/30 bg-success-tint p-4 text-sm text-fg">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={1.5} aria-hidden="true" />
          <span>If an account exists for that email, a password reset link has been sent.</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label" htmlFor="forgot-1">
              Registered email
            </label>
            <div className="relative">
              <input id="forgot-1"
                type="email"
                required
                disabled={loading}
                placeholder="partner@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
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
                <span>Sending…</span>
              </>
            ) : (
              <>
                <span>Send reset link</span>
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      )}

      {/* Footer nav */}
      <div className="mt-8 border-t border-border pt-6 text-center">
        <p className="text-sm text-fg-muted">
          Remembered your password?{' '}
          <Link
            href="/sign-in"
            className="text-accent-text hover:underline transition-colors duration-150 font-medium ml-1"
          >Sign in</Link>
        </p>
      </div>
    </div>
  );
}
