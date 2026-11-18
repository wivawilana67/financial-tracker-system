// Network-first for the app's own files, falling back to the cache when offline.
// Backend calls (POST and GET to script.google.com) and Google scripts are cross-origin and never cached.
// PROD and TEST are published on one origin: each scope has its own cache, and the PROD worker never touches /test/.

const IS_TEST_SCOPE = new URL(self.registration.scope).pathname.endsWith('/test/');
const CACHE = IS_TEST_SCOPE ? 'fintrack-test-shell' : 'fintrack-shell';
const TEST_PATH = new URL('test/', self.registration.scope).pathname;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './api.js',
  './auth.js',
  './ui.js',
  './config.js',
  './cc.js',
  './home.js',
  './sw.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Old caches are never deleted here: the other environment shares this origin and may still use its cache.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!IS_TEST_SCOPE && url.pathname.startsWith(TEST_PATH)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
