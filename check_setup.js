#!/usr/bin/env node
/**
 * Скрипт для проверки, что всё готово к запуску
 */

const db = require('./src/config/db');
const fs = require('fs');
const path = require('path');

async function checkSetup() {
  console.log('\n🔍 ПРОВЕРКА УСТАНОВКИ МЕСЕНДЖЕРА\n');

  let errors = [];
  let warnings = [];

  // 1. Проверка файлов
  console.log('1️⃣ Проверка файлов...');
  const requiredFiles = [
    'server.js',
    'public/index.html',
    'src/app.js',
    'src/config/db.js',
    '.env'
  ];

  requiredFiles.forEach(file => {
    if (fs.existsSync(file)) {
      console.log(`   ✅ ${file}`);
    } else {
      errors.push(`Не найден файл: ${file}`);
      console.log(`   ❌ ${file}`);
    }
  });

  // 2. Проверка node_modules
  console.log('\n2️⃣ Проверка зависимостей...');
  const requiredPackages = ['express', 'socket.io', 'pg', 'dotenv'];
  
  requiredPackages.forEach(pkg => {
    try {
      require(pkg);
      console.log(`   ✅ ${pkg}`);
    } catch (e) {
      errors.push(`Не установлен пакет: ${pkg}`);
      console.log(`   ❌ ${pkg}`);
    }
  });

  // 3. Проверка БД
  console.log('\n3️⃣ Проверка базы данных...');
  try {
    const result = await db.query('SELECT NOW() as time');
    console.log(`   ✅ PostgreSQL подключена`);

    // Проверим таблицы
    const tables = await db.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);

    const tableNames = tables.rows.map(r => r.table_name).sort();
    const requiredTables = ['users', 'chats', 'chat_users', 'messages'];

    requiredTables.forEach(table => {
      if (tableNames.includes(table)) {
        console.log(`   ✅ Таблица: ${table}`);
      } else {
        errors.push(`Не найдена таблица: ${table}`);
        console.log(`   ❌ Таблица: ${table}`);
      }
    });

    // Проверим данные
    const users = await db.query('SELECT COUNT(*) as cnt FROM users');
    const userCount = users.rows[0].cnt;
    console.log(`   📊 Пользователей в БД: ${userCount}`);

    if (userCount < 2) {
      warnings.push('В БД менее 2 пользователей. Запусти: node add_test_users.js');
      console.log(`   ⚠️  Рекомендация: добавь тестовых пользователей`);
    }

  } catch (err) {
    errors.push(`Ошибка БД: ${err.message}`);
    console.log(`   ❌ PostgreSQL: ${err.message}`);
  }

  // 4. Проверка портов
  console.log('\n4️⃣ Проверка портов...');
  const net = require('net');
  
  const port = 3000;
  const server = net.createServer();
  
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      warnings.push(`Порт ${port} занят. Останови: pkill -f "node.*server"`);
      console.log(`   ⚠️  Порт ${port} занят`);
    }
  });

  server.once('listening', () => {
    server.close();
    console.log(`   ✅ Порт ${port} свободен`);
  });

  server.listen(port, 'localhost');

  // Ждём проверки портов
  await new Promise(resolve => setTimeout(resolve, 100));

  // Результаты
  console.log('\n' + '='.repeat(50));
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✨ ВСЁ ГОТОВО К ЗАПУСКУ!\n');
    console.log('Запусти: node server.js\n');
  } else {
    if (errors.length > 0) {
      console.log(`\n❌ ОШИБКИ (${errors.length}):`);
      errors.forEach(e => console.log(`   - ${e}`));
    }
    if (warnings.length > 0) {
      console.log(`\n⚠️  ПРЕДУПРЕЖДЕНИЯ (${warnings.length}):`);
      warnings.forEach(w => console.log(`   - ${w}`));
    }
  }
  console.log('='.repeat(50) + '\n');

  process.exit(errors.length > 0 ? 1 : 0);
}

checkSetup().catch(err => {
  console.error('❌ Критическая ошибка:', err);
  process.exit(1);
});
