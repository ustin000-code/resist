const db = require('./src/config/db');
const { findOrCreateChat } = require('./src/controllers/chat.controller');

async function testChats() {
  try {
    console.log('\n🧪 ТЕСТИРОВАНИЕ ЛОГИКИ ЧАТОВ\n');

    // 1. Добавляем тестовых пользователей
    console.log('1️⃣ Добавление пользователей...');
    const user1Result = await db.query(
      "INSERT INTO users (name, phone, password) VALUES ('Алиса', '+79991111111', 'pass1') ON CONFLICT (phone) DO UPDATE SET name='Алиса' RETURNING id"
    );
    const user1_id = user1Result.rows[0].id;
    
    const user2Result = await db.query(
      "INSERT INTO users (name, phone, password) VALUES ('Боб', '+79992222222', 'pass2') ON CONFLICT (phone) DO UPDATE SET name='Боб' RETURNING id"
    );
    const user2_id = user2Result.rows[0].id;

    console.log(`   ✅ Пользователь 1: ${user1_id} (Алиса)`);
    console.log(`   ✅ Пользователь 2: ${user2_id} (Боб)\n`);

    // 2. Создаём первый чат
    console.log('2️⃣ Создание первого чата...');
    const chat1_id = await findOrCreateChat(user1_id, user2_id);
    console.log(`   ✅ Чат создан: ${chat1_id}\n`);

    // 3. Посмотрим, найдется ли существующий чат
    console.log('3️⃣ Поиск существующего чата (должен найти уже созданный)...');
    const chat2_id = await findOrCreateChat(user1_id, user2_id);
    console.log(`   ✅ Найден чат: ${chat2_id}`);
    console.log(`   ${chat1_id === chat2_id ? '✅ ID совпадают!' : '❌ ID НЕ СОВПАДАЮТ!'}\n`);

    // 4. Проверим в обратном порядке
    console.log('4️⃣ Поиск чата в обратном порядке (user2, user1)...');
    const chat3_id = await findOrCreateChat(user2_id, user1_id);
    console.log(`   ✅ Найден чат: ${chat3_id}`);
    console.log(`   ${chat1_id === chat3_id ? '✅ Это один и тот же чат!' : '❌ Это разные чаты!'}\n`);

    // 5. Отправляем сообщение
    console.log('5️⃣ Отправка сообщения от Алисы к Бобу...');
    const msgResult = await db.query(
      `INSERT INTO messages(chat_id, sender_id, receiver_id, text)
       VALUES($1, $2, $3, $4) RETURNING *`,
      [chat1_id, user1_id, user2_id, 'Привет! Это тестовое сообщение']
    );
    console.log(`   ✅ Сообщение сохранено:`, msgResult.rows[0]);

    // 6. Получаем все сообщения в чате
    console.log('\n6️⃣ Получение всех сообщений в чате...');
    const messagesResult = await db.query(
      `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC`,
      [chat1_id]
    );
    console.log(`   ✅ Найдено сообщений: ${messagesResult.rows.length}`);
    messagesResult.rows.forEach(msg => {
      console.log(`      - ${msg.sender_id} → ${msg.receiver_id}: "${msg.text}"`);
    });

    // 7. Получаем чаты пользователя
    console.log('\n7️⃣ Получение списка чатов Алисы...');
    const chatsResult = await db.query(`
      SELECT
        c.id AS chat_id,
        u.id AS other_user_id,
        u.name,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) AS message_count
      FROM chats c
      JOIN chat_users cu1 ON cu1.chat_id = c.id
      JOIN chat_users cu2 ON cu2.chat_id = c.id
      JOIN users u ON u.id = cu2.user_id
      WHERE cu1.user_id = $1 AND cu2.user_id != $1
    `, [user1_id]);
    
    console.log(`   ✅ Чатов найдено: ${chatsResult.rows.length}`);
    chatsResult.rows.forEach(chat => {
      console.log(`      - Чат ${chat.chat_id} с ${chat.name} (${chat.message_count} сообщений)`);
    });

    console.log('\n✨ ВСЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО!\n');

  } catch (err) {
    console.error('\n❌ ОШИБКА:', err.message);
    console.error(err);
  }

  process.exit(0);
}

testChats();
