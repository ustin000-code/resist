const crypto = require('crypto');
const db = require('../config/db');
const bcrypt = require('bcrypt');
const { generateToken } = require('../utils/jwt');
const { normalizePhone, isValidPhone } = require('../utils/phone.server');
const { normalizeEmail, isValidEmail } = require('../utils/email.server');
const { sendOtpEmail, isSmtpConfigured } = require('../services/mail.service');

let phoneConstraintsEnsured = false;
let otpTableEnsured = false;

/** Лимит запросов кода на один номер (антиспам). Настраивается через .env. */
function getOtpRequestRateLimit() {
  const disabled =
    process.env.OTP_RATE_LIMIT_DISABLED === '1' ||
    process.env.OTP_RATE_LIMIT_DISABLED === 'true';
  if (disabled) {
    return { disabled: true, max: 0, windowMinutes: 60 };
  }

  const isProd = process.env.NODE_ENV === 'production';
  const maxFromEnv = parseInt(String(process.env.OTP_RATE_LIMIT_MAX || '').trim(), 10);
  const minFromEnv = parseInt(
    String(process.env.OTP_RATE_LIMIT_WINDOW_MINUTES || '').trim(),
    10
  );
  const defaultMax = isProd ? 30 : 200;
  const max =
    Number.isFinite(maxFromEnv) && maxFromEnv > 0 ? maxFromEnv : defaultMax;
  const windowMinutes =
    Number.isFinite(minFromEnv) && minFromEnv > 0 ? minFromEnv : 60;
  return { disabled: false, max, windowMinutes };
}

