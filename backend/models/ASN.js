const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

const asnSchema = new Schema({
  // Business IDs are unique per tenant, not globally — see the compound index below.
  id:                { type: String, required: true }, // e.g. 'ASN-826291'
  poId:              { type: String, required: true },               // ref PO.id
  vendorId:          { type: String, required: true },
  status:            { type: String, enum: ['Submitted','In Transit','Received'], default: 'Submitted' },
  shipDate:          { type: Date, required: true },
  estimatedDeliveryDate: { type: Date, required: true },
  carrierName:       String,
  trackingNumber:    String,
  vehicleNumber:     String,
  invoiceReference:  String,
  ewayBillNo:        String,
  sapInboundDelivery:String,
  documentIds:       [{ type: Schema.Types.ObjectId, ref: 'File' }],  // uploaded files (or file documents)
  items:             [{
    line: Number,
    materialCode: { type: String, required: true },
    description: String,
    shippedQuantity: { type: Number, required: true },
    uom: { type: String, default: 'EA' }
  }],
  submittedAt:       { type: Date, default: Date.now }
}, { timestamps: true });

asnSchema.plugin(tenantPlugin);
asnSchema.index({ clientId: 1, id: 1 }, { unique: true });
asnSchema.index({ clientId: 1, vendorId: 1 });
asnSchema.index({ clientId: 1, status: 1 });
asnSchema.index({ clientId: 1, poId: 1 });

module.exports = mongoose.model('ASN', asnSchema);
