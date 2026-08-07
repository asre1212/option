# Options Tracker

A single-page, offline-capable PWA for tracking options trades — selling puts and
covered calls, rolling positions, and measuring annualized returns. All data lives
in your browser's localStorage; nothing is sent to a server.

## Features

- **Portfolio** — active positions with strike, premium, contracts, live days-to-expiry
  (highlighted red when ≤ 5 days), income, and annualized ROI. The headline realized
  P&L figure is **year to date**, with the all-time total on the line beneath it.
  Each card carries the buy-back price below which closing now beats holding.
- **The wheel** — assignment creates a share lot; covered calls written against it
  lower its basis; called away or sold closes the cycle. See below.
- **Decision support** — close-early breakeven per position, roll-vs-close verdict,
  capital efficiency ranking, and concentration/assignment risk.
- **Roll tracking** — roll a position to a new strike/expiration; premiums accumulate,
  the full roll history stays on the card, and the roll sheet says whether the new leg
  alone beats your realized average.
- **Watchlist** — tickers and ETFs you are thinking about, each showing price, the
  day's move, and what a put is paying 5% and 10% out of the money at ~45 days,
  with the annualized ROI. Refreshed through the session, 9:31 am to just before
  the close, ET. See below.
- **Analysis** — realized P&L, capital-weighted annualized ROI, win rate, average
  holding period, month-by-month performance with every closed position and what
  it earned, and breakdowns by term written, ticker and type.
- **ROI Calculator** — single-leg calculator plus a VS mode to compare two candidate
  trades side by side.
- **Scan** — OCR brokerage screenshots (Tesseract.js, in-browser) into pre-filled
  trade cards for review before saving.
- **Batch entry** — bulk-enter historic trades that were never logged, either as
  quick rows or pasted straight from a spreadsheet. See below.
- **Backup** — export/import JSON backups (validated on import; watchlist and its notes
  included), Excel export (SheetJS), and a reminder banner when your last backup is over
  30 days old.
- **Offline** — installable and fully usable with no connection. See below.
- **Expiry reminders** — an opt-in notification when something is within 5 days of
  expiring, raised when you open or return to the app. The same permission carries the
  watchlist's target-yield alert.

## The wheel

Selling a put and being assigned is not the end of the trade — it is the middle of
one. The app models the whole cycle:

1. **Sell a put.** Capital committed is `strike × 100 × contracts`.
2. **Assigned** (the *Assign* action). The option keeps its premium and a **share
   lot** takes over the capital, at the strike you were put.
3. **Sell calls against the lot.** A call linked to a lot is measured against what
   those shares cost, and adds no capital of its own — the lot already carries it.
4. **Called away or sold.** The lot closes and the cycle's return is settled.

A lot always shows its **net basis** — cost less every premium the lot has earned —
which is the price the stock has to reach for the cycle to break even. Premiums stay
counted on the option legs and the lot carries only the stock gain or loss, so
nothing is counted twice.

## ROI formula

Per-trade annualized ROI at execution:

```
ROI% = (365 / DTE) × (premium / strike) × 100
```

Aggregate ROI (history, analysis, weighted averages) is **capital-day weighted**:
each trade counts by the dollars it committed for the days it was actually open:

```
ROI% = 365 × Σ profit / Σ (capital × days held) × 100
```

Three things this gets right that are easy to get wrong:

- **Days held is measured, not summed.** A roll's term starts on the roll date, so
  adding the terms together double-counts the unexpired remainder of the old
  contract — a 35-day put rolled with 5 days left into a 30-day contract ran for 60
  days, not 65. Days are always the calendar span from open to close.
- **Covered calls do not commit their own capital.** The shares do. Counting both
  the lot and the call written against it would double the denominator and halve
  the measured return.
- **Share lots are measured the same way as options**, so a wheel cycle and a plain
  put are directly comparable.

## Close-early breakeven

Holding to expiry earns the remaining premium at a steady pace. Closing early ends
the trade sooner and frees the capital, so the same premium is earned over fewer
days. The two break even at:

```
buy-back price = total premium × (days remaining / total span)
```

