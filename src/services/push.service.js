const fs = require('fs');
const path = require('path');
const db = require('../config/db');

let adminInited = false;
let messaging = null;
const ANDROID_MESSAGES_CHANNEL_ID = 'messages_v2';

function initFirebase() {
  if (adminInited) return messaging;
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const jsonPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!jsonRaw && !jsonPath) {
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    if (admin.apps.length) {
      messaging = admin.messaging();
      adminInited = true;
      return messaging;
    }
    const cred = jsonRaw
      ? JSON.parse(jsonRaw)
      : JSON.parse(
          fs.readFileSync(path.resolve(process.cwd(), jsonPath), 'utf8')
        );
    admin.initializeApp({
      credential: admin.credential.cert(cred),
    });
    messaging = admin.messaging();
    adminInited = true;
    console.log('✅ Firebase Admin (push) инициализирован');
    return messaging;
  } catch (e) {
    console.warn('⚠️ Firebase push недоступен:', e.message);
    return null;
  }
}

/**
 * Уведомить офлайн-участников о новом сообщении (если настроен FCM).
 * @param {object} opts
 * @param {object} opts.message — строка из messages.*
 * @param {number} opts.senderId
 * @param {Record<string, boolean>} opts.foregroundMap — userId -> true (кто сейчас в foreground)
 * @param {string} [opts.preview] — текст превью
 */
async function getPushContext(chatId, senderId) {
  const r = await db.query(
    `SELECT
       COALESCE(c.type, 'direct') AS chat_type,
       COALESCE(c.title, '') AS chat_title,
       COALESCE(u.name, 'Пользователь') AS sender_name
     FROM chats c
     JOIN users u ON u.id = $2
     WHERE c.id = $1
     LIMIT 1`,
    [chatId, senderId]
  );
  return r.rows[0] || {
    chat_type: 'direct',
    chat_title: '',
    sender_name: 'Пользователь',
  };
}

async function getUnreadBadgeCount(userId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(x.unread_count), 0)::int AS unread_total
     FROM (
       SELECT COUNT(*)::int AS unread_count
       FROM chat_users cu
       JOIN messages m ON m.chat_id = cu.chat_id
       WHERE cu.user_id = $1
         AND m.sender_id <> $1
         AND m.id > COALESCE(cu.last_read_message_id, 0)
       GROUP BY cu.chat_id
     ) x`,
    [userId]
  );
  return Number(r.rows[0]?.unread_total || 0);
}

async function notifyNewMessage({ message, senderId, foregroundMap, preview }) {
  const msg = initFirebase();
  if (!msg || !message) return;

  const chatId = message.chat_id;
  const ctx = await getPushContext(chatId, senderId);
  const senderName = String(ctx.sender_name || 'Пользователь').trim() || 'Пользователь';
  const isGroup = String(ctx.chat_type || 'direct') === 'group';
  const chatTitle = isGroup
    ? String(ctx.chat_title || 'Группа').trim() || 'Группа'
    : senderName;
  const r = await db.query(
    'SELECT user_id FROM chat_users WHERE chat_id = $1 AND user_id <> $2',
    [chatId, senderId]
  );

  const bodyBase =
    preview ||
    (String(message.text || '').length > 120
      ? `${String(message.text).slice(0, 117)}…`
      : String(message.text || 'Новое сообщение'));
  const body = isGroup ? `${senderName}: ${bodyBase}` : bodyBase;

  const data = {
    type: 'message',
    chatId: String(chatId),
    messageId: String(message.id),
    senderId: String(senderId),
    senderName,
    chatTitle,
  };

  for (const row of r.rows) {
    const uid = String(row.user_id);
    if (foregroundMap && foregroundMap[uid]) continue;

    const tokensR = await db.query(
      'SELECT token, platform FROM user_push_tokens WHERE user_id = $1',
      [row.user_id]
    );
    const tokens = tokensR.rows.filter((x) => x.token);
    if (!tokens.length) continue;
    const badge = await getUnreadBadgeCount(row.user_id);

    const dataStr = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    );
    for (const tokenRow of tokens) {
      try {
        await msg.send({
          token: tokenRow.token,
          notification: { title: chatTitle, body },
          data: dataStr,
          android: {
            priority: 'high',
            ttl: 24 * 60 * 60 * 1000,
            notification: {
              channelId: ANDROID_MESSAGES_CHANNEL_ID,
              icon: 'ic_stat_resist',
              color: '#26C6CF',
              sound: 'default',
              defaultVibrateTimings: true,
              vibrateTimingsMillis: [0, 250, 180, 320],
              notificationCount: Math.max(1, badge),
              visibility: 'public',
              tag: `chat-${chatId}`,
            },
          },
          apns: {
            headers: {
              'apns-priority': '10',
            },
            payload: {
              aps: {
                sound: 'default',
                badge,
                'thread-id': `chat-${chatId}`,
              },
            },
          },
        });
      } catch (e) {
        console.warn('[push] send:', e.message);
      }
    }
  }
}

module.exports = { notifyNewMessage, initFirebase };
