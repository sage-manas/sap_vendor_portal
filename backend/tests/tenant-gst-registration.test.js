// Finding 4.4: the platform console can set a client's GSTIN and state.
//
// Both were real columns on `Client` that nothing could write. The schema
// comment said so outright — "Nullable because nothing sets them yet (no
// onboarding screen collects them)" — and the consequence was in
// services/gst.service.js: with no `Client.state`, place of supply could never
// be derived, so every invoice's tax was split as "state unknown" rather than
// into CGST+SGST or IGST.
//
// The interesting part is not the two new fields but what they have to agree
// with. `isIntraState` compares the tenant's state to the supplier's as
// trimmed, lower-cased strings, and the supplier picked theirs from a fixed
// list. A free-text box would have let an operator store 'MH', which matches
// no supplier state and fails silently — every intra-state invoice billed as
// IGST with nothing to show it had gone wrong. So the state is constrained to
// the registry (config/indianStates.js) and stored in the registry's own
// spelling.

const request = require('supertest');
const buildTestApp = require('./testApp');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { createOperatorSession } = require('./helpers');
const { INDIAN_STATES } = require('../config/indianStates');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// 27 is Maharashtra's GST state code, so this GSTIN and 'Maharashtra' agree.
const MH_GSTIN = '27AABCU9603R1ZM';
// 29 is Karnataka's.
const KA_GSTIN = '29AABCU9603R1ZX';

const readClient = (clientId) => withoutTenantScope(
  () => rawPrisma.client.findFirst({ where: { clientId } }),
);

const patch = (token, body, clientId = 'CLT-0001') =>
  request(app).put(`/api/platform/tenants/${clientId}`).set(bearer(token)).send(body);

describe('an operator sets the tenant\'s own GST registration', () => {
  it('stores a GSTIN and state, and reports them back', async () => {
    const { token } = await createOperatorSession();

    const res = await patch(token, { gstin: MH_GSTIN, state: 'Maharashtra' });

    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ gstin: MH_GSTIN, state: 'Maharashtra' });
    expect(await readClient('CLT-0001')).toMatchObject({ gstin: MH_GSTIN, state: 'Maharashtra' });
  });

  it('reports both as null for a tenant that has not been configured', async () => {
    const { token } = await createOperatorSession();

    const res = await request(app).get('/api/platform/tenants/CLT-0001').set(bearer(token));

    expect(res.status).toBe(200);
    // Not '' and not absent: null is what gst.service.js reads as "place of
    // supply unknown", and it is how the console tells "not configured" from
    // "configured and wrong".
    expect(res.body.tenant.gstin).toBeNull();
    expect(res.body.tenant.state).toBeNull();
  });

  it('records the change in the audit trail, with the old value', async () => {
    const { token } = await createOperatorSession();
    await patch(token, { gstin: MH_GSTIN, state: 'Maharashtra' });

    await patch(token, { gstin: KA_GSTIN, state: 'Karnataka' });

    const audit = await request(app).get('/api/platform/audit').set(bearer(token));
    const entry = audit.body.entries.find((row) => row.meta?.fields?.includes('gstin'));
    expect(entry).toBeTruthy();
    expect(entry.meta.changed.gstin).toEqual({ from: MH_GSTIN, to: KA_GSTIN });
    expect(entry.meta.changed.state).toEqual({ from: 'Maharashtra', to: 'Karnataka' });
  });

  it('lets an operator clear a registration that was entered in error', async () => {
    const { token } = await createOperatorSession();
    await patch(token, { gstin: MH_GSTIN, state: 'Maharashtra' });

    const res = await patch(token, { gstin: '', state: '' });

    expect(res.status).toBe(200);
    expect(res.body.tenant.gstin).toBeNull();
    expect(res.body.tenant.state).toBeNull();
  });

  it('accepts a GSTIN and state at provisioning time', async () => {
    const { token } = await createOperatorSession();

    const res = await request(app).post('/api/platform/tenants').set(bearer(token)).send({
      companyName: 'Northwind Manufacturing',
      slug: 'northwind-gst',
      admin: { email: 'ops@northwind.example.com', name: 'Nadia Ops' },
      gstin: MH_GSTIN,
      state: 'Maharashtra',
    });

    expect(res.status).toBe(201);
    expect(res.body.tenant).toMatchObject({ gstin: MH_GSTIN, state: 'Maharashtra' });
  });
});

