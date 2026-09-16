const PDFDocument = require('pdfkit');
const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const { requireVendorScope } = require('../utils/requestScope');
const { toNumber } = require('../utils/money');

// PDFKit's built-in Helvetica is WinAnsi-encoded and has no rupee glyph: a
// rupee sign drawn with it comes out as a stray character in front of every
// amount. Amounts are prefixed "Rs." instead, which the font can draw.
const inr = (value) => `Rs. ${toNumber(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A value the record does not hold is printed as a dash, never as a sample
// value that reads like the supplier's or the buyer's real data.
const orDash = (value) => (value == null || value === '' ? '-' : String(value));

// Account numbers are masked on a document that gets emailed and printed.
const maskAccount = (value) => (value ? `XXXX${String(value).slice(-4)}` : '-');

// Helper to draw horizontal lines
const drawLine = (doc, y) => {
  doc.strokeColor('#d2d5d8')
     .lineWidth(1)
     .moveTo(50, y)
     .lineTo(550, y)
     .stroke();
};

// @desc    Generate account statement PDF (Last 3 months payments)
// @route   GET /api/reports/statement
// @access  Public
const generateStatement = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { OR: [{ vendorId }, { clerkId: vendorId }] } });

  // Get all payments for this vendor
  const payments = await prisma.payment.findMany({ where: { vendorId }, include: { items: true }, orderBy: { paymentDate: 'desc' } });

  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  // Stream directly to response
  res.setHeader('Content-Type', 'application/pdf');
  const runDate = new Date();
  res.setHeader('Content-Disposition', `attachment; filename="statement-${vendorId}-${runDate.toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  // Title / Branding Header
  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(18).text('VendorConnect Portal', 50, 50);
  doc.fillColor('#1c1c1c').font('Helvetica').fontSize(10).text('Enterprise Supplier Self-Service Platform', 50, 70);

  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(12).text('ACCOUNT STATEMENT', 350, 50, { align: 'right' });
  doc.fillColor('#1c1c1c').font('Helvetica-Bold').fontSize(9).text(`Buyer: ${orDash(req.client?.companyName)}`, 350, 68, { align: 'right' });
  doc.font('Helvetica').text(`All payments to ${runDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`, 350, 80, { align: 'right' });

  drawLine(doc, 100);

  // Vendor Information Block
  doc.font('Helvetica-Bold').fontSize(10).text('SUPPLIER PROFILE', 50, 115);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Company: ${orDash(vendor?.companyName)}`, 50, 130);
  doc.text(`Vendor Code: ${orDash(vendor?.sapVendorCode || vendor?.vendorId)}`, 50, 142);
  doc.text(`GSTIN: ${orDash(vendor?.gstin)}`, 50, 154);
  doc.text(`PAN: ${orDash(vendor?.pan)}`, 50, 166);

  // Banking Summary Block
  doc.font('Helvetica-Bold').fontSize(10).text('PAYEE BANKING REFERENCE', 320, 115);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Bank Name: ${orDash(vendor?.bankName)}`, 320, 130);
  doc.text(`A/C Number: ${maskAccount(vendor?.accountNumber)}`, 320, 142);
  doc.text(`IFSC Code: ${orDash(vendor?.ifscCode)}`, 320, 154);
  doc.text(`Branch: ${orDash(vendor?.bankBranch)}`, 320, 166);

  drawLine(doc, 190);

  // Table Headers
  const tableTop = 210;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#004080');
  doc.text('Date', 50, tableTop);
  doc.text('UTR Reference / Pmt Doc', 115, tableTop);
  doc.text('Invoice Ref', 245, tableTop);
  doc.text('Gross Amt', 335, tableTop, { width: 65, align: 'right' });
  doc.text('TDS', 405, tableTop, { width: 55, align: 'right' });
  doc.text('Net Paid', 465, tableTop, { width: 85, align: 'right' });

  drawLine(doc, 225);

  // Table Data Row Rendering
  let y = 235;
  let totalGross = 0;
  let totalTds = 0;
  let totalNet = 0;

  doc.font('Helvetica').fontSize(8.5).fillColor('#1c1c1c');

  if (payments && payments.length > 0) {
    payments.forEach(pmt => {
      const pmtDate = new Date(pmt.paymentDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const utr = pmt.utrCode || pmt.id;
      // A remittance can settle more than one invoice (issue #63) — every
      // one it covers, not just the first.
      const invRef = orDash((pmt.items || []).map((item) => item.invoiceNumber || item.invoiceId).filter(Boolean).join(', '));
      // grossAmount/tdsDeducted/netAmount are Decimal-typed columns — converted
      // here rather than left to `totalGross += gross` below's string-
      // concatenation trap (see utils/money.js), and because Decimal's own
      // toLocaleString() silently ignores the locale/fraction-digit options
      // passed to it further down, unlike a plain number's.
      const gross = toNumber(pmt.grossAmount) || 0;
      const tds = toNumber(pmt.tdsDeducted) || 0;
      const net = toNumber(pmt.netAmount) || 0;

      totalGross += gross;
      totalTds += tds;
      totalNet += net;

      doc.text(pmtDate, 50, y);
      doc.text(utr, 115, y);
      doc.text(invRef, 245, y);
      doc.text(inr(gross), 315, y, { width: 85, align: 'right' });
      doc.text(`-${inr(tds)}`, 395, y, { width: 65, align: 'right' });
      doc.text(inr(net), 465, y, { width: 85, align: 'right' });

      y += 20;
      // Draw subline
      doc.strokeColor('#f0f4f8').lineWidth(0.5).moveTo(50, y - 5).lineTo(550, y - 5).stroke();
    });
  } else {
    // Render empty layout row
    doc.text('No payments have been made to this account yet.', 50, y, { align: 'center', width: 500 });
    y += 25;
  }

  y += 5;
  drawLine(doc, y);
  y += 10;

  // Render Table Totals row
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#004080');
  doc.text('TOTAL VOLUME SUMMARY', 50, y);
  doc.text(inr(totalGross), 315, y, { width: 85, align: 'right' });
  doc.text(`-${inr(totalTds)}`, 395, y, { width: 65, align: 'right' });
  doc.text(inr(totalNet), 465, y, { width: 85, align: 'right' });

  y += 25;
  drawLine(doc, y);

  // Footer notes / compliance reference details
  y += 20;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1c1c1c').text('Important Compliance Information:', 50, y);
  doc.font('Helvetica').fontSize(8).fillColor('#4b5563');
  y += 12;
  doc.text(`1. TDS listed above is tax withheld by the buyer${vendor?.tdsSection ? ` under section ${vendor.tdsSection}` : ''}.`, 50, y);
  y += 10;
  doc.text('2. Form 16A certificates are issued by the buyer from TRACES; request one from the Payments screen.', 50, y);
  y += 10;
  doc.text('3. In case of discrepancies in gross settlement values, register a query directly in the Communication Hub.', 50, y);

  // End Document
  doc.end();
});

