const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

const grnSchema = new Schema({
  // Unique per tenant — see the compound index below.
  id:              { type: String, required: true }, // e.g. 'GRN-1800xxxxx'
  poId:            { type: String, required: true },
  asnId:           { type: String, required: true },
  vendorId:        { type: String, required: true },
  sapMigoDoc:      String,
  postingDate:     { type: Date, required: true },
  receivedBy:      String,
  invoiceSubmitted:{ type: Boolean, default: false },
  items: [{
    line: Number,
    materialCode: { type: String, required: true },
    description: String,
    receivedQuantity: { type: Number, required: true },
    acceptedQuantity: { type: Number, required: true },
    rejectedQuantity: { type: Number, default: 0 },
    rejectionReason: String,
    uom: { type: String, default: 'EA' }
  }]
}, { timestamps: true });

grnSchema.virtual('totalAccepted').get(function() {
  return this.items.reduce((sum, item) => sum + item.acceptedQuantity, 0);
});

grnSchema.virtual('rejectionRate').get(function() {
  const totalReceived = this.items.reduce((sum, item) => sum + item.receivedQuantity, 0);
  if (totalReceived === 0) return 0;
  const totalRejected = this.items.reduce((sum, item) => sum + item.rejectedQuantity, 0);
  return (totalRejected / totalReceived) * 100;
});

grnSchema.plugin(tenantPlugin);
grnSchema.index({ clientId: 1, id: 1 }, { unique: true });
grnSchema.index({ clientId: 1, vendorId: 1 });
grnSchema.index({ clientId: 1, poId: 1 });

grnSchema.set('toJSON', { virtuals: true });
grnSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GRN', grnSchema);
