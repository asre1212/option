/* ─────────────────────────────────────────
   Quote relay — Cloudflare Worker

   The watchlist reads delayed quotes from public feeds. A browser may only
   read another site's data when that site sends an Access-Control-Allow-Origin
   header, and these feeds do not, so the request fails before it leaves the
   phone. This re-issues it from Cloudflare's edge, where that rule does not
   apply, and returns the answer with the header the browser needs.

   Deploy (free tier, no card):
     1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World
     2. Replace the code with this file, Deploy
     3. Copy the workers.dev URL and put it in the app:
        Watchlist → source → Custom →  https://<name>.<you>.workers.dev/?url=
        Then tap "Test This Route".

   Two deliberate limits, because an unrestricted relay is an open proxy that
   anyone on the internet can point at anything:

   - ALLOWED_HOSTS — only the quote feeds can be fetched through it.
   - ALLOWED_ORIGINS — only your copy of the app may call it. Leave it empty
     to allow any origin (simpler; fine for a personal relay that is already
     limited to the hosts above).
───────────────────────────────────────── */

const ALLOWED_HOSTS = [
  'api.massive.com',            // Massive (formerly Polygon.io)
  'api.polygon.io',             // its legacy hostname, still served
  'cdn.cboe.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com'
];

// e.g. ['https://asre1212.github.io']. Empty = any origin.
const ALLOWED_ORIGINS = [];

const MAX_URL = 2000;

function corsHeaders(origin) {
  const allow = !ALLOWED_ORIGINS.length ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : null);
  if (!allow) return null;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    // A relayed price is only useful while it is fresh
    'Cache-Control': 'public, max-age=60',
    ...(ALLOWED_ORIGINS.length ? { 'Vary': 'Origin' } : {})
  };
}

const fail = (status, msg, headers) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);
    if (!cors) return fail(403, 'origin not allowed');

    // Preflight — only sent if the app ever adds a custom header, but a relay
    // that answers it costs nothing and saves a confusing failure later.
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET')     return fail(405, 'GET only', cors);

    const target = new URL(request.url).searchParams.get('url');
    if (!target)                 return fail(400, 'missing ?url=', cors);
    if (target.length > MAX_URL) return fail(414, 'url too long', cors);

    let dest;
    try { dest = new URL(target); } catch (e) { return fail(400, 'malformed url', cors); }
    if (dest.protocol !== 'https:')            return fail(400, 'https only', cors);
    if (!ALLOWED_HOSTS.includes(dest.hostname)) return fail(403, `host not allowed: ${dest.hostname}`, cors);

    let upstream;
    try {
      upstream = await fetch(dest.toString(), {
        headers: {
          // Yahoo returns 401 to an unrecognised client; Cboe does not care
          'User-Agent': 'Mozilla/5.0 (compatible; options-tracker-relay)',
          'Accept': 'application/json,text/plain,*/*'
        },
        cf: { cacheTtl: 60, cacheEverything: true }
      });
    } catch (e) {
      return fail(502, `upstream unreachable: ${e.message}`, cors);
    }

    // Pass the upstream status through rather than flattening everything to
    // 200 — the app's error messages are only useful if they are true.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json'
      }
    });
  }
};
