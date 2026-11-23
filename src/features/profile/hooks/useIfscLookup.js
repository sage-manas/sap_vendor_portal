'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import { IFSC_PATTERN } from '../validation';

// Looks an IFSC code up in Razorpay's free, public IFSC directory (built from
// RBI's published list), for the two places a supplier types one: the
// registration form and the bank-change request. The browser calls it
// directly; the security policy allows exactly this host
// (src/lib/security-headers.js).
//
// Three answers, kept apart because they mean different things to the
// supplier:
//   found       — the code is a real branch; bank and branch come back.
//   not_found   — the directory answered and has no such branch. Almost always
//                 a typo, so the supplier is told to check it. Not a refusal:
//                 the list trails RBI by weeks, so a brand-new branch can be
//                 missing.
//   unavailable — the directory could not be reached. Says nothing about the
//                 code, so the supplier types bank and branch themselves.
//
// `onFound` receives { bank, branch } once per code that resolves, for a form
// to fill its own fields from.

export const IFSC_DIRECTORY_URL = 'https://ifsc.razorpay.com';

export const IFSC_MESSAGES = {
  not_found: 'No bank branch has this IFSC code. Check it against your cheque book.',
  unavailable: 'Could not look up this IFSC code. Enter the bank name and branch yourself.',
};

const ask = async (code) => {
  try {
    const res = await fetch(`${IFSC_DIRECTORY_URL}/${code}`);
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'unavailable' };
    const data = await res.json();
    return { status: 'found', bank: data.BANK || '', branch: data.BRANCH || '' };
  } catch {
    return { status: 'unavailable' };
  }
};

/**
 * `{ status, bank, branch, message }`, where status is idle (no well-formed
 * code yet), loading, found, not_found or unavailable.
 */
export function useIfscLookup(rawCode, onFound) {
  const code = String(rawCode || '').toUpperCase();
  const wellFormed = IFSC_PATTERN.test(code);
  // The answer remembers which code it is for, so a stale one is never shown
  // against a code typed since — and nothing has to be reset when the code
  // changes.
  const [answer, setAnswer] = useState({ code: '' });
  const found = useEffectEvent((result) => onFound?.(result));

  useEffect(() => {
    if (!wellFormed) return undefined;
    let cancelled = false;
    ask(code).then((result) => {
      if (cancelled) return;
      setAnswer({ code, ...result });
      if (result.status === 'found') found({ bank: result.bank, branch: result.branch });
    });
    return () => { cancelled = true; };
  }, [code, wellFormed]);

  if (!wellFormed) return { status: 'idle', message: '' };
  if (answer.code !== code) return { status: 'loading', message: '' };
  return { ...answer, message: IFSC_MESSAGES[answer.status] || '' };
}
