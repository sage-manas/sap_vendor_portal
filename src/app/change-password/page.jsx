'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, KeyRound, ArrowRight, Loader2, AlertCircle, ShieldAlert } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useWhoami, forgetWhoami } from '@/lib/whoami';

// Where an account provisioned with a temporary password lands. Tenant
// administrators are created by the platform console and suppliers by their
// buyer, both with a generated password emailed once; until it is replaced the
// portal sends them here (see the redirect in lib/portal-context.js).
//
// The platform console has its own equivalent inside PlatformGate — different
// plane, different session, same rule.

export default function ChangePasswordPage() {
  const router = useRouter();
  const { mustChangePassword, isTenantStaff } = useWhoami();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Choose a password different from the temporary one.');
      return;
    }

    setBusy(true);
    try {
      await apiClient.post('/auth/change-password', { currentPassword, newPassword });
      // The cached session still says the password is temporary; drop it so the
      // next read reflects the change rather than bouncing straight back here.
      forgetWhoami();
      router.push(isTenantStaff ? '/workspace' : '/');
    } catch (err) {
      setError(err?.message || 'Could not change your password. Check the current one and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start justify-center py-10 px-4">
      <div className="w-full max-w-[420px] p-8 card animate-fadeUp">
        <div className="flex flex-col items-center mb-8">
          <div className="size-12 rounded-none flex items-center justify-center text-white mb-3 shrink-0" style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}>
            <Building2 className="size-6" />
          </div>
          <h2 className="text-xl font-bold text-text-primary tracking-wide">Change Your Password</h2>
          <p className="text-[10px] text-text-tertiary font-mono tracking-wider uppercase mt-1">
            SUPPLIER PARTNER PORTAL
          </p>
        </div>

        {mustChangePassword && (
          <div className="p-3 mb-5 rounded-none bg-amber-900/20 border border-amber-900/50 flex items-start gap-2.5 text-xs text-amber-400">
            <ShieldAlert className="size-4 shrink-0 mt-0.5" />
            <span>
              You are signed in with the temporary password from your invitation
              email. Choose your own before continuing.
            </span>
          </div>
        )}

        {error && (
          <div className="p-3 mb-5 rounded-none bg-rose-900/20 border border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-400">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Current Password</label>
            <div className="relative">
              <input
                type="password"
                required
                disabled={busy}
                placeholder="The one you were emailed"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
            </div>
          </div>

          <div>
            <label className="label">New Password</label>
            <div className="relative">
              <input
                type="password"
                required
                disabled={busy}
                placeholder="Min 6 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
            </div>
          </div>

          <div>
            <label className="label">Confirm New Password</label>
            <div className="relative">
              <input
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
                <span>Saving…</span>
              </>
            ) : (
              <>
                <span>Change Password</span>
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
