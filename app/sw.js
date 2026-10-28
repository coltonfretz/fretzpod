// Fretzpod service worker: keeps a copy of the app's own files so it opens
// instantly and still opens with no connection. Only the app shell: music,
// art and everything else from Jellyfin is never touched or cached here.
//
// Network first, cache as the fallback: a deploy shows up on the next open
// instead of waiting for the cache to expire.
//
// Service workers only run on https pages, so this does nothing on a plain
// http copy of the app; it's for the https copy people install.
// build.py fills both placeholders, so nobody has to remember either:
// __BUILD__ is the version plus a fingerprint of the app files (any change
// installs a fresh copy on phones), __SHELL__ every file in app/ (a new file
// can't be left out of the offline copy).
const CACHE = 'fretzpod-shell-__BUILD__';
const SHELL = ['./', ...'__SHELL__'.split(',')];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Speaker state, song links and the score boards are live; never keep or
  // serve copies.
  if (url.pathname.startsWith('/speakers/') || url.pathname.startsWith('/scores/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))),
  );
});
