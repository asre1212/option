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
- **History & Analysis** — realized P&L, capital-weighted annualized ROI, win rate,
  average holding period, month-by-month performance, and breakdowns by term
  written, ticker and type.
- **ROI Calculator** — single-leg calculator plus a VS mode to compare two candidate
  trades side by side.
- **Scan** — OCR brokerage screenshots (Tesseract.js, in-browser) into pre-filled
  trade cards for review before saving.
- **Batch entry** — bulk-enter historic trades that were never logged, either as
  quick rows or pasted straight from a spreadsheet. See below.
- **Backup** — export/import JSON backups (validated on import), Excel export
  (SheetJS), and a reminder banner when your last backup is over 30 days old.
- **Offline** — installable and fully usable with no connection. See below.
- **Expiry reminders** — an opt-in notification when something is within 5 days of
  expiring, raised when you open or return to the app.

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

## Analysis

Beyond month-by-month totals, the Analysis tab answers what actually works and what
is actually at risk:

- **Win rate and average holding period** alongside realized P&L and monthly ROI.
- **Breakdowns** by term written (0–7d / 8–21d / 22–45d / 46d+), by ticker, and by
  type — each with win rate, P&L and capital-weighted annualized ROI, so patterns
  like "45-day trades beat weeklies" become visible.
- **Concentration** — capital at risk per ticker, with a warning when one name is
  40% or more of the book.
- **Assignment obligation** — the cash needed if every open put is assigned.
- **Capital efficiency** — open positions ranked by annualized return, weakest
  flagged, which is the one to close or roll first.

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
ROI calculator, analysis, and JSON export/import.

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
