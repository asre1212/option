/* ─────────────────────────────────────────
   Quote relay — Cloudflare Worker

   The watchlist reads delayed quotes from public feeds. A browser may only
   read another site's data when that site sends an Access-Control-Allow-Origin
   header, and these feeds do not, so the request fails before it leaves the
   phone. This re-issues it from Cloudflare's edge, where that rule does not
   apply, and returns the answer with the header the browser needs.

   Deploy (free tier, no card) — either route:

     From GitHub, no code editor:
       Workers & Pages → Create → Connect GitHub → pick this repo.
       wrangler.toml tells it what to build; later changes ship on push.

     By hand:
       Workers & Pages → Create → Start with Hello World → Deploy,
       then Edit code, paste this file, Deploy.

   Then put the URL in the app:
     Watchlist → source → Custom →  https://<worker>.<account>.workers.dev/?url=

   Find that address under Domains and routes on the Worker's Overview page —
   both halves are chosen by Cloudflare, not by you, so read it rather than
   assuming it. If the workers.dev row there says Disabled, enable it first:
   until then the hostname does not resolve at all and the browser reports the
   server as missing rather than as refusing. Then tap "Test This Route".

   ── The API key ──
   Set MASSIVE_KEY as a Worker secret and the key never touches the phone at
   all: it is added here, at the edge, on the way out. Nothing to paste into
   the app, nothing sitting in localStorage, nothing in a URL a relay could
   log. In the app, turn on "my relay holds the key".

     Dashboard → your Worker → Settings → Variables and Secrets
       → Add → type: Secret, name: MASSIVE_KEY, value: <your key> → Deploy

   A secret set this way is write-only — it can be replaced but never read
   back out of the dashboard, and it is not in the repository.

   Three deliberate limits, because an unrestricted relay is an open proxy
   that anyone on the internet can point at anything — and one holding your
   key would let them spend your quota:

   - ALLOWED_HOSTS — only the quote feeds can be fetched through it.
   - ALLOWED_ORIGINS — only your copy of the app may call it.
   - The key is only ever attached to the Massive hosts, never to any other
     upstream, so it cannot leak sideways.
───────────────────────────────────────── */

const MASSIVE_HOSTS = [
  'api.massive.com',            // Massive (formerly Polygon.io)
  'api.polygon.io'              // its legacy hostname, still served
];

const ALLOWED_HOSTS = [
  ...MASSIVE_HOSTS,
  'cdn.cboe.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com'
];

// Only these pages may use this relay. Empty = any origin, which also means
// anyone who finds the URL can spend your Massive quota — so if you set the
// MASSIVE_KEY secret, keep this filled in.
const ALLOWED_ORIGINS = ['https://asre1212.github.io'];

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
  async fetch(request, env) {
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

    /* Attach the key here rather than expecting the caller to carry it — the
       whole point of holding it as a secret. Only for Massive, and only when
       the caller did not already supply one, so a key typed into the app
       still wins and nothing is silently overridden. */
    const wantsKey = MASSIVE_HOSTS.includes(dest.hostname);
    if (wantsKey && env?.MASSIVE_KEY && !dest.searchParams.get('apiKey')) {
      dest.searchParams.set('apiKey', env.MASSIVE_KEY);
    }
    if (wantsKey && !dest.searchParams.get('apiKey')) {
      return fail(401, 'no API key: set the MASSIVE_KEY secret on this Worker, or enter one in the app', cors);
    }

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
