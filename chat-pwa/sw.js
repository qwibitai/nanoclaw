const CACHE = 'nanoclaw-chat-v88';
const ASSETS = ['/', '/index.html', '/app.js', '/pcm-worklet.js', '/style.css', '/marked.min.js', '/dompurify.min.js', '/logo-dark.svg', '/logo-light.svg'];
const VENDORED = new Set(['/marked.min.js', '/dompurify.min.js', '/logo-dark.svg', '/logo-light.svg']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// IndexedDB-backed unread counter shared between the SW and the page.
function badgeDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nanoclaw-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function badgeIncrement() {
  const db = await badgeDB();
  return new Promise((resolve) => {
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    const getReq = store.get('count');
    getReq.onsuccess = () => {
      const next = (getReq.result || 0) + 1;
      store.put(next, 'count');
      tx.oncomplete = () => resolve(next);
    };
  });
}

async function applyBadge(n) {
  if ('setAppBadge' in self.navigator) {
    try { await self.navigator.setAppBadge(n); } catch {}
  }
}

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* best-effort */ }
  const title = data.title || 'NanoClaw';
  const body = data.body || 'New message';
  const tag = data.tag || 'nanoclaw-msg';
  const roomId = data.roomId || '';
  e.waitUntil((async () => {
    // Only bump the badge if no visible PWA window exists — otherwise the
    // user is already looking at the app and the unread count should stay 0.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisible = clients.some((c) => c.visibilityState === 'visible');
    if (!hasVisible) {
      const n = await badgeIncrement();
      await applyBadge(n);
    }
    await self.registration.showNotification(title, {
      body,
      tag,
      data: { roomId },
      badge: '/logo-light.svg',
      icon: '/logo-dark.svg',
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const roomId = (e.notification.data && e.notification.data.roomId) || '';
  const targetUrl = roomId ? `/?room=${encodeURIComponent(roomId)}` : '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.registration.scope.replace(/\/$/, ''))) {
        await c.focus();
        if (roomId) c.postMessage({ type: 'open-room', roomId });
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/ws')) return;

  const url = new URL(e.request.url);

  // Vendored libs: cache-first (they never change)
  if (VENDORED.has(url.pathname)) {
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
    return;
  }

  // App files: network-first, fall back to cache (always fresh after server restart)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
