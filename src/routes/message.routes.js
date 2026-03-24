const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth.middleware');
const messageController = require('../controllers/message.controller');

/** Проверка версии API (без auth): есть ли новый бэкенд с /chat/:id */
router.get('/ping', (req, res) => {
  res.json({ ok: true, messagesApi: 'v2' });
});

/** Сообщения чата по id (личный или группа) */
router.get('/chat/:chatId', auth, messageController.getMessagesByChatId);
router.get('/chat/:chatId/delta', auth, messageController.getMessagesByChatDelta);
router.patch('/:messageId', auth, messageController.updateMessage);
router.post('/delete', auth, messageController.deleteMessages);

/** Легаси: диалог двух пользователей (нужен JWT) */
router.get('/dialog/:user1/:user2', auth, async (req, res) => {
  const userId = Number(req.user?.id);
  const u1 = Number(req.params.user1);
  const u2 = Number(req.params.user2);

  if (userId !== u1 && userId !== u2) {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  try {
    const result = await db.query(
      `
      SELECT * FROM messages
      WHERE (sender_id = $1 AND receiver_id = $2)
         OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY id ASC
      `,
      [u1, u2]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения сообщений' });
  }
});

module.exports = router;
