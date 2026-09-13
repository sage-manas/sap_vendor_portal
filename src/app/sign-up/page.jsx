'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, KeyRound, Mail, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import WorkspaceBrand from '@/components/portal/WorkspaceBrand';
import { useWorkspaceRealm } from '@/lib/workspace-realm';

export default function SignUpPage() {
  const router = useRouter();
  const { workspace, known, selfRegistrationOpen } = useWorkspaceRealm();
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gstin, setGstin] = useState('');
  const [pan, setPan] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('jwt_token');
      if (token) {
        router.push('/');
      }
    }
  }, [router]);

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');

    // Pre-validate GSTIN and PAN structure before submitting
    const gstinRegex = /^[0-9]{2}[A-Z0-9]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
    const panRegex = /^[A-Z0-9]{5}[0-9]{4}[A-Z]{1}$/i;

    if (!gstinRegex.test(gstin)) {
      setError('Invalid GSTIN format. Example: 27AAAAA1111A1Z1');
      return;
    }
    if (!panRegex.test(pan)) {
      setError('Invalid PAN format. Example: AAAAA1111A');
      return;
    }

    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${apiUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          email,
          password,
          gstin,
          pan
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || Object.values(data.errors || {})[0] || 'Registration failed');
      }

      // Save credentials and token
      localStorage.setItem('jwt_token', data.token);
      localStorage.setItem('clerk_user_id', data.vendor.vendorId);
      localStorage.setItem('sap_vendor_profile_data', JSON.stringify(data.vendor));

      // Route to dashboard
      router.push('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // A workspace can close self-service registration (config/tenantSettings.js).
  // The API refuses the POST either way; this is so a supplier reads the reason
  // instead of filling in a form that cannot be accepted.
  if (known && !selfRegistrationOpen) {
    return (
      <div className="w-full max-w-[460px] p-8 card animate-fadeUp my-8">
        <WorkspaceBrand workspace={workspace} caption="Registration by invitation" />
        <p className="text-xs text-text-secondary text-center leading-relaxed">
          This workspace admits suppliers by invitation. Ask your contact in the buying
          organisation to send you one — the invitation link brings you straight to onboarding.
        </p>
        <div className="mt-6 pt-5 border-t border-border text-center">
          <Link href="/sign-in" className="text-[11px] text-emerald-400 hover:underline font-medium">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[460px] p-8 card animate-fadeUp my-8">
      {/* Whose front door this is (workspace-realm.js) */}
      <WorkspaceBrand workspace={workspace} caption="Supplier registration" />

      {/* Error Output */}
      {error && (
        <div className="p-3 mb-4 rounded-none bg-rose-900/20 border border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-400">
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Onboarding Form */}
      <form onSubmit={handleRegister} className="space-y-3.5">
        <div className="grid grid-cols-1 gap-3.5">
          {/* Company Name */}
          <div>
            <label className="label" htmlFor="signup-company">
              Company Registered Name
            </label>
            <div className="relative">
              <input id="signup-company"
                type="text"
                required
                disabled={loading}
                placeholder="Acme Manufacturing Ltd"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="pl-8.5"
              />
              <Building2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-tertiary" />
            </div>
          </div>

          {/* Email */}
          <div>
            <label className="label" htmlFor="signup-email">
              Corporate Contact Email
            </label>
            <div className="relative">
              <input id="signup-email"
                type="email"
                required
                disabled={loading}
                placeholder="partner@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-8.5"
              />
              <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-tertiary" />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="label" htmlFor="signup-password">
              Create Password
            </label>
            <div className="relative">
              <input id="signup-password"
                type="password"
                required
                disabled={loading}
                placeholder="Min 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-8.5"
              />
              <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-tertiary" />
            </div>
          </div>

          {/* GSTIN & PAN Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="signup-gstin">
                GSTIN Number (India)
              </label>
              <input id="signup-gstin"
                type="text"
                required
                disabled={loading}
                placeholder="27AAAAA1111A1Z1"
                value={gstin}
                onChange={(e) => setGstin(e.target.value)}
                className="uppercase"
              />
            </div>
            <div>
              <label className="label" htmlFor="signup-pan">
                PAN Number
              </label>
              <input id="signup-pan"
                type="text"
                required
                disabled={loading}
                placeholder="AAAAA1111A"
                value={pan}
                onChange={(e) => setPan(e.target.value)}
                className="uppercase"
              />
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="btn btn-v w-full h-9 justify-center disabled:opacity-50 disabled:cursor-not-allowed mt-2"
        >
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              <span>Verifying and Onboarding...</span>
            </>
          ) : (
            <>
              <span>Create Account</span>
              <ArrowRight className="size-4" />
            </>
          )}
        </button>
      </form>

      {/* Footer login redirect */}
      <div className="mt-6 pt-5 border-t border-border text-center">
        <p className="text-[11px] text-text-tertiary">
          Already registered?{' '}
          <Link
            href="/sign-in"
            className="text-emerald-400 hover:underline transition-colors duration-150 font-medium ml-1"
          >
            Sign In here
          </Link>
        </p>
      </div>
    </div>
  );
}
