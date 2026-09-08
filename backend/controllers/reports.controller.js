const PDFDocument = require('pdfkit');
const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const { requireVendorScope } = require('../utils/requestScope');
const { toNumber } = require('../utils/money');

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
  const payments = await prisma.payment.findMany({ where: { vendorId }, orderBy: { paymentDate: 'desc' } });

  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  // Stream directly to response
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="statement-Q1-2026.pdf"');
  doc.pipe(res);

  // Title / Branding Header
  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(18).text('VendorConnect Portal', 50, 50);
  doc.fillColor('#1c1c1c').font('Helvetica').fontSize(10).text('Enterprise Supplier Self-Service Platform', 50, 70);

  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(12).text('ACCOUNT STATEMENT', 350, 50, { align: 'right' });
  doc.fillColor('#1c1c1c').font('Helvetica-Bold').fontSize(9).text('Period: Q1 FY 2026-27', 350, 68, { align: 'right' });
  doc.font('Helvetica').text(`Run Date: ${new Date().toLocaleDateString('en-IN')}`, 350, 80, { align: 'right' });

  drawLine(doc, 100);

  // Vendor Information Block
  doc.font('Helvetica-Bold').fontSize(10).text('SUPPLIER PROFILE', 50, 115);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Company: ${vendor ? vendor.companyName : 'Bharat Steel & Alloys Pvt. Ltd.'}`, 50, 130);
  doc.text(`Vendor Code: ${vendor ? (vendor.sapVendorCode || 'SAP-100042') : 'SAP-100042'}`, 50, 142);
  doc.text(`GSTIN: ${vendor ? (vendor.gstin || '27AABCB1234F1Z5') : '27AABCB1234F1Z5'}`, 50, 154);
  doc.text(`PAN: ${vendor ? (vendor.pan || 'AABCB1234F') : 'AABCB1234F'}`, 50, 166);

  // Banking Summary Block
  doc.font('Helvetica-Bold').fontSize(10).text('PAYEE BANKING REFERENCE', 320, 115);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Bank Name: ${vendor ? (vendor.bankName || 'HDFC Bank Ltd') : 'HDFC Bank Ltd'}`, 320, 130);
  doc.text(`A/C Number: ${vendor ? (vendor.accountNumber || '50200049281029') : '50200049281029'}`, 320, 142);
  doc.text(`IFSC Code: ${vendor ? (vendor.ifscCode || 'HDFC0000001') : 'HDFC0000001'}`, 320, 154);
  doc.text(`Branch: ${vendor ? (vendor.bankBranch || 'Nariman Point, Mumbai') : 'Nariman Point, Mumbai'}`, 320, 166);

  drawLine(doc, 190);

  // Table Headers
  const tableTop = 210;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#004080');
  doc.text('Date', 50, tableTop);
  doc.text('UTR Reference / Pmt Doc', 115, tableTop);
  doc.text('Invoice Ref', 245, tableTop);
  doc.text('Gross Amt', 335, tableTop, { width: 65, align: 'right' });
  doc.text('TDS (1%)', 405, tableTop, { width: 55, align: 'right' });
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
      const invRef = pmt.invoiceNumber || 'INV-REF';
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
      doc.text(`₹${gross.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 335, y, { width: 65, align: 'right' });
      doc.text(`-₹${tds.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 405, y, { width: 55, align: 'right' });
      doc.text(`₹${net.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { width: 85, align: 'right' });

      y += 20;
      // Draw subline
      doc.strokeColor('#f0f4f8').lineWidth(0.5).moveTo(50, y - 5).lineTo(550, y - 5).stroke();
    });
  } else {
    // Render empty layout row
    doc.text('No payment history records registered for the current period.', 50, y, { align: 'center', width: 500 });
    y += 25;
  }

  y += 5;
  drawLine(doc, y);
  y += 10;

  // Render Table Totals row
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#004080');
  doc.text('TOTAL VOLUME SUMMARY', 50, y);
  doc.text(`₹${totalGross.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 335, y, { width: 65, align: 'right' });
  doc.text(`-₹${totalTds.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 405, y, { width: 55, align: 'right' });
  doc.text(`₹${totalNet.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { width: 85, align: 'right' });

  y += 25;
  drawLine(doc, y);

  // Footer notes / compliance reference details
  y += 20;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1c1c1c').text('Important Compliance Information:', 50, y);
  doc.font('Helvetica').fontSize(8).fillColor('#4b5563');
  y += 12;
  doc.text('1. TDS deduction listed above represents withholding tax deposited under Income Tax Section 194C.', 50, y);
  y += 10;
  doc.text('2. Corresponding quarterly Form 16A TDS certificates can be retrieved from the Payments ledger window.', 50, y);
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
  const po = await prisma.purchaseOrder.findFirst({ where: { id: invoice.poId } });

  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoiceNumber}.pdf"`);
  doc.pipe(res);

  // Title / Branding Header
  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(16).text(vendor ? vendor.companyName : 'Bharat Steel & Alloys Pvt. Ltd.', 50, 50);
  doc.fillColor('#1c1c1c').font('Helvetica').fontSize(9).text(vendor ? (vendor.address || 'Street address line') : 'Street address line', 50, 68);
  doc.text(`${vendor ? (vendor.city || 'Mumbai') : 'Mumbai'}, ${vendor ? (vendor.state || 'Maharashtra') : 'Maharashtra'} - ${vendor ? (vendor.postalCode || '400001') : '400001'}`, 50, 80);
  doc.text(`GSTIN: ${vendor ? vendor.gstin : '27AABCB1234F1Z5'} | PAN: ${vendor ? vendor.pan : 'AABCB1234F'}`, 50, 92);

  doc.fillColor('#004080').font('Helvetica-Bold').fontSize(13).text('TAX INVOICE', 350, 50, { align: 'right' });
  doc.fillColor('#1c1c1c').font('Helvetica-Bold').fontSize(9).text(`Invoice No: ${invoice.invoiceNumber}`, 350, 68, { align: 'right' });
  doc.font('Helvetica').text(`Invoice Date: ${new Date(invoice.invoiceDate).toLocaleDateString('en-IN')}`, 350, 80, { align: 'right' });
  doc.text(`SAP Miro Doc: ${invoice.sapMiroDoc}`, 350, 92, { align: 'right' });

  drawLine(doc, 110);

  // Bill To (Enterprise Customer details)
  doc.font('Helvetica-Bold').fontSize(9.5).text('BILL TO (CUSTOMER)', 50, 130);
  doc.font('Helvetica').fontSize(9);
  doc.text('Indian Manufacturing Enterprise Ltd.', 50, 145);
  doc.text('Plant 1000 Procurement and Accounts Desk,', 50, 157);
  doc.text('Main Industrial Area, Sector 4,', 50, 169);
  doc.text('Mumbai, Maharashtra - 400012', 50, 181);
  doc.text('GSTIN: 27AAAAM1000A1Z0 (Enterprise)', 50, 193);

  // Shipping details / reference links
  doc.font('Helvetica-Bold').fontSize(9.5).text('TRANSACTION REFERENCES', 320, 130);
  doc.font('Helvetica').fontSize(9);
  doc.text(`Purchase Order ID: ${invoice.poId}`, 320, 145);
  doc.text(`SAP PO Number: ${po ? (po.sapPoNumber || '4500000129') : '4500000129'}`, 320, 157);
  doc.text(`Goods Receipt GRN: ${invoice.grnId}`, 320, 169);
  doc.text(`Payment Terms: ${po ? (po.paymentTerms || 'NET 30 Days') : 'NET 30 Days'}`, 320, 181);
  doc.text(`Currency: ${invoice.currency}`, 320, 193);

  drawLine(doc, 215);

  // Table Headers
  const tableTop = 235;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#004080');
  doc.text('Line', 50, tableTop, { width: 30 });
  doc.text('Material / Description', 90, tableTop, { width: 180 });
  doc.text('Quantity', 280, tableTop, { width: 50, align: 'right' });
  doc.text('UOM', 340, tableTop, { width: 35 });
  doc.text('Rate (₹)', 385, tableTop, { width: 70, align: 'right' });
  doc.text('Amount (₹)', 465, tableTop, { width: 85, align: 'right' });

  drawLine(doc, 250);

  // Items rows
  let y = 260;
  doc.font('Helvetica').fontSize(8.5).fillColor('#1c1c1c');

  invoice.items.forEach(item => {
    doc.text(String(item.line), 50, y, { width: 30 });
    doc.text(`${item.materialCode}\n${item.description}`, 90, y, { width: 180 });
    doc.text(String(item.quantity), 280, y, { width: 50, align: 'right' });
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

  // Subtotals and GST rates display. subTotal/taxAmount/totalAmount are
  // Decimal-typed columns: a raw Decimal's own .toLocaleString() silently
  // ignores the locale/fraction-digit options passed to it below (ignored,
  // not thrown — it just renders "1234.5" instead of "1,234.50"), unlike a
  // plain number's. Converting here, before either fallback expression runs,
  // keeps every downstream use — including the ones below that only "happen"
  // to work today because `/` and `-` force numeric coercion — on the same
  // plain-number footing.
  const totalAmount = toNumber(invoice.totalAmount);
  const subTotal = toNumber(invoice.subTotal) || (totalAmount / 1.18);
  const taxVal = toNumber(invoice.taxAmount) || (totalAmount - subTotal);

  doc.font('Helvetica').fontSize(9);
  doc.text('Subtotal (Net Taxable Value):', 300, y, { align: 'right', width: 150 });
  doc.font('Helvetica-Bold').text(`₹${subTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { align: 'right', width: 85 });
  y += 15;

  // Standard 18% split (CGST 9% + SGST 9%)
  doc.font('Helvetica').text('CGST @ 9.0%:', 300, y, { align: 'right', width: 150 });
  doc.font('Helvetica-Bold').text(`₹${(taxVal / 2).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { align: 'right', width: 85 });
  y += 15;

  doc.font('Helvetica').text('SGST @ 9.0%:', 300, y, { align: 'right', width: 150 });
  doc.font('Helvetica-Bold').text(`₹${(taxVal / 2).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { align: 'right', width: 85 });
  y += 15;

  drawLine(doc, y);
  y += 8;

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#004080');
  doc.text('INVOICE TOTAL (INR):', 300, y, { align: 'right', width: 150 });
  doc.text(`₹${totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { align: 'right', width: 85 });

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
