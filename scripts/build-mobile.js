const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const targets = [
  path.join(rootDir, "android", "app", "src", "main", "assets", "public"),
  path.join(rootDir, "ios", "App", "App", "public"),
];
const capConfigSrc = path.join(rootDir, "capacitor.config.json");
const capConfigAndroid = path.join(
  rootDir,
  "android",
  "app",
  "src",
  "main",
  "assets",
  "capacitor.config.json"
);

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    ensureDir(to);
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

if (!exists(distDir)) {
  console.error("dist/ не найден. Нечего синхронизировать в мобильные assets.");
  process.exit(1);
}

const distEntries = fs.readdirSync(distDir);
if (!distEntries.length) {
  console.error("dist/ пустой. Сначала нужна готовая web-сборка.");
  process.exit(1);
}

for (const target of targets) {
  ensureDir(target);
  for (const entry of distEntries) {
    copyRecursive(path.join(distDir, entry), path.join(target, entry));
  }
}

if (exists(capConfigSrc)) {
  ensureDir(path.dirname(capConfigAndroid));
  fs.copyFileSync(capConfigSrc, capConfigAndroid);
}

console.log("Готово: текущий dist синхронизирован в Android/iOS public.");
console.log("Если исходная web-сборка менялась, но dist не обновлялся, сначала нужно вернуть полноценный frontend build.");
