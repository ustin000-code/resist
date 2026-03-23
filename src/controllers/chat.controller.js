const db = require('../config/db');
const { normalizePhone, isValidPhone } = require('../utils/phone.server');

async function ensureChatUsersReadColumn() {
  await db.query(`
    ALTER TABLE chat_users
    ADD COLUMN IF NOT EXISTS last_read_message_id INTEGER DEFAULT 0
  `);
}

async function ensureChatUsersArchiveColumn() {
  await db.query(`
    ALTER TABLE chat_users
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE
  `);
}

exports.createChat = async (req, res) => {
  const { phone } = req.body;
  const currentUserId = req.user?.id;
  const normalizedPhone = normalizePhone(phone);

  try {
    console.log(`\n========== СОЗДАНИЕ ЧАТА ==========`);
    console.log(`📞 Номер контакта: ${phone}`);
    console.log(`👤 Текущий пользователь: ${currentUserId}`);
    console.log(`🔐 Весь req.user:`, req.user);

    if (!phone) {
      console.log(`❌ Ошибка: телефон не указан`);
      return res.status(400).json({ error: 'Укажите телефон контакта' });
    }
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Некорректный номер телефона контакта' });
    }

    if (!currentUserId) {
      console.log(`❌ Ошибка: пользователь не авторизован. currentUserId=${currentUserId}`);
      console.log(`req.user=`, req.user);
      return res.status(401).json({ error: 'Пользователь не авторизован' });
    }

    // Ищем пользователя по телефону
    console.log(`🔍 Ищу пользователя с телефоном: ${phone}`);
    const userResult = await db.query(
      'SELECT id, name FROM users WHERE phone = $1',
      [normalizedPhone]
    );

    if (userResult.rows.length === 0) {
      console.log(`❌ Ошибка: пользователь не найден`);
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const otherUserId = userResult.rows[0].id;
    const otherUserName = userResult.rows[0].name;

    console.log(`✅ Найден пользователь: ${otherUserName} (ID: ${otherUserId})`);

    // Проверяем, нет ли уже чата между ними
    console.log(`🔍 Проверяю наличие существующего чата...`);
    const existingChat = await db.query(`
      SELECT c.id AS chat_id
      FROM chats c
      JOIN chat_users cu1
        ON cu1.chat_id = c.id
       AND cu1.user_id = $1
      JOIN chat_users cu2
        ON cu2.chat_id = c.id
       AND cu2.user_id = $2
      WHERE COALESCE(c.type, 'direct') = 'direct'
        AND (
          SELECT COUNT(*)::int
          FROM chat_users cu
          WHERE cu.chat_id = c.id
        ) = 2
      ORDER BY c.id DESC
      LIMIT 1
    `, [currentUserId, otherUserId]);

    if (existingChat.rows.length > 0) {
      console.log(`♻️ Чат уже существует: ${existingChat.rows[0].chat_id}`);
      const responseData = {
        chat_id: existingChat.rows[0].chat_id,
        other_user_id: Number(otherUserId)
      };
      console.log(`📤 ОТВЕТ (СУЩЕСТВУЮЩИЙ ЧАТ):`, responseData);
      console.log(`JSON:`, JSON.stringify(responseData));
      console.log(`=====================================\n`);
      return res.json(responseData);
    }

    // Создаём новый чат
    console.log(`📝 Создание нового чата...`);
    const chat = await db.query(
      'INSERT INTO chats DEFAULT VALUES RETURNING id'
    );

    const chatId = chat.rows[0].id;
    console.log(`💬 Чат создан с ID: ${chatId}`);

    // Добавляем обоих пользователей в чат
    console.log(`👥 Добавляю пользователей в чат...`);
    await db.query(
      'INSERT INTO chat_users(chat_id, user_id) VALUES ($1,$2),($1,$3)',
      [chatId, currentUserId, otherUserId]
    );

    console.log(`✅ Добавлены оба пользователя в чат ${chatId}`);

    const responseData = {
      chat_id: Number(chatId),
      other_user_id: Number(otherUserId)
    };
    
    console.log(`📤 ОТВЕТ (НОВЫЙ ЧАТ):`);
    console.log(`   responseData =`, responseData);
    console.log(`   JSON =`, JSON.stringify(responseData));
    console.log(`=====================================\n`);

    res.json(responseData);

  } catch (err) {
    console.error(`\n❌ KRITICHESKAYA OSHIBKA:`, err.message);
    console.error(`Stack:`, err.stack);
    console.error(`=====================================\n`);
    res.status(500).json({ error: err.message });
  }
};


