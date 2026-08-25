'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, KeyRound, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import WorkspaceBrand from '@/components/portal/WorkspaceBrand';
import { useWorkspaceRealm } from '@/lib/workspace-realm';

export default function SignInPage() {
  const router = useRouter();
  const { workspace, selfRegistrationOpen } = useWorkspaceRealm();
  const [vendorIdOrEmail, setVendorIdOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('jwt_token');
      if (token) {
        // Only a supplier login cached a vendor profile — tenant staff
        // belong on the back office, not the supplier portal home.
        router.push(localStorage.getItem('sap_vendor_profile_data') ? '/' : '/workspace');
      }
    }
  }, [router]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!vendorIdOrEmail || !password) {
      setError('Please enter both credentials.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorIdOrEmail, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.errors?.vendorIdOrEmail || data.errors?.password || 'Authentication failed');
      }

      // Save the token. Tenant staff (client_admin/buyer/finance) get back
      // `user`, not `vendor` — only a supplier login carries a vendor profile
      // to cache, and only a supplier belongs on the supplier portal home.
      localStorage.setItem('jwt_token', data.token);

      if (data.vendor) {
        localStorage.setItem('clerk_user_id', data.vendor.vendorId);
        localStorage.setItem('sap_vendor_profile_data', JSON.stringify(data.vendor));
        router.push('/');
      } else {
        router.push('/workspace');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
      {/* Whose front door this is (workspace-realm.js) */}
      <WorkspaceBrand workspace={workspace} caption="Supplier portal · VendorConnect" />

      {/* Form Error Message */}
      {error && (
        <div className="p-3 mb-5 rounded-none bg-rose-900/20 border border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-400">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Login Form */}
      <form onSubmit={handleLogin} className="space-y-4">
        <div>
          <label className="label">
            Vendor ID or Registered Email
          </label>
          <div className="relative">
            <input
              type="text"
              required
              disabled={loading}
              placeholder="VND-40012 or partner@domain.com"
              value={vendorIdOrEmail}
              onChange={(e) => setVendorIdOrEmail(e.target.value)}
              className="pl-9 disabled:opacity-55"
            />
            <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1.5">
            <label className="label mb-0">
              Password
            </label>
            <Link
              href="/forgot-password"
              className="text-[10px] font-semibold text-emerald-400 hover:opacity-80 transition-opacity duration-150"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <input
              type="password"
              required
              disabled={loading}
              placeholder="••••••••"
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
              <span>Verifying Credentials...</span>
            </>
          ) : (
            <>
              <span>Sign In to Portal</span>
              <ArrowRight className="size-4" />
            </>
          )}
        </button>
      </form>

      {/* Footer onboarding links. A workspace that admits suppliers by
          invitation only has no register link to offer. */}
      <div className="mt-8 pt-6 border-t border-border text-center">
        {selfRegistrationOpen ? (
          <p className="text-[11px] text-text-tertiary">
            New vendor partner?{' '}
            <Link
              href="/sign-up"
              className="text-emerald-400 hover:underline transition-colors duration-150 font-medium ml-1"
            >
              Register Profile
            </Link>
          </p>
        ) : (
          <p className="text-[11px] text-text-tertiary">
            This workspace admits suppliers by invitation. Contact your buyer for an invite.
          </p>
        )}
      </div>
    </div>
  );
}
