// Minimal Service Worker — PWA 安装必需，不缓存任何内容。
// 更新 index.html 后立即生效，无需手动清缓存。

// 安装时跳过等待，立即激活
self.addEventListener('install', () => self.skipWaiting());

// 激活时清除所有旧版本遗留的缓存，然后接管页面
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 兼容旧版 Chromium 的 PWA 安装检查；仅转发页面导航，不缓存内容。
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});
