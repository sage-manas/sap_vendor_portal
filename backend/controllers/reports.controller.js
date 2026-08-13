const PDFDocument = require('pdfkit');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const Vendor = require('../models/Vendor');
const PurchaseOrder = require('../models/PurchaseOrder');
const RFQ = require('../models/RFQ');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const { requireVendorScope } = require('../utils/requestScope');

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
  const vendor = await Vendor.findOne({ $or: [{ vendorId }, { clerkId: vendorId }] });
  
  // Get all payments for this vendor
  const payments = await Payment.find({ vendorId }).sort({ paymentDate: -1 });

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
      const gross = pmt.grossAmount || pmt.amount;
      const tds = pmt.tdsDeducted || 0;
      const net = pmt.netAmount || pmt.amount;

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

  const invoice = await Invoice.findOne({ id });
  if (!invoice) {
    return next(ApiError.notFound('Invoice document not found'));
  }

  const vendor = await Vendor.findOne({ $or: [{ vendorId: invoice.vendorId }, { clerkId: invoice.vendorId }] });
  const po = await PurchaseOrder.findOne({ id: invoice.poId });

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
    doc.text(item.unitPrice.toFixed(2), 385, y, { width: 70, align: 'right' });
    doc.text(item.amount.toFixed(2), 465, y, { width: 85, align: 'right' });
    
    y += 28;
    doc.strokeColor('#f0f4f8').lineWidth(0.5).moveTo(50, y - 5).lineTo(550, y - 5).stroke();
  });

  y += 5;
  drawLine(doc, y);
  y += 10;

  // Subtotals and GST rates display
  const subTotal = invoice.subTotal || (invoice.totalAmount / 1.18);
  const taxVal = invoice.taxAmount || (invoice.totalAmount - subTotal);

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
  doc.text(`₹${invoice.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 465, y, { align: 'right', width: 85 });

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
  const totalVendors = await Vendor.countDocuments({});
  const totalRfqs = await RFQ.countDocuments({});
  const totalPOs = await PurchaseOrder.countDocuments({});
  const totalInvoices = await Invoice.countDocuments({});
  const totalPayments = await Payment.countDocuments({});

  const paymentVolume = await Payment.aggregate([
    { $group: { _id: null, total: { $sum: "$netAmount" } } }
  ]);
  const totalVolume = paymentVolume.length > 0 ? paymentVolume[0].total : 0;

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
