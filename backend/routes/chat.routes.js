const router = require('express').Router();
const chatController = require('../controllers/chat.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const requireFeature = require('../middleware/requireFeature');
const { PERMISSIONS } = require('../config/permissions');
const { chatMessageSchema } = require('../validators/chat.validator');

// Messaging is a feature a tenant can switch off (config/tenantSettings.js).
// The flag closes the API, not just the screen.
router.use(requireFeature('features.supplierChat'));

router.get('/', requirePermission(PERMISSIONS.CHAT_READ), chatController.getMessages);
router.post('/', requirePermission(PERMISSIONS.CHAT_WRITE), validate(chatMessageSchema), chatController.sendMessage);

module.exports = router;
