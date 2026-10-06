import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const mockInit = vi.fn();
const mockCapture = vi.fn();
const mockAddBreadcrumb = vi.fn();
const scope = { setContext: vi.fn(), setTag: vi.fn() };

vi.mock('@sentry/browser', () => ({
  init: (...a) => mockInit(...a),
  captureException: (...a) => mockCapture(...a),
  addBreadcrumb: (...a) => mockAddBreadcrumb(...a),
  withScope: (fn) => fn(scope),
}));

import Monitor, { scrub, scrubDeep } from './monitoring';

const GSTIN = '27AAPFU0939F1ZV';
const PAN = 'AAPFU0939F';
const IFSC = 'HDFC0001234';
const ACCOUNT = '123456789012';

describe('browser error tracking (monitoring)', () => {
  const saved = process.env.NEXT_PUBLIC_SENTRY_DSN;
  beforeEach(() => { Monitor.resetForTests(); vi.clearAllMocks(); delete process.env.NEXT_PUBLIC_SENTRY_DSN; });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN; else process.env.NEXT_PUBLIC_SENTRY_DSN = saved;
  });

  describe('without a DSN', () => {
    it('does nothing and never loads the SDK', async () => {
      expect(await Monitor.initialize()).toBe(false);
      expect(Monitor.isEnabled()).toBe(false);
      expect(Monitor.report(new Error('x'))).toBe(false);
      expect(Monitor.breadcrumb({ url: '/a', navigationType: 'push' })).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    });
  });

  describe('with a DSN', () => {
    beforeEach(() => { process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://key@example.invalid/1'; });

    it('initialises errors-only with no PII, replay or tracing', async () => {
      expect(await Monitor.initialize()).toBe(true);
      const o = mockInit.mock.calls[0][0];
      expect(o.sendDefaultPii).toBe(false);
      expect(o.tracesSampleRate).toBe(0);
      expect(o.replaysSessionSampleRate).toBe(0);
      expect(o.replaysOnErrorSampleRate).toBe(0);
    });

    it('drops the integrations that record requests, history or console', async () => {
      await Monitor.initialize();
      const { integrations } = mockInit.mock.calls[0][0];
      const kept = integrations(['Breadcrumbs', 'BrowserTracing', 'Replay', 'GlobalHandlers', 'Dedupe', 'LinkedErrors']
        .map((name) => ({ name })));
      expect(kept.map((i) => i.name)).toEqual(['Dedupe', 'LinkedErrors']);
    });

    it('beforeSend scrubs every identifier in an event and drops it on failure', async () => {
      await Monitor.initialize();
      const { beforeSend } = mockInit.mock.calls[0][0];
      const out = JSON.stringify(beforeSend({
        message: `bank ${ACCOUNT} ifsc ${IFSC}`, extra: { nested: [{ pan: PAN, gstin: GSTIN }] },
      }));
      for (const raw of [ACCOUNT, IFSC, PAN, GSTIN]) expect(out).not.toContain(raw);

      const hostile = {};
      Object.defineProperty(hostile, 'x', { enumerable: true, get() { throw new Error('no'); } });
      expect(beforeSend(hostile)).toBeNull();
    });

    it('report() scrubs its context', async () => {
      await Monitor.initialize();
      expect(Monitor.report(new Error('x'), { account: ACCOUNT })).toBe(true);
      expect(JSON.stringify(scope.setContext.mock.calls[0][1])).not.toContain(ACCOUNT);
      expect(mockCapture).toHaveBeenCalledTimes(1);
    });

    it('records a scrubbed navigation breadcrumb by hand', async () => {
      await Monitor.initialize();
      Monitor.breadcrumb({ url: `/x?pan=${PAN}`, navigationType: 'push' });
      const crumb = mockAddBreadcrumb.mock.calls[0][0];
      expect(crumb.category).toBe('navigation');
      expect(crumb.message).not.toContain(PAN);
    });

    it('never throws if the SDK does', async () => {
      mockInit.mockImplementationOnce(() => { throw new Error('boom'); });
      expect(await Monitor.initialize()).toBe(false);
    });
  });

  describe('scrubbing', () => {
    it('leaves ordinary text and short numbers alone', () => {
      expect(scrub('PO 4500001234 line 10 failed')).toBe('PO [REDACTED-NUMBER] line 10 failed');
      expect(scrub('line 10 of 12')).toBe('line 10 of 12');
    });

    it('is depth-limited and tolerates cycles-in-spirit (deep trees)', () => {
      let deep = { v: ACCOUNT };
      for (let i = 0; i < 20; i += 1) deep = { child: deep };
      expect(() => scrubDeep(deep)).not.toThrow();
    });

    it('catches the same fixed-format identifiers the server-side redactor does', () => {
      const require = createRequire(import.meta.url);
      const { redactString } = require('../../backend/utils/redact');
      for (const id of [GSTIN, PAN, IFSC]) {
        expect(redactString(`x ${id} y`)).not.toContain(id);
        expect(scrub(`x ${id} y`)).not.toContain(id);
      }
    });
  });
});
