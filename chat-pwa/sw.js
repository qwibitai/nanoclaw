const CACHE = 'nanoclaw-chat-v29';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/marked.min.js', '/dompurify.min.js', '/logo-dark.svg', '/logo-light.svg'];
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
