const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const chatController = require('../controllers/chat.controller');

router.get('/:userId/delta', auth, chatController.getUserChatsDelta);
router.get('/:userId', auth, chatController.getUserChats);
router.post('/create', auth, chatController.createChat);
router.post('/group', auth, chatController.createGroup);
router.post('/:chatId/read', auth, chatController.markChatRead);
router.post('/:chatId/archive', auth, chatController.setChatArchived);
router.patch('/:chatId/archive', auth, chatController.setChatArchived);
router.post('/:chatId/delete', auth, chatController.deleteChatForUser);
router.delete('/:chatId', auth, chatController.deleteChatForUser);

module.exports = router;
