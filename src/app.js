const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');

const {
  inviteLinkHandler,
  serveApkDownload,
  serveAndroidInstallPage,
  apkDownloadDiagnosticHandler,
} = require('./utils/inviteAndApk');
const {
  androidUpdateHandler,
  androidUpdateStatusHandler,
} = require('./utils/androidUpdate.server');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const chatRoutes = require('./routes/chat.routes');
const messageRoutes = require('./routes/message.routes');

const app = express();
app.set('trust proxy', 1);
const uploadRoutes = require('./routes/upload.routes');
const searchRoutes = require('./routes/search.routes');
const pushRoutes = require('./routes/push.routes');
const authMiddleware = require('./middleware/auth.middleware');
const userController = require('./controllers/user.controller');

app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

/** «Пригласить друзей» + APK — те же маршруты, что в server.js (если API крутится без оболочки). */
app.get('/api/app/invite-link', inviteLinkHandler);
app.get('/api/app/invite-link/', inviteLinkHandler);
app.get('/api/app/android-update', androidUpdateHandler);
app.get('/api/app/android-update/', androidUpdateHandler);
app.get('/api/__android_update_status', androidUpdateStatusHandler);
app.get('/api/__apk_download', apkDownloadDiagnosticHandler);
app.get('/download/android-update', serveAndroidInstallPage);
app.get('/download/install', serveAndroidInstallPage);
app.get('/download/app.apk', serveApkDownload);
app.get('/download/resist.apk', serveApkDownload);
app.get('/app-debug.apk', serveApkDownload);

/**
 * Профиль: до роутеров, чтобы работало даже со старым бандлом (GET /api/users/me)
 * и при любых нюансах Express 5 + app.use('/api/users', router).
 */
app.get('/api/users/me', authMiddleware, userController.getMe);
app.patch('/api/users/me', authMiddleware, userController.patchMe);
app.get('/api/auth/me', authMiddleware, userController.getMe);
app.patch('/api/auth/me', authMiddleware, userController.patchMe);

// API раньше статики — так надёжнее для POST /api/*
app.use('/api/upload', uploadRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/push', pushRoutes);

app.use('/api/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/uploads', express.static('uploads'));
app.use(express.static(path.join(__dirname, '../public')));

// Явный 404 для API: если видишь JSON с hint — это наш Node; если HTML Error — часто другой процесс/прокси
app.use((req, res) => {
  const url = req.originalUrl || req.url || '';
  if (url.startsWith('/api')) {
    return res.status(404).json({
      error: 'API route not found',
      method: req.method,
      path: url,
      hint: 'Проверь деплой: GET /api/auth/ping должен вернуть otp-v1',
    });
  }
  res.status(404).send('Not found');
});

module.exports = app;
