'use client';

import { Check, Circle } from 'lucide-react';

// The password policy, shown while the password is typed. Display only: the
// rules are enforced by the API (backend/validators/auth.validator.js,
// passwordField), and these mirror them so a person sees what is asked of
// them before the form is refused. If the policy changes there, change it here.
export const PASSWORD_RULES = [
  { label: 'At least 10 characters', test: (value) => value.length >= 10 },
  { label: 'A lowercase letter', test: (value) => /[a-z]/.test(value) },
  { label: 'An uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { label: 'A number', test: (value) => /[0-9]/.test(value) },
];

export default function PasswordChecklist({ value = '', id }) {
  return (
    <ul id={id} className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs" aria-label="Password requirements">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(value);
        return (
          <li key={rule.label} className={`flex items-center gap-1.5 ${met ? 'text-fg' : 'text-fg-subtle'}`}>
            {met
              ? <Check className="size-3.5 shrink-0 text-success" strokeWidth={2} aria-hidden="true" />
              : <Circle className="size-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />}
            {rule.label}
            {/* The icon is decorative; the state is said in words. */}
            <span className="sr-only">{met ? ' — met' : ' — not yet'}</span>
          </li>
        );
      })}
    </ul>
  );
}
