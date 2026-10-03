const express = require('express');
const request = require('supertest');
const { MESSAGE } = require('triple-beam');

const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const logger = require('../utils/logger');
const requestLogger = require('../middleware/requestLogger');
const { recordSapCall } = require('../utils/sapLogger');
const { redactDeep, redactString } = require('../utils/redact');
const { seedClient } = require('./helpers');

// 2.1 — bank account numbers, IFSC codes, PAN, GSTIN and UTRs reached the log
// files and the SAP communication log in clear. Three places each carried
// their own, partial idea of what to hide; they now share utils/redact.js and
// show only the last four characters of an identifier.

const ACCOUNT = '501002345678901';
const IFSC = 'HDFC0001234';
const PAN = 'AAAPL1234C';
const GSTIN = '27AAAPL1234C1ZV';
const UTR = 'HDFCR52026091812345';

describe('redactDeep', () => {
  it('keeps the last four characters of each sensitive identifier', () => {
    const out = redactDeep({
      accountNumber: ACCOUNT, ifscCode: IFSC, pan: PAN, gstin: GSTIN, utrCode: UTR, deducteePan: PAN,
    });
    expect(out).toEqual({
      accountNumber: '****8901', ifscCode: '****1234', pan: '****234C', gstin: '****C1ZV', utrCode: '****2345', deducteePan: '****234C',
    });
  });

  it.each(['ACCOUNT_NUMBER', 'account_number', 'bankAccount', 'BANKN', 'IFSC', 'ifsc_code', 'PAN', 'gstin', 'GSTIN', 'UTR', 'utr_code'])(
    'recognises the key spelled %s', (key) => {
      const out = redactDeep({ [key]: '1234567890123' });
      expect(out[key]).toBe('****0123');
    },
  );

  it('reaches into nested objects and arrays', () => {
    const out = redactDeep({ data: { vendors: [{ name: 'Acme', bank: { accountNumber: ACCOUNT } }] } });
    expect(out.data.vendors[0].bank.accountNumber).toBe('****8901');
    expect(out.data.vendors[0].name).toBe('Acme');
  });

  it('does not touch a key that merely contains one of the words', () => {
    const input = { company: 'Acme', companyName: 'Acme Pvt Ltd', span: 3, utrechtOffice: 'NL', panel: 'x' };
    expect(redactDeep(input)).toEqual(input);
  });

  it('still blanks secrets completely rather than showing a tail', () => {
    const out = redactDeep({ password: 'hunter2hunter2', Authorization: 'Bearer abcdefgh1234', apiKey: 'k-1234567890' });
    expect(Object.values(out)).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]']);
  });

  it('masks a short value completely instead of leaking most of it', () => {
    expect(redactDeep({ accountNumber: '12345' }).accountNumber).toBe('****');
  });

  it('is idempotent', () => {
    const once = redactDeep({ accountNumber: ACCOUNT });
    expect(redactDeep(once)).toEqual(once);
  });

  it('does not mutate its input, and survives a cycle', () => {
    const input = { accountNumber: ACCOUNT };
    input.self = input;
    const out = redactDeep(input);
    expect(input.accountNumber).toBe(ACCOUNT);
    expect(out.accountNumber).toBe('****8901');
  });

  it('passes numbers, booleans, nulls and dates through', () => {
    const when = new Date('2026-01-01');
    expect(redactDeep({ n: 1, b: true, z: null, when })).toEqual({ n: 1, b: true, z: null, when });
  });

  it('masks a numeric account number', () => {
    expect(redactDeep({ accountNumber: 501002345678901 }).accountNumber).toBe('****8901');
  });
});

describe('redactString', () => {
  it('masks identifiers that appear inside free text', () => {
    const text = `Unique constraint failed for vendor ${GSTIN} (PAN ${PAN}), IFSC ${IFSC}`;
    const out = redactString(text);
    expect(out).not.toContain(GSTIN);
    expect(out).not.toContain(PAN);
    expect(out).not.toContain(IFSC);
    expect(out).toContain('****C1ZV');
  });

  it('masks a sensitive field inside JSON text', () => {
    const out = redactString(`{"accountNumber":"${ACCOUNT}","ifscCode": "${IFSC}","city":"Pune"}`);
    expect(out).not.toContain(ACCOUNT);
    expect(out).not.toContain(IFSC);
    expect(out).toContain('"city":"Pune"');
  });

  it('masks a sensitive query parameter in a URL', () => {
    const out = redactString(`/api/vendors?gstin=${GSTIN}&status=Approved&accountNumber=${ACCOUNT}`);
    expect(out).toBe('/api/vendors?gstin=****C1ZV&status=Approved&accountNumber=****8901');
  });

  it('leaves ordinary text alone', () => {
    const text = 'PO 4500012345 for ACME PHARMA, GRN posted 2026-09-18';
    expect(redactString(text)).toBe(text);
  });
});

