const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const user = process.env.DB_USER || 'postgres';
const host = process.env.DB_HOST || 'localhost';
const port = Number(process.env.DB_PORT) || 5432;
const database = process.env.DB_NAME || 'messenger';
const rawPassword = process.env.DB_PASSWORD;

/**
 * В pg/lib/connection-parameters.js пустая строка password в объекте Pool игнорируется
 * (if (config[key]) — '' falsy), подставляется null → SCRAM: "client password must be a string".
 * Через connectionString пароль попадает в конфиг как обычная строка.
 */
function buildConnectionString() {
  const u = encodeURIComponent(user);
  const db = encodeURIComponent(database);
  const pwd =
    rawPassword !== undefined && rawPassword !== null
      ? String(rawPassword).trim()
      : '';

  if (pwd.length > 0) {
    const p = encodeURIComponent(pwd);
    return `postgresql://${u}:${p}@${host}:${port}/${db}`;
  }

  // без пароля в URL (trust/peer на сервере)
  return `postgresql://${u}@${host}:${port}/${db}`;
}

const connectionString = buildConnectionString();

if (!rawPassword || String(rawPassword).trim() === '') {
  console.warn(
    '⚠️ DB_PASSWORD в .env пустой. Если PostgreSQL требует пароль (SCRAM), задай DB_PASSWORD и перезапусти сервер.'
  );
}

const pool = new Pool({
  connectionString,
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err);
});

module.exports = pool;
