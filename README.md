# Options Tracker

A single-page, offline-capable PWA for tracking options trades — selling puts and
covered calls, rolling positions, and measuring annualized returns. All data lives
in your browser's localStorage; nothing is sent to a server.

## Features

- **Portfolio** — active positions with strike, premium, contracts, live days-to-expiry
  (highlighted red when ≤ 5 days), income, and annualized ROI. The headline realized
  P&L figure is **year to date**, with the all-time total on the line beneath it.
- **Roll tracking** — roll a position to a new strike/expiration; premiums and DTE
  accumulate and the full roll history stays on the card.
- **History & Analysis** — realized P&L, capital-weighted annualized ROI, and
  month-by-month performance.
- **ROI Calculator** — single-leg calculator plus a VS mode to compare two candidate
  trades side by side.
- **Scan** — OCR brokerage screenshots (Tesseract.js, in-browser) into pre-filled
  trade cards for review before saving.
- **Batch entry** — bulk-enter historic trades that were never logged, either as
  quick rows or pasted straight from a spreadsheet. See below.
- **Backup** — export/import JSON backups (validated on import), Excel export
  (SheetJS), and a reminder banner when your last backup is over 30 days old.
- **Offline** — installable and fully usable with no connection. See below.

## ROI formula

Per-trade annualized ROI at execution:

```
ROI% = (365 / DTE) × (premium / strike) × 100
```

Aggregate ROI (history, analysis, weighted averages) is **capital-day weighted**:
each trade counts by the dollars it committed for the days it was open:

```
ROI% = 365 × Σ profit / Σ (strike × 100 × contracts × days open) × 100
```

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
`active`, `expired` (assignment counts here — the premium is kept either way) or
`closed`; leave it blank and it is inferred from whether the expiration has passed.
Close price and close date apply only to positions bought back early.

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