describe('the winston format', () => {
  const format = (meta, message = 'event') => {
    const out = logger.format.transform({ level: 'info', message, ...meta });
    return out[MESSAGE];
  };

  it('masks identifiers anywhere in the metadata, however nested', () => {
    const line = format({ vendor: { bank: { accountNumber: ACCOUNT, ifscCode: IFSC }, pan: PAN, gstin: GSTIN } });
    [ACCOUNT, IFSC, PAN, GSTIN].forEach((value) => expect(line).not.toContain(value));
    expect(line).toContain('****8901');
  });

  it('masks an identifier in the message text itself', () => {
    const line = format({}, `bank change rejected for account ${GSTIN}`);
    expect(line).not.toContain(GSTIN);
  });

  it('still redacts the secrets it always did', () => {
    const line = format({ password: 'hunter2hunter2', headers: { authorization: 'Bearer abc.def.ghi' } });
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('abc.def.ghi');
  });
});

describe('requestLogger', () => {
  const appLoggingA400 = () => {
    const app = express();
    app.use(express.json());
    app.use(requestLogger);
    app.put('/api/vendors/bank', (_req, res) => res.status(400).json({ error: 'invalid' }));
    return app;
  };

  it('hands the logger a masked body and a masked URL', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger);
    try {
      await request(appLoggingA400())
        .put(`/api/vendors/bank?gstin=${GSTIN}`)
        .send({ accountNumber: ACCOUNT, ifscCode: IFSC, pan: PAN, accountName: 'Acme' });

      const seen = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
      [ACCOUNT, IFSC, PAN, GSTIN].forEach((value) => expect(seen).not.toContain(value));
      expect(seen).toContain('****8901');
      expect(seen).toContain('Acme');
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

describe('the SAP communication log', () => {
  beforeEach(() => seedClient());

  const stored = () => runWithTenant('CLT-0001', () => prisma.sapLog.findFirst({ where: { vendorId: 'v1' } }));

  it('stores a payload with identifiers masked', async () => {
    await runWithTenant('CLT-0001', () => recordSapCall({
      transaction: 'VENDOR_CREATE',
      vendorId: 'v1',
      payload: { gstin: GSTIN, bank: { accountNumber: ACCOUNT, ifscCode: IFSC }, general_data: { name: 'Acme Pvt Ltd' } },
    }));

    const row = await stored();
    [ACCOUNT, IFSC, GSTIN].forEach((value) => expect(row.payload).not.toContain(value));
    expect(row.payload).toContain('****C1ZV');
    expect(row.payload).toContain('Acme Pvt Ltd');
  });

  it('masks a payload that arrives as JSON text, and as free text', async () => {
    await runWithTenant('CLT-0001', () => recordSapCall({
      transaction: 'VENDOR_CREATE', vendorId: 'v1',
      payload: JSON.stringify({ BANKN: ACCOUNT, BANKL: IFSC }),
    }));
    let row = await stored();
    expect(row.payload).not.toContain(ACCOUNT);
    expect(row.payload).not.toContain(IFSC);

    await runWithTenant('CLT-0001', () => prisma.sapLog.deleteMany({ where: { vendorId: 'v1' } }));
    await runWithTenant('CLT-0001', () => recordSapCall({
      transaction: 'VENDOR_CREATE', vendorId: 'v1', payload: `Gateway echoed PAN ${PAN} back`,
    }));
    row = await stored();
    expect(row.payload).not.toContain(PAN);
  });

  it('masks an identifier SAP echoes back in an error message', async () => {
    await runWithTenant('CLT-0001', () => recordSapCall({
      transaction: 'VENDOR_CREATE', vendorId: 'v1', payload: { error: 'x' }, status: 'FAILED',
      errorMessage: `Vendor with tax number ${GSTIN} already exists`,
    }));
    const row = await stored();
    expect(row.errorMessage).not.toContain(GSTIN);
  });
});
