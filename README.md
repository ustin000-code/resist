# Resist (мессенджер)

Бэкенд: **Node.js** (`server.js`) + **PostgreSQL**, REST `/api/*` и **Socket.IO**.  
Фронт: сейчас в репозитории чаще лежит готовый **`dist/`** (и синхронизация в **Capacitor**).

## Быстрый старт (сервер)

1. `cp .env.example .env` — заполнить БД, SMTP, секреты.
2. `npm install`
3. Убедиться, что схема БД применена (см. `src/config/ensureSchema.js` при старте или миграции в проекте).
4. `node server.js` (или процесс под **PM2**, например `resist-api`).

Проверка: `GET /api/auth/ping` → JSON с маркером версии OTP.

## Веб из `dist`

```bash
MESSENGER_API_PROXY=http://127.0.0.1:3000 npm run serve:dist
```

Открыть `http://<хост>:4173`. Прокси (`vite.config.cjs`) шлёт `/api` и `/socket.io` на Node.

## Мобильное приложение (Android)

```bash
npm run build:mobile    # dist → android/.../assets/public + capacitor.config.json
cd android && ./gradlew assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

Подробности, типичные ошибки и правила для ИИ-агентов — в **[AGENTS.md](./AGENTS.md)**.
