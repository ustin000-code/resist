#!/bin/bash

echo "🛑 Остановка старых процессов..."
pkill -f "node" 2>/dev/null || true
sleep 2

echo "🧹 Очистка логов тестов..."
rm -f /tmp/server.log /tmp/test.log

echo "✅ Запуск сервера..."
cd /root/messenger
node server.js
