const db = require('./db');
const { normalizePhone, isValidPhone } = require('../utils/phone.server');
const { normalizeEmail } = require('../utils/email.server');

/**
 * Дополняет схему старых БД до актуальной (init.sql мог не применяться целиком).
 */
async function ensureSchema() {
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
    ON users (email) WHERE email IS NOT NULL;
  `);

  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for_all BOOLEAN DEFAULT FALSE;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS message_hidden_for_users (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_message_hidden_for_users_user_id
    ON message_hidden_for_users(user_id);
  `);
  await db.query(`
    UPDATE messages
       SET updated_at = COALESCE(updated_at, created_at, NOW())
     WHERE updated_at IS NULL;
  `);

  await db.query(`
    ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;
  `);

  await db.query(`
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'direct';
  `);
  await db.query(`
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS title VARCHAR(255);
  `);
  await db.query(`
    UPDATE chats SET type = 'direct' WHERE type IS NULL;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_push_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      platform VARCHAR(32) DEFAULT 'android',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, token)
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON user_push_tokens(user_id);
  `);

  /** Жёсткая привязка «нормализованный телефон → email» (даже если в users.email пусто у старых записей). */
  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_phone_email_binding (
      phone_normalized VARCHAR(16) PRIMARY KEY,
      email_normalized VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const usersWithEmail = await db.query(
    `SELECT phone, email FROM users
     WHERE phone IS NOT NULL AND email IS NOT NULL AND trim(email) <> ''`
  );
  for (const row of usersWithEmail.rows) {
    const p = normalizePhone(row.phone);
    if (!isValidPhone(p)) continue;
    const e = normalizeEmail(row.email);
    if (!e) continue;
    await db.query(
      `INSERT INTO auth_phone_email_binding (phone_normalized, email_normalized)
       VALUES ($1, $2)
       ON CONFLICT (phone_normalized) DO NOTHING`,
      [p, e]
    );
  }
}

module.exports = { ensureSchema };
