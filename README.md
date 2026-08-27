# Options Tracker

A single-page, offline-capable PWA for tracking options trades — selling puts and
covered calls, rolling positions, and measuring annualized returns. All data lives
in your browser's localStorage; nothing is sent to a server.

## Features

- **Portfolio** — active positions with strike, premium, contracts, live days-to-expiry
  (highlighted red when ≤ 5 days), income, and annualized ROI. The headline realized
  P&L figure is **year to date**, with the all-time total on the line beneath it.
  Each card carries the stock behind the contract: what it was trading at when the
  contract was written, where it is now, and the move since — as a percentage, per share
  and across the shares the contract covers. Same for a share lot, measured from its cost
  basis. See below.
- **The wheel** — assignment creates a share lot; covered calls written against it
  lower its basis; called away or sold closes the cycle. See below.
- **Decision support** — close-early breakeven and the roll-vs-switch price on the
  Watchlist tab, roll-vs-close verdict on the roll sheet, capital efficiency ranking,
  and concentration/assignment risk in Analysis. None of it on the position cards.
- **Roll tracking** — roll a position to a new strike/expiration; premiums accumulate,
  the full roll history stays on the card, and the roll sheet says whether the new leg
  alone beats your realized average.
- **Watchlist** — tickers and ETFs you are thinking about, each showing price, the
  day's move, and what a put is paying 5% and 10% out of the money at ~45 days,
  with the annualized ROI — plus 15% and 20% on any name whose 5% leg is paying over
  50% annualized. Refreshed five times a day, premarket to the close — by the relay
  itself if you set one up, so the app need not be open. See below.
- **Analysis** — realized P&L, capital-weighted annualized ROI, win rate, average
  holding period, month-by-month performance with every closed position and what
  it earned, breakdowns by term written, ticker and type, and how far from the stock
  the contracts were written — with what each distance actually returned.
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
the "take profit at 50%" rule, computed from your actual dates.

**It is not on the position cards.** Advice on every position on every look is noise,
so the threshold is shown where it is actually being asked for: the Watchlist tab,
next to the candidate that would replace the capital.

That version assumes the freed capital does nothing. When the watchlist holds a
candidate paying more than a position is making, the price worth paying to get out
rises by whatever the capital would earn there instead:

```
buy-back price = premium × (remaining / span)  +  strike × altROI × (remaining / 365)
```

Capital per share is the strike, so both terms are per share and directly comparable
to a quoted option price. With `altROI = 0` it collapses back to the line above. The
Watchlist tab's **Close to fund it** table carries both figures side by side and ranks
which positions are worth closing to fund the best candidate on the list.

## The stock behind each contract

A strike on its own says nothing. **$200** is a careful trade on a $240 stock and a
reckless one on a $205 stock, and the difference is the only thing that decides whether a
put gets assigned. So every executed trade carries the stock as well as the contract:

- **At execution** — what the stock was trading at the day the contract was written.
- **Stock now** — the current price, with the time it was taken and which feed gave it.
- **Since opened** — the move between the two, as a percentage and in money: per share,
  and across the shares the contract covers, because the same percentage is very
  different money on one contract than on five.

Underneath, the line that matters: how far the strike sits from the stock **today**
against how far it sat **the day it was written**. A put drifting toward its strike is
the whole reason to look. A share lot gets the same three figures measured from its cost
basis, plus where the stock stands against the net basis the cycle breaks even at.

None of this is P&L. The premium is the P&L on an option; this is where the stock has
gone, which is a different question and the one that decides whether to hold, roll or
close.

### Where the price at execution comes from

It is stamped onto the trade and never recalculated — a fill is a fact about the trade,
not something to re-derive — so it travels in a JSON backup and appears in the Excel
export. Three ways in, and each card says which one it used:

- **Price when logged** — a trade entered the day it was opened takes the quote already
  on hand. A quote from an earlier day is refused rather than stamped, because last
  week's price is not this week's execution.
