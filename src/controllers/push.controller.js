const db = require('../config/db');

/**
 * Регистрация FCM-токена (Capacitor / Android). Дубликаты по (user_id, token) обновляют время.
 */
exports.registerToken = async (req, res) => {
  const userId = req.user?.id;
  const { token, platform } = req.body || {};

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Укажите token' });
    }

    const plat = (platform || 'android').slice(0, 32);

    await db.query(
      `
      INSERT INTO user_push_tokens (user_id, token, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, token) DO UPDATE SET created_at = NOW(), platform = EXCLUDED.platform
      `,
      [userId, token.trim(), plat]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сохранить токен' });
  }
};

exports.unregisterToken = async (req, res) => {
  const userId = req.user?.id;
  const { token } = req.body || {};

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (!token) {
      return res.status(400).json({ error: 'Укажите token' });
    }

    await db.query(
      'DELETE FROM user_push_tokens WHERE user_id = $1 AND token = $2',
      [userId, token.trim()]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка' });
  }
};
