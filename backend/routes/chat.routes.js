const router = require('express').Router();
const chatController = require('../controllers/chat.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { chatMessageSchema } = require('../validators/chat.validator');

router.get('/', requirePermission(PERMISSIONS.CHAT_READ), chatController.getMessages);
router.post('/', requirePermission(PERMISSIONS.CHAT_WRITE), validate(chatMessageSchema), chatController.sendMessage);

module.exports = router;