// @desc    Generate GST Compliant tax invoice details PDF
// @route   GET /api/reports/invoice/:id
// @access  Public
const generateInvoicePDF = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const vendorId = requireVendorScope(req);

  const invoice = await prisma.invoice.findFirst({ where: { id }, include: { items: true } });
  if (!invoice) {
    return next(ApiError.notFound('Invoice document not found'));
  }

  const vendor = await prisma.vendor.findFirst({ where: { OR: [{ vendorId: invoice.vendorId }, { clerkId: invoice.vendorId }] } });
  const po = await prisma.purchaseOrder.findFirst({ where: { id: invoice.poId }, include: { items: true } });
  // Plant is per line item, not one value for the whole order (issue #62) —
  // this only prints something when every line agrees, rather than picking
  // one line's plant and presenting it as the order's.
  const plants = [...new Set((po?.items || []).map((item) => item.plant).filter(Boolean))];

  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`);
  doc.pipe(res);

  // Title / Branding Header
  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(16).text(orDash(vendor?.companyName), 50, 50);
  doc.fillColor('#1c1c1c').font('Helvetica').fontSize(9).text(orDash(vendor?.address), 50, 68);
  doc.text([vendor?.city, vendor?.state].filter(Boolean).join(', ') + (vendor?.postalCode ? ` - ${vendor.postalCode}` : ''), 50, 80);
  doc.text(`GSTIN: ${orDash(vendor?.gstin)} | PAN: ${orDash(vendor?.pan)}`, 50, 92);

  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(13).text('TAX INVOICE', 350, 50, { align: 'right' });
  doc.fillColor('#1c1c1c').font('Helvetica-Bold').fontSize(9).text(`Invoice No: ${invoice.invoiceNumber}`, 350, 68, { align: 'right' });
  doc.font('Helvetica').text(`Invoice Date: ${new Date(invoice.invoiceDate).toLocaleDateString('en-IN')}`, 350, 80, { align: 'right' });
  doc.text(`SAP MIRO Doc: ${invoice.sapMiroDoc || 'Awaiting AP posting'}`, 350, 92, { align: 'right' });

  drawLine(doc, 110);

  // Bill To (Enterprise Customer details)
  doc.font('Helvetica-Bold').fontSize(9.5).text('BILL TO (CUSTOMER)', 50, 130);
  doc.font('Helvetica').fontSize(9);
  // The buyer is the tenant this request belongs to. Its registered address
  // and GSTIN are not held by the portal, so they are not printed.
  doc.text(orDash(req.client?.companyName), 50, 145);
  doc.text(`Plant ${orDash(plants.join('/') || null)} - Procurement and Accounts`, 50, 157);
  doc.text(orDash(po?.deliveryAddress), 50, 169, { width: 250 });

  // Shipping details / reference links
  doc.font('Helvetica-Bold').fontSize(9.5).text('TRANSACTION REFERENCES', 320, 130);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Purchase Order ID: ${invoice.poId}`, 320, 145);
  doc.text(`SAP PO Number: ${orDash(po?.sapPoNumber)}`, 320, 157);
  doc.text(`Goods Receipt GRN: ${orDash(invoice.grnId)}`, 320, 169);
  doc.text(`Payment Terms: ${orDash(po?.paymentTerms)}`, 320, 181);
  doc.text(`Currency: ${invoice.currency}`, 320, 193);

  drawLine(doc, 215);

  // Table Headers
  const tableTop = 235;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#004080');
  doc.text('Line', 50, tableTop, { width: 30 });
  doc.text('Material / Description', 90, tableTop, { width: 180 });
  doc.text('Quantity', 280, tableTop, { width: 50, align: 'right' });
  doc.text('UOM', 340, tableTop, { width: 35 });
  doc.text('Rate (Rs.)', 385, tableTop, { width: 70, align: 'right' });
  doc.text('Amount (Rs.)', 465, tableTop, { width: 85, align: 'right' });

  drawLine(doc, 250);

  // Items rows
  let y = 260;
  doc.font('Helvetica').fontSize(8.5).fillColor('#1c1c1c');

  invoice.items.forEach(item => {
    doc.text(String(item.line), 50, y, { width: 30 });
    doc.text(`${item.materialCode}\n${item.description}`, 90, y, { width: 180 });
    // item.quantity is Decimal-typed (issue #65) — String() on a raw Decimal
    // would print every stored decimal place (e.g. "10.000"); toNumber first
    // prints it the way a plain number would.
    doc.text(String(toNumber(item.quantity)), 280, y, { width: 50, align: 'right' });
    doc.text('EA', 340, y, { width: 35 });
    // unitPrice/amount are Decimal-typed — their own .toFixed() happens to
    // match Number.prototype.toFixed's output, but converting first keeps this
    // consistent with the subTotal/taxVal/totalAmount block below, where a raw
    // Decimal's .toLocaleString() does NOT match (see there for why).
    doc.text(toNumber(item.unitPrice).toFixed(2), 385, y, { width: 70, align: 'right' });
    doc.text(toNumber(item.amount).toFixed(2), 465, y, { width: 85, align: 'right' });

    y += 28;
    doc.strokeColor('#f0f4f8').lineWidth(0.5).moveTo(50, y - 5).lineTo(550, y - 5).stroke();
  });

  y += 5;
  drawLine(doc, y);
  y += 10;

  // Subtotals and GST display. subTotal/taxAmount/totalAmount are
  // Decimal-typed columns: a raw Decimal's own .toLocaleString() silently
  // ignores the locale/fraction-digit options passed to it below (ignored,
  // not thrown — it just renders "1234.5" instead of "1,234.50"), unlike a
  // plain number's. Converting here keeps every downstream use on the same
  // plain-number footing.
  //
  // Nothing here derives subTotal or taxAmount from totalAmount and an
  // assumed rate — Invoice stores exactly one taxAmount, with no CGST/SGST/
  // IGST breakdown (that needs per-line tax modelling — #17), so this prints
  // only the figures actually on the row, or says plainly that they are not
  // available rather than inventing them (issue #57). totalAmount is the one
  // figure every invoice genuinely carries and is always printed as stored.
  const totalAmount = toNumber(invoice.totalAmount);
  const subTotal = toNumber(invoice.subTotal);
  const taxVal = toNumber(invoice.taxAmount);
  const hasTaxBreakdown = subTotal > 0;

  doc.font('Helvetica').fontSize(9);
  doc.text('Subtotal (Net Taxable Value):', 300, y, { align: 'right', width: 150 });
  doc.font('Helvetica-Bold').text(hasTaxBreakdown ? inr(subTotal) : 'Not available', 445, y, { align: 'right', width: 105 });
  y += 15;

  // One tax line, at the rate the invoice's own taxCode names — not a
  // CGST/SGST split, since nothing in this system records how the stored
  // taxAmount divides between them.
  doc.font('Helvetica').text(`GST (${orDash(invoice.taxCode)}):`, 300, y, { align: 'right', width: 150 });
  doc.font('Helvetica-Bold').text(hasTaxBreakdown ? inr(taxVal) : 'Not available', 445, y, { align: 'right', width: 105 });
  y += 15;

  drawLine(doc, y);
  y += 8;

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#004080');
  doc.text('INVOICE TOTAL (INR):', 300, y, { align: 'right', width: 150 });
  doc.text(inr(totalAmount), 445, y, { align: 'right', width: 105 });

  // Digital footnote validation stamps
  y += 45;
  drawLine(doc, y);
  y += 15;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1c1c1c').text('Declaration:', 50, y);
  doc.font('Helvetica-Oblique').fontSize(8.0).fillColor('#4b5563');
  y += 12;
  doc.text('"This is a digital receipt processed and submitted through the VendorConnect Supplier Portal. All material specifications and unit prices are bound by and synchronized with the matching SAP purchase agreement logs."', 50, y, { width: 500 });

  doc.end();
});

// @desc    Get aggregate platform metrics (Admin)
// @route   GET /api/reports/metrics
// @access  Admin/Private
const getPlatformMetrics = asyncHandler(async (req, res, next) => {
  const [totalVendors, totalRfqs, totalPOs, totalInvoices, totalPayments, paymentVolume] = await Promise.all([
    prisma.vendor.count({}),
    prisma.rFQ.count({}),
    prisma.purchaseOrder.count({}),
    prisma.invoice.count({}),
    prisma.payment.count({}),
    prisma.payment.aggregate({ _sum: { netAmount: true } }),
  ]);
  // Prisma's aggregate _sum over a Decimal column returns a Decimal, not a
  // plain number — left unconverted this reaches res.json() below and
  // serializes as a string (see utils/money.js).
  const totalVolume = toNumber(paymentVolume._sum.netAmount) || 0;

  res.json({
    totalVendors,
    totalRfqs,
    totalPOs,
    totalInvoices,
    totalPayments,
    totalVolume
  });
});

module.exports = {
  generateStatement,
  generateInvoicePDF,
  getPlatformMetrics
};
