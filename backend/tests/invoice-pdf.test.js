const request = require('supertest');
const zlib = require('zlib');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();

// GET /api/reports/invoice/:id derived subTotal from totalAmount / 1.18 when
// subTotal was missing or zero, then printed the resulting figure — and,
// unconditionally, a CGST 9% / SGST 9% split of taxAmount — on a document
// headed "TAX INVOICE". Invoice stores exactly one taxAmount with no
// CGST/SGST/IGST breakdown at all, so that split was invented even when
// subTotal/taxAmount were real. See issue #57.
//
// pdfkit compresses its content streams (FlateDecode), so the rendered text
// isn't visible in the raw response bytes — this inflates every stream
// object and concatenates them, the same way any PDF viewer would, so the
// assertions below are against what a reader actually sees.
const textFromPdf = (buffer) => {
  const raw = buffer.toString('latin1');
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
  const inflated = streams
    .map(([, body]) => {
      try {
        return zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
      } catch {
        return ''; // Not every stream is FlateDecode-compressed text (e.g. embedded fonts).
      }
    })
    .join('\n');

  // pdfkit shows text two ways: `(literal) Tj` and `[<hex> kerning <hex> ...] TJ`
  // — this document uses the latter. Each hex run is a run of glyph codes
  // that, for pdfkit's standard-font encoding, map 1:1 onto the ASCII bytes
  // of the string (`<494e56>` decodes to "INV"); the numbers between runs in
  // a TJ array are kerning adjustments, not characters, and are skipped by
  // only matching what's inside angle brackets. Concatenating runs in
  // document order reconstructs each drawn line intact.
  const hexRuns = [...inflated.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'));
  const literalRuns = [...inflated.matchAll(/\(([^()]*)\)\s*Tj/g)].map(([, s]) => s);

  return [...hexRuns, ...literalRuns].join('');
};

describe('GET /api/reports/invoice/:id — no fabricated tax figures (issue #57)', () => {
  it('an invoice with no stored subTotal renders "Not available", never a derived split', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });

    const invoice = await asTenant(async () => {
      const po = await prisma.purchaseOrder.create({ data: { id: 'PO-2026-9700', vendorId: vendor.vendorId } });
      return prisma.invoice.create({
        data: {
          id: 'INV-970001', poId: po.id, vendorId: vendor.vendorId,
          invoiceNumber: 'ISSUE-57/1', invoiceDate: new Date(),
          // subTotal/taxAmount are Decimal columns, required but not
          // guaranteed non-zero — this is the shape the SAP-discovery path
          // (and any historical row predating stricter writes) can produce.
          subTotal: 0, taxAmount: 0, totalAmount: 118,
          invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
        },
      });
    });

    const res = await request(app)
      .get(`/api/reports/invoice/${invoice.id}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');

    const text = textFromPdf(res.body);
    expect(text).toContain('Not available');
    // The invented split this issue removes — never printed, whatever the data.
    expect(text).not.toMatch(/CGST/);
    expect(text).not.toMatch(/SGST/);
    // The one figure that is always real is still there.
    expect(text).toContain('118.00');
  });

  it('an invoice with real stored figures prints them as-is, still with no CGST/SGST split', async () => {
    const { token, vendor } = await registerVendor(app, {
      vendorId: 'vendor_test_002', companyName: 'Beta Supplies Pvt Ltd',
      gstin: '27AABCB1234F1Z6', pan: 'AABCB1235F', email: 'beta@example.com',
    }, { onboarded: true });

    const invoice = await asTenant(async () => {
      const po = await prisma.purchaseOrder.create({ data: { id: 'PO-2026-9701', vendorId: vendor.vendorId } });
      return prisma.invoice.create({
        data: {
          id: 'INV-970002', poId: po.id, vendorId: vendor.vendorId,
          invoiceNumber: 'ISSUE-57/2', invoiceDate: new Date(),
          subTotal: 1000, taxAmount: 180, totalAmount: 1180, taxCode: 'G1',
          invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
        },
      });
    });

    const res = await request(app)
      .get(`/api/reports/invoice/${invoice.id}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const text = textFromPdf(res.body);
    expect(text).toContain('1,000.00');
    expect(text).toContain('180.00');
    expect(text).toContain('G1');
    expect(text).not.toMatch(/CGST/);
    expect(text).not.toMatch(/SGST/);
    expect(text).not.toContain('Not available');
  });
});
