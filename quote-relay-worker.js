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

/* ═══════════════════════════════════════
   SCHEDULED COLLECTION  (optional)

   A page can only refresh while it is open, which is no use at 6:30 in the
   morning. With a KV namespace bound as QUOTES and the cron triggers in
   wrangler.toml, this Worker collects on its own schedule and the app just
   reads the result when it opens — one request instead of two per ticker,
   and data that is current whether or not the phone was awake.

   Everything here is optional. With no QUOTES binding the Worker is still a
   plain relay and the app falls back to fetching for itself.

   What is stored is the raw filtered chain, not finished figures: strike
   selection and ROI stay in the app, where they are already written and
   tested, so there is one implementation of the maths rather than two.
═══════════════════════════════════════ */

// Keep in step with MARKET_SLOTS in app.js — the app displays these, this
// runs them. New York time; the cron fires far more often than this and the
// due check below decides what actually happens.
const SLOTS = [
  { key: 'pre',   h: 6,  m: 30 },
  { key: 'open',  h: 9,  m: 31 },
  { key: 'noon',  h: 12, m: 0  },
  { key: 'aft',   h: 14, m: 30 },
  { key: 'close', h: 15, m: 58 }
];

const WATCH_KEY = 'watchlist';
const SNAP_KEY  = 'snapshot';
const MAX_WATCH = 40;

// Wall clock in New York, so the schedule follows the market rather than UTC
// and needs no changing twice a year.
function marketNow(now) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(now || new Date()).forEach(x => { p[x.type] = x.value; });
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10),
    weekend: p.weekday === 'Sat' || p.weekday === 'Sun'
  };
}

// Options do not trade before the opening bell, so anything collected then
// carries yesterday's closes on the contracts even when the underlying has
// moved. Say so rather than letting it read as live.
const isPremarket = m => m.minutes < 9 * 60 + 30;

const jsonResponse = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });

