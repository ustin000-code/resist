const db = require('../config/db');

/**
 * Поиск по тексту сообщений в чатах, где участвует текущий пользователь.
 */
exports.searchMessages = async (req, res) => {
  const userId = req.user?.id;
  const q = (req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (q.length < 2) {
      return res.status(400).json({ error: 'Введите минимум 2 символа' });
    }

    const pattern = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

    const result = await db.query(
      `
      SELECT m.id, m.chat_id, m.sender_id, m.receiver_id, m.text, m.created_at,
             COALESCE(c.type, 'direct') AS chat_type,
             c.title AS group_title
      FROM messages m
      JOIN chat_users cu ON cu.chat_id = m.chat_id AND cu.user_id = $1
      JOIN chats c ON c.id = m.chat_id
      WHERE m.text ILIKE $2 ESCAPE '\\'
      ORDER BY m.id DESC
      LIMIT $3
      `,
      [userId, pattern, limit]
    );

    res.json({ results: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
};
