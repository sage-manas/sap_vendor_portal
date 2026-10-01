const request = require('supertest');
const fs = require('fs');
const net = require('net');
const path = require('path');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser, asTenant } = require('./helpers');
const { checkUpload, detectKind, contentDisposition, mimeForFileName } = require('../utils/fileType');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const uploadsRoot = path.join(__dirname, '..', 'uploads');

// Issue #124. The upload filter looked at the extension only, then stored the
// client's own Content-Type and served it back. Every upload below goes through
// the real endpoint; the only seeded row is a historical one, which is a
// precondition the API can no longer produce.

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256, 'x')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const zipOf = (...names) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), ...names.map((name) => Buffer.from(`\0${name}\0`)), Buffer.alloc(32)]);
const DOCX = zipOf('[Content_Types].xml', 'word/document.xml');
const XLSX = zipOf('[Content_Types].xml', 'xl/workbook.xml');

const filesFor = (vendorId) => {
  const dir = path.join(uploadsRoot, vendorId);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

const send = (token, buffer, filename, contentType) =>
  request(app).post('/api/uploads').set(bearer(token)).attach('file', buffer, { filename, contentType });

describe('what an upload is is decided from its content', () => {
  let supplier;
  let before;

  beforeEach(async () => {
    supplier = await registerVendor(app, { vendorId: 'upl_content_1', gstin: '27AAAAA4001A1Z1' });
    before = filesFor(supplier.vendor.vendorId);
  });

  afterEach(async () => {
    const dir = path.join(uploadsRoot, supplier.vendor.vendorId);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const leftBehind = () => filesFor(supplier.vendor.vendorId).filter((name) => !before.includes(name));

  it('refuses a .pdf that declares Content-Type text/html', async () => {
    const res = await send(supplier.token, PDF, 'statement.pdf', 'text/html');
    expect(res.status).toBe(400);
    expect(leftBehind()).toEqual([]);
  });

  it('refuses a file whose bytes do not match its extension, and keeps no copy', async () => {
    const html = await send(supplier.token, HTML, 'statement.pdf', 'application/pdf');
    expect(html.status).toBe(400);

    const wrongKind = await send(supplier.token, PDF, 'photo.png', 'image/png');
    expect(wrongKind.status).toBe(400);

    expect(leftBehind()).toEqual([]);
  });

  it('refuses a zip that is a Word document and a workbook at once', async () => {
    const res = await send(supplier.token, zipOf('word/document.xml', 'xl/workbook.xml'), 'both.docx', undefined);
    expect(res.status).toBe(400);
  });

  it.each([
    ['statement.pdf', PDF, 'application/pdf', 'application/pdf'],
    ['cheque.png', PNG, 'image/png', 'image/png'],
    ['cheque.jpg', JPEG, 'image/jpeg', 'image/jpeg'],
    ['letter.docx', DOCX, undefined, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xlsx', XLSX, undefined, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('accepts a genuine %s and records the type the server derived', async (name, bytes, declared, expected) => {
    const res = await send(supplier.token, bytes, name, declared);
    expect(res.status).toBe(201);

    const row = await asTenant(() => prisma.document.findFirst({ where: { pk: res.body.documentId } }));
    expect(row.mimeType).toBe(expected);
  });

  it('accepts a generic application/octet-stream declaration for a genuine file', async () => {
    const res = await send(supplier.token, PDF, 'statement.pdf', 'application/octet-stream');
    expect(res.status).toBe(201);
  });

  it('serves a download under the derived type, with nosniff and an encoded filename', async () => {
    const up = await send(supplier.token, PDF, 'Bank cheque ü.pdf', 'application/pdf');
    expect(up.status).toBe(201);

    const res = await request(app).get(up.body.url.replace('/api', '/api')).set(bearer(supplier.token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment; /);
    expect(disposition).toContain("filename*=UTF-8''Bank%20cheque%20%C3%BC.pdf");
    expect(disposition).toMatch(/filename="[^"]*"; filename\*=/);
  });

  it('serves a historical row under a type derived from its name, not the stored claim', async () => {
    const up = await send(supplier.token, PDF, 'old.pdf', 'application/pdf');
    // A row written before this check existed, carrying whatever the client claimed.
    await asTenant(() => prisma.document.update({ where: { pk: up.body.documentId }, data: { mimeType: 'text/html' } }));

    const res = await request(app).get(up.body.url).set(bearer(supplier.token));
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
  });

  it('leaves no file behind when the document row cannot be written', async () => {
    const spy = jest.spyOn(prisma.document, 'create').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await send(supplier.token, PDF, 'statement.pdf', 'application/pdf');
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(leftBehind()).toEqual([]);
  });

  it('deletes the row and the file together', async () => {
    const admin = await createAdminUser({ email: 'upl-admin@example.com' });
    const up = await send(supplier.token, PDF, 'gone.pdf', 'application/pdf');
    expect(leftBehind().length).toBe(1);

    const res = await request(app).delete(`/api/uploads/${up.body.documentId}`).set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(leftBehind()).toEqual([]);
    expect((await request(app).get(up.body.url).set(bearer(supplier.token))).status).toBe(404);
  });

  it('keeps the file when the row cannot be deleted', async () => {
    const admin = await createAdminUser({ email: 'upl-admin2@example.com' });
    const up = await send(supplier.token, PDF, 'kept.pdf', 'application/pdf');

    const spy = jest.spyOn(prisma.document, 'delete').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await request(app).delete(`/api/uploads/${up.body.documentId}`).set(bearer(admin.token));
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    // The record still points at a file that is still there.
    expect((await request(app).get(up.body.url).set(bearer(supplier.token))).status).toBe(200);
  });
});

describe('the content checks, in isolation', () => {
  it('names a kind only for content that proves it', () => {
    expect(detectKind(PDF)).toBe('pdf');
    expect(detectKind(HTML)).toBeNull();
    expect(detectKind(Buffer.alloc(0))).toBeNull();
    expect(detectKind(DOCX)).toBe('docx');
    expect(detectKind(XLSX)).toBe('xlsx');
  });

  it('refuses an extension outside the allow-list whatever the bytes are', () => {
    expect(checkUpload({ buffer: PDF, originalName: 'run.exe', declaredMime: 'application/pdf' }).error).toBeTruthy();
  });

  it('derives the served type from the file name alone', () => {
    expect(mimeForFileName('1700000000_statement.pdf')).toBe('application/pdf');
    expect(mimeForFileName('readme.html')).toBe('application/octet-stream');
  });

  it('encodes a filename that would break a header value', () => {
    const header = contentDisposition('a";b\r\nX-Injected: 1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).not.toContain('";b');
  });
});

describe('optional ClamAV scan', () => {
  let supplier;
  let server;
  let port;
  const original = {};

  // A stand-in clamd that speaks just enough INSTREAM to answer: it reads the
  // stream to its zero-length terminator and says FOUND when the content carries
  // the marker. It proves this code's side of the protocol and its policy, not
  // that a real clamd accepts it.
  const startFakeClamd = () => new Promise((resolve) => {
    server = net.createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on('data', (data) => {
        received = Buffer.concat([received, data]);
        if (received.subarray(0, 10).toString() !== 'zINSTREAM\0') return;
        let offset = 10;
        const content = [];
        while (received.length >= offset + 4) {
          const length = received.readUInt32BE(offset);
          if (length === 0) {
            const infected = Buffer.concat(content).includes('EICAR-TEST-MARKER');
            socket.end(infected ? 'stream: Fake.Test.Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (received.length < offset + 4 + length) return;
          content.push(received.subarray(offset + 4, offset + 4 + length));
          offset += 4 + length;
        }
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });

  beforeAll(() => {
    for (const key of ['CLAMAV_HOST', 'CLAMAV_PORT', 'CLAMAV_REQUIRED', 'CLAMAV_TIMEOUT_MS']) original[key] = process.env[key];
  });

  beforeEach(async () => {
    supplier = await registerVendor(app, { vendorId: 'upl_scan_1', gstin: '27AAAAA4003A1Z1' });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    server = null;
    fs.rmSync(path.join(uploadsRoot, 'upl_scan_1'), { recursive: true, force: true });
  });

  const infectedPdf = Buffer.concat([PDF, Buffer.from('EICAR-TEST-MARKER')]);

  it('does nothing when no scanner is configured', async () => {
    delete process.env.CLAMAV_HOST;
    expect((await send(supplier.token, infectedPdf, 'a.pdf', 'application/pdf')).status).toBe(201);
  });

  it('refuses a file the scanner flags, and keeps no copy', async () => {
    await startFakeClamd();
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(port);

    const res = await send(supplier.token, infectedPdf, 'bad.pdf', 'application/pdf');
    expect(res.status).toBe(422);
    expect(filesFor('upl_scan_1')).toEqual([]);
  });

  it('stores a file the scanner passes', async () => {
    await startFakeClamd();
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(port);

    expect((await send(supplier.token, PDF, 'good.pdf', 'application/pdf')).status).toBe(201);
  });

  it('lets an upload through when the scanner is down, unless scanning is required', async () => {
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = '1'; // nothing listens here
    process.env.CLAMAV_TIMEOUT_MS = '500';

    process.env.CLAMAV_REQUIRED = 'false';
    expect((await send(supplier.token, PDF, 'soft.pdf', 'application/pdf')).status).toBe(201);

    process.env.CLAMAV_REQUIRED = 'true';
    const hard = await send(supplier.token, PDF, 'hard.pdf', 'application/pdf');
    expect(hard.status).toBe(503);
    expect(filesFor('upl_scan_1').filter((name) => name.endsWith('hard.pdf'))).toEqual([]);
  });
});