async function massiveJSON(path, env) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`https://api.massive.com${path}${sep}apiKey=${encodeURIComponent(env.MASSIVE_KEY)}`, {
    headers: { 'User-Agent': 'options-tracker-relay', 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const dayOffset = n => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* AAPL260220P00150000 → Feb 20 2026 put, $150. The last 15 characters are
   fixed width, so read from the end; roots contain digits often enough that
   reading from the front is not safe. */
function parseOcc(sym) {
  const m = /^(.+?)(\d{6})([CP])(\d{8})$/.exec(String(sym || '').replace(/\s+/g, '').toUpperCase());
  if (!m) return null;
  return {
    expiry: `20${m[2].slice(0,2)}-${m[2].slice(2,4)}-${m[2].slice(4,6)}`,
    type:   m[3] === 'P' ? 'put' : 'call',
    strike: parseInt(m[4], 10) / 1000
  };
}

const CBOE_INDEX  = ['SPX','VIX','NDX','RUT','DJX','XSP','OEX','XEO'];
const cboeSymbol  = t => (CBOE_INDEX.includes(t) ? '_' + t : t.replace(/\./g, ''));

/* Cboe's delayed-quote CDN: underlying and whole chain in one request, no
   key and no entitlement to be short of. It refuses browsers and shared
   proxies, which is the entire reason this Worker exists — from here it
   answers normally. */
async function collectCboe(ticker) {
  const r = await fetch(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(cboeSymbol(ticker))}.json`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; options-tracker-relay)', 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json())?.data;
  if (!d || !Array.isArray(d.options)) throw new Error('unexpected response');

  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const price = num(d.current_price) ?? num(d.last_trade_price) ?? num(d.close);
  if (price == null || price <= 0) throw new Error('no price');

  // The whole chain is far more than is needed; keep the window the app picks from
  const lo = dayOffset(20), hi = dayOffset(90);
  const chain = [];
  for (const o of d.options) {
    const p = parseOcc(o.option);
    if (!p || p.type !== 'put' || p.expiry < lo || p.expiry > hi) continue;
    chain.push({
      expiry: p.expiry, strike: p.strike,
      bid:  num(o.bid) ?? 0,
      ask:  num(o.ask) ?? 0,
      last: num(o.last_trade_price) ?? 0,
      oi:   num(o.open_interest) ?? 0
    });
  }
  if (!chain.length) throw new Error('no puts in range');

  return {
    price,
    prevClose: num(d.prev_day_close) ?? num(d.close),
    changePct: num(d.price_change_percent),
    chain, source: 'Cboe · relay'
  };
}

/* One ticker: the puts expiring near 45 days out, plus the previous close.
   Returns the same shape the app's Massive provider builds, so the app can
   run its existing leg-selection over it unchanged. */
async function collectMassive(ticker, env) {
  const t = encodeURIComponent(ticker);
  let results = [];
  for (const [lo, hi] of [[38, 52], [20, 90]]) {
    const j = await massiveJSON(
      `/v3/snapshot/options/${t}?contract_type=put&limit=250`
      + `&expiration_date.gte=${dayOffset(lo)}&expiration_date.lte=${dayOffset(hi)}`, env);
    results = Array.isArray(j?.results) ? j.results : [];
    if (results.length) break;
  }
  if (!results.length) throw new Error('no put contracts');

  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  let price = null;
  const chain = [];
  for (const r of results) {
    const strike = num(r?.details?.strike_price);
    const expiry = r?.details?.expiration_date;
    if (strike == null || strike <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(expiry || '')) continue;
    if (price == null) price = num(r?.underlying_asset?.price);
    chain.push({
      expiry, strike,
      bid:  num(r?.last_quote?.bid) ?? 0,
      ask:  num(r?.last_quote?.ask) ?? 0,
      last: num(r?.last_trade?.price) ?? num(r?.day?.close) ?? 0,
      oi:   num(r?.open_interest) ?? 0
    });
  }
  if (!chain.length) throw new Error('no usable contracts');

  let prevClose = null;
  try {
    const p = await massiveJSON(`/v2/aggs/ticker/${t}/prev?adjusted=true`, env);
    prevClose = num(p?.results?.[0]?.c);
    if (price == null) price = prevClose;
  } catch (e) { /* the chain is the point */ }
  if (price == null || price <= 0) throw new Error('no underlying price');

  return {
    price, prevClose,
    changePct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : null,
    chain, source: 'Massive · relay'
  };
}

/* Massive first when there is a key, because it is the licensed source and
   the one anybody is actually entitled to read. It answers 403 when the plan
   does not cover option chains — the free tier does not — so Cboe is not a
   last resort here, it is what usually does the work. */
async function collectTicker(ticker, env) {
  const errs = [];
  if (env?.MASSIVE_KEY) {
    try { return await collectMassive(ticker, env); }
    catch (e) { errs.push(`Massive: ${e.message || e}`); }
  }
  try { return await collectCboe(ticker); }
  catch (e) { errs.push(`Cboe: ${e.message || e}`); }
  throw new Error(errs.join(' · '));
}

/* Which slots are due today and have not run. Missed ones are collapsed —
   one collection brings everything current, so a Worker that was asleep or
   erroring does not then replay the whole day. */
function dueSlots(state, m) {
  if (m.weekend) return [];
  const runs = (state.date === m.date && state.runs) ? state.runs : [];
  return SLOTS.filter(s => !runs.includes(s.key) && m.minutes >= s.h * 60 + s.m);
}

/* Pacing. The 26-second walk exists for one reason: Massive's free tier
   allows five requests a minute and collectMassive makes two per ticker.
   With no key nothing here touches Massive at all — it is Cboe's CDN, one
   request per ticker, with no published per-minute limit — so the same pause
   buys nothing and costs the run its budget. */
const GAP_KEYED = 26000;
const GAP_OPEN  = 1500;

/* A Worker driven by a Cron Trigger is stopped at fifteen minutes. Forty
   tickers at 26 seconds is over seventeen, so a keyed collection was being
   killed part-way — and since the snapshot was only written at the very end,
   a killed run stored nothing at all. Every cron then started the same doomed
   pass again and the app was served the same old snapshot for ever.
   Two changes fix that: stop while there is still room to write, and write as
   we go. What a budgeted run does not reach keeps its earlier timestamp, so
   the next slot picks it up first and the app fetches it directly meanwhile. */
const RUN_BUDGET_MS = 12 * 60 * 1000;
const WRITE_EVERY   = 5;

const SLOT_KEYS = SLOTS.map(s => s.key);

// Whatever has waited longest goes first, so a run that cannot reach the whole
// list rotates through it across slots instead of retreading the same head.
function collectOrder(tickers, quotes) {
  const stamp = tk => {
    const q = quotes[tk] || {};
    const t = [q.asOf, q.errorAt].map(v => (v ? Date.parse(v) : NaN)).filter(n => isFinite(n));
    return t.length ? Math.max(...t) : null;
  };
  return tickers
    .map((tk, i) => ({ tk, i, at: stamp(tk) }))
    .sort((a, b) => {
      if (a.at == null || b.at == null) return (a.at == null ? 0 : 1) - (b.at == null ? 0 : 1) || a.i - b.i;
      return a.at - b.at || a.i - b.i;
    })
    .map(x => x.tk);
}

async function collect(env, force) {
  if (!env?.QUOTES) return { skipped: 'no KV namespace bound' };

  const m     = marketNow();
  const prev  = await env.QUOTES.get(SNAP_KEY, 'json') || {};
  const state = { date: prev.date, runs: prev.runs };
  const due   = force ? [{ key: 'manual' }] : dueSlots(state, m);
  if (!due.length) return { skipped: 'nothing due' };

  const tickers = (await env.QUOTES.get(WATCH_KEY, 'json')) || [];
  if (!tickers.length) return { skipped: 'watchlist empty' };

  const quotes = { ...(prev.quotes || {}) };
  const runs   = [...new Set(
    (prev.date === m.date ? (prev.runs || []) : []).concat(due.map(s => s.key))
  )].filter(k => SLOT_KEYS.includes(k));

  const save = () => env.QUOTES.put(SNAP_KEY, JSON.stringify({
    date: m.date, runs, updated: new Date().toISOString(),
    premarket: isPremarket(m), quotes
  }));

  /* Claim the slot before collecting, not after. The cron fires every five
     minutes and a collection runs for longer than that, so a slot left unclaimed
     has the next firing start a second pass over the same tickers alongside the
     first — two runs racing to write one snapshot, and on a keyed account both
     of them rate limited. */
  await save();

  const gap      = env?.MASSIVE_KEY ? GAP_KEYED : GAP_OPEN;
  const deadline = Date.now() + RUN_BUDGET_MS;
  const order    = collectOrder(tickers.slice(0, MAX_WATCH), quotes);
  let done = 0;
  for (const tk of order) {
    if (done && Date.now() + gap > deadline) break;
    if (done) await new Promise(r => setTimeout(r, gap));
    try {
      quotes[tk] = { ...(await collectTicker(tk, env)), asOf: new Date().toISOString(), premarket: isPremarket(m) };
    } catch (e) {
      const kept = quotes[tk] || {};
      quotes[tk] = { ...kept, error: String(e.message || e).slice(0, 200), errorAt: new Date().toISOString() };
    }
    done++;
    if (done % WRITE_EVERY === 0) await save();
  }

  await save();
  return { collected: done, of: order.length, slots: due.map(s => s.key) };
}

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

    const reqUrl = new URL(request.url);

    /* ── Collected snapshot ──
       Everything the app needs in one request, however long ago the phone
       was last open. Absent a KV binding this says so plainly rather than
       failing in a way that looks like a network problem. */
    if (reqUrl.pathname === '/snapshot') {
      if (!env?.QUOTES) return fail(501, 'no KV namespace bound — scheduled collection is not set up', cors);
      const snap = await env.QUOTES.get(SNAP_KEY, 'json');
      if (!snap) return jsonResponse({ updated: null, quotes: {} }, 200, cors);
      return jsonResponse(snap, 200, cors);
    }

    /* The Worker collects on a schedule, so it has to be told what to watch.
       A GET keeps it a simple request with no preflight; the origin lock is
       what stops anyone else rewriting the list. */
    if (reqUrl.pathname === '/watch') {
      if (!env?.QUOTES) return fail(501, 'no KV namespace bound', cors);
      const raw = (reqUrl.searchParams.get('set') || '').toUpperCase();
      const list = raw.split(',').map(s => s.trim())
        .filter(s => /^[A-Z.]{1,6}$/.test(s)).slice(0, MAX_WATCH);
      const seen = [...new Set(list)];
      await env.QUOTES.put(WATCH_KEY, JSON.stringify(seen));
      return jsonResponse({ watching: seen }, 200, cors);
    }

    // Collect on demand — the app's Refresh button, and a way to test the
    // whole path without waiting for a cron.
    if (reqUrl.pathname === '/collect') {
      return jsonResponse(await collect(env, true), 200, cors);
    }

    const target = reqUrl.searchParams.get('url');
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
  },

  /* Cron. wrangler.toml fires this every few minutes across the session; the
     due check decides whether anything actually happens, which keeps the
     schedule on New York time without needing two sets of UTC triggers to
     cover daylight saving. A collection takes minutes, so it is handed to
     waitUntil rather than awaited. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env, false));
  }
};
