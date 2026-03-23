const db = require('../config/db');
const { normalizePhone, isValidPhone } = require('../utils/phone.server');
const { normalizeEmail, isValidEmail } = require('../utils/email.server');

function sanitizeUserRow(row) {
  if (!row) return null;
  const { password: _p, ...safe } = row;
  return safe;
}

const MAX_MATCH_PHONES = 500;

/**
 * Раньше отдавались все пользователи — это дыра в приватности и не «контакты из телефона».
 * Каталог отключён; используйте POST /api/users/match с номерами из адресной книги (или другим ограниченным набором).
 */
exports.getUsers = async (req, res) => {
  res.status(403).json({
    error:
      'Полный список пользователей недоступен. Используйте POST /api/users/match с массивом номеров.',
  });
};

/**
 * Кто из переданных нормализуемых номеров зарегистрирован (кроме текущего пользователя).
 * Тело: { phones: string[] }
 */
exports.matchUsersByPhones = async (req, res) => {
  const currentUserId = req.user?.id;
  if (!currentUserId) {
    return res.status(401).json({ error: 'Не авторизован' });
  }

  const raw = req.body?.phones;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'Ожидается phones: string[]' });
  }
  if (raw.length > MAX_MATCH_PHONES) {
    return res
      .status(400)
      .json({ error: `Не больше ${MAX_MATCH_PHONES} номеров за запрос` });
  }

  const unique = new Set();
  for (const p of raw) {
    const n = normalizePhone(p);
    if (/^7\d{10}$/.test(n)) {
      unique.add(n);
    }
  }

  const list = [...unique];
  if (list.length === 0) {
    return res.json([]);
  }

  try {
    const result = await db.query(
      `SELECT id, name, phone FROM users
       WHERE phone = ANY($1::text[])
         AND id <> $2::integer
       ORDER BY name`,
      [list, currentUserId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMe = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const r = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(sanitizeUserRow(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Карточка пользователя для чата: только если есть общий чат (личный или группа).
 * Без email и прочих лишних полей.
 */
exports.getPeerProfile = async (req, res) => {
  const myId = req.user?.id;
  if (!myId) return res.status(401).json({ error: 'Не авторизован' });

  const raw = req.params.userId;
  if (!/^\d+$/.test(String(raw || ''))) {
    return res.status(400).json({ error: 'Некорректный id' });
  }
  const peerId = Number(raw);
  if (!peerId || peerId === Number(myId)) {
    return res.status(400).json({ error: 'Некорректный пользователь' });
  }

  try {
    const shared = await db.query(
      `SELECT 1
       FROM chat_users cu1
       JOIN chat_users cu2 ON cu1.chat_id = cu2.chat_id AND cu2.user_id = $2
       WHERE cu1.user_id = $1
       LIMIT 1`,
      [myId, peerId]
    );
    if (!shared.rows.length) {
      return res.status(403).json({ error: 'Нет общего чата с этим пользователем' });
    }

    const u = await db.query(
      'SELECT id, name, phone, avatar_url FROM users WHERE id = $1',
      [peerId]
    );
    if (!u.rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json(u.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** PATCH { name?, email?, avatar_url? } — хотя бы одно поле */
exports.patchMe = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Не авторизован' });

  const body = req.body || {};
  const updates = [];
  const vals = [];
  let i = 1;

  if (body.name !== undefined) {
    const n = String(body.name || '').trim();
    if (n.length > 120) {
      return res.status(400).json({ error: 'Имя не длиннее 120 символов' });
    }
    updates.push(`name = $${i++}`);
    vals.push(n || 'Пользователь');
  }

  if (body.email !== undefined) {
    const e = normalizeEmail(body.email);
    if (!isValidEmail(e)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    const clash = await db.query(
      `SELECT id FROM users
       WHERE email IS NOT NULL AND trim(email) <> ''
         AND lower(trim(email::text)) = lower(trim($1::text)) AND id <> $2`,
      [e, userId]
    );
    if (clash.rows.length) {
      return res.status(409).json({ error: 'Этот email уже используется' });
    }
    updates.push(`email = $${i++}`);
    vals.push(e);
  }

  if (body.avatar_url !== undefined) {
    const u = String(body.avatar_url || '').trim();
    if (u && (!u.startsWith('/uploads/') || u.length > 500 || u.includes('..'))) {
      return res.status(400).json({ error: 'Некорректный URL аватара' });
    }
    updates.push(`avatar_url = $${i++}`);
    vals.push(u || null);
  }

  if (!updates.length) {
    return res.status(400).json({ error: 'Укажите name, email или avatar_url' });
  }

  try {
    vals.push(userId);
    await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`,
      vals
    );

    if (body.email !== undefined) {
      const phoneRow = await db.query('SELECT phone FROM users WHERE id = $1', [userId]);
      const p = normalizePhone(phoneRow.rows[0]?.phone);
      const e = normalizeEmail(body.email);
      if (isValidPhone(p) && isValidEmail(e)) {
        await db.query(
          `INSERT INTO auth_phone_email_binding (phone_normalized, email_normalized)
           VALUES ($1, $2)
           ON CONFLICT (phone_normalized) DO UPDATE SET email_normalized = EXCLUDED.email_normalized`,
          [p, e]
        );
      }
    }

    const r = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    res.json(sanitizeUserRow(r.rows[0]));
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Конфликт уникальности (email)' });
    }
    res.status(500).json({ error: err.message });
  }
};
