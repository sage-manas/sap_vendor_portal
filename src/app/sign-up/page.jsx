'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, KeyRound, Mail, ArrowRight, Loader2, AlertCircle, MailCheck } from 'lucide-react';
import WorkspaceBrand from '@/components/portal/WorkspaceBrand';
import { useWorkspaceRealm } from '@/lib/workspace-realm';
import { currentSlug, withWorkspace } from '@/lib/workspace-slug';
import PasswordChecklist from '@/components/ui/PasswordChecklist';

export default function SignUpPage() {
  const router = useRouter();
  const { workspace, known, slug, selfRegistrationOpen, workspaceRequired } = useWorkspaceRealm();
  // Which workspace this registration joins, said in words. An unbranded tenant
  // is still a named one; only a screen that resolved no workspace at all names
  // none, and that screen does not offer the form (#255).
  const workspaceName = workspace?.companyName || null;
  const joining = workspaceName
    ? `This registration creates a supplier account in ${workspaceName}'s workspace on VendorConnect.`
    : null;
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gstin, setGstin] = useState('');
  const [pan, setPan] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submittedTo, setSubmittedTo] = useState('');

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

    // The realm answer decides which workspace this account joins, so nothing
    // is posted before it arrives. Without it the screen cannot say whose
    // workspace the supplier would be joining, and that is the whole point of
    // naming it (#255).
    if (!known) {
      setError('Still working out which workspace this registration joins. Try again in a moment.');
      return;
    }

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
      // Under account tenancy the link says which workspace this registers
      // into; under subdomain tenancy the address does and this is ignored.
      const response = await fetch(`${apiUrl}${withWorkspace('/auth/register', currentSlug())}`, {
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

      // No session comes back: the account exists once the emailed link is
      // followed. The answer is the same whether or not the address was already
      // known, so this screen says only what is true in both cases.
      setSubmittedTo(email);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (submittedTo) {
    return (
      <div className="w-full max-w-[460px] p-8 card animate-fadeUp my-8">
        <WorkspaceBrand
          workspace={workspace}
          caption="Supplier registration"
          naming={workspaceName ? `Your registration was sent to ${workspaceName}'s workspace on VendorConnect.` : null}
        />
        <div role="status" className="flex items-start gap-2.5 rounded-md border border-success/30 bg-success-tint p-4 text-sm text-fg">
          <MailCheck className="size-4 shrink-0 mt-0.5" />
          <span>
            Check your email. If {submittedTo} can be registered, a confirmation link is on its way —
            open it and enter your password to finish creating your account.
          </span>
        </div>
        <div className="mt-6 pt-5 border-t border-border text-center">
          <Link href={withWorkspace('/sign-in', slug)} className="text-sm font-medium text-accent-text hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  // Two reasons there is no form to fill in: no workspace resolved at all, so
  // the registration has nowhere to go and the API refuses it (#254); or a
  // resolved workspace that has closed self-service registration
  // (config/tenantSettings.js). Either way a supplier reads the reason instead
  // of posting into a guess.
  if (known && !selfRegistrationOpen) {
    return (
      <div className="w-full max-w-[460px] p-8 card animate-fadeUp my-8">
        <WorkspaceBrand
          workspace={workspace}
          caption={workspaceRequired ? 'No workspace named' : 'Registration by invitation'}
          naming={workspaceName ? `${workspaceName}'s supplier workspace on VendorConnect.` : null}
        />
        <p className="text-center text-sm text-fg-muted">
          {workspaceRequired
            ? 'This address names no workspace, so there is nothing to register into. Registration starts from the link your buying organisation shares with its suppliers. Ask your contact there to send it — it brings you straight to onboarding.'
            : 'This workspace admits suppliers by invitation. Ask your contact in the buying organisation to send you one — the invitation link brings you straight to onboarding.'}
        </p>
        <div className="mt-6 pt-5 border-t border-border text-center">
          <Link href={withWorkspace('/sign-in', slug)} className="text-sm font-medium text-accent-text hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[460px] p-8 card animate-fadeUp my-8">
      {/* Whose front door this is (workspace-realm.js), named in words as well
          as in branding — the form below binds the account to it. */}
      <WorkspaceBrand workspace={workspace} caption="Supplier registration" naming={joining} />

      {/* Error Output */}
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-fg">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Onboarding Form */}
      <form onSubmit={handleRegister} className="space-y-3.5">
        <div className="grid grid-cols-1 gap-3.5">
          {/* Company Name */}
          <div>
            <label className="label" htmlFor="signup-company">
              Company registered name
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
              <Building2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle" />
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
              <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle" />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="label" htmlFor="signup-password">
              Create password
            </label>
            <div className="relative">
              <input id="signup-password"
                aria-describedby="signup-password-rules"
                type="password"
                required
                minLength={10}
                disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-8.5"
              />
              <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle" />
            </div>
            <PasswordChecklist value={password} id="signup-password-rules" />
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
          disabled={loading || !known}
          className="btn btn-v w-full h-9 justify-center disabled:opacity-50 disabled:cursor-not-allowed mt-2"
        >
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              <span>Creating your account…</span>
            </>
          ) : (
            <>
              <span>Create account</span>
              <ArrowRight className="size-4" />
            </>
          )}
        </button>
      </form>

      {/* Footer login redirect */}
      <div className="mt-6 pt-5 border-t border-border text-center">
        <p className="text-sm text-fg-muted">
          Already registered?{' '}
          <Link
            href={withWorkspace('/sign-in', slug)}
            className="text-accent-text hover:underline transition-colors duration-150 font-medium ml-1"
          >
            Sign In here
          </Link>
        </p>
      </div>
    </div>
  );
}