Below that price, closing now annualizes better than holding — the general form of
the "take profit at 50%" rule, computed from your actual dates. Every open position
shows its own threshold.

That version assumes the freed capital does nothing. When the watchlist holds a
candidate paying more than a position is making, the price worth paying to get out
rises by whatever the capital would earn there instead:

```
buy-back price = premium × (remaining / span)  +  strike × altROI × (remaining / 365)
```

Capital per share is the strike, so both terms are per share and directly comparable
to a quoted option price. With `altROI = 0` it collapses back to the line above. Open
position cards show the second figure whenever there is a better candidate on the
watchlist, and the Watchlist tab ranks which positions are worth closing to fund it.

## Watchlist

Tickers you are considering, not ones you hold. **+** adds one. Each card carries the
current price, the day's percentage move, and two put candidates — the strikes nearest
5% and 10% below spot at the listed expiration closest to 45 days out — with premium
and annualized ROI. **Log** turns either one into a pre-filled new trade, and **remove**
offers an undo, since it sits under the floating add button.

Three controls sit under the schedule line:

- **sort** — the order you added them in, or best annualized yield first. Cards with no
  quote to rank sink to the bottom rather than shuffling as quotes arrive.
- **target** — an annualized yield worth being told about. Cards at or above it are
  marked, and if expiry reminders are switched on, a scheduled update notifies you when
  something crosses it: once a day, and only for tickers that were not already above
  the line at the previous run. A stale quote never counts as clearing it.
- **source** — the data provider, API key and relay route, described below.

