/**
 * Прокси для `vite preview` / dev: с телефона достаточно открыть :4173,
 * запросы /api и WebSocket /socket.io уходят на Node (по умолчанию :3000).
 *
 * Запуск: MESSENGER_API_PROXY=http://127.0.0.1:3000 npm run serve:dist
 */
const { defineConfig } = require("vite");

const apiTarget =
  process.env.MESSENGER_API_PROXY || "http://127.0.0.1:3000";

const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
  },
  "/socket.io": {
    target: apiTarget,
    ws: true,
    changeOrigin: true,
  },
};

module.exports = defineConfig({
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    proxy: { ...proxy },
  },
  server: {
    proxy: { ...proxy },
  },
});
