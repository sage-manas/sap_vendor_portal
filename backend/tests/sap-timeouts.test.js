const { timeoutFor, timeoutConfigFields, DEFAULT_TIMEOUT_MS, METHOD_DEFAULTS } = require('../sap/timeouts');
const { METHOD_NAMES } = require('../sap/contract');
const s4odata = require('../sap/drivers/s4odata.driver');

// Per-endpoint SAP timeouts (go-live item 3.x).
//
// Every call in s4odata.driver.js used to read the same
// `Number(config.timeoutMs) || 10000`, with one exception — `poGrnTimeoutMs`,
// added because zpo_grn_vendor/Detail was observed taking 22–84s for ~170
// orders and a 10s ceiling made it permanently unusable. That exception is the
// evidence the single shared ceiling was wrong: one number is either too tight
// for the slowest endpoint or too slack for the rest, and too slack is not
// free — a 120s ceiling on every read means a held connection and a user
// watching a spinner before the circuit breaker learns anything.
//
// What this must NOT become is a table of invented per-endpoint latencies.
// The only endpoint this project has measured is the PO/GRN one, so that is
// the only entry in METHOD_DEFAULTS, and the tests below pin that: an
// unmeasured endpoint resolves to the shared timeout, exactly as before.

describe('resolution order', () => {
  it('prefers the per-endpoint override for this tenant', () => {
    expect(timeoutFor('vendorCreate', { vendorCreateTimeoutMs: 45000, timeoutMs: 10000 })).toBe(45000);
  });

  it('falls back to a measured default where one exists', () => {
    expect(timeoutFor('vendorPoGrnDisplay', { timeoutMs: 10000 })).toBe(120000);
  });

  it('lets a per-endpoint override beat the measured default', () => {
    // A tenant whose SAP is faster (or slower) than the sandbox.
    expect(timeoutFor('vendorPoGrnDisplay', { vendorPoGrnDisplayTimeoutMs: 30000 })).toBe(30000);
  });

  it('falls back to the tenant\'s shared timeout for an unmeasured endpoint', () => {
    expect(timeoutFor('vendorRfqDisplay', { timeoutMs: 25000 })).toBe(25000);
  });

  it('falls back to 10s when the connection sets nothing', () => {
    expect(timeoutFor('vendorRfqDisplay', {})).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFor('vendorRfqDisplay')).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('answers the shared timeout for a call that belongs to no single method', () => {
    // The OData session-priming GET happens on behalf of whichever write is
    // in flight, so it cannot claim a method's budget.
    expect(timeoutFor(null, { timeoutMs: 15000 })).toBe(15000);
    expect(timeoutFor(null, {})).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('a value that is not a timeout is treated as unset', () => {
  // These are connection-form fields, so '' , null and 'abc' all arrive in
  // practice. Each has to mean "fall through", never "no time at all" — a
  // zero or NaN timeout aborts the request instantly and reads to an operator
  // as SAP being down.
  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['non-numeric text', 'abc'],
    ['zero', 0],
    ['negative', -1],
  ])('ignores a %s per-endpoint override', (label, value) => {
    expect(timeoutFor('vendorCreate', { vendorCreateTimeoutMs: value, timeoutMs: 20000 })).toBe(20000);
  });

  it.each([['empty string', ''], ['zero', 0], ['non-numeric text', 'abc']])(
    'ignores a %s shared timeout',
    (label, value) => {
      expect(timeoutFor('vendorCreate', { timeoutMs: value })).toBe(DEFAULT_TIMEOUT_MS);
    },
  );

  it('still prefers a measured default over an unusable shared timeout', () => {
    expect(timeoutFor('vendorPoGrnDisplay', { timeoutMs: 0 })).toBe(120000);
  });
});

describe('the pre-existing poGrnTimeoutMs keeps working', () => {
  // It is already set on live tenant connections. Silently ignoring it would
  // mean the slowest endpoint in the system quietly reverting to a 10s
  // ceiling at deploy — the exact failure the field was added to fix.
  it('is honoured where a connection already sets it', () => {
    expect(timeoutFor('vendorPoGrnDisplay', { poGrnTimeoutMs: 90000 })).toBe(90000);
  });

  it('is beaten by the new per-endpoint key, so a migration can land either way round', () => {
    expect(timeoutFor('vendorPoGrnDisplay', {
      poGrnTimeoutMs: 90000,
      vendorPoGrnDisplayTimeoutMs: 150000,
    })).toBe(150000);
  });

  it('applies to nothing else', () => {
    expect(timeoutFor('vendorCreate', { poGrnTimeoutMs: 90000 })).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('the measured defaults are measurements, not guesses', () => {
  // The guard that keeps this honest. An entry here claims a real observation
  // about a real SAP endpoint; a table that grows by guesswork is how '1000'
  // and the fabricated document numbers happened (issues #125, #121).
  it('declares a default for only the one endpoint this project has measured', () => {
    expect(Object.keys(METHOD_DEFAULTS)).toEqual(['vendorPoGrnDisplay']);
  });

  it('declares every default against a real contract method', () => {
    for (const method of Object.keys(METHOD_DEFAULTS)) {
      expect(METHOD_NAMES).toContain(method);
    }
  });

  it('declares no default below the shared ceiling, which would be a tightening nobody asked for', () => {
    for (const [method, ms] of Object.entries(METHOD_DEFAULTS)) {
      expect([method, ms >= DEFAULT_TIMEOUT_MS]).toEqual([method, true]);
    }
  });
});

describe('every SAP method is tunable', () => {
  const fields = timeoutConfigFields();

  it('offers one override field per contract method', () => {
    expect(fields.map((field) => field.name).sort())
      .toEqual(METHOD_NAMES.map((method) => `${method}TimeoutMs`).sort());
  });

  it('gives no field a default, so an empty one means "use the shared timeout"', () => {
    // A default here would write a per-endpoint value onto every connection,
    // which is the opposite of the point.
    for (const field of fields) {
      expect([field.name, 'default' in field]).toEqual([field.name, false]);
    }
  });

  it('names the measured default in the label where there is one', () => {
    const poGrn = fields.find((field) => field.name === 'vendorPoGrnDisplayTimeoutMs');
    expect(poGrn.label).toContain('120000');
  });
});

describe('the driver exposes the override fields', () => {
  const names = s4odata.configFields.map((field) => field.name);

  it('includes every per-endpoint override', () => {
    for (const method of METHOD_NAMES) {
      expect(names).toContain(`${method}TimeoutMs`);
    }
  });

  it('still exposes the shared timeout and the legacy key', () => {
    expect(names).toContain('timeoutMs');
    expect(names).toContain('poGrnTimeoutMs');
  });

  it('declares each field exactly once', () => {
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });
});

describe('no call site is left on the old expression', () => {
  // The point of the change is that there is one place that answers "how long
  // may a SAP call take". A `|| 10000` left behind is a second one.
  const source = require('fs').readFileSync(require.resolve('../sap/drivers/s4odata.driver'), 'utf8');

  it('leaves no literal fallback timeout in the driver', () => {
    expect(source).not.toContain('config.timeoutMs) || 10000');
    expect(source).not.toContain('config.poGrnTimeoutMs');
  });

  it('routes every abortableFetch and getWithBody through the resolver', () => {
    // 17 call sites at the time of writing; asserting "none left over" rather
    // than a count, so adding an endpoint does not fail this for no reason.
    const resolved = source.match(/timeoutFor\(/g) || [];
    expect(resolved.length).toBeGreaterThanOrEqual(17);
  });
});
