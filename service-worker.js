/* ─────────────────────────────────────────
   Options Tracker — Service Worker

   Versioning is automatic. There is no number to bump: the version is
   derived from the validators (ETag / Last-Modified) the host already
   sends for the deployed files, so it changes by itself on every deploy
   and never changes when nothing has shipped.

   Same-origin app shell: network-first with cache fallback. Because the
   shell is fetched from the network on every online load anyway, a
   changed deployment is noticed as it arrives — no polling, no extra
   requests — and open tabs are told a new version is ready.

   Allowlisted third-party assets (webfont, lazy-loaded libraries):
   cache-first in a separate runtime cache, so the app keeps its
   typography — and Excel export / OCR keep working — with no
   connection, once each has been fetched successfully one time.
───────────────────────────────────────── */

const SHELL_CACHE    = 'options-tracker-shell';
const RUNTIME_CACHE  = 'options-tracker-runtime-v1';
// Caches from the old hand-numbered scheme, cleaned up on activate
const LEGACY_PREFIX  = 'options-tracker-v';

const CACHE_ASSETS   = [
  './',
  './index.html',
  './app.js',
  './options-tracker.html',
  './manifest.json',
  './icon.svg'
];

// The files whose content defines a release. A change to either is a new
// version; the rest of the shell rides along with them.
const VERSION_ASSETS = ['./index.html', './app.js'];

// Cross-origin hosts whose responses may be kept for offline use. Every URL
// served from these is either version-pinned or immutable, so a stored copy
// never goes stale; anything not listed here is left entirely alone.
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',    // webfont stylesheet
  'fonts.gstatic.com',       // webfont files
  'cdnjs.cloudflare.com',    // SheetJS (Excel export)
  'cdn.jsdelivr.net'         // Tesseract.js (OCR engine + language data)
];

/* ── What identifies a deployed file ──
   ETag first, then Last-Modified, then Content-Length as a weak last
   resort. A file whose bytes changed but which reports none of these
   simply never triggers an update notice — the network-first fetch still
   serves the new copy, so the app is current either way. */
function assetSignature(response) {
  if (!response) return '';
  const h = response.headers;
  return h.get('etag') || h.get('last-modified') || h.get('content-length') || '';
}

// FNV-1a — short, stable, and synchronous. This is a change detector,
// not a security hash.
function shortHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const shellUrl = path => new URL(path, self.location).href;

// The version currently on disk: a hash of what the cached release files
// identify themselves as. Empty until the shell has been cached once.
async function currentVersion() {
  const cache = await caches.open(SHELL_CACHE);
  const parts = [];
  for (const path of VERSION_ASSETS) {
    parts.push(assetSignature(await cache.match(shellUrl(path))));
  }
  return parts.some(Boolean) ? shortHash(parts.join('|')) : '';
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(message));
}

/* ── INSTALL: cache app shell ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
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
          .filter(key => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map(key  => caches.delete(key))   // includes the old numbered caches
      ))
      .then(() => self.clients.claim())      // take control of all tabs now
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

/* ── Network-first for the app shell ──
   Every online load already fetches these, so this is also where a new
   deployment is detected: if a release file comes back identifying
   itself differently from the copy we hold, that is a new version and
   the open tabs are told so. */
async function shellAsset(request, isNavigation) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const isRelease = VERSION_ASSETS.some(p => shellUrl(p) === request.url) || isNavigation;
      const previous  = isRelease ? await cache.match(request, { ignoreSearch: isNavigation }) : null;
      const wasSig    = assetSignature(previous);
      const nowSig    = assetSignature(response);

      await cache.put(request, response.clone());

      // Only a genuine change counts: both sides must identify themselves,
      // and a first-ever cache is not an update.
      if (previous && wasSig && nowSig && wasSig !== nowSig) {
        broadcast({ type: 'UPDATE_READY', version: await currentVersion() });
      }
      return response;
    }
    return response;
  } catch (_) {
    // Network failed — serve from cache. Navigations ignore query params
    // so start_url variants (?source=pwa&tab=…) still hit.
    const cached = await caches.match(request, { ignoreSearch: isNavigation });
    if (cached) return cached;
    // Only page navigations get the friendly offline page; a subresource
    // must fail as a network error, never fake HTML.
    if (isNavigation) {
      return new Response(
        '<h2 style="font-family:monospace;padding:2rem">Offline — no cached version available yet.<br>Open the app once while online first.</h2>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    return Response.error();
  }
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

  event.respondWith(shellAsset(event.request, event.request.mode === 'navigate'));
});

/* ── MESSAGES from the app ── */
self.addEventListener('message', event => {
  const data = event.data;
  const reply = msg => { if (event.source) event.source.postMessage(msg); };

  // Which version is running
  if (data === 'GET_VERSION') {
    event.waitUntil(currentVersion().then(version => reply({ type: 'VERSION', version })));
    return;
  }

  // A waiting worker asked to take over immediately
  if (data === 'SKIP_WAITING') { self.skipWaiting(); return; }

  // "Update App" button: clear the app shell then tell the client to reload.
  // The runtime cache is deliberately left alone — its entries are pinned
  // URLs, and dropping them would cost the app its offline font and
  // libraries until the next time each is downloaded again.
  if (data === 'CLEAR_AND_RELOAD') {
    event.waitUntil(
      caches.delete(SHELL_CACHE)
        .then(() => caches.open(SHELL_CACHE).then(c => c.addAll(CACHE_ASSETS)).catch(() => {}))
        .then(() => reply('READY_TO_RELOAD'))
    );
    return;
  }

  // Manual cache bust (e.g. after a GitHub Pages push) — full clean,
  // third-party assets included.
  if (data === 'CLEAR_CACHE') {
    event.waitUntil(
      Promise.all([caches.delete(SHELL_CACHE), caches.delete(RUNTIME_CACHE)])
        .then(() => reply('CACHE_CLEARED'))
    );
  }
});
