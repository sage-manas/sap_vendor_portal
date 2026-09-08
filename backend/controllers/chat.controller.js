const { prisma } = require('../db/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');
const { runWithTenant } = require('../utils/tenantContext');

const { requireVendorScope } = require('../utils/requestScope');

// @desc    Get all chat messages for the current vendor
// @route   GET /api/chats
// @access  Public (Will be secured later)
const getMessages = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);

  // Find all messages for the vendor
  const messages = await prisma.chatMessage.findMany({ where: { vendorId }, orderBy: { timestamp: 'asc' } });

  // Mark all unread messages from Buyer/System/etc. as read
  await prisma.chatMessage.updateMany({
    where: { vendorId, sender: { not: 'Vendor' }, isRead: false },
    data: { isRead: true },
  });

  res.json(messages);
});

// @desc    Send a message and trigger smart auto-replies
// @route   POST /api/chats
// @access  Public
const sendMessage = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { clientId } = req;
  const { message, linkedPoId, linkedRfqId } = req.body;

  if (!message || !message.trim()) {
    return next(ApiError.badRequest('Message content cannot be empty'));
  }

  // Create vendor message
  const chatMsg = await prisma.chatMessage.create({
    data: {
      vendorId,
      sender: 'Vendor',
      message: message.trim(),
      linkedPoId: linkedPoId || null,
      linkedRfqId: linkedRfqId || null,
      timestamp: new Date(),
      isRead: true
    },
  });

  // Emit to socket room
  const io = req.app.get('io');
  emitToVendor(io, clientId, vendorId, EVENTS.CHAT_MESSAGE, chatMsg);

  // Parse keyword for smart reply
  const lowerText = message.toLowerCase();
  let replyText = "We have received your query and updated the transaction record in SAP. A buyer officer will get back to you shortly.";
  let senderRole = 'Buyer';

  if (lowerText.includes('price') || lowerText.includes('tax') || lowerText.includes('gst')) {
    replyText = "Tax code G1 (18% GST) applies to regular domestic supplies. Ensure your matching HSN invoice parameters align exactly with the Purchase Order unit rates.";
    senderRole = 'Finance';
  } else if (lowerText.includes('delivery') || lowerText.includes('delay') || lowerText.includes('dispatched')) {
    replyText = "Please send us your shipment details with the expected delivery dates. If the delay is significant, message the logistics desk.";
    senderRole = 'Warehouse';
  } else if (lowerText.includes('reject') || lowerText.includes('quality') || lowerText.includes('defect')) {
    replyText = "Quality rejection requires a signed Inspection Sheet and a copy of the discrepancy report. Please submit a physical claim form or contact warehouse quality control.";
    senderRole = 'Quality';
  }

  // Simulate auto-reply after 2 seconds. The timer fires outside the request,
  // so the tenant context has to be re-bound explicitly.
  setTimeout(() => runWithTenant(clientId, async () => {
    try {
      const replyMsg = await prisma.chatMessage.create({
        data: {
          vendorId,
          sender: senderRole,
          message: replyText,
          linkedPoId: linkedPoId || null,
          linkedRfqId: linkedRfqId || null,
          timestamp: new Date(),
          isRead: false
        },
      });

      emitToVendor(io, clientId, vendorId, EVENTS.CHAT_MESSAGE, replyMsg);
      console.log(`[Socket Chat] Sent auto-reply to vendor ${vendorId}: "${replyText}"`);
    } catch (err) {
      console.error('[Socket Chat] Failed to send auto-reply:', err);
    }
  }), 2000);

  res.status(201).json(chatMsg);
});

module.exports = {
  getMessages,
  sendMessage
};