- **Close that day** — anything logged after the fact (a batch of historic trades, an
  OCR'd screenshot, a trade entered days late) is filled in from a daily history feed.
- **Entered by hand** — `edit` on the card, for a delisted symbol, a fill nowhere near
  the day's close, or a browser the history feed refuses. Clearing it lets the app try
  again.

The same three ways fill the **other end of the window** on a closed trade — the stock on
the day it ended — which is what *The stock instead* is measured from. It is stored
alongside as `spotAtClose`, and a window that has not ended yet is never asked about.

The backfill asks **once per ticker and date, ever**, and a date is one answer to two
questions: trades opened that day and trades that ended that day take the same daily
close, so one fetch settles all of them and a price already stamped is never asked about
again. Dates a contract was *written* on come first — that is a decision being made today
with a piece missing — and end dates, which only feed the stock comparison, wait their
turn. It runs a few at a time on launch and after each refresh rather than all at once,
and a failure is remembered for a day so a delisted symbol or a blocked feed does not turn
into a burst of requests on every load. The Analysis tab says how many are still missing
and offers **fetch now**, which ignores that memory.

History comes from Massive's daily aggregates when a key is in play and Yahoo's chart
endpoint otherwise — Cboe's delayed-quote feed has no history to offer, so it sits this
one out. Both take the same route as a quote: direct first, the relay only once every
provider has failed on its own. A trade opened on a weekend or a holiday has no bar of
its own, so the **last session at or before** the open date is used — that is the price
that was actually on the screen.

### Where the current price comes from

The same quote store the watchlist fills, so the two tabs can never disagree about where
a stock is. Held tickers are refreshed on the same schedule, through the same feeds, in
the same request; a ticker both held and watched is fetched once. When a relay is
collecting on its own schedule, the portfolio's tickers are pushed to it alongside the
watchlist, so what you hold is waiting in the snapshot too. Watched names lead the list,
since they are the ones the yield target notifies on.

A ticker that has just joined the portfolio is fetched immediately rather than waiting
for the next scheduled run. A stale quote is labelled as stale rather than dropped, and a
card with no quote yet says so — the same rule the watchlist follows.

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

### Deeper strikes on a rich name

Two legs are the strategy. A third and fourth appear only when the name is paying
enough to make standing much further from the money worth quoting:

> **When the 5% leg is annualizing more than 50%, the card also lists 15% and 20%
> out of the money.**

They sit under a band in the table's own header style carrying the number that put
them there — *"5% is paying 62.40% — over 50%"* — so a card never silently changes
shape. Everything else about the card is unchanged, and a name under the trigger looks
exactly as it always did.

The rule is a live reading, not a state. It is re-tested every refresh, when the legs
are rebuilt from the chain, and again at render, so the two rows appear the moment the
5% leg crosses 50% and are gone the moment it falls back — including on a quote that
was fetched while the name was hot. Exactly 50% is not over 50%, so the trigger needs
to be cleared, not matched.

Two deliberate details. A deep strike with no quote, or none listed that far out, is
left off rather than shown as an empty row: absence is information on a core leg and
clutter on a bonus one. And the deep legs are ranked alongside the others for the yield
target, sorting and the switch suggestion — in practice the 5% leg still wins, since
further out of the money pays less, but nothing on the tab is measured against rows the
card is not showing.

Hand-entered quotes (**edit** on a card) carry the 5% and 10% legs only. There is no
chain behind them to pick a 15% strike from, and inventing one is not what that sheet
is for.

### Where the quotes come from

One refresh covers this list and everything held in the portfolio — see *The stock behind
each contract* above — so a ticker that is both watched and held is fetched once.

**Cboe's delayed-quote CDN, through your own relay, is what actually works** — one
request returns the underlying and its whole chain, with no key, no sign-up and no
entitlement to fall short of. It refuses browsers and shared public proxies, which is
the entire reason the relay exists; from a Worker it answers normally.

**Massive** (formerly Polygon.io) is a licensed data product and is tried first when a
key is set, but its free **Options Basic** plan does **not** include option chains —
that endpoint answers `403 not entitled` without a paid tier. A key is only worth
setting if you have a paid one. Because 403 is a standing condition rather than a
passing error, the app remembers it and drops Massive from the order instead of
spending the first request of every refresh rediscovering it; changing the key or the
relay setting clears that and tries again.

Massive takes two calls per ticker — the chain snapshot, filtered server-side to
expirations near 45 days, and the previous close that turns a price into the day's move
— so with a key in play the refresh slows to one symbol every 26 seconds to stay inside
the 5-a-minute allowance. Cboe needs one call and no such pacing. Yahoo sits behind both
as a last resort, its chain endpoint now wanting a session and its chart endpoint giving
a price alone.

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
that runs on the free tier, deploys by pasting one file — or straight from this repo, via
`wrangler.toml` — and takes only the quote-feed hosts as targets so it cannot be used as
an open proxy. Its URL goes in *Custom*.

Two things that bite when setting it up. The address is
`https://<worker>.<account>.workers.dev`, and **both halves are assigned by Cloudflare** —
read it off *Domains and routes* on the Worker's Overview page rather than guessing. And
if that panel shows **workers.dev · Disabled**, enable it before anything else: until then
the hostname does not resolve, and the browser reports the server as missing rather than
as refusing, which looks like a wrong URL instead of a switched-off route.

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

Five times a day, on New York time: **6:30 am** (premarket), then **9:31 am** — a minute
after the open, so the first prints have happened — **12:00 pm**, **2:30 pm** and
**3:58 pm**. The last sits closer to the bell than to the one before it on purpose: an
evening glance at the watchlist should show closing prices, not mid-afternoon ones.
Weekends are skipped; market holidays are not modelled, so a holiday simply carries the
previous close forward.

**Premarket is a genuine half-measure, and the app says so.** Options do not trade before
9:30 — OPRA is shut — so a 6:30 collection pairs a live underlying price with *yesterday's
closing quotes* on the contracts. The strikes are picked against this morning's price but
the premiums, and every ROI built from them, are last night's. Cards from that run carry a
warning saying exactly that, and a premarket quote is barred from driving the close-early
and switch advice, where a stale premium would price a real decision wrongly.

### Collecting without the app open

A page with no server can only refresh while it is open, which is no use at 6:30 in the
morning. Given a KV namespace and the cron triggers in `wrangler.toml`, the relay collects
on this schedule by itself and the app reads the result when it opens — **one request
instead of two per ticker**, no rate-limit stagger to sit through, and data that is current
whether or not the phone was awake.

- `/watch?set=…` — the app pushes what it needs prices for whenever that changes — the
  watchlist and the tickers it holds — so the relay knows what to collect. A GET, so it
  stays a simple request; the origin lock is what keeps anyone else from rewriting it.
  The relay keeps the first 40, and watched names are sent first.
- `/snapshot` — everything, in one response.
- `/collect` — collect now, for testing the path without waiting for a cron.

The relay stores the **raw filtered chain**, not finished figures. Strike selection and
ROI stay in the app, through the same code that handles a direct fetch, so there is one
implementation of the maths rather than two that can drift apart.

The cron fires every five minutes across the hours covering the session, and the Worker
checks the real Eastern time to decide whether a slot is due — one trigger rather than a
pair for each daylight-saving offset. The slot is claimed before the collection starts,
not after it finishes: a collection runs for longer than five minutes, so an unclaimed
slot would have the next firing start a second pass over the same tickers alongside the
first.

**The relay's answer stands only where it is new.** Per ticker, and measured against what
the app already has: a price or an error the app has not seen before is the answer, and
re-asking the feeds directly would only bury a useful message like `HTTP 429` under the
CORS failures that led to using a relay at all. Anything the snapshot did not move — a
relay that has stopped collecting keeps serving the last snapshot it wrote, hour after
hour — is fetched directly instead. Without that test a stalled relay reads as a
successful refresh, retires the slot and leaves the watchlist frozen on old prices.

A Cron Trigger is stopped at fifteen minutes, so a collection stops at twelve and writes
its snapshot as it goes rather than only at the end. Whatever it does not reach keeps its
earlier timestamp, which puts it first in the next slot's run — and the app fetches it
directly in the meantime. The 26-second pause between symbols is Massive's rate limit, so
it applies only when `MASSIVE_KEY` is set; without a key the collection is Cboe's CDN at
one request per ticker and moves at a polite 1.5 seconds.

All of it is optional. With no KV namespace bound the Worker is still a plain relay, and
the app goes back to fetching for itself.

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

**Whatever has waited longest goes first.** A run is minutes long and the phone is
usually put away before it finishes — the timers stop with it — so starting at the top
of the list every time would refresh the same few names for ever while everything below
them aged. Watched names still lead, as they do in the request the relay is sent; the age
only decides the order within the watched names and within the held-only ones, so a run
cut short spends what it has on the watchlist.

A run that reaches nothing at all leaves its slot due, but waits ten minutes before
trying again. Retrying every minute for the rest of the day is how an outage turns into
a rate limit, and a rate limit is indistinguishable from prices that never update.
Reconnecting clears that wait, since regaining a network is new information.

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
- **Distance from the stock** — the average distance the contracts were written at,
  the average distance the open ones stand at now, how far the stock has moved under
  them, and how many are through their strike today. Under those, **what each distance
  returned**: closed trades bucketed by how far out they were written (in the money /
  0–2% / 2–5% / 5–10% / 10%+) with win rate, P&L and capital-weighted annualized ROI
  in distance order, so the trade-off is legible — closer to the money pays more and
  gets touched more often, and this says whether it has actually been worth it on your
  own trades. Trades with no price at execution sit out of these figures rather than
  being guessed at, and the tab says how many that is.
- **The stock instead** — see below.

### The stock instead

One aggregate, tallied over every closed contract: what the shares would have made
**bought the day the contract was written and sold the day it ended**. Same ticker, same
days — the option chose them, so there is no hindsight in the choosing, which is what
makes it a fair thing to measure the premium against.

**A hundred shares per contract**, which is what the contract itself controls, so a
two-lot counts twice and the two P&L figures sit on the same size. It is deliberately not
the same *capital*: a cash-secured put pledges the strike, buying the shares costs the
spot. Both totals are shown, and the annualized figures put each return over the money it
actually needed — which is why the dollar ranking and the annualized ranking can disagree,
and the card says so when they do.

The premium total beside it covers **exactly the same trades**, not every closed trade, so
the two numbers are comparable rather than merely adjacent.

Two things are left out on purpose:

- **Open positions.** A window that has not ended has no closing price to measure to.
- **Share lots from assignment.** They are the stock already, and their gain or loss is in
  Total Realized P&L unchanged. An assigned contract still counts here for its own window
  — from the day it was written to the day it was assigned — and the card says so.

A trade that rolled counts once, over its whole window, the same as everywhere else in the
app. A contract needs a stock price at **both** ends or it sits out, and the count says how
many made it — `4 of 5 closed contracts`. Missing ends are filled in by the same backfill
that fills the price at execution, and **fetch now** is on the card.

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
| `wrangler.toml` | Config for deploying that Worker from this repo. `name` must match the Worker in your dashboard, or a second one is created beside it. |

## Deploying

Any static host works — GitHub Pages included. Serve the repo root; the app is
`index.html`. On iOS, open the page in Safari and use *Share → Add to Home Screen*
to install it as an app.

## Development notes

- No build step; edit `index.html` / `app.js` directly.
- Trade records carry optional fields for the stock at either end of the window —
  `spotAtOpen` / `spotSource` at execution, and on a closed trade `spotAtClose` /
  `spotCloseSource` at the day it ended (both sources are `entry` / `close` / `manual`).
  Records saved before they existed are valid without them and get filled in by the
  backfill; nothing in the app treats their absence as an error.
- The service worker is network-first, so deploys show up on next load with a
  network connection. The in-app **Update App** button clears the cache explicitly.
- External dependencies (Tesseract.js for OCR, SheetJS for Excel export) are
  lazy-loaded from CDNs at pinned versions and only when those features are used.
