const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

const paymentSchema = new Schema({
  // Unique per tenant — see the compound index below.
  id:            { type: String, required: true },
  invoiceId:     { type: String, required: true },
  poId:          { type: String, required: true },
  vendorId:      { type: String, required: true },
  invoiceRef:    String,
  invoiceNumber: { type: String },
  sapMiroDoc:    { type: String },
  grossAmount:   { type: Number },
  tdsDeducted:   { type: Number, default: 0 },
  netAmount:     { type: Number, required: true },
  paymentDate:   { type: Date, required: true },
  utrCode:       { type: String, required: true },
  paymentMethod: { type: String, enum: ['NEFT','RTGS','IMPS'], default: 'NEFT' },
  sapPaymentDoc: String,
  bankName:      String,
  runId:         String,    // F110 Run ID
  
  // TDS quarterly certificate fields
  fiscalYear:    { type: Number },
  quarter:       { type: String },
  tdsSection:    { type: String },
  deducteePan:   { type: String },
  deductorTan:   { type: String },
  totalTds:      { type: Number }
}, { timestamps: true });

paymentSchema.plugin(tenantPlugin);
paymentSchema.index({ clientId: 1, id: 1 }, { unique: true });
paymentSchema.index({ clientId: 1, vendorId: 1 });
paymentSchema.index({ clientId: 1, invoiceId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
