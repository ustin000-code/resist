/**
 * Полуавтообновление APK (GET /api/app/android-update).
 * Общий код для server.js и src/app.js.
 */
const path = require('path');
const fs = require('fs');
const {
  APK_RELEASE_PATH,
  getAvailableApkPath,
  publicBaseFromRequest,
} = require('./inviteAndApk');

const ANDROID_GRADLE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'android',
  'app',
  'build.gradle'
);

function readAndroidVersionFromGradleSync() {
  try {
    const src = fs.readFileSync(ANDROID_GRADLE_PATH, 'utf8');
    const codeM = src.match(/versionCode\s+(\d+)/);
    const nameM = src.match(/versionName\s+"([^"]+)"/);
    const versionCode = codeM ? parseInt(codeM[1], 10) : 0;
    const versionName = nameM ? String(nameM[1]).trim() : '';
    return { versionCode, versionName };
  } catch {
    return { versionCode: 0, versionName: '' };
  }
}

function withVersionQuery(url, versionCode) {
  const raw = String(url || '').trim();
  const version = Number(versionCode);
  if (!raw || !Number.isFinite(version) || version <= 0) return raw;
  const joiner = raw.includes('?') ? '&' : '?';
  return `${raw}${joiner}v=${version}`;
}

/**
 * Авто-режим: versionCode из android/app/build.gradle + releases/app-debug.apk.
 * См. docs/ANDROID_UPDATE.md
 */
function getAndroidUpdateConfig() {
  const disRaw = String(process.env.ANDROID_UPDATE_DISABLE || '')
    .trim()
    .toLowerCase();
  if (disRaw === '1' || disRaw === 'true' || disRaw === 'yes') {
    return { enabled: false, reason: 'disabled' };
  }

  const envCode = String(process.env.ANDROID_UPDATE_VERSION_CODE || '').trim();
  const gradle = readAndroidVersionFromGradleSync();
  let latestVersionCode = parseInt(envCode, 10);
  if (!Number.isFinite(latestVersionCode) || latestVersionCode <= 0) {
    latestVersionCode = gradle.versionCode;
  }

  let apkUrl = String(process.env.ANDROID_UPDATE_APK_URL || '').trim();
  if (!apkUrl) {
    apkUrl = '/download/app.apk';
  }
  apkUrl = withVersionQuery(apkUrl, latestVersionCode);

  const versionName =
    String(process.env.ANDROID_UPDATE_VERSION_NAME || '').trim() ||
    gradle.versionName;

  if (!Number.isFinite(latestVersionCode) || latestVersionCode <= 0) {
    return { enabled: false, reason: 'no_version' };
  }

  const isLocalApkPath =
    !/^https?:\/\//i.test(apkUrl) && apkUrl.startsWith('/');
  if (isLocalApkPath && !getAvailableApkPath()) {
    return { enabled: false, reason: 'no_apk_file' };
  }

  return {
    enabled: true,
    latestVersionCode,
    versionName,
    apkUrl,
    message: String(process.env.ANDROID_UPDATE_MESSAGE || '').trim(),
  };
}

const SKIP_HINTS = {
  disabled: 'В .env задано ANDROID_UPDATE_DISABLE=1.',
  no_version:
    'Нет versionCode: на VPS часто нет папки android/. В .env укажите ANDROID_UPDATE_VERSION_CODE= число БОЛЬШЕ, чем у установленного APK (см. android/app/build.gradle).',
  no_apk_file:
    'Нет файла releases/app-debug.apk. Выполните на сервере: npm run apk:to-releases (копирует android/app/build/outputs/apk/debug/app-debug.apk) или задайте ANDROID_UPDATE_APK_URL=https://…',
  unknown: 'См. GET /api/__android_update_status и docs/ANDROID_UPDATE.md',
};

function hintForReason(reason) {
  return SKIP_HINTS[reason] || SKIP_HINTS.unknown;
}

function androidUpdateHandler(req, res) {
  const cfg = getAndroidUpdateConfig();
  if (!cfg.enabled) {
    const reason = cfg.reason || 'unknown';
    return res.json({
      skip: true,
      reason,
      hint: hintForReason(reason),
    });
  }
  let apkUrl = cfg.apkUrl;
  if (!/^https?:\/\//i.test(apkUrl) && apkUrl.startsWith('/')) {
    const base = publicBaseFromRequest(req);
    if (base) {
      apkUrl = `${base}${apkUrl}`;
    }
  }
  res.json({
    skip: false,
    latestVersionCode: cfg.latestVersionCode,
    versionName: cfg.versionName || '',
    apkUrl,
    message: cfg.message || '',
  });
}

function androidUpdateStatusHandler(_req, res) {
  const gradleExists = fs.existsSync(ANDROID_GRADLE_PATH);
  const apkPath = getAvailableApkPath();
  const apkExists = Boolean(apkPath);
  let apkBytes = 0;
  if (apkExists) {
    try {
      apkBytes = fs.statSync(apkPath).size;
    } catch {
      /* ignore */
    }
  }
  const cfg = getAndroidUpdateConfig();
  const gradle = readAndroidVersionFromGradleSync();
  res.json({
    gradlePath: ANDROID_GRADLE_PATH,
    gradleFileExists: gradleExists,
    gradleVersionCode: gradle.versionCode,
    gradleVersionName: gradle.versionName,
    apkReleasePath: APK_RELEASE_PATH,
    apkDetectedPath: apkPath || '',
    apkReleaseExists: apkExists,
    apkReleaseBytes: apkBytes,
    env: {
      ANDROID_UPDATE_DISABLE: process.env.ANDROID_UPDATE_DISABLE || '',
      ANDROID_UPDATE_VERSION_CODE: process.env.ANDROID_UPDATE_VERSION_CODE || '',
      ANDROID_UPDATE_APK_URL: process.env.ANDROID_UPDATE_APK_URL || '',
    },
    effective: {
      enabled: cfg.enabled,
      reason: cfg.reason || null,
      latestVersionCode: cfg.enabled ? cfg.latestVersionCode : null,
      apkUrl: cfg.enabled ? cfg.apkUrl : null,
    },
    hint: cfg.enabled ? null : hintForReason(cfg.reason || 'unknown'),
  });
}

module.exports = {
  getAndroidUpdateConfig,
  androidUpdateHandler,
  androidUpdateStatusHandler,
  readAndroidVersionFromGradleSync,
  ANDROID_GRADLE_PATH,
};