// список чатов пользователя (личные + группы)
exports.getUserChats = async (req, res) => {
  const raw = req.params.userId;
  if (!/^\d+$/.test(String(raw))) {
    return res.status(400).json({ error: 'Некорректный id пользователя' });
  }
  const userId = raw;

  try {
    await ensureChatUsersReadColumn();
    await ensureChatUsersArchiveColumn();
    const result = await db.query(
      `
      SELECT
        c.id AS chat_id,
        CASE
          WHEN COALESCE(c.type, 'direct') = 'group' THEN COALESCE(c.title, 'Группа')
          ELSE ou.name
        END AS name,
        CASE
          WHEN COALESCE(c.type, 'direct') = 'group' THEN NULL
          ELSE ou.id
        END AS other_user_id,
        COALESCE(c.type, 'direct') AS chat_type,
        c.title AS group_title,
        (
          SELECT text FROM messages
          WHERE chat_id = c.id
          ORDER BY id DESC LIMIT 1
        ) AS last_message,
        (
          SELECT created_at FROM messages
          WHERE chat_id = c.id
          ORDER BY id DESC LIMIT 1
        ) AS last_time,
        (
          SELECT COUNT(*)::int
          FROM messages m
          WHERE m.chat_id = c.id
            AND m.sender_id <> $1::integer
            AND m.id > COALESCE(me.last_read_message_id, 0)
        ) AS unread_count
        ,
        COALESCE(me.is_archived, FALSE) AS is_archived
      FROM chats c
      JOIN chat_users me ON me.chat_id = c.id AND me.user_id = $1
      LEFT JOIN LATERAL (
        SELECT u.id, u.name, u.phone AS other_phone
        FROM chat_users cu
        JOIN users u ON u.id = cu.user_id
        WHERE cu.chat_id = c.id AND cu.user_id <> $1
        LIMIT 1
      ) ou ON COALESCE(c.type, 'direct') = 'direct'
      WHERE COALESCE(c.type, 'direct') = 'group'
         OR (
              COALESCE(c.type, 'direct') = 'direct'
              AND (SELECT COUNT(*)::int FROM chat_users WHERE chat_id = c.id) = 2
            )
      ORDER BY COALESCE(
        (
          SELECT created_at FROM messages
          WHERE chat_id = c.id
          ORDER BY id DESC LIMIT 1
        ),
        c.created_at
      ) DESC
      `,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка чатов' });
  }
};

exports.setChatArchived = async (req, res) => {
  const currentUserId = req.user?.id;
  const rawChatId = req.params.chatId;
  const archived = req.body?.archived;
  const chatId = Number(rawChatId);

  if (!currentUserId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return res.status(400).json({ error: 'Некорректный chatId' });
  }
  if (typeof archived !== 'boolean') {
    return res.status(400).json({ error: 'Укажите archived: true/false' });
  }

  try {
    await ensureChatUsersArchiveColumn();
    const membership = await db.query(
      'SELECT 1 FROM chat_users WHERE chat_id = $1 AND user_id = $2',
      [chatId, currentUserId]
    );
    if (!membership.rows.length) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    await db.query(
      'UPDATE chat_users SET is_archived = $1 WHERE chat_id = $2 AND user_id = $3',
      [archived, chatId, currentUserId]
    );

    res.json({ ok: true, chat_id: chatId, archived });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка архивации чата' });
  }
};

exports.deleteChatForUser = async (req, res) => {
  const currentUserId = req.user?.id;
  const rawChatId = req.params.chatId;
  const chatId = Number(rawChatId);

  if (!currentUserId) {
    return res.status(401).json({ error: 'Пользователь не авторизован' });
  }
  if (!Number.isFinite(chatId) || chatId <= 0) {
    return res.status(400).json({ error: 'Некорректный chatId' });
  }

  try {
    const membership = await db.query(
      'SELECT 1 FROM chat_users WHERE chat_id = $1 AND user_id = $2',
      [chatId, currentUserId]
    );
    if (!membership.rows.length) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    await db.query(
      'DELETE FROM chat_users WHERE chat_id = $1 AND user_id = $2',
      [chatId, currentUserId]
    );

    res.json({ ok: true, chat_id: chatId, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления чата' });
  }
};

/** Создать группу: название + id участников (создатель добавляется автоматически) */
exports.createGroup = async (req, res) => {
  const currentUserId = req.user?.id;
  const { title, member_ids: memberIds } = req.body || {};

  try {
    if (!currentUserId) {
      return res.status(401).json({ error: 'Пользователь не авторизован' });
    }
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t) {
      return res.status(400).json({ error: 'Укажите название группы' });
    }
    if (!Array.isArray(memberIds) || memberIds.length < 1) {
      return res.status(400).json({ error: 'Добавьте минимум одного участника (member_ids)' });
    }

    const ids = [...new Set([currentUserId, ...memberIds.map((x) => Number(x)).filter(Boolean)])];
    if (ids.length < 2) {
      return res.status(400).json({ error: 'Нужно минимум два участника' });
    }

    for (const uid of ids) {
      const u = await db.query('SELECT id FROM users WHERE id = $1', [uid]);
      if (u.rows.length === 0) {
        return res.status(400).json({ error: `Пользователь id=${uid} не найден` });
      }
    }

    const chat = await db.query(
      `INSERT INTO chats (type, title) VALUES ('group', $1) RETURNING id`,
      [t]
    );
    const chatId = chat.rows[0].id;

    for (const uid of ids) {
      await db.query(
        'INSERT INTO chat_users (chat_id, user_id) VALUES ($1, $2)',
        [chatId, uid]
      );
    }

    res.json({
      chat_id: Number(chatId),
      chat_type: 'group',
      title: t,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Ошибка создания группы' });
  }
};

exports.markChatRead = async (req, res) => {
  const userId = req.user?.id;
  const chatId = Number(req.params.chatId);

  try {
    if (!userId) {
      return res.status(401).json({ error: 'Пользователь не авторизован' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'Некорректный chatId' });
    }

    await ensureChatUsersReadColumn();

    const membership = await db.query(
      'SELECT 1 FROM chat_users WHERE chat_id = $1 AND user_id = $2 LIMIT 1',
      [chatId, userId]
    );

    if (!membership.rows.length) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    const lastMessage = await db.query(
      'SELECT COALESCE(MAX(id), 0) AS last_id FROM messages WHERE chat_id = $1',
      [chatId]
    );

    const lastId = Number(lastMessage.rows[0]?.last_id || 0);
    await db.query(
      'UPDATE chat_users SET last_read_message_id = $1 WHERE chat_id = $2 AND user_id = $3',
      [lastId, chatId, userId]
    );

    await db.query(
      `UPDATE messages SET read_at = NOW()
       WHERE chat_id = $1 AND id <= $3 AND read_at IS NULL
       AND (
         receiver_id = $2
         OR (receiver_id IS NULL AND sender_id <> $2)
       )`,
      [chatId, userId, lastId]
    );

    res.json({ ok: true, chat_id: chatId, last_read_message_id: lastId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления статуса прочтения' });
  }
};


// найти или создать чат
exports.findOrCreateChat = async (user1, user2) => {
  try {
    console.log(`🔍 Поиск чата между ${user1} и ${user2}`);

    // Ищем чат в обе стороны (user1-user2 и user2-user1)
    const existing = await db.query(`
      SELECT DISTINCT cu1.chat_id
      FROM chat_users cu1
      JOIN chat_users cu2 ON cu1.chat_id = cu2.chat_id
      WHERE 
        (cu1.user_id = $1 AND cu2.user_id = $2)
        OR 
        (cu1.user_id = $2 AND cu2.user_id = $1)
      LIMIT 1
    `, [user1, user2]);

    if (existing.rows.length > 0) {
      console.log(`✅ Чат найден: ${existing.rows[0].chat_id}`);
      return existing.rows[0].chat_id;
    }

    console.log(`📝 Создание нового чата...`);
    
    const chat = await db.query(
      'INSERT INTO chats DEFAULT VALUES RETURNING id'
    );

    const chatId = chat.rows[0].id;
    console.log(`💬 Чат создан с ID: ${chatId}`);

    // Добавляем обоих пользователей в чат
    await db.query(
      'INSERT INTO chat_users(chat_id, user_id) VALUES ($1,$2),($1,$3)',
      [chatId, user1, user2]
    );

    console.log(`👥 Пользователи добавлены в чат ${chatId}`);
    return chatId;

  } catch (err) {
    console.error('❌ Ошибка при поиске/создании чата:', err.message);
    throw err; // ⭐ Бросаем ошибку вместо возврата undefined
  }
};
