// ═══════════════════════════════════════════════
// BTCsaki Service Worker — バックグラウンド通知
// ═══════════════════════════════════════════════

const CACHE_NAME = 'btcsaki-v2-realtimeplus';

// インストール時: キャッシュにコアファイルを保存
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html']).catch(() => {})
    )
  );
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ: ネットワークファースト、フォールバックでキャッシュ
self.addEventListener('fetch', event => {
  // API呼び出しはキャッシュしない
  if (event.request.url.includes('api.') || event.request.url.includes('open.er-api')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // レスポンスをキャッシュに保存
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// メインスレッドからの通知リクエストを受信
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, icon } = event.data;
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        tag: tag || 'btcsaki-' + Date.now(),
        icon: icon || '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [200, 100, 200],
        requireInteraction: false,
        silent: false,
        data: { url: '/' },
      })
    );
  }
});

// 通知クリック → アプリを開く
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // 既に開いているタブがあればフォーカス
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      // なければ新しいタブで開く
      return self.clients.openWindow('/');
    })
  );
});
