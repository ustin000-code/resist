const path = require('path');
// Подхват .env из корня проекта (рядом с server.js), даже если порядок require другой
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const nodemailer = require('nodemailer');

let etherealTransportPromise = null;

function useEthereal() {
  const v = String(process.env.SMTP_USE_ETHEREAL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function resendApiKey() {
  return String(process.env.RESEND_API_KEY || '').trim();
}

/** Письмо на реальный ящик через [Resend](https://resend.com) — один API-ключ, без SMTP. */
async function sendViaResend(to, subject, text) {
  const key = resendApiKey();
  if (!key) return false;

  const from =
    process.env.RESEND_FROM ||
    process.env.SMTP_FROM ||
    'Resist <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${raw}`);
  }
  return true;
}

/** Одноразовая регистрация тестового ящика на ethereal.email (без вашего SMTP). */
async function getEtherealTransporter() {
  if (!etherealTransportPromise) {
    etherealTransportPromise = (async () => {
      const testAccount = await nodemailer.createTestAccount();
      console.log('[mail] Ethereal: создан тестовый SMTP-аккаунт (письма не в реальный ящик).');
      return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
    })();
  }
  return etherealTransportPromise;
}

function createRealSmtpTransport() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });
}

/**
 * @param {string} to
 * @param {string} code
 * @param {string} phoneDisplay e.g. +7...
 * @returns {Promise<{ dev?: boolean, ethereal?: boolean, etherealPreviewUrl?: string }>}
 */
async function sendOtpEmail(to, code, phoneDisplay) {
  const subject = 'Код входа в Resist';
  const text = `Код для входа в Resist (телефон ${phoneDisplay}): ${code}\n\nКод действует 10 минут.`;

  const real = createRealSmtpTransport();
  if (real) {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'resist@localhost';
    const info = await real.sendMail({ from, to, subject, text });
    return {
      dev: false,
      smtp: {
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted,
        rejected: info.rejected,
      },
    };
  }

  if (resendApiKey()) {
    await sendViaResend(to, subject, text);
    console.log('[mail] Код отправлен через Resend на', to);
    return { dev: false };
  }

  if (useEthereal()) {
    const transporter = await getEtherealTransporter();
    const from =
      process.env.SMTP_FROM ||
      process.env.SMTP_USER ||
      '"Resist (Ethereal)" <otp@ethereal.email>';
    const info = await transporter.sendMail({ from, to, subject, text });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log('[mail] Откройте письмо в браузере (Ethereal):', previewUrl);
    }
    return { dev: false, ethereal: true, etherealPreviewUrl: previewUrl || undefined };
  }

  console.log('\n[mail] Нет доставки: задайте SMTP_*, или RESEND_API_KEY, или SMTP_USE_ETHEREAL=1. Код:');
  console.log(`  to=${to}  phone=${phoneDisplay}  code=${code}\n`);
  return { dev: true };
}

/** Для OTP_REQUIRE_SMTP: SMTP, Resend или Ethereal. */
function isSmtpConfigured() {
  if (Boolean(String(process.env.SMTP_HOST || '').trim())) {
    return true;
  }
  if (resendApiKey()) {
    return true;
  }
  return useEthereal();
}

/** Для /api/auth/ping: что реально видит процесс (none = в логе «почта не настроена»). */
function getOtpMailDeliveryMode() {
  if (String(process.env.SMTP_HOST || '').trim()) return 'smtp';
  if (resendApiKey()) return 'resend';
  if (useEthereal()) return 'ethereal';
  return 'none';
}

module.exports = {
  sendOtpEmail,
  isSmtpConfigured,
  getOtpMailDeliveryMode,
};
