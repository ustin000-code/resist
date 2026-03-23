const path = require('path');
// Всегда .env рядом с server.js, даже если запуск из другой директории (иначе OTP_* и DB_* не читаются)
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const express = require('express');
const cors = require('cors');

/**
 * Оболочка над src/app: маршруты профиля здесь — даже если на сервере старый src/app.js
 * без /me, после git pull достаточно перезапустить node server.js (этот файл).
 */
const authMiddleware = require('./src/middleware/auth.middleware');
const userController = require('./src/controllers/user.controller');
const authController = require('./src/controllers/auth.controller');
const {
  APK_RELEASE_PATH,
  inviteLinkHandler,
  serveApkDownload,
  serveAndroidInstallPage,
  apkDownloadDiagnosticHandler,
} = require('./src/utils/inviteAndApk');
const {
  getAndroidUpdateConfig,
  androidUpdateHandler,
  androidUpdateStatusHandler,
} = require('./src/utils/androidUpdate.server');
const innerApp = require('./src/app');

const app = express();
/** За reverse-proxy (nginx) — корректные req.protocol / Host для абсолютных ссылок в API. */
app.set('trust proxy', 1);
app.use(
  cors({
    origin: '*',
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());

/** Без авторизации: если 404 — на :3000 не этот server.js (другой процесс / старый деплой). */
app.get('/api/__server_js', (_req, res) => {
  res.json({
    ok: true,
    entry: 'server.js',
    outerProfileRoutes: true,
    pid: process.pid,
  });
});

/** Диагностика: HTTP + Socket.IO для сообщений (без авторизации). */
app.get('/api/__messaging_health', (_req, res) => {
  res.json({
    ok: true,
    http: true,
    socketIo: {
      path: '/socket.io',
      transports: 'websocket + polling',
      clientEmits: 'join(userId), send_message({ sender_id, chat_id, text }), typing, …',
      serverEmits: 'receive_message, message_sent, messages_read, online_users, …',
    },
    serverLogs:
      'При успешной отправке в логе Node: 📨 Получено сообщение … 💾 Сообщение сохранено',
    checkFromPhone:
      'Откройте в браузере телефона этот же хост:порт + /api/__messaging_health — должен быть JSON ok:true',
  });
});

app.get('/api/users/me', authMiddleware, userController.getMe);
app.patch('/api/users/me', authMiddleware, userController.patchMe);
app.get('/api/users/me/', authMiddleware, userController.getMe);
app.patch('/api/users/me/', authMiddleware, userController.patchMe);
app.get('/api/auth/me', authMiddleware, userController.getMe);
app.patch('/api/auth/me', authMiddleware, userController.patchMe);
app.get('/api/auth/me/', authMiddleware, userController.getMe);
app.patch('/api/auth/me/', authMiddleware, userController.patchMe);

/** Вход по пригласительной ссылке (без OTP) — дублируем здесь: иначе при старом src/app на VPS будет 404. */
app.post('/api/auth/invite-register', authController.inviteRegister);
app.post('/api/auth/invite-register/', authController.inviteRegister);

/** Проверка обновления Android APK (без авторизации). См. docs/ANDROID_UPDATE.md */
app.get("/api/app/android-update", androidUpdateHandler);
app.get("/api/app/android-update/", androidUpdateHandler);
app.get("/api/__android_update_status", androidUpdateStatusHandler);

app.get("/api/app/invite-link", inviteLinkHandler);
app.get("/api/app/invite-link/", inviteLinkHandler);

app.get("/api/__apk_download", apkDownloadDiagnosticHandler);
app.get("/download/android-update", serveAndroidInstallPage);
app.get("/download/install", serveAndroidInstallPage);
app.get("/download/app.apk", serveApkDownload);
app.get("/download/resist.apk", serveApkDownload);
/** Тот же файл — короткая ссылка, как часто отдают с порта (напр. :8080): /app-debug.apk */
app.get("/app-debug.apk", serveApkDownload);
/** Медиа через /api: надёжно за reverse-proxy, где проброшен только /api. */
app.use("/api/uploads", express.static(path.join(__dirname, "uploads")));

app.use(innerApp);

// Диагностика: в логе при старте должно быть hasRequestCodeRoute: true
try {
  const authRoutesPath = path.join(__dirname, 'src/routes/auth.routes.js');
  const authSrc = fs.readFileSync(authRoutesPath, 'utf8');
  console.log('📎 auth.routes.js:', authRoutesPath);
  console.log('   has request-code:', authSrc.includes('request-code'));
  console.log('   has invite-register:', authSrc.includes('invite-register'));
  console.log("   has '/ping':", authSrc.includes("'/ping'"));
} catch (e) {
  console.error('❌ Не удалось прочитать auth.routes.js:', e.message);
}
const http = require('http');
const { Server } = require('socket.io');
const db = require('./src/config/db');
const { findOrCreateChat } = require('./src/controllers/chat.controller');
const { notifyNewMessage } = require('./src/services/push.service');

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
});

