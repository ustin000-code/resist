const db = require('./src/config/db');

async function test() {
  try {
    // Вставим тестовых пользователей
    const user1 = await db.query(
      `INSERT INTO users (name, phone, password) 
       VALUES ('Alice', '+79991111111', 'pass1') 
       ON CONFLICT DO NOTHING 
       RETURNING id`
    );
    
    const user2 = await db.query(
      `INSERT INTO users (name, phone, password) 
       VALUES ('Bob', '+79992222222', 'pass2') 
       ON CONFLICT DO NOTHING 
       RETURNING id`
    );

    const u1 = user1.rows[0]?.id || 1;
    const u2 = user2.rows[0]?.id || 2;

    console.log('👤 Пользователи:', u1, u2);

    // Создадим чат
    const chat = await db.query(
      'INSERT INTO chats DEFAULT VALUES RETURNING id'
    );
    const chatId = chat.rows[0].id;
    console.log('💬 Чат создан:', chatId);

    // Добавим пользователей в чат
    await db.query(
      'INSERT INTO chat_users(chat_id, user_id) VALUES ($1,$2),($1,$3)',
      [chatId, u1, u2]
    );
    console.log('✅ Пользователи добавлены в чат');

    // Отправим сообщение
    const msg = await db.query(
      `INSERT INTO messages(chat_id, sender_id, receiver_id, text) 
       VALUES($1,$2,$3,$4) RETURNING *`,
      [chatId, u1, u2, 'Привет!']
    );
    console.log('💌 Сообщение создано:', msg.rows[0]);

    console.log('✨ ВСЕ РАБОТАЕТ!');
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
  }
  process.exit(0);
}

test();
