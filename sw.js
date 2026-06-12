const CACHE_VERSION = 'v16'; // BUMP THIS ON EACH DEPLOY
const CACHE = 'readalong-' + CACHE_VERSION;
const SHELL = ['/reader.html', '/manifest.json', '/icon.svg'];
const OFFLINE_HTML = '<html><body style="background:#0f0e0d;color:#d4af37;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><h1>📖</h1><p style="margin-top:1rem">Немає з\'єднання</p><p style="font-size:0.85rem;color:#9b8b74">Перевірте інтернет</p></body></html>';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all([
        ...keys.filter(k => k.startsWith('readalong-') && k !== CACHE).map(k => caches.delete(k)),
        self.clients.claim()
      ])
    )
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  if (url.includes('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Network-first for HTML — always serve fresh CSS/JS references
  if (e.request.destination === 'document' || url.endsWith('/reader.html')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.ok ? res.clone() : null;   // клон СИНХРОННО, до return
        if (copy) caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Network-first for JS modules — деплой завжди тягне свіжі модулі, кеш = офлайн-фолбек
  if (e.request.destination === 'script') {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.ok ? res.clone() : null;   // клон СИНХРОННО, до return
        if (copy) caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone)).catch(() => {});
        }
        return res;
      });
    }).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html;charset=utf-8' } }))
  );
});
