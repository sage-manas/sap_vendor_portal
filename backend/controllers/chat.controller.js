const { prisma } = require('../db/prisma');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');

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

// @desc    Send a message
// @route   POST /api/chats
// @access  Public
//
// Writes exactly the one row the caller sent — nothing here fabricates a
// reply attributed to Buyer/Finance/Quality/Warehouse. This used to schedule
// a setTimeout that wrote a keyword-matched "reply" under one of those
// senders, one of them falsely claiming SAP had been updated; no code path
// does that anymore (issue #55). A real reply only ever comes from a real
// person on that role, through whatever surface they use to send one.
const sendMessage = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { clientId } = req;
  const { message, linkedPoId, linkedRfqId } = req.body;

  if (!message || !message.trim()) {
    return next(ApiError.badRequest('Message content cannot be empty'));
  }

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

  const io = req.app.get('io');
  emitToVendor(io, clientId, vendorId, EVENTS.CHAT_MESSAGE, chatMsg);

  res.status(201).json(chatMsg);
});

module.exports = {
  getMessages,
  sendMessage
};
