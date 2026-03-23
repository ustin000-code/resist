/**
 * Публичная ссылка приглашения + отдача APK.
 * Используется и в server.js, и в src/app.js (если API запускают без оболочки server.js).
 */
const path = require('path');
const fs = require('fs');

const APK_RELEASE_PATH = path.join(__dirname, '..', '..', 'releases', 'app-debug.apk');
const APK_DEBUG_BUILD_PATH = path.join(
  __dirname,
  '..',
  '..',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk'
);

function getAvailableApkPath() {
  const candidates = [APK_RELEASE_PATH, APK_DEBUG_BUILD_PATH]
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return {
          filePath,
          mtimeMs: Number(stat.mtimeMs) || 0,
          size: Number(stat.size) || 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.size - a.size;
    });

  return candidates[0]?.filePath || '';
}

function inviteHostIsLoopback(hostHeader) {
  if (!hostHeader) return true;
  const hostOnly = String(hostHeader)
    .split(':')[0]
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return (
    hostOnly === 'localhost' ||
    hostOnly === '127.0.0.1' ||
    hostOnly === '::1' ||
    hostOnly === '0.0.0.0'
  );
}

/** Запас, если прокси не пробросил X-Forwarded-Host (старый Vite / nginx). */
function publicBaseFromReferer(req) {
  const ref = String(req.get('referer') || req.get('referrer') || '').trim();
  if (!ref) return '';
  try {
    const u = new URL(ref);
    if (inviteHostIsLoopback(u.hostname)) return '';
    return `${u.protocol}//${u.host}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Capacitor / мобильное приложение шлёт origin из VITE_API_BASE_URL; включается INVITE_ALLOW_CLIENT_ORIGIN=1 на сервере. */
function normalizedOriginFromClientHeader(req) {
  const allow = String(process.env.INVITE_ALLOW_CLIENT_ORIGIN || '')
    .trim()
    .toLowerCase();
  if (allow !== '1' && allow !== 'true' && allow !== 'yes') {
    return '';
  }
  const raw = String(req.get('x-public-app-origin') || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (inviteHostIsLoopback(u.hostname)) return '';
    return `${u.protocol}//${u.host}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Публичный base URL для внешних ссылок (invite, APK download, update prompt). */
function publicBaseFromRequest(req) {
  let base = String(
    process.env.INVITE_FRONTEND_URL ||
      process.env.VITE_INVITE_FRONTEND_URL ||
      process.env.PUBLIC_APP_URL ||
      ''
  )
    .trim()
    .replace(/\/$/, '');

  const host = req.get('host') || '';
  if (!base && host && !inviteHostIsLoopback(host)) {
    base = `${req.protocol}://${host}`;
  }

  if (!base) {
    const xfHost = String(req.get('x-forwarded-host') || '')
      .split(',')[0]
      .trim();
    const xfProtoRaw = String(req.get('x-forwarded-proto') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const xfProto =
      xfProtoRaw === 'https' || xfProtoRaw === 'http'
        ? xfProtoRaw
        : String(req.protocol || 'http').replace(/:$/, '');
    if (xfHost && !inviteHostIsLoopback(xfHost)) {
      base = `${xfProto}://${xfHost}`.replace(/\/$/, '');
    }
  }

  if (!base) {
    const fromRef = publicBaseFromReferer(req);
    if (fromRef) base = fromRef;
  }

  if (!base) {
    const fromClient = normalizedOriginFromClientHeader(req);
    if (fromClient) base = fromClient;
  }

  return base;
}

/**
 * Публичная ссылка для «Пригласить друзей» (без авторизации).
 * INVITE_FRONTEND_URL — обязателен, если запрос к API приходит с localhost.
 */
function inviteLinkHandler(req, res) {
  const secret = String(process.env.REGISTRATION_INVITE_SECRET || '').trim();
  if (!secret || secret.length < 12) {
    return res.json({ ok: false, configured: false });
  }
  let base = publicBaseFromRequest(req);

  if (!base) {
    return res.json({
      ok: false,
      configured: true,
      missingBase: true,
      hint:
        'В .env на сервере: INVITE_FRONTEND_URL=http://ВАШ_IP:ПОРТ (или https://домен) — как открываете сайт с телефона, не localhost. Для APK/iOS без дублирования URL: INVITE_ALLOW_CLIENT_ORIGIN=1 (приложение передаёт адрес из VITE_API_BASE_URL) и перезапуск Node.',
    });
  }

  let publicHost = '';
  try {
    publicHost = new URL(base).hostname;
  } catch {
    return res.json({
      ok: false,
      configured: true,
      missingBase: true,
      hint: 'INVITE_FRONTEND_URL должен быть полным URL, например http://5.45.119.39:4173',
    });
  }
  if (inviteHostIsLoopback(publicHost)) {
    return res.json({
      ok: false,
      configured: true,
      missingBase: true,
      hint:
        'INVITE_FRONTEND_URL не может быть localhost — укажите внешний IP или домен, как открываете приложение с телефона.',
    });
  }

  const url = `${base}/?invite=${encodeURIComponent(secret)}`;

  const envApk = String(
    process.env.INVITE_ANDROID_APK_URL || process.env.ANDROID_UPDATE_APK_URL || ''
  ).trim();
  let apkDownloadUrl = '';
  if (envApk) {
    if (/^https?:\/\//i.test(envApk)) {
      apkDownloadUrl = envApk.replace(/\/$/, '');
    } else if (envApk.startsWith('/')) {
      apkDownloadUrl = `${base}${envApk}`;
    }
  } else if (getAvailableApkPath()) {
    apkDownloadUrl = `${base}/download/app.apk`;
  }

  res.json({
    ok: true,
    configured: true,
    url,
    ...(apkDownloadUrl ? { apkDownloadUrl } : {}),
  });
}

function serveApkDownload(_req, res) {
  const apkPath = getAvailableApkPath();
  if (!apkPath) {
    return res
      .status(404)
      .type('text/plain; charset=utf-8')
      .send(
        'APK не найден. Ожидается один из файлов:\n' +
          `  ${APK_RELEASE_PATH}\n` +
          `  ${APK_DEBUG_BUILD_PATH}\n` +
          'Подробнее: docs/DOWNLOAD_APK.md'
      );
  }
  const abs = path.resolve(apkPath);
  let downloadName = 'Resist.apk';
  try {
    const stat = fs.statSync(abs);
    const stamp = new Date(stat.mtimeMs || Date.now())
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    downloadName = `Resist-${stamp}.apk`;
  } catch {
    downloadName = 'Resist.apk';
  }
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      res.status(500).type('text/plain; charset=utf-8').send(String(err.message));
    }
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveInstallPageApkUrl(req) {
  const raw = String(req.query?.apk || '').trim();
  if (!raw) return '/download/app.apk';
  if (raw.startsWith('/')) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href;
    }
  } catch {
    /* ignore invalid custom url */
  }
  return '/download/app.apk';
}

function serveAndroidInstallPage(req, res) {
  const apkHref = resolveInstallPageApkUrl(req);
  const safeApkHref = escapeHtml(apkHref);
  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <title>Обновление Resist</title>
  <style>
    :root {
      --bg: #0b1020;
      --card: rgba(17, 24, 39, 0.92);
      --text: #f8fafc;
      --muted: #cbd5e1;
      --accent: #22c55e;
      --accent-2: #38bdf8;
      --border: rgba(148, 163, 184, 0.2);
      --shadow: 0 24px 80px rgba(15, 23, 42, 0.45);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 34%),
        radial-gradient(circle at bottom, rgba(34, 197, 94, 0.16), transparent 28%),
        var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 24px 16px 48px;
    }
    .card {
      width: min(100%, 560px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 24px;
      box-shadow: var(--shadow);
      padding: 24px 20px;
      backdrop-filter: blur(18px);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 28px;
      line-height: 1.15;
    }
    p {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.5;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 54px;
      margin: 14px 0 18px;
      border: 0;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #04111d;
      font-size: 18px;
      font-weight: 800;
      text-decoration: none;
    }
    .steps {
      margin: 0;
      padding-left: 20px;
      color: var(--text);
    }
    .steps li {
      margin: 0 0 10px;
      line-height: 1.45;
    }
    .note {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.52);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .small-link {
      display: inline-block;
      margin-top: 16px;
      color: #93c5fd;
      text-decoration: none;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Обновление готово</h1>
    <p>Нажмите кнопку ниже. Когда загрузка закончится, Android покажет файл <b>Resist.apk</b> в загрузках или в шторке уведомлений.</p>
    <a class="button" href="${safeApkHref}">Скачать APK</a>
    <ol class="steps">
      <li>Нажмите <b>Скачать APK</b>.</li>
      <li>Дождитесь окончания загрузки.</li>
      <li>Откройте файл <b>Resist.apk</b> из уведомления или папки <b>Download</b>.</li>
      <li>Если Android спросит разрешение, включите установку из этого источника и повторите запуск файла.</li>
    </ol>
    <div class="note">
      Если кнопка уже скачала файл, но установка не началась автоматически, откройте приложение <b>Файлы</b> или <b>Downloads</b> и найдите <b>Resist.apk</b>.
    </div>
    <a class="small-link" href="${safeApkHref}">Прямая ссылка на APK</a>
  </main>
</body>
</html>`);
}

/** Диагностика: есть ли файл APK и какой порт у процесса. */
function apkDownloadDiagnosticHandler(_req, res) {
  const apkPath = getAvailableApkPath();
  const exists = Boolean(apkPath);
  let bytes = 0;
  if (exists) {
    try {
      bytes = fs.statSync(apkPath).size;
    } catch (_) {
      /* ignore */
    }
  }
  const port = Number(process.env.PORT) || 3000;
  res.json({
    ok: exists,
    file: apkPath || APK_RELEASE_PATH,
    candidates: {
      release: APK_RELEASE_PATH,
      debugBuild: APK_DEBUG_BUILD_PATH,
    },
    bytes,
    port,
    urls: {
      short: `http://localhost:${port}/app-debug.apk`,
      download: `http://localhost:${port}/download/app.apk`,
    },
    hint: exists
      ? 'Файл на месте — откройте urls.short с этого же хоста и порта.'
      : 'Скопируйте app-debug.apk в releases/ (см. docs/DOWNLOAD_APK.md) и перезапуск не нужен.',
  });
}

module.exports = {
  APK_RELEASE_PATH,
  APK_DEBUG_BUILD_PATH,
  getAvailableApkPath,
  publicBaseFromRequest,
  inviteLinkHandler,
  serveApkDownload,
  serveAndroidInstallPage,
  apkDownloadDiagnosticHandler,
};
