'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ArrowRight, Loader2, AlertCircle, ShieldAlert } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useWhoami, forgetWhoami } from '@/lib/whoami';
import { AuthHeader } from '@/components/portal/WorkspaceBrand';
import PasswordChecklist from '@/components/ui/PasswordChecklist';

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
      const { token } = await apiClient.post('/auth/change-password', { currentPassword, newPassword });
      // The backend just invalidated every token issued before this moment
      // (issue #74's passwordChangedAt check) — including the one this very
      // request was authenticated with. Store the fresh one it returns so
      // this session continues instead of the next request 401ing.
      if (token) localStorage.setItem('jwt_token', token);
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
        <AuthHeader title="Change your password" />

        {mustChangePassword && (
          <div role="status" className="mb-5 flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning-tint p-3 text-sm text-fg">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.5} aria-hidden="true" />
            <span>
              You are signed in with the temporary password from your invitation
              email. Choose your own before continuing.
            </span>
          </div>
        )}

        {error && (
          <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger-tint p-3 text-sm text-fg">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label" htmlFor="change-password-1">Current password</label>
            <div className="relative">
              <input id="change-password-1"
                type="password"
                required
                disabled={busy}
                placeholder="The one you were emailed"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="change-password-2">New password</label>
            <div className="relative">
              <input id="change-password-2"
                aria-describedby="change-password-2-rules"
                type="password"
                required
                minLength={10}
                disabled={busy}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="pl-9 disabled:opacity-55"
              />
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
            </div>
            <PasswordChecklist value={newPassword} id="change-password-2-rules" />
          </div>

          <div>
            <label className="label" htmlFor="change-password-3">Confirm new password</label>
            <div className="relative">
              <input id="change-password-3"
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
                <span>Saving…</span>
              </>
            ) : (
              <>
                <span>Change password</span>
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
