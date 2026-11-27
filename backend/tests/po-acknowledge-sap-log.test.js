// Issue #351. With no config.fields.poAcknowledgeField the s4_odata driver
// writes nothing to SAP — the standard OData PATCH has nowhere to go — but it
// still returned a log, so the tenant's SAP log showed
// "RFC_PO_ACKNOWLEDGE · SUCCESS" for a call that was never made (seen live:
// CLT-0003, PO-2026-0008). The log is the record of what SAP was told.
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const { seedClient } = require('./helpers');

const PO = { id: 'PO-ACK-1', vendorId: 'vendor_ack', sapPoNumber: '4500022854', acknowledgedAt: new Date() };

beforeEach(() => seedClient());
afterEach(() => { delete global.fetch; });

describe('poAcknowledge on an SAP connection with nowhere to record it', () => {
  const adapter = () => buildTransientAdapter({
    clientId: 'CLT-0001',
    driver: 's4_odata',
    config: { baseUrl: 'http://sandbox', sapClient: '800', companyCode: 'SSDN' },
    secrets: {},
  });

  it('says SAP was not written to, sends nothing, and logs no SAP call', async () => {
    global.fetch = jest.fn();

    const result = await runWithTenant('CLT-0001', () => adapter().poAcknowledge({ po: PO }));

    expect(result.sapWritten).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const logs = await runWithTenant('CLT-0001', () => prisma.sapLog.findMany({ where: { documentRef: PO.id } }));
    expect(logs).toHaveLength(0);
  });
});

describe('poAcknowledge on the simulator', () => {
  it('still records the acknowledgement it simulates', async () => {
    const result = await runWithTenant('CLT-0001', () => buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} })
      .poAcknowledge({ po: PO }));

    expect(result.sapWritten).toBe(true);
    const logs = await runWithTenant('CLT-0001', () => prisma.sapLog.findMany({ where: { documentRef: PO.id } }));
    expect(logs).toHaveLength(1);
  });
});
