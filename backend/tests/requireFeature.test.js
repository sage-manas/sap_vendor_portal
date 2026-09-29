const requireFeature = require('../middleware/requireFeature');

// requireFeature is plain Express middleware — tested directly here rather
// than through a real gated route, the same approach tests/error-handler.test.js
// uses for errorHandler. It used to be exercised end to end through
// GET /api/chats (tests/workspace.test.js), the one route that used it — that
// route was removed with the supplier-messaging feature (issue #168), which
// would otherwise have left the 404-vs-200-per-tenant half of ADR-0023's
// "a feature flag closes the API, not just the screen" pattern uncovered.

// features.supplierSelfRegistration is a real registered setting (its path,
// client.featureFlags.supplierSelfRegistration, is what settingValue reads) —
// requireFeature() takes a registry key and throws on an unknown one, so a
// made-up key would not exercise the real lookup.
const req = (featureValue) => ({ client: { featureFlags: { supplierSelfRegistration: featureValue } } });

const mockRes = () => {
  const res = { locals: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

describe('requireFeature', () => {
  it('refuses with a 404, not a 403 — the endpoint should not appear to exist', () => {
    const middleware = requireFeature('features.supplierSelfRegistration');
    let caught;
    middleware(req(false), mockRes(), (err) => { caught = err; });

    expect(caught).toBeTruthy();
    expect(caught.statusCode).toBe(404);
  });

  it('calls next with no error when the flag is on', () => {
    const middleware = requireFeature('features.supplierSelfRegistration');
    let called = false;
    middleware(req(true), mockRes(), (err) => { called = true; expect(err).toBeUndefined(); });

    expect(called).toBe(true);
  });
});
