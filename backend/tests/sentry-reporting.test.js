const mockInit = jest.fn();
const mockCapture = jest.fn();
const mockSetTag = jest.fn();
const mockScope = { setTag: jest.fn(), setContext: jest.fn() };
const mockWithScope = jest.fn((fn) => fn(mockScope));

jest.mock('@sentry/node', () => ({
  init: (...a) => mockInit(...a),
  captureException: (...a) => mockCapture(...a),
  setTag: (...a) => mockSetTag(...a),
  withScope: (fn) => mockWithScope(fn),
}));

const sentry = require('../observability/sentry');

const GSTIN = '27AAPFU0939F1ZV';
const PAN = 'AAPFU0939F';
const IFSC = 'HDFC0001234';

describe('error reporting (observability/sentry)', () => {
  const saved = process.env.SENTRY_DSN;

  beforeEach(() => {
    sentry.resetForTests();
    jest.clearAllMocks();
    delete process.env.SENTRY_DSN;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = saved;
    sentry.resetForTests();
  });

  describe('without a DSN', () => {
    it('stays disabled and never loads or calls the SDK', () => {
      expect(sentry.initSentry({ serviceName: 'api' })).toBe(false);
      expect(sentry.isEnabled()).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('report() is a no-op that returns false', () => {
      sentry.initSentry();
      expect(sentry.report(new Error('boom'), { requestId: 'r1' })).toBe(false);
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it('treats a whitespace-only DSN as unset', () => {
      process.env.SENTRY_DSN = '   ';
      expect(sentry.initSentry()).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
    });
  });

  describe('with a DSN', () => {
    beforeEach(() => { process.env.SENTRY_DSN = 'https://key@example.invalid/1'; });

    it('initialises errors-only, with no tracing, auto-instrumentation or breadcrumbs', () => {
      expect(sentry.initSentry({ serviceName: 'jobs' })).toBe(true);
      const options = mockInit.mock.calls[0][0];
      expect(options.dsn).toBe('https://key@example.invalid/1');
      expect(options.tracesSampleRate).toBe(0);
      expect(options.profilesSampleRate).toBe(0);
      expect(options.defaultIntegrations).toBe(false);
      expect(options.maxBreadcrumbs).toBe(0);
      expect(mockSetTag).toHaveBeenCalledWith('service', 'jobs');
    });

    it('initialises once per process', () => {
      sentry.initSentry();
      sentry.initSentry();
      expect(mockInit).toHaveBeenCalledTimes(1);
    });

    it('survives an SDK that throws on init, reporting disabled rather than crashing boot', () => {
      mockInit.mockImplementationOnce(() => { throw new Error('bad dsn'); });
      expect(sentry.initSentry()).toBe(false);
      expect(sentry.isEnabled()).toBe(false);
    });

    it('tags requestId, clientId and route, and sends the rest as redacted detail', () => {
      sentry.initSentry();
      sentry.report(new Error('boom'), {
        requestId: 'req-1', clientId: 'CLT-9', route: 'GET /pos', statusCode: 500, accountNumber: '123456789012',
      });
      expect(mockScope.setTag).toHaveBeenCalledWith('requestId', 'req-1');
      expect(mockScope.setTag).toHaveBeenCalledWith('clientId', 'CLT-9');
      expect(mockScope.setTag).toHaveBeenCalledWith('route', 'GET /pos');
      const [, detail] = mockScope.setContext.mock.calls[0];
      expect(detail.statusCode).toBe(500);
      expect(JSON.stringify(detail)).not.toContain('123456789012');
    });

    it('redacts identifiers quoted in the error message and stack', () => {
      sentry.initSentry();
      sentry.report(new Error(`SAP rejected GSTIN ${GSTIN}, PAN ${PAN}, IFSC ${IFSC}`));
      const sent = mockCapture.mock.calls[0][0];
      for (const raw of [GSTIN, PAN, IFSC]) {
        expect(sent.message).not.toContain(raw);
        expect(sent.stack).not.toContain(raw);
      }
    });

    it('does not rewrite the error the caller still has to log and respond with', () => {
      sentry.initSentry();
      const original = new Error(`bad GSTIN ${GSTIN}`);
      sentry.report(original);
      expect(original.message).toContain(GSTIN);
    });

    it('never throws when the SDK does, and reports failure', () => {
      sentry.initSentry();
      mockWithScope.mockImplementationOnce(() => { throw new Error('transport down'); });
      expect(sentry.report(new Error('boom'))).toBe(false);
    });

    it('wraps a non-Error rejection instead of crashing', () => {
      sentry.initSentry();
      expect(sentry.report(`plain string with ${GSTIN}`)).toBe(true);
      expect(mockCapture.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(mockCapture.mock.calls[0][0].message).not.toContain(GSTIN);
    });

    it('beforeSend redacts the whole event, and drops it if redaction fails', () => {
      sentry.initSentry();
      const { beforeSend } = mockInit.mock.calls[0][0];
      const out = beforeSend({ extra: { gstin: GSTIN, note: `x ${PAN}` } });
      expect(JSON.stringify(out)).not.toContain(GSTIN);
      expect(JSON.stringify(out)).not.toContain(PAN);

      const hostile = {};
      Object.defineProperty(hostile, 'extra', { enumerable: true, get() { throw new Error('nope'); } });
      expect(beforeSend(hostile)).toBeNull();
    });
  });
});
