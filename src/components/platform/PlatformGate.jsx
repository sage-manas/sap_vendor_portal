'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import { KeyRound, Loader2, AlertCircle, ShieldCheck, Mail } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { usePlatformSession, STAGE } from '@/lib/platform-session';

// The sign-in flow, in the order the server dictates it: password → forced
// change (if the credentials were issued) → enrol a second factor (if there
// isn't one) → type a code. Each step submits, adopts the returned token, and
// lets the session decide what comes next — the client never decides it is
// finished.

const Field = ({ label, hint, ...props }) => (
  <div>
    <label className="label">{label}</label>
    <input className="w-full" {...props} />
    {hint && <p className="mt-1.5 text-[11px] text-text-tertiary">{hint}</p>}
  </div>
);

const Panel = ({ title, caption, error, children }) => (
  <div className="w-full max-w-[440px] card p-8">
    <div className="mb-6">
      <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">VendorConnect Platform</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-text-primary">{title}</h1>
      {caption && <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">{caption}</p>}
    </div>

    {error && (
      <div role="alert" className="mb-5 flex items-start gap-2.5 border border-rose-500/50 bg-rose-500/10 p-3 text-xs text-rose-400">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{error}</span>
      </div>
    )}

    {children}
  </div>
);

const Submit = ({ busy, children }) => (
  <button type="submit" disabled={busy} className="btn btn-v h-10 w-full justify-center disabled:opacity-50">
    {busy ? <><Loader2 className="size-4 animate-spin" /><span>Working…</span></> : children}
  </button>
);

// Wraps a submit handler with the busy/error bookkeeping every step here needs.
const useStep = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, setError, run };
};

function SignIn() {
  const { adopt } = usePlatformSession();
  const { busy, error, run } = useStep();
  const [form, setForm] = useState({ email: '', password: '' });
  const [sentTo, setSentTo] = useState('');

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      const res = await platformApi.login(form.email, form.password);
      await adopt(res.token);
    });
  };

  const forgot = () => run(async () => {
    if (!form.email) throw new Error('Enter your email address first.');
    await platformApi.forgotPassword(form.email);
    setSentTo(form.email);
  });

  return (
    <Panel
      title="Operator sign-in"
      caption="This console administers tenant workspaces. Tenant and supplier accounts sign in elsewhere."
      error={error}
    >
      {sentTo && (
        <p className="mb-5 flex items-start gap-2.5 border border-border p-3 text-xs text-text-secondary">
          <Mail className="mt-0.5 size-4 shrink-0" />
          If an operator account exists for {sentTo}, a reset link is on its way.
        </p>
      )}

      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Email" type="email" required autoComplete="username" disabled={busy}
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <Field
          label="Password" type="password" required autoComplete="current-password" disabled={busy}
          value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <Submit busy={busy}><span>Continue</span><KeyRound className="size-4" /></Submit>
      </form>

      <button type="button" onClick={forgot} disabled={busy} className="mt-5 text-[11px] text-text-tertiary hover:text-text-primary">
        Forgot your password?
      </button>
    </Panel>
  );
}

function ChangePassword() {
  const { adopt, signOut, operator } = usePlatformSession();
  const { busy, error, run } = useStep();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      if (form.newPassword !== form.confirm) throw new Error('The two new passwords do not match.');
      const res = await platformApi.changePassword(form.currentPassword, form.newPassword);
      await adopt(res.token);
    });
  };

  return (
    <Panel
      title="Choose your own password"
      caption={`${operator?.email} was issued temporary credentials. Replace them before going any further.`}
      error={error}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Temporary password" type="password" required autoComplete="current-password" disabled={busy}
          value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
        <Field label="New password" type="password" required minLength={6} autoComplete="new-password" disabled={busy}
          hint="At least six characters."
          value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
        <Field label="Confirm new password" type="password" required autoComplete="new-password" disabled={busy}
          value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        <Submit busy={busy}><span>Set password</span></Submit>
      </form>

      <button type="button" onClick={signOut} className="mt-5 text-[11px] text-text-tertiary hover:text-text-primary">
        Sign out
      </button>
    </Panel>
  );
}

function EnrolMfa() {
  const { adopt, signOut, operator } = usePlatformSession();
  const { busy, error, run } = useStep();
  const [enrolment, setEnrolment] = useState(null);
  const [code, setCode] = useState('');

  const begin = () => run(async () => setEnrolment(await platformApi.enrolMfa()));

  const confirm = (event) => {
    event.preventDefault();
    run(async () => {
      const res = await platformApi.verifyMfa(code);
      await adopt(res.token);
    });
  };

  return (
    <Panel
      title="Set up your authenticator"
      caption="Multi-factor authentication is mandatory on the platform console. It cannot be skipped or turned off."
      error={error}
    >
      {!enrolment ? (
        <button type="button" onClick={begin} disabled={busy} className="btn btn-v h-10 w-full justify-center disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <><ShieldCheck className="size-4" /><span>Generate my secret</span></>}
        </button>
      ) : (
        <>
          <div className="mb-5 border border-border-em p-4">
            <p className="text-[11px] text-text-secondary">
              Add an account for <span className="mono">{operator?.email}</span> in your authenticator app,
              using this key. It is shown once and never again.
            </p>
            <p className="mono mt-3 break-all text-[13px] text-emerald-text">{enrolment.secret}</p>
          </div>

          <form onSubmit={confirm} className="space-y-4">
            <Field
              label="Six-digit code" inputMode="numeric" pattern="\d{6}" maxLength={6} required disabled={busy}
              className="w-full mono tracking-[0.4em]"
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Submit busy={busy}><span>Finish enrolment</span></Submit>
          </form>
        </>
      )}

      <button type="button" onClick={signOut} className="mt-5 text-[11px] text-text-tertiary hover:text-text-primary">
        Sign out
      </button>
    </Panel>
  );
}

function VerifyMfa() {
  const { adopt, signOut } = usePlatformSession();
  const { busy, error, run } = useStep();
  const [code, setCode] = useState('');

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      const res = await platformApi.verifyMfa(code);
      await adopt(res.token);
    });
  };

  return (
    <Panel title="Second factor" caption="Enter the current code from your authenticator app." error={error}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Six-digit code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus disabled={busy}
          className="w-full mono tracking-[0.4em]"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        <Submit busy={busy}><span>Enter console</span></Submit>
      </form>

      <button type="button" onClick={signOut} className="mt-5 text-[11px] text-text-tertiary hover:text-text-primary">
        Sign out
      </button>
    </Panel>
  );
}

// Platform routes that render without a session. The list is short by design:
// everything else is behind the flow above.
const PUBLIC_ROUTES = ['/platform/reset-password'];

const STEPS = {
  [STAGE.SIGNED_OUT]: SignIn,
  [STAGE.CHANGE_PASSWORD]: ChangePassword,
  [STAGE.ENROL_MFA]: EnrolMfa,
  [STAGE.VERIFY_MFA]: VerifyMfa,
};

/**
 * Renders the console when the session is complete, and the right step of the
 * sign-in flow when it is not.
 */
export default function PlatformGate({ children }) {
  const { stage } = usePlatformSession();
  const pathname = usePathname();

  // Completing a password reset happens with no session at all, so this one
  // route renders itself rather than the sign-in step.
  if (PUBLIC_ROUTES.includes(pathname)) return children;

  if (stage === STAGE.CONSOLE) return children;

  if (stage === STAGE.LOADING) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base">
        <Loader2 className="size-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  const Step = STEPS[stage] || SignIn;
  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4 py-10">
      <Step />
    </div>
  );
}