async function ensureOtpTable() {
  if (otpTableEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_otp_codes (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      email VARCHAR(255) NOT NULL,
      code_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_otp_phone_created
    ON auth_otp_codes (phone, created_at DESC)
  `);
  otpTableEnsured = true;
}

async function ensurePhoneConstraints() {
  if (phoneConstraintsEnsured) return;
  const users = await db.query('SELECT id, phone FROM users WHERE phone IS NOT NULL');
  const seen = new Map();
  for (const row of users.rows) {
    const normalized = normalizePhone(row.phone);
    if (!isValidPhone(normalized)) continue;
    const conflictId = seen.get(normalized);
    if (conflictId && conflictId !== row.id) {
      throw new Error(`PHONE_CONFLICT:${normalized}`);
    }
    seen.set(normalized, row.id);
    if (normalized !== row.phone) {
      await db.query('UPDATE users SET phone = $1 WHERE id = $2', [normalized, row.id]);
    }
  }

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique_idx
    ON users (phone)
    WHERE phone IS NOT NULL
  `);
  phoneConstraintsEnsured = true;
}

function sanitizeUser(user) {
  const { password, ...safeUser } = user;
  return safeUser;
}

/**
 * В БД телефон может быть +7…, 8…, с пробелами — точное WHERE phone = $1 часто не находит строку.
 */
async function findUserByNormalizedPhone(normalizedPhone) {
  const r = await db.query('SELECT * FROM users WHERE phone IS NOT NULL');
  for (const row of r.rows) {
    if (normalizePhone(row.phone) === normalizedPhone) {
      return row;
    }
  }
  return null;
}

/**
 * Если в auth_phone_email_binding ещё нет строки, но в users.email уже есть почта —
 * дописываем binding (бэкап при старте мог не увидеть правки после запуска сервера).
 */
async function ensureBindingFromUserEmailIfMissing(normalizedPhone) {
  const has = await db.query(
    'SELECT 1 FROM auth_phone_email_binding WHERE phone_normalized = $1',
    [normalizedPhone]
  );
  if (has.rows.length > 0) return;

  const u = await findUserByNormalizedPhone(normalizedPhone);
  if (!u) return;
  const stored = u.email;
  if (stored == null || !String(stored).trim()) return;
  const sn = normalizeEmail(stored);
  if (!sn) return;
  await db.query(
    `INSERT INTO auth_phone_email_binding (phone_normalized, email_normalized)
     VALUES ($1, $2)
     ON CONFLICT (phone_normalized) DO NOTHING`,
    [normalizedPhone, sn]
  );
}

/** Сравнение invite-токена без утечки по времени (SHA-256 → timingSafeEqual). */
function inviteTokenValid(provided, expected) {
  const p = String(provided || '');
  const e = String(expected || '').trim();
  if (!e || p.length < 12) return false;
  const hp = crypto.createHash('sha256').update(p, 'utf8').digest();
  const he = crypto.createHash('sha256').update(e, 'utf8').digest();
  return crypto.timingSafeEqual(hp, he);
}

/**
 * Создание/обновление пользователя и выдача JWT (после успешного OTP или invite).
 * Дублирует бывший блок в verifyCode после проверки кода.
 */
async function upsertUserSessionAfterPhoneEmailOk(res, normalizedPhone, emailNorm, name) {
  let uRow = await findUserByNormalizedPhone(normalizedPhone);
  let user;

  if (!uRow) {
    const userName = String(name || '').trim() || `User ${normalizedPhone.slice(-4)}`;
    try {
      user = await db.query(
        'INSERT INTO users(name, phone, email) VALUES($1,$2,$3) RETURNING *',
        [userName, normalizedPhone, emailNorm]
      );
    } catch (insertErr) {
      if (insertErr?.code === '23505' && insertErr.constraint?.includes('email')) {
        res.status(409).json({ error: 'Этот email уже привязан к другому аккаунту' });
        return;
      }
      throw insertErr;
    }
  } else {
    const storedNorm =
      uRow.email && String(uRow.email).trim() ? normalizeEmail(uRow.email) : null;
    if (storedNorm && storedNorm !== emailNorm) {
      res.status(409).json({
        error:
          'Этот номер уже привязан к другой почте. Нельзя сменить email без входа со старой почтой.',
      });
      return;
    }
    if (!storedNorm && emailNorm) {
      try {
        await db.query('UPDATE users SET email = $1 WHERE id = $2', [emailNorm, uRow.id]);
        uRow = (await db.query('SELECT * FROM users WHERE id = $1', [uRow.id])).rows[0];
      } catch (e) {
        if (e?.code === '23505') {
          res.status(409).json({ error: 'Этот email уже используется другим пользователем' });
          return;
        }
        throw e;
      }
    }
    user = { rows: [uRow] };
  }

  await db.query(
    `INSERT INTO auth_phone_email_binding (phone_normalized, email_normalized)
     VALUES ($1, $2)
     ON CONFLICT (phone_normalized) DO NOTHING`,
    [normalizedPhone, emailNorm]
  );

  const token = generateToken(user.rows[0]);
  res.json({ user: sanitizeUser(user.rows[0]), token });
}

/** Вход по ссылке с секретом ?invite=… — без кода из почты (только если задан REGISTRATION_INVITE_SECRET). */
exports.inviteRegister = async (req, res) => {
  const secret = String(process.env.REGISTRATION_INVITE_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({
      error: 'Пригласительные ссылки отключены (не задан REGISTRATION_INVITE_SECRET на сервере).',
    });
  }

  const { invite, phone, email, name } = req.body;

  try {
    if (!inviteTokenValid(invite, secret)) {
      return res.status(403).json({ error: 'Неверная или устаревшая ссылка приглашения.' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Некорректный номер телефона. Используй формат +7XXXXXXXXXX' });
    }

    const emailNorm = normalizeEmail(email);
    if (!isValidEmail(emailNorm)) {
      return res.status(400).json({ error: 'Укажи корректный email' });
    }

    await ensurePhoneConstraints();
    await ensureBindingFromUserEmailIfMissing(normalizedPhone);

    const bindingVerify = await db.query(
      'SELECT email_normalized FROM auth_phone_email_binding WHERE phone_normalized = $1',
      [normalizedPhone]
    );
    if (bindingVerify.rows.length > 0 && bindingVerify.rows[0].email_normalized !== emailNorm) {
      return res.status(409).json({
        error:
          'Этот номер уже привязан к другой почте. Укажите тот же email, с которым вы входили ранее.',
      });
    }

    const existingForEmailCheck = await findUserByNormalizedPhone(normalizedPhone);
    if (existingForEmailCheck) {
      const stored = existingForEmailCheck.email;
      if (stored != null && String(stored).trim() !== '') {
        const storedNorm = normalizeEmail(stored);
        if (storedNorm && storedNorm !== emailNorm) {
          return res.status(409).json({
            error:
              'Этот номер уже привязан к другой почте. Укажите тот же email, с которым регистрировались.',
          });
        }
      }
    }

    await upsertUserSessionAfterPhoneEmailOk(res, normalizedPhone, emailNorm, name);
  } catch (err) {
    if (String(err.message || '').startsWith('PHONE_CONFLICT:')) {
      const conflictPhone = String(err.message).split(':')[1] || '';
      return res.status(409).json({
        error: `Найдены дубли после нормализации телефона (${conflictPhone}). Удали дубликаты в users.`,
      });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// регистрация (можно оставить, но уже не обязательна)
exports.register = async (req, res) => {
  const { name, phone } = req.body;

  try {
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Некорректный номер телефона. Используй формат +7XXXXXXXXXX' });
    }

    await ensurePhoneConstraints();

    const existing = await db.query(
      'SELECT id FROM users WHERE phone = $1 LIMIT 1',
      [normalizedPhone]
    );

    if (existing.rows.length) {
      return res.status(409).json({ error: 'Пользователь с таким номером уже существует' });
    }

    const hashed = await bcrypt.hash(normalizedPhone, 5);
    const userName = String(name || '').trim() || `User ${normalizedPhone.slice(-4)}`;

    const user = await db.query(
      'INSERT INTO users(name, phone, password) VALUES($1,$2,$3) RETURNING *',
      [userName, normalizedPhone, hashed]
    );

    const token = generateToken(user.rows[0]);

    res.json({ user: sanitizeUser(user.rows[0]), token });
  } catch (err) {
    if (String(err.message || '').startsWith('PHONE_CONFLICT:')) {
      const conflictPhone = String(err.message).split(':')[1] || '';
      return res.status(409).json({ error: `Найдены дубли после нормализации телефона (${conflictPhone}). Удали дубликаты в users.` });
    }
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Пользователь с таким номером уже существует' });
    }
    res.status(500).json({ error: err.message });
  }
};

// логин по телефону (если уже есть)
exports.login = async (req, res) => {
  const { phone } = req.body;

  try {
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Некорректный номер телефона. Используй формат +7XXXXXXXXXX' });
    }

    const user = await db.query(
      'SELECT * FROM users WHERE phone = $1',
      [normalizedPhone]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Пользователь с таким номером не найден' });
    }

    const token = generateToken(user.rows[0]);

    res.json({ user: sanitizeUser(user.rows[0]), token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Устарело: вход только через код на email (см. request-code / verify-code)
exports.loginOrRegister = async (req, res) => {
  return res.status(403).json({
    error: 'Вход только по коду из письма. Нажми «Получить код» и введи код с почты.',
    code: 'OTP_REQUIRED',
  });
};

/** Запрос кода на email (привязка к номеру телефона) */
exports.requestCode = async (req, res) => {
  const { phone, email } = req.body;

  try {
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Некорректный номер телефона. Используй формат +7XXXXXXXXXX' });
    }

    const emailNorm = normalizeEmail(email);
    if (!isValidEmail(emailNorm)) {
      return res.status(400).json({ error: 'Укажи корректный email' });
    }

    await ensurePhoneConstraints();

    await ensureBindingFromUserEmailIfMissing(normalizedPhone);

    const bindingRow = await db.query(
      'SELECT email_normalized FROM auth_phone_email_binding WHERE phone_normalized = $1',
      [normalizedPhone]
    );
    if (bindingRow.rows.length > 0 && bindingRow.rows[0].email_normalized !== emailNorm) {
      return res.status(409).json({
        error:
          'Этот номер уже привязан к другой почте. Укажите тот же email, с которым вы входили ранее.',
      });
    }

    const existingUser = await findUserByNormalizedPhone(normalizedPhone);
    if (existingUser) {
      const stored = existingUser.email;
      if (stored != null && String(stored).trim() !== '') {
        const storedNorm = normalizeEmail(stored);
        if (storedNorm && storedNorm !== emailNorm) {
          return res.status(409).json({
            error:
              'Этот номер уже привязан к другой почте. Укажите тот же email, с которым вы входили ранее.',
          });
        }
      }
    }

    await ensureOtpTable();

    const requireSmtp =
      process.env.OTP_REQUIRE_SMTP === '1' ||
      process.env.OTP_REQUIRE_SMTP === 'true';
    if (requireSmtp && !isSmtpConfigured()) {
      return res.status(503).json({
        error:
          'Почта не настроена: задайте SMTP_HOST, SMTP_USER, SMTP_PASS (и при необходимости SMTP_FROM) в .env на сервере.',
      });
    }

    const rateCfg = getOtpRequestRateLimit();

    // Убираем просроченные коды (не считаем в лимит и не засоряем таблицу).
    await db.query(`DELETE FROM auth_otp_codes WHERE expires_at < NOW()`);

    if (!rateCfg.disabled) {
      const { max: rateMax, windowMinutes } = rateCfg;
      const windowSince = new Date(Date.now() - windowMinutes * 60 * 1000);
      // Считаем только непросроченные строки за окно (один номер — много разных email давали 50+ «живых» строк).
      const recent = await db.query(
        `SELECT COUNT(*)::int AS c FROM auth_otp_codes
         WHERE phone = $1 AND created_at > $2 AND expires_at > NOW()`,
        [normalizedPhone, windowSince]
      );

      if (recent.rows[0].c >= rateMax) {
        return res.status(429).json({
          error: `Слишком много запросов кода для этого номера (лимит: ${rateMax} за ${windowMinutes} мин). Временно отключите лимит: OTP_RATE_LIMIT_DISABLED=1 в .env на сервере. Или: DELETE FROM auth_otp_codes WHERE phone = 'номер_как_в_бд';`,
        });
      }
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      `DELETE FROM auth_otp_codes WHERE phone = $1 AND email = $2`,
      [normalizedPhone, emailNorm]
    );

    await db.query(
      `INSERT INTO auth_otp_codes (phone, email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [normalizedPhone, emailNorm, codeHash, expiresAt]
    );

    const phoneDisplay = `+${normalizedPhone}`;
    const mailResult = await sendOtpEmail(emailNorm, code, phoneDisplay);

    const mailMode = mailResult.dev ? 'dev' : mailResult.ethereal ? 'ethereal' : 'smtp';

    res.json({
      ok: true,
      mailMode,
      etherealPreviewUrl: mailResult.etherealPreviewUrl,
      message: mailResult.dev
        ? 'SMTP не настроен: код выведен в консоль сервера (где запущен node server.js), не на почту.'
        : mailResult.ethereal
          ? 'Тестовая почта Ethereal: письмо не в реальный ящик — откройте ссылку из ответа (на экране или в логе сервера).'
          : 'Код отправлен на указанный email.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Ошибка отправки кода' });
  }
};

/** Проверка кода и выдача JWT (аккаунт жёстко по телефону) */
exports.verifyCode = async (req, res) => {
  const { phone, email, code, name } = req.body;

  try {
    const normalizedPhone = normalizePhone(phone);
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Некорректный номер телефона' });
    }

    const emailNorm = normalizeEmail(email);
    if (!isValidEmail(emailNorm)) {
      return res.status(400).json({ error: 'Укажи корректный email' });
    }

    const codeStr = String(code || '').replace(/\D/g, '').trim();
    if (codeStr.length !== 6) {
      return res.status(400).json({ error: 'Введи 6-значный код из письма' });
    }

    await ensureOtpTable();
    await ensurePhoneConstraints();

    await ensureBindingFromUserEmailIfMissing(normalizedPhone);

    const bindingVerify = await db.query(
      'SELECT email_normalized FROM auth_phone_email_binding WHERE phone_normalized = $1',
      [normalizedPhone]
    );
    if (bindingVerify.rows.length > 0 && bindingVerify.rows[0].email_normalized !== emailNorm) {
      return res.status(409).json({
        error:
          'Этот номер уже привязан к другой почте. Введите тот же email, с которым регистрировались.',
      });
    }

    const existingForEmailCheck = await findUserByNormalizedPhone(normalizedPhone);
    if (existingForEmailCheck) {
      const stored = existingForEmailCheck.email;
      if (stored != null && String(stored).trim() !== '') {
        const storedNorm = normalizeEmail(stored);
        if (storedNorm && storedNorm !== emailNorm) {
          return res.status(409).json({
            error:
              'Этот номер уже привязан к другой почте. Введите тот же email, с которым регистрировались.',
          });
        }
      }
    }

    const row = await db.query(
      `SELECT * FROM auth_otp_codes
       WHERE phone = $1 AND email = $2
       ORDER BY id DESC LIMIT 1`,
      [normalizedPhone, emailNorm]
    );

    if (!row.rows.length) {
      return res.status(400).json({ error: 'Сначала запроси код (кнопка «Получить код»)' });
    }

    const otp = row.rows[0];

    if (new Date(otp.expires_at) < new Date()) {
      await db.query('DELETE FROM auth_otp_codes WHERE id = $1', [otp.id]);
      return res.status(400).json({ error: 'Код истёк. Запроси новый.' });
    }

    if (Number(otp.attempts) >= 5) {
      return res.status(429).json({ error: 'Слишком много неверных попыток. Запроси новый код.' });
    }

    const match = await bcrypt.compare(codeStr, otp.code_hash);
    if (!match) {
      await db.query(
        'UPDATE auth_otp_codes SET attempts = attempts + 1 WHERE id = $1',
        [otp.id]
      );
      return res.status(400).json({ error: 'Неверный код' });
    }

    await db.query('DELETE FROM auth_otp_codes WHERE id = $1', [otp.id]);

    await upsertUserSessionAfterPhoneEmailOk(res, normalizedPhone, emailNorm, name);
    return;
  } catch (err) {
    if (String(err.message || '').startsWith('PHONE_CONFLICT:')) {
      const conflictPhone = String(err.message).split(':')[1] || '';
      return res.status(409).json({ error: `Найдены дубли после нормализации телефона (${conflictPhone}). Удали дубликаты в users.` });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
