import { describe, it, expect } from 'vitest';
import { displayDate } from './displayDate';

// Issue #289. Three shapes reach this formatter and each has to be read as
// what it is: a timestamp in the reader's local time, a date-only string with
// no timezone at all, and SAP's own YYYYMMDD.
//
// The suite runs with TZ=Asia/Kolkata (see vitest.config.js), so "local" here
// is UTC+5:30 — the offset that makes the off-by-one visible: 20:00 UTC on
// the 19th is 01:30 IST on the 20th.

describe('displayDate', () => {
  it('reads an ISO timestamp in local time, not UTC', () => {
    // The defect this replaces: RfqView's formatDate did `split('T')[0]` and
    // so reported the UTC calendar day — 19 Oct for a moment that was, where
    // the reader is, the 20th.
    expect(displayDate('2026-10-19T20:00:00Z')).toBe('20 Oct 2026');
  });

  it('keeps a bare YYYY-MM-DD on its own day', () => {
    // `new Date('2026-05-10')` is UTC midnight by spec. A date-only field has
    // no timezone to be converted out of, so it must not shift either way.
    expect(displayDate('2026-05-10')).toBe('10 May 2026');
  });

  it('parses SAP\'s YYYYMMDD, which Date() rejects outright', () => {
    expect(displayDate('20251112')).toBe('12 Nov 2025');
  });

  it('shows an unparseable value as it came, never "Invalid Date"', () => {
    expect(displayDate('not a date')).toBe('not a date');
  });

  it('shows an em dash for a missing value', () => {
    expect(displayDate(null)).toBe('—');
    expect(displayDate('')).toBe('—');
  });
});
