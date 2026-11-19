// Network-first service worker: always picks up new versions when online, works offline from cache otherwise.
const V = 'gb-v15';
const ASSETS = ['./', 'index.html', 'gb.js?v=14', 'net.js?v=14', 'app.js?v=14', 'manifest.webmanifest', 'icon.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== self.location.origin) return;   // only our own files; never touch the code service / streams
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
