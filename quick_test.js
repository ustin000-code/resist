#!/usr/bin/env node
const db = require('./src/config/db');

async function quickTest() {
  try {
    // Добавим пользователей
    const res = await db.query("SELECT COUNT(*) as cnt FROM users");
    console.log('Пользователей в БД:', res.rows[0].cnt);
    process.exit(0);
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);  
  }
}

quickTest();
