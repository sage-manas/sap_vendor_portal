const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

const purchaseOrderSchema = new Schema({
  // Unique per tenant — see the compound index below.
  id:            { type: String, required: true }, // e.g. 'PO-2026-0081'
  sapPoNumber:   String,
  vendorId:      { type: String, required: true },        // Clerk user ID
  vendorDbId:    { type: Schema.Types.ObjectId, ref: 'Vendor' },
  buyerName:     String,
  plant:         String,
  paymentTerms:  String,
  currency:      { type: String, default: 'INR' },
  incoterms:     String,
  deliveryAddress:String,
  status:        { type: String, enum: ['Open','Acknowledged','Dispatched','Delivered','Invoiced','Paid'], default: 'Open' },
  createdDate:   { type: Date, default: Date.now },
  acknowledgedAt:Date,
  fromRfqId:     String,
  
  items: [{
    line: { type: Number, required: true },
    materialCode: { type: String, required: true },
    description: String,
    quantity: { type: Number, required: true },
    grnQuantity: { type: Number, default: 0 },
    unitPrice: { type: Number, required: true },
    netValue: { type: Number, required: true },
    uom: { type: String, default: 'EA' }
  }]
}, { timestamps: true });

purchaseOrderSchema.plugin(tenantPlugin);
purchaseOrderSchema.index({ clientId: 1, id: 1 }, { unique: true });
purchaseOrderSchema.index({ clientId: 1, vendorId: 1 });
purchaseOrderSchema.index({ clientId: 1, status: 1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