/** userId (number) -> Set<socketId> — несколько вкладок и стабильная доставка после reconnect */
const userSockets = new Map();
/** userId (number) -> Set<socketId> c видимым/активным приложением. Для push важен foreground, а не просто online. */
const userForegroundSockets = new Map();

function upsertSocketPresence(map, userIdRaw, socketId, enabled) {
  const uid = Number(userIdRaw);
  if (!Number.isFinite(uid) || uid <= 0 || !socketId) return;
  if (enabled) {
    if (!map.has(uid)) map.set(uid, new Set());
    map.get(uid).add(socketId);
    return;
  }
  const set = map.get(uid);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    map.delete(uid);
  }
}

function unregisterUserSocket(socket) {
  const uid = socket._appUserId;
  if (uid == null) return;
  const set = userSockets.get(uid);
  if (set) {
    set.delete(socket.id);
    if (set.size === 0) userSockets.delete(uid);
  }
  upsertSocketPresence(userForegroundSockets, uid, socket.id, false);
  try {
    socket.leave(`user:${uid}`);
  } catch (_) {
    /* ignore */
  }
  delete socket._appUserId;
  delete socket._appForeground;
}

function registerUserSocket(socket, userIdRaw) {
  const uid = Number(userIdRaw);
  if (!Number.isFinite(uid) || uid <= 0) {
    console.warn('⚠️ join: некорректный userId', userIdRaw);
    return false;
  }
  unregisterUserSocket(socket);
  socket._appUserId = uid;
  socket._appForeground = true;
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socket.id);
  upsertSocketPresence(userForegroundSockets, uid, socket.id, true);
  socket.join(`user:${uid}`);
  return true;
}

function emitToUser(userIdRaw, event, payload) {
  const uid = Number(userIdRaw);
  const set = userSockets.get(uid);
  if (!set) return;
  for (const sid of set) {
    io.to(sid).emit(event, payload);
  }
}

function userIsOnline(userIdRaw) {
  const uid = Number(userIdRaw);
  const set = userSockets.get(uid);
  return Boolean(set && set.size > 0);
}

function userHasForegroundSocket(userIdRaw) {
  const uid = Number(userIdRaw);
  const set = userForegroundSockets.get(uid);
  return Boolean(set && set.size > 0);
}

function foregroundMapForPush() {
  const m = {};
  for (const id of userForegroundSockets.keys()) {
    m[String(id)] = true;
  }
  return m;
}

function broadcastOnlineUsers() {
  const list = Array.from(userSockets.keys());
  console.log('🟢 Online users:', list);
  io.emit('online_users', list);
}

