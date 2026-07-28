# Options Tracker

A single-page, offline-capable PWA for tracking options trades — selling puts and
covered calls, rolling positions, and measuring annualized returns. All data lives
in your browser's localStorage; nothing is sent to a server.

## Features

- **Portfolio** — active positions with strike, premium, contracts, live days-to-expiry
  (highlighted red when ≤ 5 days), income, and annualized ROI.
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
