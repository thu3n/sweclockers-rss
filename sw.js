/**
 * FyndRadar service worker.
 *
 * - App-skalet (HTML/CSS/JS/ikoner) cachas och serveras direkt, uppdateras i bakgrunden.
 * - data/ hämtas alltid från nätet först, med cachen som reserv vid offline.
 * - Produktbilder och favicons från andra domäner rörs inte.
 */
const VERSION = 'v3';
const SHELL_CACHE = `fyndradar-shell-${VERSION}`;
const DATA_CACHE = `fyndradar-data-${VERSION}`;

const SHELL_FILES = ['./', './index.html', './index.css', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(stripQuery(request), response.clone());
    return response;
  } catch {
    const cached = await cache.match(stripQuery(request));
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

/** data/-filer cache-bustas med ?t=; lagra dem utan query så reserven hittas. */
function stripQuery(request) {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString());
}