io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);

  socket.on('join', (userId) => {
    if (!userId) return;
    if (!registerUserSocket(socket, userId)) return;
    broadcastOnlineUsers();
  });

  socket.on('app_state', (payload) => {
    if (socket._appUserId == null) return;
    const foreground = payload?.foreground !== false;
    socket._appForeground = foreground;
    upsertSocketPresence(userForegroundSockets, socket._appUserId, socket.id, foreground);
  });

  socket.on('send_message', async (data) => {
    const {
      sender_id,
      receiver_id,
      text,
      chat_id: chatIdIn,
      reply_to_message_id,
    } = data;

    console.log('📨 Получено сообщение:', data);

    if (!sender_id || !text) {
      console.error('❌ ОШИБКА: нет sender_id или text', data);
      socket.emit('chat_error', 'Ошибка: заполни все поля');
      return;
    }

    try {
      let chat_id;
      let receiverIdForDb = receiver_id != null ? Number(receiver_id) : null;

      if (chatIdIn != null && chatIdIn !== '') {
        const chatId = Number(chatIdIn);
        const mem = await db.query(
          `SELECT COALESCE(c.type, 'direct') AS type
           FROM chats c
           JOIN chat_users cu ON cu.chat_id = c.id
           WHERE c.id = $1 AND cu.user_id = $2`,
          [chatId, sender_id]
        );
        if (!mem.rows.length) {
          socket.emit('chat_error', 'Нет доступа к чату');
          return;
        }
        const chatType = mem.rows[0].type;
        chat_id = chatId;
        if (chatType === 'group') {
          receiverIdForDb = null;
        } else {
          const other = await db.query(
            'SELECT user_id FROM chat_users WHERE chat_id = $1 AND user_id <> $2 LIMIT 1',
            [chat_id, sender_id]
          );
          receiverIdForDb = other.rows[0] ? Number(other.rows[0].user_id) : null;
        }
      } else {
        if (!receiver_id) {
          socket.emit('chat_error', 'Ошибка: укажи собеседника или открой чат');
          return;
        }
        console.log(`⏳ Поиск/создание чата между ${sender_id} и ${receiver_id}...`);
        chat_id = await findOrCreateChat(sender_id, receiver_id);
        if (!chat_id) {
          throw new Error('Не удалось создать чат: chat_id пуст');
        }
        console.log('✅ Chat ID получен:', chat_id);
      }

      let deliveredAt = null;
      const membersR = await db.query(
        'SELECT user_id FROM chat_users WHERE chat_id = $1',
        [chat_id]
      );
      for (const row of membersR.rows) {
        const uid = Number(row.user_id);
        if (uid === Number(sender_id)) continue;
        if (userIsOnline(uid)) {
          deliveredAt = new Date();
          break;
        }
      }

      let replyToMessageId = Number(reply_to_message_id || 0) || null;
      if (replyToMessageId) {
        const replyCheck = await db.query(
          'SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2 LIMIT 1',
          [replyToMessageId, chat_id]
        );
        if (!replyCheck.rows.length) {
          replyToMessageId = null;
        }
      }
      const result = await db.query(
        `INSERT INTO messages(chat_id, sender_id, receiver_id, text, delivered_at, reply_to_message_id)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [chat_id, sender_id, receiverIdForDb, text, deliveredAt, replyToMessageId]
      );

      const message = result.rows[0];
      console.log('💾 Сообщение сохранено:', message.id);

      for (const row of membersR.rows) {
        const uid = Number(row.user_id);
        if (uid === Number(sender_id)) continue;
        if (userIsOnline(uid)) {
          console.log(`📤 Отправляю сообщение пользователю ${uid}`);
          emitToUser(uid, 'receive_message', message);
        }
      }

      const preview =
        text && text.includes('/uploads/')
          ? '📎 Файл'
          : String(text || '').slice(0, 140);

      await notifyNewMessage({
        message,
        senderId: sender_id,
        foregroundMap: foregroundMapForPush(),
        preview,
      });

      socket.emit('message_sent', message);
    } catch (err) {
      console.error('❌ Ошибка при отправке сообщения:', err.message);
      socket.emit('chat_error', 'Ошибка при отправке: ' + err.message);
    }
  });

  socket.on('typing', async (payload) => {
    const { sender_id, receiver_id, chat_id: typingChatId } = payload || {};
    if (!sender_id) return;

    if (typingChatId != null && typingChatId !== '') {
      const cid = Number(typingChatId);
      const r = await db.query(
        'SELECT user_id FROM chat_users WHERE chat_id = $1',
        [cid]
      );
      for (const row of r.rows) {
        const uid = Number(row.user_id);
        if (uid === Number(sender_id)) continue;
        emitToUser(uid, 'typing', { from: sender_id, chat_id: cid });
      }
      return;
    }

    if (!receiver_id) return;
    emitToUser(receiver_id, 'typing', { from: sender_id });
  });

  socket.on('read_receipt', async (payload) => {
    const { reader_id, partner_id, chat_id: ridChatId, last_message_id } = payload || {};
    if (!reader_id) return;

    if (ridChatId != null && ridChatId !== '') {
      const cid = Number(ridChatId);
      const r = await db.query(
        'SELECT user_id FROM chat_users WHERE chat_id = $1',
        [cid]
      );
      for (const row of r.rows) {
        const uid = Number(row.user_id);
        if (uid === Number(reader_id)) continue;
        emitToUser(uid, 'messages_read', {
          reader_id,
          chat_id: cid,
          last_message_id,
        });
      }
      return;
    }

    if (!partner_id) return;
    emitToUser(partner_id, 'messages_read', {
      reader_id,
      chat_id: ridChatId,
      last_message_id,
    });
  });

  socket.on('delivered_receipt', async (payload) => {
    try {
      const { receiver_id, partner_id, chat_id, last_message_id } = payload || {};
      const receiverId = Number(receiver_id);
      const partnerId = Number(partner_id);
      const chatId = Number(chat_id);
      const lastMessageId = Number(last_message_id);
      if (!receiverId || !partnerId || !chatId || !lastMessageId) return;

      await db.query(
        `UPDATE messages
            SET delivered_at = COALESCE(delivered_at, NOW())
          WHERE chat_id = $1
            AND sender_id = $2
            AND receiver_id = $3
            AND id <= $4
            AND delivered_at IS NULL`,
        [chatId, partnerId, receiverId, lastMessageId]
      );

      emitToUser(partnerId, 'messages_delivered', {
        receiver_id: receiverId,
        chat_id: chatId,
        last_message_id: lastMessageId,
      });
    } catch (error) {
      console.error('❌ Ошибка delivered_receipt:', error.message);
    }
  });

  /** WebRTC сигналинг: offer / answer / ice / hangup / decline (только личные чаты). */
  socket.on('call_signal', async (raw) => {
    try {
      const payload = raw || {};
      const from = Number(payload.fromUserId);
      const to = Number(payload.toUserId);
      const cid = Number(payload.chatId);
      if (!from || !to || !cid || !payload.kind) return;
      if (socket._appUserId !== from) {
        socket.emit('call_error', { message: 'Сигнал звонка от чужого сокета' });
        return;
      }
      const mem = await db.query(
        `SELECT COUNT(*)::int AS c FROM chat_users WHERE chat_id = $1 AND user_id IN ($2, $3)`,
        [cid, from, to]
      );
      if (!mem.rows[0] || Number(mem.rows[0].c) < 2) {
        socket.emit('call_error', { message: 'Нет доступа к звонку в этом чате' });
        return;
      }
      const ct = await db.query(
        `SELECT COALESCE(type, 'direct') AS type FROM chats WHERE id = $1`,
        [cid]
      );
      if (!ct.rows.length || ct.rows[0].type === 'group') {
        socket.emit('call_error', { message: 'Групповые звонки не поддерживаются' });
        return;
      }
      emitToUser(to, 'call_signal', payload);
    } catch (e) {
      console.warn('[call_signal]', e.message);
    }
  });

  socket.on('disconnect', () => {
    if (socket._appUserId != null) {
      console.log('🔴 User disconnected:', socket._appUserId, socket.id);
    }
    unregisterUserSocket(socket);
    broadcastOnlineUsers();
  });
});

const PORT = process.env.PORT || 3000;
const { ensureSchema } = require('./src/config/ensureSchema');
const { getOtpMailDeliveryMode } = require('./src/services/mail.service');

(async () => {
  try {
    await ensureSchema();
    console.log('✅ Схема БД: users.email, группы, push-токены (если не было — добавлено)');
  } catch (e) {
    console.error('❌ Миграция схемы БД:', e.message);
    process.exit(1);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на http://0.0.0.0:${PORT}`);
    console.log(`✅ Доступен на http://localhost:${PORT}`);
    if (fs.existsSync(APK_RELEASE_PATH)) {
      try {
        const sz = fs.statSync(APK_RELEASE_PATH).size;
        console.log(
          `📎 APK: OK (${sz} bytes) → http://<ваш-ip>:${PORT}/app-debug.apk`
        );
      } catch (_) {
        console.log(`📎 APK: файл есть, но не удалось прочитать размер`);
      }
    } else {
      console.log(
        `⚠️  APK: нет ${APK_RELEASE_PATH} — /app-debug.apk ответит 404. Проверка: GET /api/__apk_download`
      );
    }
    const upd = getAndroidUpdateConfig();
    if (upd.enabled) {
      console.log(
        `📲 Android update: клиентам с более старым versionCode покажем обновление → ${upd.apkUrl} (сборка ${upd.latestVersionCode}${upd.versionName ? ` ${upd.versionName}` : ''})`
      );
    } else {
      const r = upd.reason || 'no_version';
      if (r === 'no_apk_file') {
        console.log(
          `📲 Android update: авто отключён — нет releases/app-debug.apk → npm run apk:to-releases (из android/app/build/outputs/apk/debug) или ANDROID_UPDATE_APK_URL`
        );
      } else if (r === 'disabled') {
        console.log(
          `📲 Android update: выключено (ANDROID_UPDATE_DISABLE). Проверка: GET /api/__android_update_status`
        );
      } else {
        console.log(
          `📲 Android update: выключено (${r}) — versionCode в android/app/build.gradle или ANDROID_UPDATE_VERSION_CODE в .env. Проверка: GET /api/__android_update_status`
        );
      }
    }
    console.log('📊 WebSocket сервер готов к подключениям');
    const mailMode = getOtpMailDeliveryMode();
    console.log(
      `📧 OTP почта: ${mailMode}` +
        (mailMode === 'none'
          ? ' (нет RESEND_API_KEY/SMTP — проверь .env в папке с server.js и перезапуск)'
          : '')
    );
    console.log(`📌 Проверка: GET http://localhost:${PORT}/api/auth/ping (поле otpMailDelivery)`);
    console.log(
      `📌 Точка входа: GET http://localhost:${PORT}/api/__server_js → {"entry":"server.js"} (если 404 — другой процесс на порту)`
    );
    console.log(`📌 Код: POST http://localhost:${PORT}/api/auth/request-code`);
  });

  try {
    const result = await db.query('SELECT NOW()');
    console.log('✅ БД подключена:', result.rows[0].now);
  } catch (err) {
    console.error('❌ Ошибка подключения к БД:', err.message);
  }
})();
