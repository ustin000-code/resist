const db = require('../config/db');

/** Проверка, что пользователь состоит в чате */
async function assertChatMember(chatId, userId) {
  const r = await db.query(
    'SELECT 1 FROM chat_users WHERE chat_id = $1 AND user_id = $2 LIMIT 1',
    [chatId, userId]
  );
  return r.rows.length > 0;
}

async function ensureMessageActionSchema() {
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_all BOOLEAN DEFAULT FALSE
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS message_hidden_for_users (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    )
  `);
  await db.query(`
    UPDATE messages
       SET updated_at = COALESCE(updated_at, created_at, NOW())
     WHERE updated_at IS NULL
  `);
}

function uniquePositiveIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  )];
}

function parseOptionalTimestamp(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

exports.getMessagesByChatId = async (req, res) => {
  const userId = req.user?.id;
  const chatId = Number(req.params.chatId);
  const beforeId = Number(req.query?.beforeId || 0);
  const requestedLimit = Number(req.query?.limit || 0);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 0;

  try {
    await ensureMessageActionSchema();
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'Некорректный chat_id' });
    }

    const ok = await assertChatMember(chatId, userId);
    if (!ok) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    const result =
      limit > 0 || (Number.isFinite(beforeId) && beforeId > 0)
        ? await db.query(
            `SELECT page.*
               FROM (
                 SELECT m.*
                   FROM messages m
                   LEFT JOIN message_hidden_for_users mh
                     ON mh.message_id = m.id
                    AND mh.user_id = $2
                  WHERE m.chat_id = $1
                    AND mh.message_id IS NULL
                    AND ($3::integer <= 0 OR m.id < $3)
                  ORDER BY m.id DESC
                  LIMIT $4
               ) page
              ORDER BY page.id ASC`,
            [chatId, userId, Number.isFinite(beforeId) && beforeId > 0 ? beforeId : 0, limit || 200]
          )
        : await db.query(
            `SELECT m.*
               FROM messages m
               LEFT JOIN message_hidden_for_users mh
                 ON mh.message_id = m.id
                AND mh.user_id = $2
              WHERE m.chat_id = $1
                AND mh.message_id IS NULL
              ORDER BY m.id ASC`,
            [chatId, userId]
          );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
};

exports.getMessagesByChatDelta = async (req, res) => {
  const userId = req.user?.id;
  const chatId = Number(req.params.chatId);
  const afterId = Number(req.query?.afterId || 0);
  const afterTs = parseOptionalTimestamp(req.query?.afterTs);

  try {
    await ensureMessageActionSchema();
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (!chatId) {
      return res.status(400).json({ error: 'Некорректный chat_id' });
    }

    const ok = await assertChatMember(chatId, userId);
    if (!ok) {
      return res.status(403).json({ error: 'Нет доступа к чату' });
    }

    const result = await db.query(
      `SELECT m.*
         FROM messages m
         LEFT JOIN message_hidden_for_users mh
           ON mh.message_id = m.id
          AND mh.user_id = $2
        WHERE m.chat_id = $1
          AND mh.message_id IS NULL
          AND (
            ($3::integer > 0 AND m.id > $3)
            OR (
              $4::timestamptz IS NOT NULL
              AND GREATEST(
                COALESCE(m.created_at, TO_TIMESTAMP(0)),
                COALESCE(m.updated_at, m.created_at, TO_TIMESTAMP(0)),
                COALESCE(m.delivered_at, m.created_at, TO_TIMESTAMP(0)),
                COALESCE(m.read_at, m.created_at, TO_TIMESTAMP(0))
              ) > $4::timestamptz
            )
          )
        ORDER BY m.id ASC`,
      [chatId, userId, Number.isFinite(afterId) && afterId > 0 ? afterId : 0, afterTs]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки delta сообщений' });
  }
};

exports.updateMessage = async (req, res) => {
  const userId = Number(req.user?.id || 0);
  const messageId = Number(req.params.messageId);
  const text = String(req.body?.text || '').trim();

  try {
    await ensureMessageActionSchema();
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (!messageId) {
      return res.status(400).json({ error: 'Некорректный messageId' });
    }
    if (!text) {
      return res.status(400).json({ error: 'Текст сообщения пуст' });
    }

    const row = await db.query(
      `SELECT m.*
         FROM messages m
         JOIN chat_users cu
           ON cu.chat_id = m.chat_id
          AND cu.user_id = $2
        WHERE m.id = $1
        LIMIT 1`,
      [messageId, userId]
    );
    const message = row.rows[0];
    if (!message) {
      return res.status(404).json({ error: 'Сообщение не найдено' });
    }
    if (Number(message.sender_id) !== userId) {
      return res.status(403).json({ error: 'Редактировать можно только свои сообщения' });
    }
    if (message.deleted_for_all) {
      return res.status(400).json({ error: 'Удалённое сообщение нельзя редактировать' });
    }
    if (String(message.text || '').includes('/uploads/')) {
      return res.status(400).json({ error: 'Сообщение с вложением пока нельзя редактировать' });
    }

    const updated = await db.query(
      `UPDATE messages
          SET text = $2,
              edited_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [messageId, text]
    );

    res.json({ ok: true, message: updated.rows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка редактирования сообщения' });
  }
};

exports.deleteMessages = async (req, res) => {
  const userId = Number(req.user?.id || 0);
  const messageIds = uniquePositiveIds(req.body?.messageIds);
  const scope = String(req.body?.scope || 'self').trim().toLowerCase();

  try {
    await ensureMessageActionSchema();
    if (!userId) {
      return res.status(401).json({ error: 'Не авторизован' });
    }
    if (!messageIds.length) {
      return res.status(400).json({ error: 'Нет сообщений для удаления' });
    }
    if (scope !== 'self' && scope !== 'everyone') {
      return res.status(400).json({ error: 'scope должен быть self или everyone' });
    }

    const rows = await db.query(
      `SELECT m.*
         FROM messages m
         JOIN chat_users cu
           ON cu.chat_id = m.chat_id
          AND cu.user_id = $2
        WHERE m.id = ANY($1::int[])`,
      [messageIds, userId]
    );
    if (!rows.rows.length) {
      return res.status(404).json({ error: 'Сообщения не найдены' });
    }
    if (rows.rows.length !== messageIds.length) {
      return res.status(403).json({ error: 'Часть сообщений недоступна' });
    }

    if (scope === 'everyone') {
      const canDeleteForEveryone = rows.rows.every((message) => {
        return Number(message.sender_id) === userId && !message.deleted_for_all;
      });
      if (!canDeleteForEveryone) {
        return res.status(403).json({ error: 'Удалить у всех можно только свои сообщения' });
      }

      await db.query(
        `UPDATE messages
            SET text = 'Сообщение удалено',
                deleted_for_all = TRUE,
                reply_to_message_id = NULL,
                edited_at = NULL,
                updated_at = NOW()
          WHERE id = ANY($1::int[])`,
        [messageIds]
      );

      return res.json({
        ok: true,
        deleted: true,
        scope,
        messageIds,
      });
    }

    await db.query(
      `INSERT INTO message_hidden_for_users (message_id, user_id)
       SELECT x.message_id, $2
         FROM UNNEST($1::int[]) AS x(message_id)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [messageIds, userId]
    );

    res.json({
      ok: true,
      deleted: true,
      scope,
      messageIds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления сообщений' });
  }
};
