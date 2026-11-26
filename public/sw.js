// Service Worker for Udhaar PWA Shell
const CACHE_NAME = 'udhaar-shell-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never cache API calls (sensitive financial data must never be stored in shared service worker caches)
  if (url.pathname.startsWith('/api') || e.request.method !== 'GET') {
    return;
  }

  // Network-first for HTML, fallback to cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for static icons and assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
