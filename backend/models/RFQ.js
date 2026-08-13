const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

const rfqSchema = new Schema({
  // Unique per tenant — see the compound index below.
  id:             { type: String, required: true },  // 'RFQ-2026-001'
  description:    { type: String, required: true },
  status:         { type: String, enum: ['Draft','Bidding Open','Submitted','Under Review','Awarded','Closed'], default: 'Bidding Open' },
  deadlineDate:   { type: Date, required: true },
  rfqType:        { type: String, enum: ['AN','AB'], default: 'AN' },
  paymentTerms:   String,
  purchasingOrg:  { type: String, default: '1000' },
  purchasingGroup:String,
  companyCode:    { type: String, default: '1000' },
  currency:       { type: String, default: 'INR' },
  deliveryLocation:String,
  createdDate:    { type: Date, default: Date.now },
  
  items: [{
    line:         { type: Number, required: true },
    materialCode: { type: String, required: true },
    description:  String,
    quantity:     { type: Number, required: true },
    uom:          { type: String, default: 'EA' },
    targetPrice:  Number,
    plant:        { type: String, default: '1000' },
    deliveryDate: Date
  }],
  
  bids: [{
    vendorId:     String,        // Clerk user ID
    vendorDbId:   Schema.Types.ObjectId, // MongoDB Vendor._id
    vendorName:   String,
    unitPrices:   { type: Map, of: Number },  // lineNo → price
    gstRate:      String,
    taxCode:      String,        // G1, G2, G3, G4
    freight:      { type: Number, default: 0 },
    deliveryLeadTimeDays: Number,
    vendorRating: Number,
    technicalScore:{ type: Number, default: 80 },
    validityDate: Date,
    moq:          { type: Number, default: 1 },
    remarks:      String,
    uploadedDocs: [{
      documentId:   String,
      originalName: String,
      url:          String
    }],
    submittedAt:  { type: Date, default: Date.now }
  }],
  
  invitedVendors:[{ id: String, name: String, status: { type: String, default: 'Pending' }, rating: Number }],
  awardedVendorId:  String,
  awardedVendorName:String,
  awardedAt:        Date,
  convertedPoId:    String
}, { timestamps: true });

rfqSchema.plugin(tenantPlugin);
rfqSchema.index({ clientId: 1, id: 1 }, { unique: true });
rfqSchema.index({ clientId: 1, status: 1 });
rfqSchema.index({ clientId: 1, deadlineDate: 1 });
rfqSchema.index({ clientId: 1, 'invitedVendors.id': 1 });

module.exports = mongoose.model('RFQ', rfqSchema);
