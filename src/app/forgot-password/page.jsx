'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Building2, Mail, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

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
      {/* Brand Header */}
      <div className="flex flex-col items-center mb-8">
        <div className="size-12 rounded-none flex items-center justify-center text-white mb-3 shrink-0" style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}>
          <Building2 className="size-6" />
        </div>
        <h2 className="text-xl font-bold text-text-primary tracking-wide">Reset Your Password</h2>
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

      {submitted ? (
        <div className="p-4 rounded-none bg-emerald-900/10 border border-emerald-900/40 flex items-start gap-2.5 text-xs text-emerald-400">
          <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
          <span>If an account exists for that email, a password reset link has been sent.</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">
              Registered Email
            </label>
            <div className="relative">
              <input
                type="email"
                required
                disabled={loading}
                placeholder="partner@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
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
                <span>Sending Reset Link...</span>
              </>
            ) : (
              <>
                <span>Send Reset Link</span>
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      )}

      {/* Footer nav */}
      <div className="mt-8 pt-6 border-t border-border text-center">
        <p className="text-[11px] text-text-tertiary">
          Remembered your password?{' '}
          <Link
            href="/sign-in"
            className="text-emerald-400 hover:underline transition-colors duration-150 font-medium ml-1"
          >
            Sign In
          </Link>
        </p>
      </div>
    </div>
  );
}
