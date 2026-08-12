const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

const chatMessageSchema = new Schema({
  vendorId:    { type: String, required: true }, // Clerk user ID
  sender:      { type: String, enum: ['Vendor', 'Buyer', 'System', 'Finance', 'Quality', 'Warehouse'], required: true },
  message:     { type: String, required: true, maxlength: 1000 },
  linkedPoId:  { type: String },
  linkedRfqId: { type: String },
  timestamp:   { type: Date, default: Date.now },
  isRead:      { type: Boolean, default: false }
}, { timestamps: true });

chatMessageSchema.plugin(tenantPlugin);
chatMessageSchema.index({ clientId: 1, vendorId: 1, timestamp: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
