const db = require('./src/config/db');

async function addTestUsers() {
  try {
    console.log('🔄 Добавление тестовых пользователей...');
    
    const result = await db.query(`
      INSERT INTO users (name, phone, password) 
      VALUES 
        ('Алиса', '+79991111111', 'hashed_pass_1'),
        ('Боб', '+79992222222', 'hashed_pass_2')
      ON CONFLICT DO NOTHING
      RETURNING id, name, phone;
    `);
    
    console.log('✅ Пользователи добавлены:', result.rows);
    
    // Получим всех пользователей
    const all = await db.query('SELECT id, name, phone FROM users;');
    console.log('📋 Все пользователи:', all.rows);
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    process.exit(1);
  }
}

addTestUsers();
