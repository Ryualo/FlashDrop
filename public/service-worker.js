/* DropFlash service worker — offline reopening of the app shell.
 *
 * The build (vite.config.ts → injectOfflinePrecache) replaces BUILD_ID and CORE_ASSETS with the
 * content hash and the list of emitted files, so every deploy gets its own cache and old caches
 * are removed only after the new version has taken control.
 */
const BUILD_ID = 'dev';
const CACHE_PREFIX = 'flashdrop-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const CORE_ASSETS = ['/', '/index.html', '/manifest.json', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  // Do not skipWaiting automatically: the page asks the user before switching versions.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: 'reload' bypasses the HTTP cache so a stale CDN/browser copy is never precached
      cache.addAll(CORE_ASSETS.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isCacheable(response) {
  return response && response.ok && response.type === 'basic';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never cache third-party responses
  if (request.headers.has('range')) return; // let the network handle partial requests

  // Navigations: network first (fresh deploys), cached app shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (isCacheable(response)) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/index.html', response.clone());
          }
          return response;
        } catch {
          const cached = (await caches.match('/index.html', { cacheName: CACHE_NAME })) || (await caches.match('/'));
          return cached || new Response('DropFlash is offline and has not been cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
        }
      })()
    );
    return;
  }

  // Build assets are content-hashed: cache first. Other same-origin GETs: cache, then network.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { cacheName: CACHE_NAME });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (isCacheable(response) && url.pathname.startsWith('/assets/')) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const any = await caches.match(request);
        return any || new Response('', { status: 504 });
      }
    })()
  );
});
