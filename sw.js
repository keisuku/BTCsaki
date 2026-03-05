// ═══════════════════════════════════════════════
// BTC先物 スキャルシグナル — Service Worker
// ═══════════════════════════════════════════════
const CACHE_NAME = 'btc-signal-v1';
const ASSETS = [
  '/BTCsakimono/',
  '/BTCsakimono/index.html',
  '/BTCsakimono/manifest.json',
  '/BTCsakimono/icon-192.png',
  '/BTCsakimono/icon-512.png',
];

// Install: cache shell assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API calls, cache-first for assets
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for API calls
  if (url.hostname !== location.hostname) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Push notification handler
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'BTCシグナル';
  const options = {
    body: data.body || 'シグナルが更新されました',
    icon: '/BTCsakimono/icon-192.png',
    badge: '/BTCsakimono/icon-192.png',
    tag: data.tag || 'signal-update',
    renotify: true,
    data: { url: '/BTCsakimono/' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Notification click: open or focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('/BTCsakimono') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/BTCsakimono/');
    })
  );
});
