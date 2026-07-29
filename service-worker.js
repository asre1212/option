/* ─────────────────────────────────────────
   Options Tracker — Service Worker
   Same-origin app shell: network-first with cache fallback,
   cleared by the "Update App" button.
   Allowlisted third-party assets (webfont, lazy-loaded libraries):
   cache-first in a separate runtime cache, so the app keeps its
   typography — and Excel export / OCR keep working — with no
   connection, once each has been fetched successfully one time.
───────────────────────────────────────── */

const CACHE_VERSION  = 'options-tracker-v4';
const RUNTIME_CACHE  = 'options-tracker-runtime-v1';
const CACHE_ASSETS   = [
  './',
  './index.html',
  './app.js',
  './options-tracker.html',
  './manifest.json',
  './icon.svg'
];

// Cross-origin hosts whose responses may be kept for offline use. Every URL
// served from these is either version-pinned or immutable, so a stored copy
// never goes stale; anything not listed here is left entirely alone.
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',    // webfont stylesheet
  'fonts.gstatic.com',       // webfont files
  'cdnjs.cloudflare.com',    // SheetJS (Excel export)
  'cdn.jsdelivr.net'         // Tesseract.js (OCR engine + language data)
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
          .filter(key => key !== CACHE_VERSION && key !== RUNTIME_CACHE)
          .map(key  => caches.delete(key))
      ))
      .then(() => self.clients.claim())  // take control of all tabs now
  );
});

/* ── Cache-first for allowlisted third-party assets ──
   A stored copy is replayed as-is; on a miss we go to the network and
   keep the response only when it is a real, readable success. A failure
   is passed through untouched — answering a library with a fabricated
   200 poisons its own caches with garbage bytes. */
async function runtimeAsset(request) {
  const cache  = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.status === 200 && response.type !== 'opaque') {
    cache.put(request, response.clone());
  }
  return response;
}

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Third-party assets we are allowed to keep (webfont, lazy libraries).
  // Everything else cross-origin goes straight to the network, untouched.
  if (url.origin !== self.location.origin) {
    if (RUNTIME_HOSTS.includes(url.hostname)) event.respondWith(runtimeAsset(event.request));
    return;
  }

  // Same-origin app shell: network first, cache fallback.
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
        // Network failed — serve from cache. Navigations ignore query
        // params so start_url variants (?source=pwa&tab=…) still hit.
        return caches.match(event.request, { ignoreSearch: event.request.mode === 'navigate' })
          .then(cached => {
            if (cached) return cached;
            // Only page navigations get the friendly offline page; a
            // subresource must fail as a network error, never fake HTML.
            if (event.request.mode === 'navigate') {
              return new Response(
                '<h2 style="font-family:monospace;padding:2rem">Offline — no cached version available yet.<br>Open the app once while online first.</h2>',
                { headers: { 'Content-Type': 'text/html' } }
              );
            }
            return Response.error();
          });
      })
  );
});

/* ── MESSAGES from the app ── */
self.addEventListener('message', event => {

  // "Update App" button: clear the app shell then tell the client to reload.
  // The runtime cache is deliberately left alone — its entries are pinned
  // URLs, and dropping them would cost the app its offline font and
  // libraries until the next time each is downloaded again.
  if (event.data === 'CLEAR_AND_RELOAD') {
    caches.delete(CACHE_VERSION).then(() => {
      // Re-cache fresh copies in the background; offline this just fails,
      // and the reload below is then served by whatever is already cached.
      caches.open(CACHE_VERSION)
        .then(cache => cache.addAll(CACHE_ASSETS))
        .catch(() => {});
      // Tell the calling tab it's safe to reload
      if (event.source) event.source.postMessage('READY_TO_RELOAD');
    });
  }

  // Manual cache bust (e.g. after a GitHub Pages push) — full clean,
  // third-party assets included.
  if (event.data === 'CLEAR_CACHE') {
    Promise.all([caches.delete(CACHE_VERSION), caches.delete(RUNTIME_CACHE)]).then(() => {
      if (event.source) event.source.postMessage('CACHE_CLEARED');
    });
  }
});
