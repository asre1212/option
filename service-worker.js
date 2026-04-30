/* ─────────────────────────────────────────
   Options Tracker — Service Worker
   Strategy: network-first with cache fallback
   Cache is cleared by the "Update App" button
───────────────────────────────────────── */

const CACHE_VERSION  = 'options-tracker-v1';
const CACHE_ASSETS   = [
  './options-tracker.html',
  './manifest.json',
  './icon.svg'
];

/* ── INSTALL: cache app shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(CACHE_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately
  );
});

/* ── ACTIVATE: remove stale caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key  => caches.delete(key))
      ))
      .then(() => self.clients.claim())  // take control of all tabs now
  );
});

/* ── FETCH: network first, cache fallback ── */
self.addEventListener('fetch', event => {
  // Only handle GET requests for same-origin or CDN assets
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // Cache a fresh copy on every successful network hit
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed — serve from cache
        return caches.match(event.request)
          .then(cached => cached || new Response(
            '<h2 style="font-family:monospace;padding:2rem">Offline — no cached version available yet.<br>Open the app once while online first.</h2>',
            { headers: { 'Content-Type': 'text/html' } }
          ));
      })
  );
});

/* ── MESSAGES from the app ── */
self.addEventListener('message', event => {

  // "Update App" button: clear cache then tell client to reload
  if (event.data === 'CLEAR_AND_RELOAD') {
    caches.delete(CACHE_VERSION).then(() => {
      // Re-cache fresh copies in the background
      caches.open(CACHE_VERSION).then(cache => cache.addAll(CACHE_ASSETS));
      // Tell the calling tab it's safe to reload
      if (event.source) event.source.postMessage('READY_TO_RELOAD');
    });
  }

  // Manual cache bust (e.g. after a GitHub Pages push)
  if (event.data === 'CLEAR_CACHE') {
    caches.delete(CACHE_VERSION).then(() => {
      if (event.source) event.source.postMessage('CACHE_CLEARED');
    });
  }
});