describe('the stored state is the one a supplier\'s state will be compared against', () => {
  // This is the point of constraining the field at all. gst.service.js's
  // isIntraState lower-cases both sides, so 'maharashtra' would happen to
  // compare equal — but 'MH' never would, and neither would a misspelling.
  it('stores the registry\'s own spelling, not the casing that was typed', async () => {
    const { token } = await createOperatorSession();

    const res = await patch(token, { state: '  maharashtra  ' });

    expect(res.status).toBe(200);
    expect(res.body.tenant.state).toBe('Maharashtra');
  });

  it('refuses a state abbreviation, which would silently never match a supplier', async () => {
    const { token } = await createOperatorSession();

    const res = await patch(token, { state: 'MH' });

    expect(res.status).toBe(400);
    expect(await readClient('CLT-0001')).toMatchObject({ state: null });
  });

  it('refuses a state that is not an Indian state or union territory', async () => {
    const { token } = await createOperatorSession();

    expect((await patch(token, { state: 'Bavaria' })).status).toBe(400);
    expect((await patch(token, { state: 'Mahrashtra' })).status).toBe(400);
  });

  it('accepts every state the registry lists', async () => {
    const { token } = await createOperatorSession();

    for (const { name } of INDIAN_STATES) {
      const res = await patch(token, { state: name });
      expect([name, res.status]).toEqual([name, 200]);
      expect(res.body.tenant.state).toBe(name);
    }
  });
});

describe('a GSTIN and a state that contradict each other are refused', () => {
  it('refuses a Karnataka GSTIN against Maharashtra in one request', async () => {
    const { token } = await createOperatorSession();

    const res = await patch(token, { gstin: KA_GSTIN, state: 'Maharashtra' });

    expect(res.status).toBe(400);
    expect(await readClient('CLT-0001')).toMatchObject({ gstin: null, state: null });
  });

  it('refuses a state change that contradicts the GSTIN already stored', async () => {
    const { token } = await createOperatorSession();
    await patch(token, { gstin: MH_GSTIN, state: 'Maharashtra' });

    // Only the state moves — the schema's own cross-check cannot see the
    // stored GSTIN, so this is the controller's job.
    const res = await patch(token, { state: 'Karnataka' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('gstin_state_mismatch');
    // And nothing moved.
    expect(await readClient('CLT-0001')).toMatchObject({ gstin: MH_GSTIN, state: 'Maharashtra' });
  });

  it('refuses a GSTIN change that contradicts the state already stored', async () => {
    const { token } = await createOperatorSession();
    await patch(token, { gstin: MH_GSTIN, state: 'Maharashtra' });

    const res = await patch(token, { gstin: KA_GSTIN });

    expect(res.status).toBe(400);
    expect(await readClient('CLT-0001')).toMatchObject({ gstin: MH_GSTIN });
  });

  it('allows moving both together when a registration really has moved state', async () => {
    const { token } = await createOperatorSession();
    await patch(token, { gstin: MH_GSTIN, state: 'Maharashtra' });

    const res = await patch(token, { gstin: KA_GSTIN, state: 'Karnataka' });

    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ gstin: KA_GSTIN, state: 'Karnataka' });
  });

  it('allows a state with no GSTIN, and a GSTIN with no state', async () => {
    const { token } = await createOperatorSession();

    expect((await patch(token, { state: 'Karnataka' })).status).toBe(200);
    expect((await patch(token, { state: '' })).status).toBe(200);
    expect((await patch(token, { gstin: MH_GSTIN })).status).toBe(200);
  });
});

describe('the GSTIN itself is shape-checked', () => {
  it('refuses something that is not a GSTIN', async () => {
    const { token } = await createOperatorSession();

    for (const gstin of ['27AABCU9603R1Z', 'not-a-gstin', '27AABCU9603R1ZMX', '270ABCU9603R1ZM1']) {
      expect([gstin, (await patch(token, { gstin })).status]).toEqual([gstin, 400]);
    }
  });

  it('refuses a key the schema does not know, rather than ignoring it', async () => {
    const { token } = await createOperatorSession();

    // updateTenantSchema is a strictObject — finding 1.7's rule. A typo'd
    // field name must not read as a successful update that changed nothing.
    const res = await patch(token, { gstIn: MH_GSTIN });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/meta/indian-states', () => {
  it('serves the registry the forms are meant to read', async () => {
    const res = await request(app).get('/api/meta/indian-states');

    expect(res.status).toBe(200);
    expect(res.body.states).toHaveLength(INDIAN_STATES.length);
    expect(res.body.states).toEqual(
      expect.arrayContaining([{ code: 'MH', name: 'Maharashtra' }]),
    );
  });

  it('does not expose the GST state code, which is server-side cross-check data', async () => {
    const res = await request(app).get('/api/meta/indian-states');

    for (const state of res.body.states) {
      expect(Object.keys(state).sort()).toEqual(['code', 'name']);
    }
  });

  // The registry exists so that this holds. If the two lists ever disagree on
  // a spelling, every invoice between a supplier registered from one and a
  // tenant configured from the other is split the wrong way, silently —
  // see issue #221, which removes the frontend's own copy.
  it('every state it serves is a state the tenant endpoint will accept', async () => {
    const { token } = await createOperatorSession();
    const res = await request(app).get('/api/meta/indian-states');

    for (const { name } of res.body.states) {
      expect([name, (await patch(token, { state: name })).status]).toEqual([name, 200]);
    }
  });
});