**edit** on a card opens a per-ticker sheet holding a free-text **note** ("earnings
8/12", "wait for $210") shown on the card, and the manual quote fields. The note saves
on its own; the quote is only written when a price is actually typed, so editing a note
never overwrites a good fetched quote with a hand one. Notes travel in a JSON backup
alongside the watchlist itself; on a merge import, a note already on the device wins.

- **Expiration** — the listed expiry closest to 45 days, preferring one inside ±7
  days. When the chain has nothing in that window the closest available is used and
  the card says so. On an exact tie the shorter term wins.
- **Strike** — the nearest strike *at or below* the target, so a leg is never less
  out of the money than asked for. The actual distance is printed under the strike.
- **Premium** — the mid of bid/ask when both sides are quoted, otherwise the bid,
  otherwise the last trade. The card always says which, because a last trade on an
  illiquid strike can be days old.
- **ROI** — `(365 / DTE) × (premium / strike)`, the same formula used everywhere else
  in the app, so a candidate and a position you hold are directly comparable.

### Where the quotes come from

**Massive** (formerly Polygon.io) is the intended source — the only one here that is a
data product rather than a public endpoint read sideways. Its **Options Basic** plan is
free, needs no card, and gives 15-minute delayed chains at 5 requests a minute, which
is ample for two updates a day. Paste the key into *Watchlist → source*. It matters
structurally as well as legally: the key travels as a query parameter, so the request
stays a simple GET with no preflight — the shape most likely to survive the browser's
cross-origin rules with no relay at all.

Two calls per ticker: the chain snapshot, filtered server-side to expirations near 45
days, and the previous close, which is what turns a price into the day's move. With a
key set the refresh slows to one symbol every 26 seconds to stay inside the free
allowance; losing the previous-close call costs only the percentage change.

Without a key it falls back to scraping public endpoints — Cboe's delayed-quote CDN,
then Yahoo Finance, then Yahoo's chart endpoint for a price alone. These usually refuse
a browser outright (see below).

The last good answer for each ticker is kept in `localStorage`, so the tab is never
blank, works offline, and shows the time each quote was taken. A failed refresh keeps
the previous quote and records why it failed rather than blanking the card.

In practice the feeds usually **refuse a browser outright**. A page may only read
another site's data when that site sends an `Access-Control-Allow-Origin` header, and
these do not, so the request fails before it leaves the device — *"Load failed"* in
Safari, *"Failed to fetch"* elsewhere. All three providers failing with the same
message is the signature: the feeds never saw the request, so nothing was down and no
retry can help.

**source** (under the schedule line) opens the Quote Source sheet, which offers Direct,
two public relays, or a custom URL, and a **Test This Route** button that asks every
provider for AAPL through the selected route and prints what each one answered. Which
route works depends on the network and public relays come and go, so the app finds out
by trying rather than assuming. Testing never changes the saved route, even if it
throws.

The durable answer is your own relay: **`quote-relay-worker.js`** is a Cloudflare Worker
that runs on the free tier, deploys by pasting one file, and takes only the quote-feed
hosts as targets so it cannot be used as an open proxy. Its URL goes in *Custom*.

**Better still, don't hold the key at all.** Set `MASSIVE_KEY` as a secret on your own
Worker (*Settings → Variables and Secrets → Secret*) and tick **my relay holds the key**
in the app. The key is attached at the edge on the way out, so it is never on the phone,
never in `localStorage`, and never in a URL anything could log. A Cloudflare secret is
write-only — replaceable, but not readable back out of the dashboard. With the key held
this way the direct route is skipped rather than sent unauthenticated, and the relay
answers `401` with an explanation if the secret is missing.

**A public relay never carries the Massive key.** A relay sees the whole URL, and for
Massive the key is in the URL; a leaked key is spendable by whoever reads it. So when
the configured relay is one of the built-in public ones, Massive is skipped on the relay
pass entirely and says so, rather than quietly handing a credential to a stranger. Your
own relay is exempt — that is what *Custom* is for.

Failing all that, **edit** on any card takes the price, expiration and two premiums typed
straight off your broker, deriving the strikes and the ROI from them — that path needs
no network at all.

Nothing here is a fill. Delayed mid prices are a starting point for deciding what to
look at, not what you will get.

### Refresh schedule

Four times through the session, on New York time: **9:31 am** — a minute after the
open, so the first prints have happened — then **12:00 pm**, **2:30 pm** and **3:58 pm**.
The last sits closer to the bell than to the one before it on purpose: an evening
glance at the watchlist should show closing prices, not mid-afternoon ones. Weekends
are skipped; market holidays are not modelled, so a holiday simply carries the
previous close forward.

A page with no server can only act while it is open, so rather than relying on a
timer alone, every entry point — launch, returning to the app, coming back online,
and a one-minute tick while open — asks the same question: has a slot for today gone
by without a run? Opening the app in the afternoon catches up the most recent slot
rather than replaying both.

Requests are deliberately spread out. Each run starts a stable random 0–4 minutes
after its slot time, so two devices running this do not hit the same feed on the same
second, and symbols are fetched one at a time with a 9–12 second gap between them.
A manual **Refresh** uses a short gap instead, and a feed answering 429 backs the
whole ticker off once before the remaining providers are tried.

## Analysis

Everything about closed trades lives here — there is no separate History tab. Beyond
month-by-month totals, the Analysis tab answers what actually works and what is
actually at risk:

- **Realized P&L** with the year-to-date figure alongside it, and **monthly ROI**
  with the annualized rate beneath it.
- **Every closed position**, under the month it closed in, carrying what it was
  written for, total premiums (and any buy-back), days the capital was tied up,
  rolls, and what that annualized to — for a share lot, the stock move, the premiums
  that lowered its basis, and the cycle ROI.
- **Win rate and average holding period** alongside realized P&L and monthly ROI.
- **Breakdowns** by term written (0–7d / 8–21d / 22–45d / 46d+), by ticker, and by
  type — each with win rate, P&L and capital-weighted annualized ROI, so patterns
  like "45-day trades beat weeklies" become visible.
- **Concentration** — capital at risk per ticker, with a warning when one name is
  40% or more of the book.
- **Assignment obligation** — the cash needed if every open put is assigned.
- **Capital efficiency** — open positions ranked by annualized return, weakest
  flagged, which is the one to close or roll first. The Watchlist tab takes this one
  step further and prices the switch against a live candidate.

## Number formatting

Every figure the app renders goes through one set of helpers in `app.js`, so the
same value reads the same way on every screen:

| Kind | Format | Example |
|---|---|---|
| Money — strikes, premiums, income, committed capital | grouped, always 2 dp | `$100,000.00` |
| P&L — anything that can be a profit or a loss | as above, with a sign | `+$1,234.56` / `-$1,234.56` |
| Percentages — every ROI | grouped, always 2 dp | `12.35%` |
| Counts — days, contracts, trades | grouped integer | `1,095d` |

Grouping is pinned to `en-US` rather than the device locale, because the `$` is
hardcoded — a phone that groups with dots would otherwise render ten thousand
dollars as `$10.000`. Rounding happens before the sign is chosen, so a value like
`-0.001` shows as `+$0.00` rather than `-$0.00`. The Excel export carries matching
number formats (`#,##0.00`) on its numeric columns, so a downloaded workbook reads
the same way as the app.

## Offline

Trades live in `localStorage` and the service worker keeps a copy of the app itself,
so once the page has been opened online a single time everything core keeps working
with no connection — viewing and adding trades, rolling, closing, batch entry, the
ROI calculator, analysis, and JSON export/import. The watchlist keeps showing the
last quotes it fetched, stamped with when they were taken.

Two caches back this:

- **App shell** (`index.html`, `app.js`, manifest, icon) — precached on install and
  refreshed network-first, so a deploy shows up on the next online load.
- **Third-party assets** (webfont, SheetJS, Tesseract.js) — cache-first in a separate
  runtime cache, from an explicit host allowlist. Each is stored the first time it is
  fetched successfully and replayed from then on, so typography survives offline and
  Excel export and screenshot scanning keep working once they have been run once.
  Anything outside the allowlist is never intercepted, and a failed fetch is passed
  through untouched rather than answered with a fabricated response.

A header pill marks the app as offline, the Scan tab explains what is limited while
disconnected, and **Update App** declines to run offline rather than clearing the
cache it is currently running from.

## Batch entry (historic trades)

*Scan → Historic Trades → Batch Entry*, or the link at the bottom of the New Trade
sheet. Two ways in, both ending at the same preview → confirm step:

- **Quick rows** — one card per trade; each new row inherits the previous row's
  dates so a batch from the same period is quick to fill.
- **Paste / CSV** — one trade per line, comma- or tab-separated, so a spreadsheet
  selection can be pasted directly. A `.csv` file can be loaded instead.

Columns, in positional order:

```
Ticker, Type, Strike, Premium, Contracts, Opened, Expiry, Outcome, Close Price, Close Date
```

A header row is optional; when present, columns may appear in any order and common
aliases are recognised (`Symbol`, `Credit`, `Quantity`, `Expiration`, `Buy Price`, …).
Dates read as `2026-02-20`, `2/20/2026` (US order) or `Feb 20 2026`. `Outcome` is
`active`, `expired`, `assigned` or `closed`; leave it blank and it is inferred from
whether the expiration has passed. An assigned put also creates the share lot it
handed you, so an old wheel cycle can be closed out from the portfolio. Close price
and close date apply only to positions bought back early.

Everything is derived from the dates entered rather than from today, so DTE, ROI,
days held and P&L land the same as if the trade had been tracked live. The preview
lists each entry with its computed P&L and ROI, flags unusable rows with the reason,
and imports only the valid ones — problem entries stay behind to be fixed. A single
**Undo** removes the whole batch just committed.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app (markup + styles) |
| `app.js` | All application logic |
| `service-worker.js` | Network-first caching for offline use |
| `manifest.json` | PWA manifest (install, shortcuts) |
| `icon.svg` | App icon |
| `options-tracker.html` | Redirect stub kept for old bookmarks / previously installed PWAs |
| `quote-relay-worker.js` | Optional Cloudflare Worker that relays the quote feeds past CORS. Not part of the app; deploy it only if you want your own route. |

## Deploying

Any static host works — GitHub Pages included. Serve the repo root; the app is
`index.html`. On iOS, open the page in Safari and use *Share → Add to Home Screen*
to install it as an app.

## Development notes

- No build step; edit `index.html` / `app.js` directly.
- The service worker is network-first, so deploys show up on next load with a
  network connection. The in-app **Update App** button clears the cache explicitly.
- External dependencies (Tesseract.js for OCR, SheetJS for Excel export) are
  lazy-loaded from CDNs at pinned versions and only when those features are used.
