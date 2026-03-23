const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { getOtpMailDeliveryMode } = require('../services/mail.service');
const authController = require('../controllers/auth.controller');
const userController = require('../controllers/user.controller');

// Проверка деплоя: GET /api/auth/ping — 200; messagesApi=v2 если есть маршруты /api/messages/chat/:id
router.get('/ping', (req, res) => {
  const otpRateLimitDisabled =
    process.env.OTP_RATE_LIMIT_DISABLED === '1' ||
    process.env.OTP_RATE_LIMIT_DISABLED === 'true';
  const inviteRegisterEnabled = Boolean(
    String(process.env.REGISTRATION_INVITE_SECRET || '').trim()
  );
  res.json({
    ok: true,
    auth: 'otp-v1',
    inviteRegister: inviteRegisterEnabled,
    routes: ['request-code', 'verify-code', 'invite-register', 'me'],
    messagesApi: 'v2',
    /** Если false, а в .env стоит 1 — бэкенд не перезапускали или другая копия проекта */
    otpRateLimitDisabled,
    otpRateLimitBuild: '2025-03-22',
    /** smtp | resend | ethereal | none — если нет в ответе, залей актуальный auth.routes.js */
    otpMailDelivery: getOtpMailDeliveryMode(),
  });
});

/** Текущий пользователь (профиль) — дублирует /api/users/me, чтобы не терялось при старых деплоях user.routes */
router.get('/me', authMiddleware, userController.getMe);
router.patch('/me', authMiddleware, userController.patchMe);

router.post('/request-code', authController.requestCode);
router.post('/verify-code', authController.verifyCode);
router.post('/invite-register', authController.inviteRegister);
router.post('/invite-register/', authController.inviteRegister);

/** @deprecated используй request-code + verify-code */
router.post('/login-phone', authController.loginOrRegister);

router.post('/register', authController.register);
router.post('/login', authController.login);

module.exports = router;
