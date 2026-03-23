# Инструкция для агентов (Cursor / AI) — проект Resist

Цель: быстро ориентироваться в репозитории, не ломать мобильную сборку и не путать порты **API** и **статики**.

---

## 1. Архитектура

| Часть | Где | Порт / роль |
|--------|-----|----------------|
| API + Socket.IO | `server.js` (оболочка), логика в `src/app.js`, роуты `src/routes/*` | `PORT` из `.env` (часто **3000**) |
| Статика фронта | `dist/` | Раздаётся через **`npm run serve:dist`** → **Vite preview :4173** |
| Android | `android/` (Capacitor) | Web-ассеты в `android/app/src/main/assets/public/` |
| iOS | `ios/App/App/public/` | Копируется тем же скриптом, что и Android |

**PM2** (типичные имена): `resist-api` (Node), `resist-web` (preview :4173). После смены **роутов** на сервере нужен **рестарт** процесса API.

---

## 2. Фронтенд: что важно знать

- Исходников Vite в корне может **не быть**; **источник правды для мобилки** — папка **`dist/`** (и патчи в `dist/assets/*.js`, если нет полного frontend-репо).
- В **`dist/index.html`** есть `<meta name="resist-api-base" content="...">` — база для части URL (например загрузки файлов).
- В минифицированном бандле зашиты константы вроде **`He` / `Ue` / `O`** — это **собранные `VITE_API_BASE_URL` / окружение**. Они задают префикс для **`/api/*`** и **клиента Socket.IO**.
  - **Нельзя** оставлять там порт **4173**, если API на **3000**: приложение будет бить в preview без API → `Failed to fetch`.
  - **Правильно:** в `.env.production` (при полноценном `vite build`) указать **`http://<публичный_хост>:3000`** для `VITE_API_BASE_URL` и `VITE_WS_URL`, пересобрать и снова `npm run build:mobile`.

---

## 3. Прокси preview (веб с телефона только через :4173)

Файл **`vite.config.cjs`** задаёт прокси для **`vite preview`** и dev-server:

- `/api` → `MESSENGER_API_PROXY` (по умолчанию `http://127.0.0.1:3000`)
- `/socket.io` — то же, с **WebSocket**

Запуск:

```bash
MESSENGER_API_PROXY=http://127.0.0.1:3000 npm run serve:dist
```

Если с телефона открывают только **4173**, а **3000** снаружи закрыт — в **браузере** всё может работать через прокси, а **старый APK**, ходивший напрямую на :3000, — нет. Либо открыть **3000** в firewall, либо собрать клиент с базой **4173** и держать прокси (тогда и API-запросы идут на тот же хост :4173).

---

## 4. Android / Capacitor — обязательно

Файл **`capacitor.config.json`** (корень репозитория) копируется в  
`android/app/src/main/assets/capacitor.config.json` скриптом **`npm run build:mobile`**.

В нём должно быть (для HTTP API с устройства):

```json
"android": {
  "allowMixedContent": true
}
```

**Почему:** WebView по умолчанию грузит приложение с **HTTPS**-подобного origin; запросы на **`http://IP:3000`** — **mixed content** и блокируются → **`Failed to fetch`**. В браузере страница может быть обычным **http://**, там блокировки нет.

Без этого конфига мобильное приложение будет «глухим» к HTTP API, даже при правильном URL.

---

## 5. Скрипты `package.json`

| Скрипт | Назначение |
|--------|------------|
| `build:client` | `vite build` — нужен полноценный frontend в корне (сейчас может отсутствовать) |
| `build:mobile` | `dist/` → `android/.../public` и `ios/.../public` + копия `capacitor.config.json` |
| `serve:dist` | Preview **:4173**, читает **`vite.config.cjs`** |
| `build:apk` | `build:mobile` + `assembleDebug` |

---

## 6. Бэкенд: точки расширения

- Роуты: `src/routes/*.routes.js`, контроллеры в **`src/controllers/`** (не путать с защитным заглушкой `src/routes/chat.controller.js` — там **throw** с подсказкой).
- CORS в `src/app.js` / `server.js`: `origin: '*'` для API.
- Совместимость старых клиентов: в `chat.routes.js` есть дубли методов (например **POST** archive/delete рядом с PATCH/DELETE), если бандл шлёт старые методы.

После изменений в роутерах: **перезапуск** процесса Node / PM2.

---

## 7. Переменные окружения

- **`.env`** — сервер (шаблон: **`.env.example`**). Не коммитить с секретами.
- **`.env.production`** — для **Vite** при сборке клиента (шаблон: **`.env.production.example`**). Для публичного репозитория — плейсхолдеры; на своём VPS можно держать реальный хост (это не секрет вроде пароля БД).
- **`.gitignore`** в корне исключает `.env`, `.env.local` и т.п. (секреты сервера); **`capacitor.config.json` в `android/.../assets` может быть в `.gitignore` шаблона Capacitor** — тогда важно не потерять копирование из корня через `npm run build:mobile`.

---

## 8. Типичные симптомы

| Симптом | Возможная причина |
|---------|-------------------|
| В браузере ок, в APK `Failed to fetch` | Нет **`allowMixedContent`** / старый APK |
| Везде `Failed to fetch` на API | Неверный **`VITE_*`** в бандле, или порт **3000** недоступен с клиента |
| В браузере на :4173 ок, APK нет | Браузер ходит через **прокси**, APK — напрямую на :3000 (firewall) |
| 404 на archive/delete в чатах | Несовпадение HTTP-метода/пути бандла и Express; проверить `chat.routes.js` и рестарт API |
| Гость вместо залогиненного UI при наличии token | Логика сессии в бандле / `localStorage` (`user`, `token`); возможен патч восстановления из JWT |

---

## 9. Что не делать без необходимости

- Не удалять **`android/app/src/main/assets/capacitor.config.json`** — при отсутствии файла Capacitor использует дефолты (**без** mixed content).
- Не сокращать **`android/app/build.gradle`** до фрагмента — сборка Gradle сломается (нужны `apply plugin`, зависимости, `capacitor.build.gradle`).
- Не коммитить реальные пароли БД/SMTP из `.env`.

---

## 10. Чеклист после правок фронта в `dist/`

1. Обновить **`dist/`** (и при необходимости `index.html` / meta `resist-api-base`).
2. `npm run build:mobile`
3. Пересобрать APK: `cd android && ./gradlew assembleDebug` (или release).
4. Для серверных правок — рестарт **`resist-api`** (или как называется процесс).

---

## 11. Документы в репозитории

- **`README.md`** — кратко для людей.
- **`AGENTS.md`** (этот файл) — для ИИ-агентов и онбординга разработчиков.

При добавлении новых «подводных камней» — дополняйте раздел 8 и чеклист в разделе 10.
