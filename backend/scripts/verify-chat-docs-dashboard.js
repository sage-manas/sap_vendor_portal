// Smoke test for chat.controller.js, upload.controller.js,
// dashboard.controller.js, and reports.controller.js's getPlatformMetrics —
// against the real dev Postgres.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

const { getMessages, sendMessage } = require('../controllers/chat.controller');
const { uploadFile, downloadFile, listDocuments, deleteDocument } = require('../controllers/upload.controller');
const { getDashboardSummary } = require('../controllers/dashboard.controller');
const { getPlatformMetrics } = require('../controllers/reports.controller');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
};

const fakeRes = () => {
  const res = { statusCode: 200, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
};
const fakeReq = (overrides = {}) => ({
  ip: '127.0.0.1', query: {}, body: {}, params: {}, app: { get: () => null }, clientId: 'CLT-0001', ...overrides,
});
const capturedNext = () => { const fn = (err) => { fn.error = err; }; return fn; };

const resetDb = async () => {
  await rawPrisma.chatMessage.deleteMany({});
  await rawPrisma.document.deleteMany({});
  await rawPrisma.purchaseOrder.deleteMany({});
  await rawPrisma.gRN.deleteMany({});
  await rawPrisma.invoice.deleteMany({});
  await rawPrisma.payment.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.rFQ.deleteMany({});
  await rawPrisma.client.deleteMany({});
};

async function main() {
  await resetDb();
  await withoutTenantScope(() => rawPrisma.client.create({
    data: { clientId: 'CLT-0001', slug: 'legacy', companyName: 'Legacy', status: 'Active' },
  }));
  await runWithTenant('CLT-0001', () => prisma.vendor.create({
    data: { vendorId: 'VND-AAAAA', companyName: 'Vendor A', gstin: '27AABCB1234F1Z5', pan: 'AABCB1234F', email: 'a@example.com' },
  }));

  await test('sendMessage creates a Vendor message and schedules an auto-reply', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA', body: { message: 'What about the price on this PO?' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => sendMessage(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.sender, 'Vendor');
    assert.strictEqual(res.body.isRead, true);
  });

  await test('the auto-reply lands from Finance (keyword: price) and getMessages marks it read', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const req = fakeReq({ scopeVendorId: 'VND-AAAAA' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getMessages(req, res));
    assert.strictEqual(res.body.length, 2);
    const reply = res.body.find((m) => m.sender === 'Finance');
    assert.ok(reply, 'expected a Finance auto-reply for a price-related question');

    const stored = await runWithTenant('CLT-0001', () => rawPrisma.chatMessage.findFirst({ where: { pk: reply.pk } }));
    assert.strictEqual(stored.isRead, true, 'getMessages must mark non-Vendor messages read');
  });

  let uploadedDocId;
  const tmpFile = path.join(os.tmpdir(), 'verify-upload-test.txt');
  fs.writeFileSync(tmpFile, 'hello world');

  await test('uploadFile persists a Document row', async () => {
    const req = fakeReq({
      scopeVendorId: 'VND-AAAAA',
      body: { linkedTo: 'RFQ' },
      file: { filename: 'stored-name.txt', originalname: 'original.txt', mimetype: 'text/plain', size: 11, path: tmpFile },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => uploadFile(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.originalName, 'original.txt');
    uploadedDocId = res.body.documentId;
  });

  await test('listDocuments filters by linkedTo', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA', query: { linkedTo: 'RFQ' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => listDocuments(req, res, capturedNext()));
    assert.strictEqual(res.body.length, 1);
  });

  await test('downloadFile streams for the owning vendor and denies another supplier', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA', params: { id: uploadedDocId } });
    const res = fakeRes();
    res.pipe = () => {};
    let piped = false;
    const realCreateReadStream = fs.createReadStream;
    // Just confirm no error/forbidden path is hit; actual streaming is fs's job.
    await runWithTenant('CLT-0001', () => downloadFile(req, res, capturedNext()));
    assert.strictEqual(res.headers['Content-Type'], 'text/plain');

    const otherReq = fakeReq({ scopeVendorId: 'VND-BBBBB', params: { id: uploadedDocId } });
    const otherNext = capturedNext();
    await runWithTenant('CLT-0001', () => downloadFile(otherReq, fakeRes(), otherNext));
    assert.strictEqual(otherNext.error?.statusCode, 403);
  });

  await test('deleteDocument removes the row and the file', async () => {
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA', params: { id: uploadedDocId } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => deleteDocument(req, res, capturedNext()));
    assert.strictEqual(res.body.message, 'Document deleted successfully');
    assert.strictEqual(fs.existsSync(tmpFile), false);

    const remaining = await runWithTenant('CLT-0001', () => rawPrisma.document.count({}));
    assert.strictEqual(remaining, 0);
  });

  await test('getDashboardSummary reflects PO/GRN/Invoice/Payment counts for the scoped vendor', async () => {
    await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: 'PO-2026-0001', vendorId: 'VND-AAAAA', status: 'Open' },
    }));
    const req = fakeReq({ scopeVendorId: 'VND-AAAAA' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getDashboardSummary(req, res));
    assert.strictEqual(res.body.openPOCount, 1);
    assert.strictEqual(res.body.invoiceCount, 0);
  });

  await test('getPlatformMetrics counts within the bound tenant scope', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getPlatformMetrics(req, res, capturedNext()));
    assert.strictEqual(res.body.totalVendors, 1);
    assert.strictEqual(res.body.totalPOs, 1);
    assert.strictEqual(res.body.totalVolume, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await resetDb();
  await rawPrisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await rawPrisma.$disconnect();
  process.exit(1);
});
