const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createAdminUser, onboardVendor } = require('./helpers');
const { VENDOR_STATUS, VENDOR_AWAITING_DECISION } = require('../config/statuses');

// Issue #289. The workspace overview's "Awaiting a decision" tile counts
// VENDOR_AWAITING_DECISION — Under Review *and* Pending Approval — but its
// link could only say `?status=Under+Review`, one status of the two. Clicking
// a number therefore opened a list that was reliably shorter than the number
// clicked, with nothing on either screen to explain the difference.
//
// `?status=awaiting` is the registry's own group, so the tile and the list it
// opens are made of the same statuses by construction. The test that matters
// is the one the issue asked for: the tile's count equals the length of the
// list its link opens.

const app = buildTestApp();

// One supplier per status, so the group filter has something to leave out as
// well as something to find.
const SEEDED = [
  ['vendor_sg_review_1', '27AAAAA7001A1Z1', VENDOR_STATUS.UNDER_REVIEW],
  ['vendor_sg_review_2', '27AAAAA7002A1Z1', VENDOR_STATUS.UNDER_REVIEW],
  ['vendor_sg_pending_1', '27AAAAA7003A1Z1', VENDOR_STATUS.PENDING_APPROVAL],
  ['vendor_sg_approved_1', '27AAAAA7004A1Z1', VENDOR_STATUS.APPROVED],
  ['vendor_sg_rejected_1', '27AAAAA7005A1Z1', VENDOR_STATUS.REJECTED],
];

describe('GET /api/vendors?status=<group>', () => {
  // Per test, not once: the suite truncates every table between tests (see
  // tests/setup.js), so an account seeded in beforeAll is gone by the second.
  let token;
  const seed = async () => {
    for (const [vendorId, gstin, status] of SEEDED) {
      await registerVendor(app, { vendorId, gstin, email: `${vendorId}@example.com` });
      await onboardVendor(vendorId, { status });
    }
    ({ token } = await createAdminUser({ email: 'status-group-admin@example.com' }));
  };

  beforeEach(seed);

  const list = (querystring) =>
    request(app).get(`/api/vendors?limit=100${querystring}`).set('Authorization', `Bearer ${token}`);

  it('returns every status in the group, not just one of them', async () => {
    const res = await list('&status=awaiting');

    expect(res.status).toBe(200);
    const statuses = res.body.vendors.map((vendor) => vendor.status);
    expect(statuses).toHaveLength(3);
    expect(new Set(statuses)).toEqual(new Set(VENDOR_AWAITING_DECISION));
  });

  it('counts the same suppliers the overview tile counts', async () => {
    // The two numbers are computed by different code over different queries
    // (controllers/workspace.controller.js counts, this endpoint lists), which
    // is exactly why a tile could drift from its own link. They agree because
    // both ask the registry which statuses the group holds.
    const [tile, opened] = await Promise.all([
      request(app).get('/api/workspace/overview').set('Authorization', `Bearer ${token}`),
      list('&status=awaiting'),
    ]);

    expect(tile.status).toBe(200);
    expect(tile.body.suppliers.awaitingDecision).toBe(3);
    expect(opened.body.pagination.total).toBe(tile.body.suppliers.awaitingDecision);
    expect(opened.body.vendors).toHaveLength(tile.body.suppliers.awaitingDecision);
  });

  it('still filters by a single status', async () => {
    const res = await list(`&status=${encodeURIComponent(VENDOR_STATUS.UNDER_REVIEW)}`);

    expect(res.status).toBe(200);
    expect(res.body.vendors).toHaveLength(2);
    expect(res.body.vendors.every((vendor) => vendor.status === VENDOR_STATUS.UNDER_REVIEW)).toBe(true);
  });

  it('offers its groups to the screen, so the filter names none itself', async () => {
    const res = await list('');

    // The dropdown renders from this, the way it already renders the statuses
    // from `filters.statuses` — a group added to the registry appears in the
    // filter by existing.
    expect(res.body.filters.groups).toEqual(
      expect.arrayContaining([{ value: 'awaiting', label: 'Awaiting a decision' }])
    );
  });

  it('rejects a status that is neither a status nor a group', async () => {
    const res = await list('&status=awaiting-decision');

    // An unknown filter is a malformed request, not an empty page — the same
    // rule a bare unknown status has always been held to.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status must be one of/);
  });
});
