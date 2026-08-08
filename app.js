/* ═══════════════════════════════════════
   DATA LAYER
═══════════════════════════════════════ */
const KEY = 'opts_v2';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {trades:[]} } catch(e) { return {trades:[]} } };
const save = d => localStorage.setItem(KEY, JSON.stringify(d));
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const todayStr = () => new Date().toISOString().split('T')[0];

// Escape a value before interpolating it into innerHTML
const esc = v => String(v ?? '').replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const TICKER_RE = /^[A-Z.]{1,6}$/;
const DATE_RE   = /^\d{4}-\d{2}-\d{2}$/;

// Contracts per trade; trades saved before the qty field existed count as 1
const tradeQty = t => Math.max(1, parseInt(t.qty) || 1);

/* ═══════════════════════════════════════
   NUMBER FORMATTING
   Every figure in the app is rendered through these, so the same value
   reads the same way everywhere: grouped thousands, two decimals for
   money and for percentages.
   Grouping is pinned to en-US rather than the device locale because the
   "$" is hardcoded — a phone that groups with dots would otherwise show
   ten thousand dollars as "$10.000".
═══════════════════════════════════════ */
const numOr0 = v => { const n = Number(v); return isFinite(n) ? n : 0; };

const fmtNum = (v, dp = 2) =>
  numOr0(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

// $1,234.56 — an amount with no direction of its own
const fmtMoney  = v => '$' + fmtNum(Math.abs(numOr0(v)));
// +$1,234.56 / -$1,234.56 — anything that can be a profit or a loss.
// Rounds before choosing the sign so -0.001 never renders as "-$0.00".
const fmtSigned = v => {
  const r = Math.round(numOr0(v) * 100) / 100;
  return (r < 0 ? '-$' : '+$') + fmtNum(Math.abs(r));
};
// 12.04%
const fmtPct    = v => fmtNum(v) + '%';
// Whole counts — days, contracts, trades
const fmtInt    = v => Math.round(numOr0(v)).toLocaleString('en-US');

/* ═══════════════════════════════════════
   DATE HELPERS
═══════════════════════════════════════ */
// Whole days from a to b (negative when b precedes a)
function daysBetween(aISO, bISO) {
  return Math.round((new Date(bISO + 'T00:00:00') - new Date(aISO + 'T00:00:00')) / 86400000);
}
const dateOffset = n => {
  const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
};

/* ═══════════════════════════════════════
   CALCULATIONS
═══════════════════════════════════════ */
// ROI% = (365/DTE) × (premium×100 / strike) — which equals (365/DTE)×(premium/strike)×100
function roiPct(premPerShare, strike, dte) {
  if (!strike || !dte || dte <= 0 || premPerShare == null || isNaN(premPerShare)) return 0;
  return (365 / dte) * (premPerShare / strike) * 100;
}

function totalPremiums(t) {
  return t.premium + (t.rolls||[]).reduce((s,r) => s + r.premium, 0);
}
// Sum of the contract terms written. NOT the days the capital was tied up —
// a roll's term starts on the roll date, so the unexpired remainder of the
// old contract is inside both terms. Use actualDays() for anything
// annualized; this is only for showing how much time was bought in total.
function termDaysWritten(t) {
  return t.dteAtExecution + (t.rolls||[]).reduce((s,r) => s + r.dte, 0);
}
function currentStrike(t) {
  const r = t.rolls;
  return (r && r.length) ? r[r.length-1].strikePrice : t.strikePrice;
}
function currentExpDate(t) {
  const r = t.rolls;
  if (r && r.length) {
    const last = r[r.length-1];
    if (last.expDate) return last.expDate;
    // legacy rolls without expDate: dateRolled + roll DTE
    const base = new Date((last.dateRolled || t.dateOpened) + 'T00:00:00');
    base.setDate(base.getDate() + (parseInt(last.dte) || 0));
    return base.toISOString().split('T')[0];
  }
  if (t.expDate) return t.expDate;
  // legacy trades without expDate: dateOpened + DTE at execution
  const base = new Date(t.dateOpened + 'T00:00:00');
  base.setDate(base.getDate() + (parseInt(t.dteAtExecution) || 0));
  return base.toISOString().split('T')[0];
}
function daysRemaining(t) {
  const exp = new Date(currentExpDate(t) + 'T00:00:00');
  const today0 = new Date(); today0.setHours(0,0,0,0);
  return Math.ceil((exp - today0) / 86400000);
}
// An option leg keeps its premium whether it expires worthless or is
// assigned. When it is assigned the share side of the trade moves into a
// position (see below) — that is where the stock gain or loss lives, so
// counting it here too would double it.
function tradePnL(t) {
  const q = tradeQty(t);
  if (t.status === 'expired' || t.status === 'assigned') return totalPremiums(t) * 100 * q;
  if (t.status === 'closed_early') return (totalPremiums(t) - (t.closeInfo?.buyingPrice||0)) * 100 * q;
  return 0;
}

// The day a position stopped tying up capital
function tradeEndDate(t) {
  if (t.status !== 'active' && t.closeInfo?.dateClosed) return t.closeInfo.dateClosed;
  return currentExpDate(t);
}
// Calendar days the capital was actually committed: open date → the day it
// ended. Measured, not summed, so rolling does not inflate it.
function actualDays(t) {
  return Math.max(1, daysBetween(t.dateOpened, tradeEndDate(t)));
}

// Dollars a trade ties up. A cash-secured put pledges strike × 100 × qty.
// A covered call written against shares you already hold adds no capital of
// its own — the share lot carries it, and counting both would halve the
// return on that capital. An uncovered call falls back to its strike.
function tradeCapital(t) {
  if (t.type === 'call' && t.positionId) return 0;
  return currentStrike(t) * 100 * tradeQty(t);
}

/* ── Share positions (the wheel) ──
   A put assignment hands you shares. Those shares tie up capital until
   they are called away or sold, and every premium collected along the way
   lowers what they effectively cost. Premiums stay counted on the option
   legs; a position carries only the stock gain or loss, so nothing is
   counted twice. */
const loadPositions = d => (d || load()).positions || [];

// Premiums collected by the put that created the lot plus every call
// written against it. Derived rather than stored, so it cannot drift.
function positionPremiums(p, trades) {
  return (trades || load().trades)
    .filter(t => t.positionId === p.id || t.id === p.sourceTradeId)
    .reduce((s, t) => s + totalPremiums(t) * 100 * tradeQty(t), 0);
}
// What the shares really cost you once premiums are netted off — the price
// the stock has to reach for the whole cycle to break even.
function positionNetBasis(p, trades) {
  return p.shares > 0 ? p.costBasis - positionPremiums(p, trades) / p.shares : p.costBasis;
}
// Stock side only; premiums are already counted on the option legs
function positionStockPnL(p) {
  if (p.status !== 'closed') return 0;
  return ((p.closeInfo?.pricePerShare || 0) - p.costBasis) * p.shares;
}
function positionCapital(p) { return p.costBasis * p.shares; }
function positionDays(p) {
  const end = p.status === 'closed' ? (p.closeInfo?.dateClosed || todayStr()) : todayStr();
  return Math.max(1, daysBetween(p.dateAcquired, end));
}
// Whole-cycle profit: the stock move plus every premium the lot earned
function positionCyclePnL(p, trades) {
  return positionStockPnL(p) + positionPremiums(p, trades);
}

/* ── Realized performance ──
   Options and share lots are measured the same way — profit over the
   capital-days that produced it — so they can be pooled into one number. */
function realizedItems(d) {
  d = d || load();
  const items = d.trades.filter(t => t.status !== 'active').map(t => ({
    kind: 'option', ref: t, ticker: t.ticker,
    pnl: tradePnL(t), capital: tradeCapital(t), days: actualDays(t),
    date: t.closeInfo?.dateClosed || t.dateOpened
  }));
  loadPositions(d).filter(p => p.status === 'closed').forEach(p => items.push({
    kind: 'shares', ref: p, ticker: p.ticker,
    pnl: positionStockPnL(p), capital: positionCapital(p), days: positionDays(p),
    date: p.closeInfo?.dateClosed || p.dateAcquired
  }));
  return items;
}

function itemsROI(items) {
  const pnl     = items.reduce((s,i) => s + i.pnl, 0);
  const capDays = items.reduce((s,i) => s + i.capital * i.days, 0);
  return capDays > 0 ? (pnl / capDays) * 365 * 100 : 0;
}

// Annualized return weighted by capital-days, for a plain list of trades
function annualizedROI(trades) {
  return itemsROI(trades.map(t => ({
    pnl: tradePnL(t), capital: tradeCapital(t), days: actualDays(t)
  })));
}

// Realized P&L booked in the current calendar year — counted in the year
// the position closed (falling back to when it opened for legacy records).
function ytdPnL(items) {
  const yr = String(new Date().getFullYear());
  return items
    .filter(i => String(i.date || '').slice(0, 4) === yr)
    .reduce((s, i) => s + i.pnl, 0);
}

function weightedStats() {
  const items = realizedItems();
  if (!items.length) return { roi:0, monthly:0, pnl:0 };
  const pnl = items.reduce((s,i) => s + i.pnl, 0);
  const roi = itemsROI(items);
  return { roi, monthly: roi / 12, pnl };
}

/* ── Decision support ──
   Holding to expiry earns the remaining premium at a fixed pace. Closing
   now ends the trade early and frees the capital, so the same premium is
   earned over fewer days. Below this buy-back price, closing now beats
   holding on an annualized basis:  breakeven = premium × remaining/span. */
function closeEarlyBreakeven(t) {
  const span = Math.max(1, daysBetween(t.dateOpened, currentExpDate(t)));
  const left = Math.max(0, daysBetween(todayStr(), currentExpDate(t)));
  return { price: totalPremiums(t) * (left / span), span, left, elapsed: span - left };
}

/* The rate an open position is running at, and the one number every "should I
   close this?" comparison is made against. A plain position keeps the rate it
   was written at; once rolled, the accumulated premium is measured over the
   real span from opening to the current expiration. Both the card and the
   watchlist's suggestions read this, so they can never disagree. */
function positionRate(t) {
  if (t.rolls && t.rolls.length) {
    const span = Math.max(1, daysBetween(t.dateOpened, currentExpDate(t)));
    return roiPct(totalPremiums(t), currentStrike(t), span);
  }
  return numOr0(t.roiAtExecution);
}

/* The same question with somewhere to put the money. Holding to expiry earns
   the remaining premium and nothing else; closing frees the capital, which
   can then earn altROI annualized for the days that were left. So the price
   worth paying to get out rises by what that capital would make elsewhere:

     buy-back price = premium × remaining/span  +  strike × altROI × remaining/365

   Capital per share is the strike, so both terms are per share and comparable
   to a quoted option price. With altROI = 0 this is closeEarlyBreakeven(). */
function switchBreakeven(t, altROI) {
  const be  = closeEarlyBreakeven(t);
  const alt = currentStrike(t) * (numOr0(altROI) / 100) * (be.left / 365);
  return { ...be, alt, altPrice: be.price + alt };
}

/* ═══════════════════════════════════════
   UI STATE
═══════════════════════════════════════ */
let addType  = 'put';
let calcTypeVal = 'put';

/* ═══════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════ */
let currentTab = 'portfolio';

// Tabs with an add button of their own, and what it opens
const FAB_TABS = { portfolio: openAddModal, watch: openWatchAdd };

function fabAction() { (FAB_TABS[currentTab] || openAddModal)(); }

function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('n-' + tab).classList.add('active');
  currentTab = tab;
  document.getElementById('fab').style.display = FAB_TABS[tab] ? 'flex' : 'none';
  if (tab === 'portfolio') { renderActive(); updateStats(); }
  if (tab === 'watch')     { renderWatchlist(); checkMarketSchedule(); }
  if (tab === 'roi')       { renderCalcAverages(); }
  if (tab === 'analysis')  { renderAnalysis(); }
  if (tab === 'scan')      { /* ready — user taps the upload zone */ }
}

/* ═══════════════════════════════════════
   OVERLAY HELPERS
═══════════════════════════════════════ */
const openOverlay   = id => document.getElementById(id).classList.add('open');
const closeOverlay  = id => document.getElementById(id).classList.remove('open');
const openConfirm   = id => document.getElementById(id).classList.add('open');
const closeConfirm  = id => document.getElementById(id).classList.remove('open');

/* ═══════════════════════════════════════
   ADD TRADE
═══════════════════════════════════════ */
// ── Date ↔ DTE sync helpers ──
function dteFromDate(dateVal) {
  if (!dateVal) return '';
  const exp = new Date(dateVal + 'T00:00:00');
  const today0 = new Date(); today0.setHours(0,0,0,0);
  return Math.max(1, Math.ceil((exp - today0) / 86400000));
}
function dateFromDTE(dte) {
  if (!dte || dte <= 0) return '';
  const d = new Date(); d.setHours(0,0,0,0);
  d.setDate(d.getDate() + parseInt(dte));
  return d.toISOString().split('T')[0];
}

// Add modal sync
function aSyncDateToDTE() {
  const v = dteFromDate(document.getElementById('a-expdate').value);
  if (v) document.getElementById('a-dte').value = v;
  addROIUpdate();
}
function aSyncDTEToDate() {
  const v = dateFromDTE(document.getElementById('a-dte').value);
  if (v) document.getElementById('a-expdate').value = v;
}

// Roll modal sync
function rSyncDateToDTE() {
  const v = dteFromDate(document.getElementById('r-expdate').value);
  if (v) document.getElementById('r-dte').value = v;
  rollROIUpdate();
}
function rSyncDTEToDate() {
  const v = dateFromDTE(document.getElementById('r-dte').value);
  if (v) document.getElementById('r-expdate').value = v;
}

// Calc tab sync
function cSyncDateToDTE() {
  const v = dteFromDate(document.getElementById('c-expdate').value);
  if (v) document.getElementById('c-dte').value = v;
  calcUpdate();
}
function cSyncDTEToDate() {
  const v = dateFromDTE(document.getElementById('c-dte').value);
  if (v) document.getElementById('c-expdate').value = v;
}

function openAddModal(prefill) {
  addType = prefill?.type || 'put';
  document.getElementById('a-ticker').value  = prefill?.ticker  || '';
  document.getElementById('a-strike').value  = prefill?.strike  || '';
  document.getElementById('a-premium').value = prefill?.premium || '';
  document.getElementById('a-qty').value     = prefill?.qty     || 1;
  renderCoversOptions(prefill?.positionId || '');
  // Accept prefill as DTE number or expiration date string
  const dte = prefill?.dte || '';
  document.getElementById('a-dte').value     = dte;
  document.getElementById('a-expdate').value = dte ? dateFromDTE(dte) : '';
  setTypeBtn('a', addType);
  addROIUpdate();
  openOverlay('m-add');
}

function setAddType(t) { addType = t; setTypeBtn('a', t); renderCoversOptions(); addROIUpdate(); }

/* Covered calls can be tied to a share lot. Offer the open lots for the
   ticker being entered; a linked call is measured against what those
   shares cost rather than against its own strike. */
function renderCoversOptions(preselect) {
  const wrap = document.getElementById('a-covers-wrap');
  const sel  = document.getElementById('a-covers');
  if (!wrap || !sel) return;
  const keep   = preselect !== undefined ? preselect : sel.value;
  const ticker = (document.getElementById('a-ticker').value || '').trim().toUpperCase();
  const open   = loadPositions().filter(p => p.status === 'open' && (!ticker || p.ticker === ticker));
  if (addType !== 'call' || !open.length) { wrap.style.display = 'none'; sel.innerHTML = ''; return; }
  sel.innerHTML = '<option value="">— not covered —</option>' + open.map(p =>
    `<option value="${esc(p.id)}">${esc(p.ticker)} · ${fmtInt(p.shares)} shares at ${fmtMoney(p.costBasis)}</option>`
  ).join('');
  sel.value = keep && open.some(p => p.id === keep) ? keep : '';
  wrap.style.display = 'block';
}
function setCalcType(t) { calcTypeVal = t; setTypeBtn('c', t); }
function setTypeBtn(pfx, t) {
  document.getElementById(pfx+'-t-put').className  = 'tgl-btn' + (t==='put'  ? ' t-put'  : '');
  document.getElementById(pfx+'-t-call').className = 'tgl-btn' + (t==='call' ? ' t-call' : '');
}

function addROIUpdate() {
  const p = parseFloat(document.getElementById('a-premium').value);
  const s = parseFloat(document.getElementById('a-strike').value);
  const d = parseFloat(document.getElementById('a-dte').value);
  if (p && s && d) {
    const r = roiPct(p, s, d);
    document.getElementById('a-roi-val').textContent = fmtPct(r);
    document.getElementById('a-roi-formula').textContent =
      `(365/${fmtInt(d)}) × (${fmtMoney(p)}×100 / ${fmtMoney(s)}) → ${fmtPct(r)}`;
  } else {
    document.getElementById('a-roi-val').textContent = '—';
    document.getElementById('a-roi-formula').textContent = '—';
  }
}

function addTrade() {
  const ticker  = document.getElementById('a-ticker').value.trim().toUpperCase();
  const strike  = parseFloat(document.getElementById('a-strike').value);
  const premium = parseFloat(document.getElementById('a-premium').value);
  const dte     = parseInt(document.getElementById('a-dte').value);
  const qty     = Math.max(1, parseInt(document.getElementById('a-qty').value) || 1);
  if (!ticker || !strike || !premium || !dte) { alert('Please fill all fields'); return; }
  if (!TICKER_RE.test(ticker)) { alert('Ticker must be 1–6 letters (A–Z)'); return; }
  const expDate = document.getElementById('a-expdate').value || dateFromDTE(dte);
  const d = load();
  const positionId = addType === 'call'
    ? (document.getElementById('a-covers')?.value || null) : null;
  d.trades.push({
    id: uid(), ticker, strikePrice: strike, premium, qty,
    type: addType, dteAtExecution: dte, expDate,
    roiAtExecution: roiPct(premium, strike, dte),
    dateOpened: todayStr(), status: 'active', rolls: [], closeInfo: null,
    ...(positionId ? { positionId } : {})
  });
  save(d);
  closeOverlay('m-add');
  renderActive(); updateStats();
}

/* ═══════════════════════════════════════
   BATCH HISTORIC ENTRY
   Bulk-enter trades that were made in the past and never logged.
   Two ways in — tap-friendly rows, or a paste from a spreadsheet —
   both feeding the same validate → preview → commit pipeline.
   Everything is derived from the dates entered (open / expiration /
   close), never from today, so old trades land with the right DTE,
   ROI and P&L.
═══════════════════════════════════════ */
let batchMode     = 'rows';
let _batchSeq     = 0;
let _lastBatchIds = [];
let _lastBatchPosIds = [];

const BATCH_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// Read the date formats people actually paste. Returns ISO or null.
function parseFlexDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const mk = (y, mi, d) => {
    const dt = new Date(y, mi, d);
    return isNaN(dt) || dt.getMonth() !== mi || dt.getDate() !== d ? null : isoDate(dt);
  };
  const year = m => { let y = m ? parseInt(m) : new Date().getFullYear(); return y < 100 ? y + 2000 : y; };
  let m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/)))              // 2026-02-20
    return mk(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{2,4}))?$/)))       // 2/20/2026 (US order)
    return mk(year(m[3]), +m[1] - 1, +m[2]);
  if ((m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:[,\s]+(\d{2,4}))?$/i))) { // Feb 20 2026
    const mi = BATCH_MONTHS.findIndex(x => m[1].toLowerCase().startsWith(x));
    return mi < 0 ? null : mk(year(m[3]), mi, +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[-\s]+([a-z]{3,9})\.?(?:[,\s-]+(\d{2,4}))?$/i))) { // 20 Feb 2026
    const mi = BATCH_MONTHS.findIndex(x => m[2].toLowerCase().startsWith(x));
    return mi < 0 ? null : mk(year(m[3]), mi, +m[1]);
  }
  return null;
}

function normBatchType(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (/^(p|put|puts|cashsecuredput|csp|shortput)$/.test(s))  return 'put';
  if (/^(c|call|calls|coveredcall|cc|shortcall)$/.test(s))   return 'call';
  return null;
}

// '' / 'auto' → decide from the expiration date
function normBatchStatus(v, expiry, today) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s || s === 'auto') return expiry ? (expiry < today ? 'expired' : 'active') : null;
  if (/^(active|open|ongoing|current|live|running|a|o)$/.test(s))                       return 'active';
  if (/^(expired|expire|exp|expiredworthless|worthless|e)$/.test(s))                   return 'expired';
  if (/^(assigned|assign|exercised|exercise|puttome|calledaway)$/.test(s))              return 'assigned';
  if (/^(closed|close|closedearly|boughtback|buyback|bought|btc|c)$/.test(s))           return 'closed_early';
  return null;
}

/* ── Open / mode switching ── */
function openBatchModal() {
  document.getElementById('bt-preview').innerHTML   = '';
  document.getElementById('bt-done-banner').innerHTML = '';
  document.getElementById('bt-commit').style.display = 'none';
  if (!document.querySelectorAll('#bt-rows .batch-row').length) batchAddRow(3);
  setBatchMode(batchMode);
  openOverlay('m-batch');
}

function setBatchMode(mode) {
  batchMode = mode === 'paste' ? 'paste' : 'rows';
  document.getElementById('bt-mode-rows').classList.toggle('selected',  batchMode === 'rows');
  document.getElementById('bt-mode-paste').classList.toggle('selected', batchMode === 'paste');
  document.getElementById('bt-rows-pane').style.display  = batchMode === 'rows'  ? 'block' : 'none';
  document.getElementById('bt-paste-pane').style.display = batchMode === 'paste' ? 'block' : 'none';
  document.getElementById('bt-preview').innerHTML = '';
  document.getElementById('bt-commit').style.display = 'none';
}

/* ── Rows mode ── */
function batchAddRow(count) {
  count = Math.max(1, parseInt(count) || 1);
  const wrap = document.getElementById('bt-rows');
  // Carry the previous row's dates forward — batches usually share a period
  const last = wrap.lastElementChild;
  const prev = last ? {
    opened: document.getElementById(`bt-opened-${last.dataset.idx}`)?.value || '',
    expiry: document.getElementById(`bt-expiry-${last.dataset.idx}`)?.value || ''
  } : { opened:'', expiry:'' };
  for (let n = 0; n < count; n++) {
    const i   = _batchSeq++;
    const div = document.createElement('div');
    div.className = 'batch-row';
    div.id = `bt-row-${i}`;
    div.dataset.idx = i;
    div.innerHTML = batchRowHTML(i, prev);
    wrap.appendChild(div);
  }
  renumberBatchRows();
}

function batchRowHTML(i, prev) {
  return `
    <div class="batch-row-hdr">
      <div class="batch-row-num" id="bt-num-${i}">Trade</div>
      <button class="batch-row-del" onclick="batchRemoveRow(${i})" aria-label="Remove row">✕</button>
    </div>
    <div class="batch-fields">
      <div class="batch-field">
        <div class="batch-field-lbl">Ticker</div>
        <input type="text" id="bt-ticker-${i}" placeholder="AAPL" style="text-transform:uppercase"
               oninput="this.value=this.value.toUpperCase()">
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Type</div>
        <select id="bt-type-${i}">
          <option value="put">PUT</option>
          <option value="call">CALL</option>
        </select>
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Strike</div>
        <input type="number" id="bt-strike-${i}" placeholder="150.00" step="0.01">
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Premium</div>
        <input type="number" id="bt-premium-${i}" placeholder="1.50" step="0.01">
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Date Opened</div>
        <input type="date" id="bt-opened-${i}" value="${esc(prev?.opened || '')}">
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Expiration</div>
        <input type="date" id="bt-expiry-${i}" value="${esc(prev?.expiry || '')}">
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Contracts</div>
        <input type="number" id="bt-qty-${i}" placeholder="1" min="1" step="1" value="1">
      </div>
      <div class="batch-field">
        <div class="batch-field-lbl">Outcome</div>
        <select id="bt-status-${i}" onchange="batchStatusChange(${i})">
          <option value="auto">Auto</option>
          <option value="active">Still active</option>
          <option value="expired">Expired / assigned</option>
          <option value="closed">Closed early</option>
        </select>
      </div>
      <div class="batch-close-fields" id="bt-closewrap-${i}">
        <div class="batch-field">
          <div class="batch-field-lbl">Buy-back Price</div>
          <input type="number" id="bt-closeprice-${i}" placeholder="0.45" step="0.01">
        </div>
        <div class="batch-field">
          <div class="batch-field-lbl">Close Date</div>
          <input type="date" id="bt-closedate-${i}">
        </div>
      </div>
    </div>`;
}

function batchStatusChange(i) {
  const closed = document.getElementById(`bt-status-${i}`).value === 'closed';
  document.getElementById(`bt-closewrap-${i}`).classList.toggle('show', closed);
}

function batchRemoveRow(i) {
  document.getElementById(`bt-row-${i}`)?.remove();
  renumberBatchRows();
}

function renumberBatchRows() {
  document.querySelectorAll('#bt-rows .batch-row').forEach((el, n) => {
    const lbl = document.getElementById(`bt-num-${el.dataset.idx}`);
    if (lbl) lbl.textContent = 'Trade ' + (n + 1);
  });
}

// Read the row cards into raw records; untouched rows are ignored
function collectBatchRows() {
  return [...document.querySelectorAll('#bt-rows .batch-row')].map((el, n) => {
    const i = el.dataset.idx;
    const g = f => (document.getElementById(`bt-${f}-${i}`)?.value || '').trim();
    return {
      label: 'Trade ' + (n + 1), _el: el,
      ticker: g('ticker'), type: g('type'), strike: g('strike'), premium: g('premium'),
      qty: g('qty'), opened: g('opened'), expiry: g('expiry'), status: g('status'),
      closePrice: g('closeprice'), closeDate: g('closedate')
    };
  }).filter(r => r.ticker || r.strike || r.premium);
}

/* ── Paste mode ── */
const BATCH_FIELDS = [
  ['ticker',     ['ticker','symbol','stock','underlying']],
  ['type',       ['type','putcall','callput','side','option','optiontype','class']],
  ['strike',     ['strike','strikeprice']],
  ['premium',    ['premium','prem','credit','price','fillprice','premiumreceived']],
  ['qty',        ['qty','quantity','contracts','contract','size','numcontracts']],
  ['opened',     ['opened','dateopened','opendate','date','entry','entrydate','tradedate','filled','filldate','sold']],
  ['expiry',     ['expiry','expiration','exp','expdate','expirationdate','expires','expiry date']],
  ['status',     ['status','outcome','result','state']],
  ['closePrice', ['closeprice','buyprice','buyback','buybackprice','buytoclose','btc','closingprice','costtoclose','exitprice']],
  ['closeDate',  ['closedate','dateclosed','closed','exit','exitdate']],
];
const BATCH_ORDER = BATCH_FIELDS.map(f => f[0]);

const cleanCell = c => String(c).trim().replace(/^["']+|["']+$/g, '').trim();

function splitBatchLine(line) {
  if (line.includes('\t')) return line.split('\t').map(cleanCell);
  if (!line.includes(',') && line.includes(';')) return line.split(';').map(cleanCell);
  if (!line.includes(',') && line.includes('|')) return line.split('|').map(cleanCell);
  // comma-separated, honouring quoted cells
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(cleanCell);
}

const headerKey = c => String(c).toLowerCase().replace(/[^a-z]/g, '');

// Map a header row to field names; null when the line isn't a header
function batchHeaderMap(cells) {
  const map = []; let hits = 0;
  cells.forEach(c => {
    const k = headerKey(c);
    const f = BATCH_FIELDS.find(([, aliases]) => aliases.some(a => headerKey(a) === k));
    if (f) { map.push(f[0]); hits++; } else map.push(null);
  });
  return hits >= 2 ? map : null;
}

function parseBatchText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows  = [];
  let map = null, headerLine = null;
  lines.forEach((line, n) => {
    if (!line.trim()) return;
    const cells = splitBatchLine(line);
    if (!cells.some(c => c)) return;
    if (!rows.length && !map) {
      const hm = batchHeaderMap(cells);
      if (hm) { map = hm; headerLine = line; return; }
    }
    const raw = { label: 'Line ' + (n + 1), _line: line };
    (map || BATCH_ORDER).forEach((field, ci) => {
      if (field) raw[field] = cells[ci] || '';
    });
    rows.push(raw);
  });
  return { rows, headerLine };
}

function batchLoadCsvFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('bt-paste').value = String(e.target.result || '').trim();
    batchReview();
  };
  reader.onerror = () => alert('Could not read that file.');
  reader.readAsText(file);
  document.getElementById('bt-csv-input').value = '';
}

function batchInsertExample() {
  document.getElementById('bt-paste').value = [
    'Ticker, Type, Strike, Premium, Contracts, Opened, Expiry, Outcome, Close Price, Close Date',
    `AAPL, PUT,  150, 1.50, 1, ${dateOffset(-120)}, ${dateOffset(-90)}, expired`,
    `MSFT, CALL, 420, 3.10, 2, ${dateOffset(-95)},  ${dateOffset(-60)}, closed, 0.45, ${dateOffset(-70)}`,
    `NVDA, PUT,  120, 1.05, 1, ${dateOffset(-20)},  ${dateOffset(15)},  active`
  ].join('\n');
  batchReview();
}

/* ── Validation ── */
// Turn one raw record into a trade, or a list of reasons it can't be used.
function normalizeBatchRow(raw) {
  const errors = [], notes = [];
  const num = v => {
    const n = parseFloat(String(v ?? '').replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : null;
  };
  const today = todayStr();

  const ticker = String(raw.ticker || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 6);
  if (!ticker)                    errors.push('ticker missing');
  else if (!TICKER_RE.test(ticker)) errors.push('ticker must be 1–6 letters');

  const type = normBatchType(raw.type);
  if (!type) errors.push(raw.type ? `type "${raw.type}" not understood — use PUT or CALL` : 'type missing (PUT or CALL)');

  const strike = num(raw.strike);
  if (strike == null || strike <= 0) errors.push('strike missing or invalid');
  const premium = num(raw.premium);
  if (premium == null || premium <= 0) errors.push('premium missing or invalid');

  const qty = Math.max(1, parseInt(num(raw.qty)) || 1);

  const opened = parseFlexDate(raw.opened);
  const expiry = parseFlexDate(raw.expiry);
  if (!opened) errors.push(raw.opened ? `date opened "${raw.opened}" not understood` : 'date opened missing');
  if (!expiry) errors.push(raw.expiry ? `expiration "${raw.expiry}" not understood` : 'expiration missing');
  if (opened && opened > today) errors.push('date opened is in the future');
  if (opened && expiry && daysBetween(opened, expiry) < 0) errors.push('expiration falls before the open date');

  const rawStatus = String(raw.status || '').trim();
  const status    = normBatchStatus(rawStatus, expiry, today);
  if (!status) errors.push(rawStatus ? `outcome "${rawStatus}" not understood — use active, expired, assigned or closed` : 'outcome missing');
  if (status === 'assigned' && type === 'put')
    notes.push('a share lot will be created at the strike — sell or close it from the portfolio');

  let closeInfo = null;
  if (status === 'expired' || status === 'assigned') {
    if (expiry && expiry > today)
      errors.push(`marked ${status === 'assigned' ? 'assigned' : 'expired'} but the expiration is still in the future`);
    if (expiry) closeInfo = { dateClosed: expiry };
  } else if (status === 'closed_early') {
    const buy = num(raw.closePrice);
    if (buy == null)   errors.push('buy-back price required for a closed trade');
    else if (buy < 0)  errors.push('buy-back price cannot be negative');
    let closeDate = parseFlexDate(raw.closeDate);
    if (!closeDate && raw.closeDate) errors.push(`close date "${raw.closeDate}" not understood`);
    if (!closeDate && !raw.closeDate && expiry) {
      closeDate = expiry <= today ? expiry : today;
      notes.push(`no close date given — using ${closeDate}`);
    }
    if (closeDate && opened && daysBetween(opened, closeDate) < 0) errors.push('close date falls before the open date');
    if (closeDate && closeDate > today) errors.push('close date is in the future');
    if (buy != null && closeDate) closeInfo = { buyingPrice: buy, dateClosed: closeDate };
  } else if (status === 'active' && expiry && expiry < today) {
    notes.push('expiration has already passed — it will show as "past exp" until you close it');
  }

  if (errors.length) return { ok: false, errors, notes, label: raw.label, src: raw };

  const dte = Math.max(1, daysBetween(opened, expiry));
  const trade = {
    id: uid(), ticker, strikePrice: strike, premium, qty,
    type, dteAtExecution: dte, expDate: expiry,
    roiAtExecution: roiPct(premium, strike, dte),
    dateOpened: opened, status, rolls: [], closeInfo
  };
  return { ok: true, trade, errors, notes, label: raw.label, src: raw };
}

function batchValidate() {
  const parsed = batchMode === 'paste'
    ? parseBatchText(document.getElementById('bt-paste').value)
    : { rows: collectBatchRows(), headerLine: null };
  return { results: parsed.rows.map(normalizeBatchRow), headerLine: parsed.headerLine };
}

/* ── Preview ── */
function batchReview() {
  const { results } = batchValidate();
  const box = document.getElementById('bt-preview');
  const commitBtn = document.getElementById('bt-commit');
  document.getElementById('bt-done-banner').innerHTML = '';

  if (!results.length) {
    box.innerHTML = `<div class="bt-preview-hdr">Preview</div>
      <div class="info-box">Nothing to check yet — ${batchMode === 'paste'
        ? 'paste your trades above.' : 'fill in at least one row above.'}</div>`;
    commitBtn.style.display = 'none';
    return;
  }

  const good   = results.filter(r => r.ok);
  const closed = good.filter(r => r.trade.status !== 'active').map(r => r.trade);
  const pnl    = closed.reduce((s, t) => s + tradePnL(t), 0);
  const roi    = closed.length ? annualizedROI(closed) : null;

  let html = `<div class="bt-preview-hdr">Preview — ${results.length} entr${results.length === 1 ? 'y' : 'ies'}</div>
    <div class="bt-summary">
      <div class="bt-sum-card">
        <div class="bt-sum-lbl">Ready</div>
        <div class="bt-sum-val ${good.length ? 'green' : ''}">${good.length}</div>
      </div>
      <div class="bt-sum-card">
        <div class="bt-sum-lbl">Problems</div>
        <div class="bt-sum-val ${results.length - good.length ? 'red' : ''}">${results.length - good.length}</div>
      </div>
      <div class="bt-sum-card">
        <div class="bt-sum-lbl">Realized P&amp;L</div>
        <div class="bt-sum-val ${pnl >= 0 ? 'green' : 'red'}">${fmtSigned(pnl)}</div>
      </div>
    </div>`;

  if (roi != null) {
    html += `<div class="info-box">Adds ${closed.length} closed trade${closed.length === 1 ? '' : 's'}
      at <b>${fmtPct(roi)}</b> weighted annualized ROI.</div>`;
  }

  results.forEach(r => {
    if (!r.ok) {
      html += `<div class="bt-prow bad">
        <div class="bt-prow-top"><div class="bt-prow-name">${esc(r.label)}${r.src.ticker ? ' · ' + esc(String(r.src.ticker).toUpperCase()) : ''}</div></div>
        <div class="bt-prow-err">${r.errors.map(e => '⚠ ' + esc(e)).join('<br>')}</div>
      </div>`;
      return;
    }
    const t   = r.trade;
    const p   = tradePnL(t);
    const dur = t.status === 'active' ? `${fmtInt(t.dteAtExecution)}d to exp` : `${fmtInt(actualDays(t))}d held`;
    const st  = t.status === 'active' ? 'active' : t.status === 'expired' ? 'expired' : 'closed early';
    html += `<div class="bt-prow">
      <div class="bt-prow-top">
        <div class="bt-prow-name">${esc(t.ticker)} <span class="muted" style="font-size:10px">${esc(t.type.toUpperCase())} ${fmtMoney(t.strikePrice)}${t.qty > 1 ? ' ×' + fmtInt(t.qty) : ''}</span></div>
        <div class="bt-prow-pnl ${t.status === 'active' ? 'muted' : p >= 0 ? 'green' : 'red'}">${
          t.status === 'active' ? '—' : fmtSigned(p)}</div>
      </div>
      <div class="bt-prow-meta">${esc(t.dateOpened)} → ${esc(t.expDate)} · ${dur} · ${st} · ${fmtPct(roiPct(
        t.status === 'closed_early' ? t.premium - (t.closeInfo?.buyingPrice || 0) : t.premium,
        t.strikePrice, t.status === 'active' ? t.dteAtExecution : actualDays(t)))} ann. ROI</div>
      ${r.notes.length ? `<div class="bt-prow-note">${r.notes.map(n => '• ' + esc(n)).join('<br>')}</div>` : ''}
    </div>`;
  });

  box.innerHTML = html;
  commitBtn.textContent = good.length
    ? `Add ${good.length} Trade${good.length === 1 ? '' : 's'}`
    : 'Nothing to add';
  commitBtn.style.display = good.length ? 'block' : 'none';
}

/* ── Commit ── */
function commitBatch() {
  const { results, headerLine } = batchValidate();
  const good = results.filter(r => r.ok);
  const bad  = results.filter(r => !r.ok);
  if (!good.length) { alert('Nothing to add — fix the highlighted entries first.'); return; }

  const d = load();
  d.positions = loadPositions(d);
  const posIds = [];
  good.forEach(r => {
    const t = r.trade;
    d.trades.push(t);
    // An assigned put historically handed over shares — create the lot so the
    // cycle can be closed out (or sold) from the portfolio.
    if (t.status === 'assigned' && t.type === 'put') {
      const p = {
        id: uid(), ticker: t.ticker, shares: tradeQty(t) * 100,
        costBasis: currentStrike(t), dateAcquired: t.closeInfo?.dateClosed || t.expDate,
        sourceTradeId: t.id, status: 'open', closeInfo: null
      };
      d.positions.push(p);
      posIds.push(p.id);
    }
  });
  save(d);
  _lastBatchIds = good.map(r => r.trade.id);
  _lastBatchPosIds = posIds;

  // Clear what was imported, leaving any problem entries behind to fix
  if (batchMode === 'paste') {
    const keep = bad.map(r => r.src._line);
    document.getElementById('bt-paste').value =
      keep.length ? [headerLine, ...keep].filter(Boolean).join('\n') : '';
  } else {
    good.forEach(r => r.src._el?.remove());
    if (!document.querySelectorAll('#bt-rows .batch-row').length) batchAddRow(1);
    renumberBatchRows();
  }

  renderActive(); updateStats();
  document.getElementById('bt-preview').innerHTML = '';
  document.getElementById('bt-commit').style.display = 'none';
  renderBatchDone(good.length, bad.length);
}

function renderBatchDone(added, remaining) {
  document.getElementById('bt-done-banner').innerHTML = `
    <div class="bt-done">
      <div class="bt-done-txt">✓ Added ${added} historic trade${added === 1 ? '' : 's'}.${
        remaining ? ` ${remaining} entr${remaining === 1 ? 'y' : 'ies'} still need fixing.` : ''}</div>
      <button class="br-btn" onclick="undoLastBatch()">Undo</button>
    </div>`;
}

function undoLastBatch() {
  if (!_lastBatchIds.length) return;
  const ids    = new Set(_lastBatchIds);
  const posIds = new Set(_lastBatchPosIds);
  const d      = load();
  d.trades     = d.trades.filter(t => !ids.has(t.id));
  d.positions  = loadPositions(d).filter(p => !posIds.has(p.id));
  save(d);
  _lastBatchIds = []; _lastBatchPosIds = [];
  renderActive(); updateStats();
  document.getElementById('bt-done-banner').innerHTML =
    `<div class="info-box">Batch undone — those trades were removed again.</div>`;
}

/* ═══════════════════════════════════════
   ROLL
═══════════════════════════════════════ */
function openRoll(id) {
  const t = load().trades.find(x => x.id === id);
  if (!t) return;
  document.getElementById('r-id').value = id;
  document.getElementById('r-strike').value  = '';
  document.getElementById('r-premium').value = '';
  document.getElementById('r-dte').value     = '';
  document.getElementById('r-expdate').value = '';
  document.getElementById('r-roi-val').textContent = '—';
  document.getElementById('r-info').innerHTML =
    `<b>${esc(t.ticker)}</b> ${esc(t.type.toUpperCase())}${tradeQty(t)>1?' ×'+fmtInt(tradeQty(t)):''} &nbsp;|&nbsp; Current strike: <b>${fmtMoney(currentStrike(t))}</b><br>
     Premiums so far: <b>${fmtMoney(totalPremiums(t))}</b> &nbsp;|&nbsp; Open: <b>${fmtInt(daysBetween(t.dateOpened, todayStr()))}d</b>`;
  openOverlay('m-roll');
}

function rollROIUpdate() {
  const id = document.getElementById('r-id').value;
  const t  = load().trades.find(x => x.id === id);
  if (!t) return;
  const np = parseFloat(document.getElementById('r-premium').value);
  const ns = parseFloat(document.getElementById('r-strike').value);
  const nd = parseInt(document.getElementById('r-dte').value);
  const verdict = document.getElementById('r-verdict');
  if (!(np && ns && nd)) { if (verdict) verdict.style.display = 'none'; return; }

  const tp = totalPremiums(t) + np;
  const newExp = document.getElementById('r-expdate').value || dateFromDTE(nd);
  const td = Math.max(1, daysBetween(t.dateOpened, newExp));
  const r  = roiPct(tp, ns, td);
  document.getElementById('r-roi-val').textContent = fmtPct(r);
  document.getElementById('r-roi-formula').textContent =
    `(365/${fmtInt(td)}) × (${fmtMoney(tp)} / ${fmtMoney(ns)}) × 100`;

  /* Combined ROI flatters a roll: it credits the new leg with premium the
     original already earned. What actually decides the roll is the new
     money on its own — is this new leg worth the capital, compared with
     what your closed trades have really returned? */
  if (!verdict) return;
  const incremental = roiPct(np, ns, nd);
  const avg = weightedStats().roi;
  const better = avg > 0 && incremental >= avg;
  verdict.className = 'tc-hint' + (better || !avg ? ' good' : '');
  verdict.style.display = 'block';
  verdict.innerHTML = avg
    ? `The new leg on its own annualizes at <b>${fmtPct(incremental)}</b> —
       ${better ? 'better than' : 'below'} your realized average of <b>${fmtPct(avg)}</b>.
       ${better ? '' : 'Closing instead frees ' + fmtMoney(ns * 100 * tradeQty(t)) + ' to redeploy.'}`
    : `The new leg on its own annualizes at <b>${fmtPct(incremental)}</b> on
       ${fmtMoney(ns * 100 * tradeQty(t))} of capital for ${fmtInt(nd)} days.`;
}

function executeRoll() {
  const id = document.getElementById('r-id').value;
  const ns = parseFloat(document.getElementById('r-strike').value);
  const np = parseFloat(document.getElementById('r-premium').value);
  const nd = parseInt(document.getElementById('r-dte').value);
  if (!ns || !np || !nd) { alert('Fill in all roll fields'); return; }
  const expDate = document.getElementById('r-expdate').value || dateFromDTE(nd);
  const d = load();
  const t = d.trades.find(x => x.id === id);
  if (!t) return;
  t.rolls.push({ strikePrice: ns, premium: np, dte: nd, dateRolled: todayStr(), expDate });
  save(d);
  closeOverlay('m-roll');
  renderActive(); updateStats();
}

/* ═══════════════════════════════════════
   CLOSE EARLY
═══════════════════════════════════════ */
function openClose(id) {
  const t = load().trades.find(x => x.id === id);
  if (!t) return;
  document.getElementById('cl-id').value    = id;
  document.getElementById('cl-buy').value   = '';
  document.getElementById('cl-date').value  = todayStr();
  document.getElementById('cl-pnl').textContent = '—';
  document.getElementById('cl-roi').textContent = '—';
  document.getElementById('cl-info').innerHTML  =
    `<b>${esc(t.ticker)}</b> ${esc(t.type.toUpperCase())}${tradeQty(t)>1?' ×'+fmtInt(tradeQty(t)):''} &nbsp;|&nbsp; Strike: <b>${fmtMoney(currentStrike(t))}</b><br>
     Total premiums collected: <b>${fmtMoney(totalPremiums(t))}</b>`;
  openOverlay('m-close');
}

function closeUpdate() {
  const id  = document.getElementById('cl-id').value;
  const t   = load().trades.find(x => x.id === id);
  if (!t) return;
  const buy = parseFloat(document.getElementById('cl-buy').value);
  if (isNaN(buy)) return;
  const closeDate = document.getElementById('cl-date').value || todayStr();
  const q   = tradeQty(t);
  const tp  = totalPremiums(t);
  const pnl = (tp - buy) * 100 * q;
  const d   = Math.max(1, Math.ceil((new Date(closeDate) - new Date(t.dateOpened)) / 86400000));
  const roi = roiPct(tp - buy, currentStrike(t), d);
  const pnlEl = document.getElementById('cl-pnl');
  pnlEl.textContent = fmtSigned(pnl);
  pnlEl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('cl-formula').textContent =
    `(${fmtMoney(tp)} − ${fmtMoney(buy)}) × 100${q>1?' × '+fmtInt(q):''}`;
  const roiEl = document.getElementById('cl-roi');
  roiEl.textContent = fmtPct(roi);
  roiEl.style.color = roi >= 0 ? 'var(--blue)' : 'var(--red)';
  document.getElementById('cl-roi-formula').textContent = `${fmtInt(d)} actual days open`;
}

function executeClose() {
  const id  = document.getElementById('cl-id').value;
  const buy = parseFloat(document.getElementById('cl-buy').value);
  const dt  = document.getElementById('cl-date').value || todayStr();
  if (isNaN(buy)) { alert('Enter buying price'); return; }
  const d = load();
  const t = d.trades.find(x => x.id === id);
  if (!t) return;
  t.status    = 'closed_early';
  t.closeInfo = { buyingPrice: buy, dateClosed: dt };
  save(d);
  closeOverlay('m-close');
  renderActive(); updateStats();
}

/* ═══════════════════════════════════════
   EXPIRE
═══════════════════════════════════════ */
function openExpire(id) {
  const t   = load().trades.find(x => x.id === id);
  if (!t) return;
  const q   = tradeQty(t);
  const pnl = totalPremiums(t) * 100 * q;
  document.getElementById('exp-id').value = id;
  document.getElementById('exp-body').textContent =
    `${t.ticker} expired worthless. Record ${fmtSigned(pnl)} profit (${fmtMoney(totalPremiums(t))} × 100${q>1?' × '+fmtInt(q):''})?`;
  openConfirm('cd-expire');
}
function confirmExpire() {
  const id = document.getElementById('exp-id').value;
  const d  = load();
  const t  = d.trades.find(x => x.id === id);
  if (!t) return;
  t.status    = 'expired';
  t.closeInfo = { dateClosed: todayStr() };
  save(d);
  closeConfirm('cd-expire');
  renderActive(); updateStats();
}

/* ═══════════════════════════════════════
   TOAST — undo for anything destructive
═══════════════════════════════════════ */
let _toastAction = null, _toastTimer = null;

function showToast(text, actionLabel, fn, ms = 9000) {
  const el = document.getElementById('toast');
  if (!el) return;
  document.getElementById('toast-txt').textContent = text;
  const btn = document.getElementById('toast-btn');
  btn.textContent = actionLabel || 'Undo';
  btn.style.display = fn ? 'block' : 'none';
  _toastAction = fn || null;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  document.getElementById('toast')?.classList.remove('show');
  _toastAction = null;
}
function toastAction() {
  const fn = _toastAction;
  hideToast();
  if (fn) fn();
}

/* ═══════════════════════════════════════
   ASSIGNMENT & SHARE POSITIONS (the wheel)
   Assigning a put hands you shares: the option leg keeps its premium and
   a share lot takes over the capital. Assigning a covered call sells that
   lot back out. Tracking both ends means the cycle — not just the leg —
   can be measured.
═══════════════════════════════════════ */
function openAssign(id) {
  const d = load();
  const t = d.trades.find(x => x.id === id);
  if (!t) return;
  const q  = tradeQty(t);
  const cs = currentStrike(t);
  document.getElementById('as-id').value   = id;
  document.getElementById('as-date').value = todayStr();

  if (t.type === 'put') {
    document.getElementById('as-title').textContent = 'Put Assigned';
    document.getElementById('as-info').innerHTML =
      `<b>${esc(t.ticker)}</b> PUT${q>1?' ×'+fmtInt(q):''} at <b>${fmtMoney(cs)}</b><br>
       You buy <b>${fmtInt(q*100)}</b> shares for <b>${fmtMoney(cs*100*q)}</b>. The
       ${fmtMoney(totalPremiums(t)*100*q)} premium stays yours and comes off what the shares cost.`;
    document.getElementById('as-prev-label').textContent = 'Net Cost / Share';
  } else {
    const p = loadPositions(d).find(p => p.id === t.positionId && p.status === 'open');
    document.getElementById('as-title').textContent = 'Call Assigned';
    document.getElementById('as-info').innerHTML = p
      ? `<b>${esc(t.ticker)}</b> CALL${q>1?' ×'+fmtInt(q):''} at <b>${fmtMoney(cs)}</b><br>
         Your <b>${fmtInt(p.shares)}</b> shares are called away for <b>${fmtMoney(cs*p.shares)}</b>,
         closing the lot bought at ${fmtMoney(p.costBasis)}.`
      : `<b>${esc(t.ticker)}</b> CALL${q>1?' ×'+fmtInt(q):''} at <b>${fmtMoney(cs)}</b><br>
         No share lot is linked to this call, so only the option leg is recorded —
         the premium is kept in full.`;
    document.getElementById('as-prev-label').textContent = p ? 'Cycle P&L' : 'Premium Kept';
  }
  assignUpdate();
  openOverlay('m-assign');
}

function assignUpdate() {
  const d = load();
  const t = d.trades.find(x => x.id === document.getElementById('as-id').value);
  if (!t) return;
  const q    = tradeQty(t);
  const cs   = currentStrike(t);
  const when = document.getElementById('as-date').value || todayStr();
  const val  = document.getElementById('as-prev-val');
  const sub  = document.getElementById('as-prev-sub');

  if (t.type === 'put') {
    const net = cs - totalPremiums(t);
    val.textContent = fmtMoney(net);
    val.style.color = 'var(--blue)';
    sub.textContent = `${fmtMoney(cs)} strike − ${fmtMoney(totalPremiums(t))} premium · ${fmtInt(q*100)} shares`;
  } else {
    const p = loadPositions(d).find(p => p.id === t.positionId && p.status === 'open');
    if (p) {
      const stock = (cs - p.costBasis) * p.shares;
      // The call is already linked to the lot, so positionPremiums() counts
      // it — adding it again here would double the premium side.
      const prem  = positionPremiums(p, d.trades);
      const days  = Math.max(1, daysBetween(p.dateAcquired, when));
      const cycle = stock + prem;
      val.textContent = fmtSigned(cycle);
      val.style.color = cycle >= 0 ? 'var(--green)' : 'var(--red)';
      sub.textContent = `${fmtSigned(stock)} stock + ${fmtMoney(prem)} premiums · ${fmtInt(days)}d`;
    } else {
      val.textContent = fmtSigned(totalPremiums(t) * 100 * q);
      val.style.color = 'var(--green)';
      sub.textContent = `${fmtMoney(totalPremiums(t))} × 100${q>1?' × '+fmtInt(q):''}`;
    }
  }
}

function confirmAssign() {
  const id   = document.getElementById('as-id').value;
  const when = document.getElementById('as-date').value || todayStr();
  const d    = load();
  const t    = d.trades.find(x => x.id === id);
  if (!t) return;
  if (!DATE_RE.test(when)) { alert('Enter the assignment date'); return; }
  if (daysBetween(t.dateOpened, when) < 0) { alert('Assignment cannot pre-date the trade'); return; }

  const q  = tradeQty(t);
  const cs = currentStrike(t);
  d.positions = d.positions || [];
  let msg;

  if (t.type === 'put') {
    d.positions.push({
      id: uid(), ticker: t.ticker, shares: q * 100, costBasis: cs,
      dateAcquired: when, sourceTradeId: t.id, status: 'open', closeInfo: null
    });
    msg = `${t.ticker}: ${fmtInt(q*100)} shares acquired at ${fmtMoney(cs)}`;
  } else {
    const p = d.positions.find(p => p.id === t.positionId && p.status === 'open');
    if (p) {
      p.status = 'closed';
      p.closeInfo = { pricePerShare: cs, dateClosed: when, reason: 'called_away' };
      msg = `${t.ticker}: ${fmtInt(p.shares)} shares called away at ${fmtMoney(cs)}`;
    } else {
      msg = `${t.ticker} call assigned`;
    }
  }
  t.status    = 'assigned';
  t.closeInfo = { dateClosed: when };
  save(d);
  closeOverlay('m-assign');
  renderActive(); updateStats();
  showToast(msg, null, null, 5000);
}

/* ── Writing a call against a lot ── */
function openSellCall(posId) {
  const p = loadPositions().find(p => p.id === posId);
  if (!p) return;
  openAddModal({ ticker: p.ticker, type: 'call', qty: Math.max(1, Math.floor(p.shares / 100)),
                 strike: p.costBasis, positionId: p.id });
}

/* ── Selling a lot outright ── */
function openClosePos(id) {
  const d = load();
  const p = loadPositions(d).find(p => p.id === id);
  if (!p) return;
  document.getElementById('cp-id').value    = id;
  document.getElementById('cp-price').value = '';
  document.getElementById('cp-date').value  = todayStr();
  document.getElementById('cp-pnl').textContent = '—';
  document.getElementById('cp-roi').textContent = '—';
  const prem = positionPremiums(p, d.trades);
  document.getElementById('cp-info').innerHTML =
    `<b>${esc(p.ticker)}</b> — <b>${fmtInt(p.shares)}</b> shares at <b>${fmtMoney(p.costBasis)}</b>
     since ${esc(p.dateAcquired)}<br>
     Premiums collected: <b>${fmtMoney(prem)}</b> &nbsp;|&nbsp;
     Net basis: <b>${fmtMoney(positionNetBasis(p, d.trades))}</b> / share`;
  const open = d.trades.filter(t => t.positionId === p.id && t.status === 'active');
  if (open.length) {
    document.getElementById('cp-info').innerHTML +=
      `<br><span style="color:var(--amber)">⚠ ${fmtInt(open.length)} open call${open.length>1?'s':''}
       written against this lot — settle ${open.length>1?'them':'it'} too.</span>`;
  }
  openOverlay('m-closepos');
}

function closePosUpdate() {
  const d = load();
  const p = loadPositions(d).find(p => p.id === document.getElementById('cp-id').value);
  if (!p) return;
  const price = parseFloat(document.getElementById('cp-price').value);
  if (isNaN(price)) return;
  const when  = document.getElementById('cp-date').value || todayStr();
  const stock = (price - p.costBasis) * p.shares;
  const prem  = positionPremiums(p, d.trades);
  const cycle = stock + prem;
  const days  = Math.max(1, daysBetween(p.dateAcquired, when));
  const roi   = (cycle / positionCapital(p)) * (365 / days) * 100;

  const pnlEl = document.getElementById('cp-pnl');
  pnlEl.textContent = fmtSigned(cycle);
  pnlEl.style.color = cycle >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('cp-formula').textContent =
    `${fmtSigned(stock)} stock + ${fmtMoney(prem)} premiums`;
  const roiEl = document.getElementById('cp-roi');
  roiEl.textContent = fmtPct(roi);
  roiEl.style.color = roi >= 0 ? 'var(--blue)' : 'var(--red)';
  document.getElementById('cp-roi-formula').textContent =
    `${fmtMoney(positionCapital(p))} held for ${fmtInt(days)}d`;
}

function confirmClosePos() {
  const id    = document.getElementById('cp-id').value;
  const price = parseFloat(document.getElementById('cp-price').value);
  const when  = document.getElementById('cp-date').value || todayStr();
  if (isNaN(price) || price < 0) { alert('Enter the sale price per share'); return; }
  const d = load();
  const p = loadPositions(d).find(p => p.id === id);
  if (!p) return;
  if (daysBetween(p.dateAcquired, when) < 0) { alert('Sale cannot pre-date the purchase'); return; }
  p.status    = 'closed';
  p.closeInfo = { pricePerShare: price, dateClosed: when, reason: 'sold' };
  save(d);
  closeOverlay('m-closepos');
  renderActive(); updateStats();
}

function openDeletePos(id) {
  document.getElementById('delpos-id').value = id;
  openConfirm('cd-delpos');
}
function confirmDeletePos() {
  const id = document.getElementById('delpos-id').value;
  const d  = load();
  const removed = loadPositions(d).find(p => p.id === id);
  if (!removed) { closeConfirm('cd-delpos'); return; }
  const relinked = d.trades.filter(t => t.positionId === id);
  relinked.forEach(t => { delete t.positionId; });
  d.positions = loadPositions(d).filter(p => p.id !== id);
  save(d);
  closeConfirm('cd-delpos');
  renderActive(); updateStats();
  showToast(`${removed.ticker} share lot removed`, 'Undo', () => {
    const dd = load();
    dd.positions = loadPositions(dd).concat([removed]);
    relinked.forEach(t => {
      const live = dd.trades.find(x => x.id === t.id);
      if (live) live.positionId = removed.id;
    });
    save(dd);
    renderActive(); updateStats();
  });
}

/* ═══════════════════════════════════════
   DELETE
═══════════════════════════════════════ */
function openDelete(id) {
  document.getElementById('del-id').value = id;
  openConfirm('cd-delete');
}
function confirmDelete() {
  const id = document.getElementById('del-id').value;
  const d  = load();
  const idx = d.trades.findIndex(t => t.id === id);
  if (idx < 0) { closeConfirm('cd-delete'); return; }
  const [removed] = d.trades.splice(idx, 1);
  save(d);
  closeConfirm('cd-delete');
  renderActive(); updateStats();
  // Deleting is the one action with no other way back — always offer undo
  showToast(`${removed.ticker} ${removed.type.toUpperCase()} deleted`, 'Undo', () => {
    const dd = load();
    dd.trades.splice(Math.min(idx, dd.trades.length), 0, removed);
    save(dd);
    renderActive(); updateStats();
  });
}

/* ═══════════════════════════════════════
   RENDER: ACTIVE TRADES
═══════════════════════════════════════ */
// The best watchlist candidate, resolved once per render rather than once
// per card — every open position is measured against the same alternative.
let _altBest = null;

function renderActive() {
  const d = load();
  _altBest = bestCandidate();
  const trades = d.trades.filter(t => t.status === 'active');
  document.getElementById('active-count').textContent = trades.length + ' position' + (trades.length !== 1 ? 's' : '');
  const el = document.getElementById('active-list');
  if (!trades.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
      <div class="empty-txt">No active trades yet<br>Tap + to add your first position</div>
    </div>`;
  } else {
    el.innerHTML = trades.map(tradeCardHTML).join('');
  }
  renderPositions(d);
}

/* ── Share lots held ── */
function renderPositions(d) {
  d = d || load();
  const open = loadPositions(d).filter(p => p.status === 'open');
  const hdr  = document.getElementById('pos-hdr');
  const list = document.getElementById('pos-list');
  if (!hdr || !list) return;
  hdr.style.display = open.length ? 'flex' : 'none';
  document.getElementById('pos-count').textContent =
    fmtInt(open.reduce((s,p) => s + p.shares, 0)) + ' shares';
  list.innerHTML = open.map(p => positionCardHTML(p, d)).join('');
}

function positionCardHTML(p, d) {
  const prem     = positionPremiums(p, d.trades);
  const netBasis = positionNetBasis(p, d.trades);
  const covered  = d.trades.filter(t => t.positionId === p.id && t.status === 'active');
  const days     = positionDays(p);
  const yieldPct = positionCapital(p) > 0
    ? (prem / positionCapital(p)) * (365 / days) * 100 : 0;

  return `<div class="pos-card" id="pc-${esc(p.id)}">
    <div class="pc-main">
      <div class="pc-row1">
        <div class="pc-ticker">${esc(p.ticker)}</div>
        <div class="tc-badges">
          ${covered.length ? '<span class="badge bdg-covered">covered</span>' : ''}
          <span class="badge bdg-shares">${fmtInt(p.shares)} shares</span>
        </div>
      </div>
      <div class="pc-metrics">
        <div class="metric">
          <div class="m-label">Cost Basis</div>
          <div class="m-val">${fmtMoney(p.costBasis)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Net Basis</div>
          <div class="m-val green">${fmtMoney(netBasis)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Premiums</div>
          <div class="m-val">${fmtMoney(prem)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Capital</div>
          <div class="m-val">${fmtMoney(positionCapital(p))}</div>
        </div>
        <div class="metric">
          <div class="m-label">Held</div>
          <div class="m-val">${fmtInt(days)}d</div>
        </div>
        <div class="metric">
          <div class="m-label">Prem. Yield</div>
          <div class="m-val amber">${fmtPct(yieldPct)}</div>
        </div>
      </div>
    </div>
    <div class="pc-basis-note">
      Break even at <b>${fmtMoney(netBasis)}</b> a share — ${fmtMoney(prem)} of premium has come
      off the ${fmtMoney(p.costBasis)} you paid${covered.length ? '' : '. Writing a call against these shares keeps that falling.'}
    </div>
    <div class="pc-actions">
      <button class="act-btn grn" onclick="openSellCall('${p.id}')">Sell Call</button>
      <button class="act-btn blu" onclick="openClosePos('${p.id}')">Sell Shares</button>
      <button class="act-btn ico" onclick="openDeletePos('${p.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>
  </div>`;
}

function tradeCardHTML(t) {
  const tp  = totalPremiums(t);
  const cs  = currentStrike(t);
  const q   = tradeQty(t);
  const rolled = t.rolls && t.rolls.length > 0;
  const roi = positionRate(t);
  const dr  = daysRemaining(t);
  const drVal = dr < 0 ? 'past exp' : fmtInt(dr) + 'd';
  const drCls = dr <= 5 ? ' red' : '';

  // Below the breakeven buy-back price, closing now annualizes better than
  // holding to expiry — the single most useful call a premium seller makes.
  const be = closeEarlyBreakeven(t);
  const hintHTML = (be.left > 0 && be.elapsed > 0) ? `
    <div class="tc-hint${be.elapsed / be.span >= 0.5 ? ' good' : ''}">
      Buy back at <b>${fmtMoney(be.price)}</b> or less and closing now beats holding
      to expiry — ${fmtInt(be.elapsed)} of ${fmtInt(be.span)} days done, ${fmtInt(be.left)} left.
    </div>` : '';

  // The same call with somewhere better to put the money: when the watchlist
  // holds a candidate clearly beating this position's rate, the price worth
  // paying to get out rises by whatever that capital would earn there instead.
  // Same ticker is not a rotation, and a thin edge does not cover two spreads.
  const alt = _altBest;
  const altHTML = (alt && be.left > 0 && tradeCapital(t) > 0
                   && alt.ticker !== t.ticker && alt.roi >= roi * MIN_SWITCH_EDGE) ? `
    <div class="tc-hint" style="margin-top:-4px">
      Or up to <b>${fmtMoney(switchBreakeven(t, alt.roi).altPrice)}</b> if you roll the capital
      into <b>${esc(alt.ticker)}</b> ${fmtMoney(alt.strike)}p at ${fmtPct(alt.roi)}.
    </div>` : '';

  const rollHistHTML = rolled ? `
    <div class="roll-hist">
      <div class="roll-lbl">Roll History — ${t.rolls.length}×</div>
      <div class="roll-row orig">
        <span>Original</span>
        <span>${fmtMoney(t.strikePrice)} strike · ${fmtMoney(t.premium)} prem · ${fmtInt(t.dteAtExecution)}d</span>
      </div>
      ${t.rolls.map((r,i) => `
        <div class="roll-row">
          <span class="blue">Roll ${i+1} &nbsp;<span style="color:var(--text3);font-size:9px">${esc(r.dateRolled)}</span></span>
          <span>${fmtMoney(r.strikePrice)} · ${fmtMoney(r.premium)} · ${fmtInt(r.dte)}d</span>
        </div>`).join('')}
    </div>` : '';

  return `<div class="trade-card ${t.type}" id="tc-${esc(t.id)}">
    <div class="tc-main">
      <div class="tc-row1">
        <div class="tc-ticker">${esc(t.ticker)}</div>
        <div class="tc-badges">
          ${q > 1 ? `<span class="badge bdg-qty">×${q}</span>` : ''}
          ${rolled ? '<span class="badge bdg-rolled">rolled</span>' : ''}
          <span class="badge bdg-${t.type}">${esc(t.type.toUpperCase())}</span>
        </div>
      </div>
      <div class="tc-metrics">
        <div class="metric">
          <div class="m-label">Strike</div>
          <div class="m-val">${fmtMoney(cs)}</div>
        </div>
        <div class="metric">
          <div class="m-label">${rolled ? 'Total Prem' : 'Premium'}</div>
          <div class="m-val">${fmtMoney(tp)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Ann. ROI</div>
          <div class="m-val amber">${fmtPct(roi)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Days Left</div>
          <div class="m-val${drCls}">${drVal}</div>
        </div>
        <div class="metric">
          <div class="m-label">Income</div>
          <div class="m-val green">${fmtMoney(tp*100*q)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Opened</div>
          <div class="m-val" style="font-size:10px;color:var(--text3)">${esc(t.dateOpened)}</div>
        </div>
      </div>
    </div>
    ${hintHTML}
    ${altHTML}
    ${rollHistHTML}
    <div class="tc-actions">
      <button class="act-btn grn" onclick="openExpire('${t.id}')">Expired</button>
      <button class="act-btn blu" onclick="openRoll('${t.id}')">Roll</button>
      <button class="act-btn red" onclick="openClose('${t.id}')">Close</button>
      <button class="act-btn amb" onclick="openAssign('${t.id}')">Assign</button>
      <button class="act-btn ico" onclick="openDelete('${t.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════
   RENDER: STATS BAR
═══════════════════════════════════════ */
function updateStats() {
  const d      = load();
  const active = d.trades.filter(t => t.status === 'active');
  const closed = d.trades.filter(t => t.status !== 'active');
  const { roi, pnl } = weightedStats();

  // P&L — this year's realized total leads, all-time sits underneath
  const ytd   = ytdPnL(realizedItems(d));
  const pnlEl = document.getElementById('s-pnl-ytd');
  pnlEl.textContent = fmtSigned(ytd);
  pnlEl.className   = 'stat-value ' + (ytd > 0 ? 'pos' : ytd < 0 ? 'neg' : 'neu');
  document.getElementById('s-pnl-sub').textContent =
    `${fmtSigned(pnl)} total · ${fmtInt(closed.length)} closed`;

  // ROI
  const roiEl = document.getElementById('s-roi');
  if (closed.length) {
    roiEl.textContent = fmtPct(roi);
    roiEl.className   = 'stat-value ' + (roi >= 0 ? 'pos' : 'neg');
  } else {
    roiEl.textContent = '—';
    roiEl.className   = 'stat-value neu';
  }

  // Committed
  const lots      = loadPositions(d).filter(p => p.status === 'open');
  const committed = active.reduce((s,t) => s + tradeCapital(t), 0)
                  + lots.reduce((s,p) => s + positionCapital(p), 0);
  document.getElementById('s-committed').textContent = fmtMoney(committed);
  document.getElementById('s-committed-sub').textContent =
    fmtInt(active.length) + ' position' + (active.length!==1?'s':'')
    + (lots.length ? ` + ${fmtInt(lots.length)} share lot${lots.length!==1?'s':''}` : '');

  renderBackupReminder();
}

/* ═══════════════════════════════════════
   BACKUP REMINDER
═══════════════════════════════════════ */
function renderBackupReminder() {
  const el = document.getElementById('backup-reminder');
  if (!el) return;
  const hasTrades = load().trades.length > 0;
  const dismissed = sessionStorage.getItem('opts_backup_reminder_dismissed');
  const ts    = localStorage.getItem('opts_last_export');
  const stale = !ts || (Date.now() - new Date(ts).getTime()) > 30 * 86400000;
  if (!hasTrades || dismissed || !stale) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="backup-reminder">
      <div class="backup-reminder-txt">${ts
        ? 'Your last backup is over 30 days old.'
        : 'Your trades are only stored on this device.'} Export a backup to keep them safe.</div>
      <div class="backup-reminder-acts">
        <button class="br-btn br-primary" onclick="exportData();renderBackupReminder()">Export</button>
        <button class="br-btn" onclick="sessionStorage.setItem('opts_backup_reminder_dismissed','1');renderBackupReminder()">Later</button>
      </div>
    </div>`;
}

/* ═══════════════════════════════════════
   RENDER: ROI CALC
═══════════════════════════════════════ */
let vsMode = false;
let calcTypeB = 'call';

function toggleVS() {
  vsMode = !vsMode;
  const btn      = document.getElementById('vs-toggle-btn');
  const legB     = document.getElementById('leg-b-section');
  const legAHdr  = document.getElementById('leg-a-hdr');
  const cmpCard  = document.getElementById('vs-compare-card');
  const singleCard = document.getElementById('c-single-card');
  const singleBtn  = document.getElementById('exec-single-btn');
  const bd         = document.getElementById('c-breakdown');

  btn.classList.toggle('active', vsMode);
  legB.classList.toggle('show', vsMode);
  legAHdr.style.display   = vsMode ? 'flex' : 'none';
  cmpCard.classList.toggle('show', vsMode);
  singleCard.style.display  = vsMode ? 'none' : 'block';
  singleBtn.classList.toggle('hide', vsMode);
  if (vsMode) bd.style.display = 'none';
  calcUpdate();
}

function calcUpdate() {
  const p = parseFloat(document.getElementById('c-premium').value);
  const s = parseFloat(document.getElementById('c-strike').value);
  const d = parseFloat(document.getElementById('c-dte').value);

  if (vsMode) {
    // Leg A
    const roiA   = (p && s && d) ? roiPct(p, s, d) : null;
    const tickA  = document.getElementById('c-ticker').value.toUpperCase() || 'Leg A';
    // Leg B
    const p2 = parseFloat(document.getElementById('b-premium').value);
    const s2 = parseFloat(document.getElementById('b-strike').value);
    const d2 = parseFloat(document.getElementById('b-dte').value);
    const roiB  = (p2 && s2 && d2) ? roiPct(p2, s2, d2) : null;
    const tickB = document.getElementById('b-ticker').value.toUpperCase() || 'Leg B';

    // Update VS result card
    const elRoiA = document.getElementById('vs-roi-a');
    const elRoiB = document.getElementById('vs-roi-b');
    const elResA = document.getElementById('vs-res-a');
    const elResB = document.getElementById('vs-res-b');
    const elSubA = document.getElementById('vs-sub-a');
    const elSubB = document.getElementById('vs-sub-b');
    const diffRow = document.getElementById('vs-diff-row');

    document.getElementById('vs-ticker-a').textContent = tickA;
    document.getElementById('vs-ticker-b').textContent = tickB;

    elRoiA.textContent = roiA != null ? fmtPct(roiA) : '—';
    elRoiB.textContent = roiB != null ? fmtPct(roiB) : '—';
    elRoiA.className   = 'vs-leg-roi' + (roiA != null ? ' has-val' : '');
    elRoiB.className   = 'vs-leg-roi' + (roiB != null ? ' has-val' : '');

    // Clear winner state
    elResA.classList.remove('winner');
    elResB.classList.remove('winner');
    elRoiA.classList.remove('winner-val');
    elRoiB.classList.remove('winner-val');
    elSubA.innerHTML = '';
    elSubB.innerHTML = '';
    diffRow.classList.remove('show');

    if (roiA != null && roiB != null) {
      const diff = fmtNum(Math.abs(roiA - roiB));
      if (roiA >= roiB) {
        elResA.classList.add('winner');
        elRoiA.classList.add('winner-val');
        elSubA.innerHTML = '<span class="vs-winner-badge">Better ▲</span>';
        elSubB.textContent = `${fmtMoney(p2*100)} income`;
        document.getElementById('vs-diff-label').textContent = `${tickA} leads by`;
      } else {
        elResB.classList.add('winner');
        elRoiB.classList.add('winner-val');
        elSubB.innerHTML = '<span class="vs-winner-badge">Better ▲</span>';
        elSubA.textContent = `${fmtMoney(p*100)} income`;
        document.getElementById('vs-diff-label').textContent = `${tickB} leads by`;
      }
      document.getElementById('vs-diff-val').textContent = diff + '% annualized ROI';
      diffRow.classList.add('show');
    } else {
      if (roiA != null) elSubA.textContent = `${fmtMoney(p*100)} income · ${fmtInt(d)}d`;
      if (roiB != null) elSubB.textContent = `${fmtMoney(p2*100)} income · ${fmtInt(d2)}d`;
    }
    return;
  }

  // ── Single mode ──
  const bd = document.getElementById('c-breakdown');
  if (!p || !s || !d) {
    document.getElementById('c-roi').textContent = '—';
    document.getElementById('c-roi-sub').textContent = 'enter values to calculate';
    bd.style.display = 'none'; return;
  }
  const roi    = roiPct(p, s, d);
  const income = p * 100;
  document.getElementById('c-roi').textContent     = fmtPct(roi);
  document.getElementById('c-roi-sub').textContent =
    `${fmtMoney(income)} income on ${fmtMoney(s)} strike · ${fmtInt(d)}d`;
  bd.style.display = 'grid';
  document.getElementById('c-income').textContent  = fmtMoney(income);
  document.getElementById('c-period').textContent  = fmtPct((p/s)*100);
  document.getElementById('c-monthly').textContent = fmtPct(roi/12);
  document.getElementById('c-weekly').textContent  = fmtPct(roi/52);
}

function renderCalcAverages() {
  const { roi, monthly } = weightedStats();
  document.getElementById('c-avg-roi').textContent     = roi     ? fmtPct(roi)     : '—';
  document.getElementById('c-avg-monthly').textContent = monthly ? fmtPct(monthly) : '—';
}

function executeCalcTrade(leg) {
  leg = leg || 'a';
  const prefix = leg === 'b' ? 'b' : 'c';
  const p      = document.getElementById(`${prefix}-premium`).value;
  const s      = document.getElementById(`${prefix}-strike`).value;
  const d      = document.getElementById(`${prefix}-dte`).value;
  const ticker = document.getElementById(leg === 'b' ? 'b-ticker' : 'c-ticker').value;
  const type   = leg === 'b' ? calcTypeB : calcTypeVal;
  if (!p || !s || !d) { alert('Enter premium, strike, and DTE first'); return; }
  switchTab('portfolio');
  setTimeout(() => openAddModal({ ticker, premium: p, strike: s, dte: d, type }), 120);
}

// ── Leg B type toggle ──
function setBCalcType(t) {
  calcTypeB = t;
  document.getElementById('b-t-put').className  = 'tgl-btn' + (t === 'put'  ? ' t-put'  : '');
  document.getElementById('b-t-call').className = 'tgl-btn' + (t === 'call' ? ' t-call' : '');
}

// ── Leg B date ↔ DTE sync ──
function bSyncDateToDTE() {
  const v = dteFromDate(document.getElementById('b-expdate').value);
  if (v) document.getElementById('b-dte').value = v;
  calcUpdate();
}
function bSyncDTEToDate() {
  const v = dateFromDTE(document.getElementById('b-dte').value);
  if (v) document.getElementById('b-expdate').value = v;
}


/* ═══════════════════════════════════════
   RENDER: ANALYSIS
═══════════════════════════════════════ */
/* Group realized items and measure each group the same way */
function breakdown(items, keyFn) {
  const g = {};
  items.forEach(i => { const k = keyFn(i); if (k != null) (g[k] = g[k] || []).push(i); });
  return Object.entries(g).map(([key, list]) => ({
    key, n: list.length,
    pnl:  list.reduce((s,i) => s + i.pnl, 0),
    roi:  itemsROI(list),
    wins: list.filter(i => i.pnl > 0).length,
    days: list.reduce((s,i) => s + i.days, 0) / list.length
  })).sort((a,b) => b.roi - a.roi);
}

// The term written is the decision the trader makes, so bucket by that
function dteBucket(t) {
  const d = t.dteAtExecution || 0;
  if (d <= 7)  return '0–7d';
  if (d <= 21) return '8–21d';
  if (d <= 45) return '22–45d';
  return '46d+';
}

function breakdownCardHTML(title, sub, rows, cols) {
  if (!rows.length) return '';
  return `<div class="brk-card">
    <div class="brk-hdr"><div class="brk-title">${title}</div><div class="brk-sub">${sub}</div></div>
    <div class="brk-row head">
      <div>${cols[0]}</div><div class="brk-val">${cols[1]}</div>
      <div class="brk-val">${cols[2]}</div><div class="brk-val">${cols[3]}</div>
    </div>
    ${rows.join('')}
  </div>`;
}

function groupRowHTML(g) {
  return `<div class="brk-row">
    <div class="brk-name">${esc(g.key)}<div style="font-size:8px;color:var(--text3);font-weight:400">
      ${fmtInt(g.n)} trade${g.n===1?'':'s'} · ${fmtInt(g.days)}d avg</div></div>
    <div class="brk-val">${fmtPct(g.wins / g.n * 100)}</div>
    <div class="brk-val ${g.pnl>=0?'green':'red'}">${fmtSigned(g.pnl)}</div>
    <div class="brk-val amber">${fmtPct(g.roi)}</div>
  </div>`;
}

/* The per-position detail the History tab used to carry, folded into the
   month the position closed in: what was written, what it earned, how long
   the capital was actually tied up, and what that annualizes to. */
function closedItemMeta(i) {
  if (i.kind === 'shares') {
    const p     = i.ref;
    const prem  = positionPremiums(p);
    const cycle = i.pnl + prem;
    const roi   = positionCapital(p) > 0 ? (cycle / positionCapital(p)) * (365 / i.days) * 100 : 0;
    return `${fmtMoney(p.costBasis)} → ${fmtMoney(p.closeInfo?.pricePerShare || 0)}
      · stock <b>${fmtSigned(i.pnl)}</b> + premiums <b>${fmtMoney(prem)}</b>
      · ${fmtInt(i.days)}d · <b>${fmtPct(roi)}</b> cycle ROI
      · ${esc(p.dateAcquired)} → ${esc(p.closeInfo?.dateClosed || '')}`;
  }
  const t     = i.ref;
  const tp    = totalPremiums(t);
  const perSh = t.status === 'closed_early' ? tp - (t.closeInfo?.buyingPrice || 0) : tp;
  const roi   = roiPct(perSh, currentStrike(t), i.days);
  const rolls = (t.rolls || []).length;
  return `premium <b>${fmtMoney(tp)}</b>${t.status === 'closed_early'
      ? ` less <b>${fmtMoney(t.closeInfo?.buyingPrice || 0)}</b> bought back` : ''}
    · ${fmtInt(i.days)}d · <b>${fmtPct(roi)}</b> ann. ROI${rolls ? ` · rolled ${fmtInt(rolls)}×` : ''}
    · ${esc(t.dateOpened)} → ${esc(tradeEndDate(t))}`;
}

function renderAnalysis() {
  const d      = load();
  const items  = realizedItems(d);
  const active = d.trades.filter(t => t.status === 'active');
  const lots   = loadPositions(d).filter(p => p.status === 'open');
  const el     = document.getElementById('analysis-content');
  if (!items.length && !active.length && !lots.length) {
    el.innerHTML = `<div class="empty"><div class="empty-txt">No trades to analyze yet</div></div>`;
    return;
  }

  const { roi: overallROI, monthly: overallMonthly, pnl: overallPnL } = weightedStats();
  const wins    = items.filter(i => i.pnl > 0).length;
  const avgDays = items.length ? items.reduce((s,i) => s + i.days, 0) / items.length : 0;
  const ytd     = ytdPnL(items);

  let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div class="stat-card">
        <div class="stat-label">Total Realized P&L</div>
        <div class="stat-value ${overallPnL>=0?'pos':'neg'}">${fmtSigned(overallPnL)}</div>
        <div class="stat-sub">${fmtSigned(ytd)} YTD · ${fmtInt(items.length)} closed</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Monthly ROI</div>
        <div class="stat-value ${overallMonthly>=0?'pos':'neg'}">${fmtPct(overallMonthly)}</div>
        <div class="stat-sub">${items.length ? fmtPct(overallROI) + ' annualized' : 'weighted by capital-days'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value neu">${items.length ? fmtPct(wins / items.length * 100) : '—'}</div>
        <div class="stat-sub">${fmtInt(wins)} of ${fmtInt(items.length)} profitable</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Days Held</div>
        <div class="stat-value neu">${items.length ? fmtInt(avgDays) + 'd' : '—'}</div>
        <div class="stat-sub">capital turnover</div>
      </div>
    </div>`;

  /* ── Concentration & assignment risk ──
     Committed capital as one number hides the question that matters to a
     put seller: if everything is assigned, what do I owe, and how much of
     it rides on a single ticker? */
  const exposure = {};
  active.filter(t => t.type === 'put').forEach(t => {
    exposure[t.ticker] = (exposure[t.ticker] || 0) + currentStrike(t) * 100 * tradeQty(t);
  });
  lots.forEach(p => { exposure[p.ticker] = (exposure[p.ticker] || 0) + positionCapital(p); });
  const exposureRows = Object.entries(exposure).sort((a,b) => b[1] - a[1]);
  const totalExposure = exposureRows.reduce((s,[,v]) => s + v, 0);
  const putObligation = active.filter(t => t.type === 'put')
    .reduce((s,t) => s + currentStrike(t) * 100 * tradeQty(t), 0);

  if (exposureRows.length) {
    const top = exposureRows[0];
    const topShare = totalExposure ? top[1] / totalExposure * 100 : 0;
    html += `<div class="bt-preview-hdr">Risk</div>`;
    if (putObligation > 0) {
      html += `<div class="risk-note">
        If every open put is assigned you need <b>${fmtMoney(putObligation)}</b> in cash to take
        delivery${lots.length ? `, on top of ${fmtMoney(lots.reduce((s,p) => s + positionCapital(p), 0))} already in shares` : ''}.
      </div>`;
    }
    html += breakdownCardHTML('Concentration', 'capital at risk by ticker',
      exposureRows.map(([tk, v]) => {
        const share = totalExposure ? v / totalExposure * 100 : 0;
        return `<div class="brk-row" style="grid-template-columns:1.4fr 1fr 1.6fr">
          <div class="brk-name">${esc(tk)}</div>
          <div class="brk-val">${fmtMoney(v)}</div>
          <div>
            <div class="brk-val">${fmtPct(share)}</div>
            <div class="brk-bar"><div class="brk-bar-fill${share >= 40 ? ' hot' : ''}" style="width:${Math.min(100, share).toFixed(1)}%"></div></div>
          </div>
        </div>`;
      }), ['Ticker', 'Exposure', 'Share', '']);
    if (topShare >= 40) {
      html += `<div class="risk-note"><b>${esc(top[0])}</b> is ${fmtPct(topShare)} of everything
        you have at risk. One earnings miss moves most of the book.</div>`;
    }
  }

  /* ── Capital efficiency: what to close first ── */
  if (active.length) {
    const ranked = active
      .map(t => ({ t, capital: tradeCapital(t), roi: positionRate(t) }))
      .sort((a,b) => b.roi - a.roi);
    html += `<div class="bt-preview-hdr">Capital Efficiency</div>`;
    // Only call something the weakest when it is actually behind the best —
    // on a tie there is nothing to single out.
    const worst = ranked.length > 1 && ranked[ranked.length-1].roi < ranked[0].roi
      ? ranked.length - 1 : -1;
    html += breakdownCardHTML('Open positions', 'annualized, best first',
      ranked.map((r,i) => `<div class="brk-row" style="grid-template-columns:1.4fr 1fr 1fr">
        <div class="brk-name">${esc(r.t.ticker)}
          <div style="font-size:8px;color:var(--text3);font-weight:400">
            ${esc(r.t.type.toUpperCase())} ${fmtMoney(currentStrike(r.t))}${tradeQty(r.t)>1?' ×'+fmtInt(tradeQty(r.t)):''}
            ${i === worst ? ' · weakest' : ''}</div></div>
        <div class="brk-val">${r.capital ? fmtMoney(r.capital) : 'covered'}</div>
        <div class="brk-val ${i === worst ? 'red' : 'amber'}">${fmtPct(r.roi)}</div>
      </div>`), ['Position', 'Capital', 'Ann. ROI', '']);
  }

  /* ── What actually works ── */
  if (items.length) {
    const optionItems = items.filter(i => i.kind === 'option');
    html += `<div class="bt-preview-hdr">What Works</div>`;
    html += breakdownCardHTML('By term written', 'days to expiry at entry',
      breakdown(optionItems, i => dteBucket(i.ref)).map(groupRowHTML),
      ['Term', 'Win', 'P&L', 'Ann. ROI']);
    html += breakdownCardHTML('By ticker', 'where the returns come from',
      breakdown(items, i => i.ticker).slice(0, 8).map(groupRowHTML),
      ['Ticker', 'Win', 'P&L', 'Ann. ROI']);
    html += breakdownCardHTML('By type', 'puts vs calls vs shares',
      breakdown(items, i => i.kind === 'shares' ? 'Shares' : i.ref.type.toUpperCase()).map(groupRowHTML),
      ['Type', 'Win', 'P&L', 'Ann. ROI']);
  }

  /* ── Month by month ── */
  const byMonth = {};
  items.forEach(i => { const k = String(i.date).slice(0,7); (byMonth[k] = byMonth[k]||[]).push(i); });
  if (Object.keys(byMonth).length) html += `<div class="bt-preview-hdr">Month by Month</div>`;

  Object.keys(byMonth).sort().reverse().forEach(mk => {
    const mItems = byMonth[mk];
    const mPnL   = mItems.reduce((s,i) => s + i.pnl, 0);
    const mROI   = itemsROI(mItems);
    const [y,m]  = mk.split('-');
    const mName  = new Date(+y, +m-1).toLocaleString('default',{month:'long',year:'numeric'});
    html += `<div class="month-card">
      <div class="mc-hdr">
        <div class="mc-name">${mName}</div>
        <div class="mc-stats">
          <div class="mc-stat">
            <div class="mc-stat-val ${mROI>=0?'amber':'red'}">${fmtPct(mROI)}</div>
            <div class="mc-stat-lbl">ROI</div>
          </div>
          <div class="mc-stat">
            <div class="mc-stat-val ${mPnL>=0?'green':'red'}">${fmtSigned(mPnL)}</div>
            <div class="mc-stat-lbl">P&L</div>
          </div>
        </div>
      </div>
      <div class="mc-trades">
        ${mItems.map(i => {
          const r = i.ref;
          const label = i.kind === 'shares'
            ? `${fmtInt(r.shares)} shares at ${fmtMoney(r.costBasis)}`
            : `${esc(r.type.toUpperCase())} ${fmtMoney(currentStrike(r))}${tradeQty(r)>1?' ×'+fmtInt(tradeQty(r)):''}`;
          const state = i.kind === 'shares'
            ? (r.closeInfo?.reason === 'called_away' ? 'called away' : 'sold')
            : (r.status === 'expired' ? 'exp' : r.status === 'assigned' ? 'assigned' : 'closed');
          return `<div class="mc-trade-row">
            <div class="mc-trade-top">
              <div><b>${esc(i.ticker)}</b><span class="muted"> · ${label}</span></div>
              <div><span class="${i.pnl>=0?'green':'red'}">${fmtSigned(i.pnl)}</span>
                <span class="muted"> · ${state}</span></div>
            </div>
            <div class="mc-trade-meta">${closedItemMeta(i)}</div>
          </div>`;}).join('')}
      </div>
    </div>`;
  });
  el.innerHTML = html;
}

/* ═══════════════════════════════════════
   WATCHLIST — MARKET DATA
   Names you are thinking about selling puts on. For each one the app wants
   three things: where the stock is, what it did today, and what the market
   is paying for a put roughly 45 days out at 5% and 10% below spot — with
   the same annualized ROI the rest of the app measures trades by, so a
   candidate can be compared against what you already hold.

   Quotes come from public delayed feeds, tried in order, and the last good
   answer for each ticker is kept in localStorage so the tab is never blank
   and works offline. Nothing here is a fill — see the note on the tab.
═══════════════════════════════════════ */
const MARKET_KEY   = 'opts_market_v1';
const PROXY_KEY    = 'opts_quote_proxy';
const TARGET_DTE   = 45;   // the term this strategy is written at
const DTE_WINDOW   = 7;    // an expiration this far either side still counts
const OTM_TARGETS  = [5, 10];
const MAX_WATCH    = 40;
const STALE_DAYS   = 4;    // beyond this a stored quote stops driving advice
const MIN_SWITCH_EDGE = 1.25;   // a candidate must beat a position by this much to be worth the swap

const loadMarket = () => {
  try { return JSON.parse(localStorage.getItem(MARKET_KEY)) || {} } catch (e) { return {} }
};
const saveMarket = m => {
  try { localStorage.setItem(MARKET_KEY, JSON.stringify(m)) } catch (e) { /* quota — quotes are disposable */ }
};
const marketQuotes = () => loadMarket().quotes || {};

// The watchlist itself lives with the trades, so it travels in a backup —
// as does the note against each ticker. Quotes deliberately do not: they are
// derived, they go stale, and a backup should not carry yesterday's prices.
const loadWatchlist  = d => ((d || load()).watchlist || []).slice();
const loadWatchNotes = d => ((d || load()).watchNotes) || {};

function saveWatchlist(list) {
  const d = load();
  d.watchlist = list;
  save(d);
}
function saveWatchNote(tk, note) {
  const d = load();
  d.watchNotes = d.watchNotes || {};
  const txt = String(note || '').trim().slice(0, 80);
  if (txt) d.watchNotes[tk] = txt; else delete d.watchNotes[tk];
  save(d);
}

/* ── Preferences ──
   How the list is ordered, and the annualized yield worth being told about. */
const SORT_KEY   = 'opts_wl_sort';
const TARGET_KEY = 'opts_wl_target';

const watchSort   = () => (localStorage.getItem(SORT_KEY) === 'roi' ? 'roi' : 'added');
const watchTarget = () => { const n = parseFloat(localStorage.getItem(TARGET_KEY)); return n > 0 ? n : null; };

function toggleWatchSort() {
  localStorage.setItem(SORT_KEY, watchSort() === 'roi' ? 'added' : 'roi');
  renderWatchlist();
}

function configureWatchTarget() {
  const cur = watchTarget();
  const val = prompt(
    'Annualized ROI worth being told about, as a percentage.\n\n'
    + 'Cards at or above it are marked, and — with expiry reminders switched on — a\n'
    + 'scheduled update will notify you when one crosses it.\n\n'
    + 'Leave blank to switch it off.', cur == null ? '' : String(cur));
  if (val === null) return;
  const v = val.trim();
  if (!v) { localStorage.removeItem(TARGET_KEY); renderWatchlist(); return; }
  const n = parseFloat(v);
  if (!(n > 0) || n > 1000) { alert('Enter a percentage between 0 and 1000, e.g. 20'); return; }
  localStorage.setItem(TARGET_KEY, String(n));
  renderWatchlist();
}

// The best leg on a card, which is what the target is measured against
function bestLeg(q) {
  if (!q || !q.legs) return null;
  return q.legs.reduce((b, l) => (!l.missing && l.roi > 0 && (!b || l.roi > b.roi)) ? l : b, null);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Fetching ──
   A quote feed that hangs is worse than one that fails, so every request is
   bounded. An optional user-supplied CORS proxy is tried only as a second
   pass, after a direct request has already failed. */
function quoteProxy() { return localStorage.getItem(PROXY_KEY) || ''; }

function apiURL(url, viaProxy) {
  const p = quoteProxy();
  return (viaProxy && p) ? p + encodeURIComponent(url) : url;
}

function fetchJSON(url, viaProxy, ms = 12000) {
  const ctl   = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort() } catch (e) {} }, ms);
  return fetch(apiURL(url, viaProxy), { cache: 'no-store', mode: 'cors', signal: ctl ? ctl.signal : undefined })
    .then(r => {
      if (r.status === 429) throw Object.assign(new Error('rate limited'), { rateLimited: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

const numOrNull = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

/* ── OCC option symbols ──
   AAPL260220P00150000 → Feb 20 2026 put, $150 strike. The last 15 characters
   are fixed-width, so read from the end and whatever precedes them is the
   root — roots contain digits often enough that reading from the front is
   not safe. */
function parseOcc(sym) {
  const s = String(sym || '').replace(/\s+/g, '').toUpperCase();
  const m = /^(.+?)(\d{6})([CP])(\d{8})$/.exec(s);
  if (!m) return null;
  const [, root, ymd, cp, strike] = m;
  return {
    root,
    expiry: `20${ymd.slice(0,2)}-${ymd.slice(2,4)}-${ymd.slice(4,6)}`,
    type:   cp === 'P' ? 'put' : 'call',
    strike: parseInt(strike, 10) / 1000
  };
}

const isoFromUnix = s => new Date(numOr0(s) * 1000).toISOString().slice(0, 10);

/* ── Provider: Massive (formerly Polygon.io) ──
   The only one of these that is an actual data product rather than a public
   endpoint being read sideways: a free Options Basic key, 15-minute delayed,
   5 requests a minute. It matters here for one structural reason — the key
   goes in a query parameter rather than a header, so the request stays a
   simple GET with no preflight, which is the shape most likely to survive
   the browser's cross-origin rules.

   Two calls per ticker. The chain snapshot is filtered server-side to the
   expirations this strategy cares about, so the response stays small; the
   previous close comes from the aggregates endpoint, which is what turns a
   price into the day's move. */
const MASSIVE_KEY  = 'opts_massive_key';
const RELAY_KEY    = 'opts_massive_relay_key';
const massiveKey   = () => (localStorage.getItem(MASSIVE_KEY) || '').trim();
// The better arrangement: the key lives as a secret on your own relay and is
// attached at the edge, so it is never on the phone and never in a URL.
const relayHoldsKey  = () => localStorage.getItem(RELAY_KEY) === '1';
const massiveEnabled = () => !!massiveKey() || relayHoldsKey();

// A relay sees the whole URL, and for Massive the key is in the URL. Somebody
// else's relay therefore must never carry it — a leaked key is spendable by
// whoever reads it. Your own relay is fine; that is the point of Custom.
const proxyIsPublic = () => {
  const p = quoteProxy();
  return !!p && SOURCE_PRESETS.some(s => s.pub && s.prefix === p);
};

async function providerMassive(ticker, viaProxy) {
  const key = massiveKey();
  if (!key && !relayHoldsKey()) throw new Error('no API key set');
  if (viaProxy && proxyIsPublic()) throw new Error('skipped — a key is never sent through a public relay');
  // With the key held by the relay there is nothing to authenticate a direct
  // request with, so that pass is skipped rather than sent to be rejected.
  if (!key && !viaProxy) throw new Error('relay holds the key — needs the relay route');
  const auth = key ? `&apiKey=${encodeURIComponent(key)}` : '';
  const t = encodeURIComponent(ticker);

  // Ask only for the expirations that could win, widening once if the
  // window is empty (a thin chain, or a holiday-shifted cycle).
  let results = [];
  for (const [lo, hi] of [[TARGET_DTE - DTE_WINDOW, TARGET_DTE + DTE_WINDOW], [20, 90]]) {
    const j = await fetchJSON(
      `https://api.massive.com/v3/snapshot/options/${t}`
      + `?contract_type=put&limit=250`
      + `&expiration_date.gte=${dateOffset(lo)}&expiration_date.lte=${dateOffset(hi)}`
      + auth, viaProxy);
    results = Array.isArray(j?.results) ? j.results : [];
    if (results.length) break;
  }
  if (!results.length) throw new Error('no put contracts returned');

  const chain = [];
  let price = null;
  results.forEach(r => {
    const d = r?.details;
    const strike = numOrNull(d?.strike_price);
    const expiry = d?.expiration_date;
    if (strike == null || strike <= 0 || !DATE_RE.test(expiry || '')) return;
    if (price == null) price = numOrNull(r?.underlying_asset?.price);
    chain.push({
      expiry, strike,
      bid:  numOrNull(r?.last_quote?.bid) ?? 0,
      ask:  numOrNull(r?.last_quote?.ask) ?? 0,
      // Free entitlements may withhold live quotes; the contract's own close
      // is the honest fallback and is labelled "last" on the card.
      last: numOrNull(r?.last_trade?.price) ?? numOrNull(r?.day?.close) ?? 0,
      oi:   numOrNull(r?.open_interest) ?? 0
    });
  });
  if (!chain.length) throw new Error('no usable contracts');

  // Previous close — gives the day's move, and stands in for the underlying
  // price when the plan does not include it on the snapshot.
  let prevClose = null;
  try {
    const p = await fetchJSON(
      `https://api.massive.com/v2/aggs/ticker/${t}/prev?adjusted=true` + auth, viaProxy);
    prevClose = numOrNull(p?.results?.[0]?.c);
    if (price == null) price = prevClose;
  } catch (e) { /* the chain is the point; the day's move is a bonus */ }

  if (price == null || price <= 0) throw new Error('no underlying price');
  return {
    price, prevClose,
    changePct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : null,
    chain, source: 'Massive'
  };
}

/* ── Provider: Cboe delayed quotes ──
   One request returns the underlying and its whole option chain, which is
   exactly the shape this tab needs. */
const CBOE_INDEX = ['SPX','VIX','NDX','RUT','DJX','XSP','OEX','XEO'];
const cboeSymbol = t => (CBOE_INDEX.includes(t) ? '_' + t : t.replace(/\./g, ''));

async function providerCboe(ticker, viaProxy) {
  const j = await fetchJSON(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(cboeSymbol(ticker))}.json`,
    viaProxy);
  const d = j && j.data;
  if (!d || !Array.isArray(d.options)) throw new Error('unexpected response');
  const price = numOrNull(d.current_price) ?? numOrNull(d.last_trade_price) ?? numOrNull(d.close);
  if (price == null || price <= 0) throw new Error('no price');
  const chain = [];
  d.options.forEach(o => {
    const p = parseOcc(o.option);
    if (!p || p.type !== 'put') return;
    chain.push({
      expiry: p.expiry, strike: p.strike,
      bid:  numOrNull(o.bid)  ?? 0,
      ask:  numOrNull(o.ask)  ?? 0,
      last: numOrNull(o.last_trade_price) ?? 0,
      oi:   numOrNull(o.open_interest) ?? 0
    });
  });
  return {
    price,
    prevClose: numOrNull(d.prev_day_close) ?? numOrNull(d.close),
    changePct: numOrNull(d.price_change_percent),
    chain, source: 'Cboe'
  };
}

/* ── Provider: Yahoo Finance ──
   Two requests: the first gives the quote and the list of expirations, the
   second the chain for the one expiration we actually want. */
async function providerYahoo(ticker, viaProxy) {
  const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`;
  const first = await fetchJSON(base, viaProxy);
  const res   = first?.optionChain?.result?.[0];
  if (!res) throw new Error('unexpected response');
  const q     = res.quote || {};
  const price = numOrNull(q.regularMarketPrice);
  if (price == null || price <= 0) throw new Error('no price');
  const out = {
    price,
    prevClose: numOrNull(q.regularMarketPreviousClose),
    changePct: numOrNull(q.regularMarketChangePercent),
    chain: [], source: 'Yahoo'
  };

  const exps = (res.expirationDates || []).map(isoFromUnix);
  const pick = pickExpiry(exps);
  if (!pick) return out;
  const unix = Math.floor(new Date(pick.iso + 'T00:00:00Z').getTime() / 1000);
  const second = await fetchJSON(`${base}?date=${unix}`, viaProxy);
  const puts   = second?.optionChain?.result?.[0]?.options?.[0]?.puts || [];
  puts.forEach(o => {
    const strike = numOrNull(o.strike);
    if (strike == null || strike <= 0) return;
    out.chain.push({
      expiry: o.expiration ? isoFromUnix(o.expiration) : pick.iso,
      strike,
      bid:  numOrNull(o.bid) ?? 0,
      ask:  numOrNull(o.ask) ?? 0,
      last: numOrNull(o.lastPrice) ?? 0,
      oi:   numOrNull(o.openInterest) ?? 0
    });
  });
  return out;
}

/* ── Provider: Yahoo chart (price only) ──
   Last resort. A card with a price and no premiums is still worth showing —
   the premiums can be typed in by hand. */
async function providerYahooPrice(ticker, viaProxy) {
  const j = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`,
    viaProxy);
  const meta = j?.chart?.result?.[0]?.meta;
  const price = numOrNull(meta?.regularMarketPrice);
  if (price == null || price <= 0) throw new Error('no price');
  return {
    price,
    prevClose: numOrNull(meta.chartPreviousClose) ?? numOrNull(meta.previousClose),
    changePct: null, chain: [], source: 'Yahoo (price only)'
  };
}

/* Massive leads when a key is set — it is the only one of these anybody is
   entitled to read from a browser. The scrapes stay on as a fallback. */
const SCRAPE_PROVIDERS = [
  { name: 'Cboe',     fn: providerCboe },
  { name: 'Yahoo',    fn: providerYahoo },
  { name: 'Yahoo·px', fn: providerYahooPrice }
];
const providers = () => (massiveEnabled()
  ? [{ name: 'Massive', fn: providerMassive }, ...SCRAPE_PROVIDERS]
  : SCRAPE_PROVIDERS);

/* Try each provider directly; only if every one fails do we make a second
   pass through the configured proxy, so a working direct route is never
   routed through someone else's server. */
async function fetchQuote(ticker) {
  const errs = [];
  let backedOff = false;   // one pause per ticker, however many feeds throttle
  for (const viaProxy of (quoteProxy() ? [false, true] : [false])) {
    for (const p of providers()) {
      try {
        const r = await p.fn(ticker, viaProxy);
        if (viaProxy) r.source += ' via proxy';
        return r;
      } catch (e) {
        errs.push(`${p.name}: ${e.message || e}`);
        if (e.rateLimited && !backedOff) { backedOff = true; await sleep(20000); }
      }
    }
  }
  throw new Error(errs.join(' · '));
}

/* ── Picking the contract ──
   The strategy is a ~45-day put, so take the listed expiration closest to 45
   days out, preferring one inside the ±7-day window; if the chain has nothing
   in that window, use the closest there is and say so on the card. */
function pickExpiry(isoList, fromISO) {
  const from  = fromISO || todayStr();
  const cands = Array.from(new Set(isoList))
    .map(iso => ({ iso, dte: daysBetween(from, iso) }))
    .filter(e => DATE_RE.test(e.iso) && e.dte > 0);
  if (!cands.length) return null;
  const inWindow = cands.filter(e => Math.abs(e.dte - TARGET_DTE) <= DTE_WINDOW);
  const pool = inWindow.length ? inWindow : cands;
  pool.sort((a,b) => Math.abs(a.dte - TARGET_DTE) - Math.abs(b.dte - TARGET_DTE) || a.dte - b.dte);
  return { ...pool[0], offTarget: !inWindow.length };
}

// Prefer a strike at or below the target — at least as far out of the money
// as asked for. Only when the chain has nothing below do we go the other way.
function pickStrike(puts, target) {
  const below = puts.filter(o => o.strike <= target);
  const pool  = below.length ? below : puts;
  if (!pool.length) return null;
  return pool.slice().sort((a,b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
}

// Mid of a two-sided market, else the bid, else the last trade — and always
// say which, because a last trade on an illiquid strike can be days old.
function legPremium(o) {
  if (o.bid > 0 && o.ask > 0 && o.ask >= o.bid) return { premium: (o.bid + o.ask) / 2, basis: 'mid' };
  if (o.bid > 0)  return { premium: o.bid,  basis: 'bid' };
  if (o.last > 0) return { premium: o.last, basis: 'last' };
  return null;
}

function buildLegs(price, chain) {
  const exp = pickExpiry((chain || []).map(o => o.expiry));
  if (!exp) return null;
  const puts = chain.filter(o => o.expiry === exp.iso && o.strike > 0);
  if (!puts.length) return null;
  return {
    expiry: exp.iso, dte: exp.dte, offTarget: exp.offTarget,
    legs: OTM_TARGETS.map(pct => {
      const o = pickStrike(puts, price * (1 - pct / 100));
      if (!o) return { pct, missing: 'no strike' };
      const p = legPremium(o);
      if (!p) return { pct, strike: o.strike, missing: 'not quoted' };
      return {
        pct, strike: o.strike,
        otmPct:  (price - o.strike) / price * 100,
        premium: p.premium, basis: p.basis,
        oi: o.oi, expiry: exp.iso, dte: exp.dte,
        roi: roiPct(p.premium, o.strike, exp.dte)
      };
    })
  };
}

/* ── Refresh ──
   Symbols are fetched one at a time with a gap between them. A scheduled run
   spreads itself over minutes on purpose: these are free public endpoints and
   a burst from every open copy of the app at 9:31:00 is what gets throttled.
   A manual refresh is a single deliberate act, so it uses a short gap. */
/* Massive's free tier allows 5 requests a minute and this makes two calls per
   ticker — chain plus previous close — so a symbol every 26 seconds keeps a
   run comfortably inside the allowance. Without a key the limits are whatever
   the public endpoints tolerate, where the concern is politeness rather than a
   published number. A scheduled run is meant to take minutes; a manual one is
   a single deliberate act and hurries, but never past the quota. */
const STAGGER_SCHEDULED = 9000;
const STAGGER_MANUAL    = 1200;
const STAGGER_JITTER    = 3000;
const STAGGER_KEYED     = 26000;
const staggerFor = manual => massiveEnabled()
  ? STAGGER_KEYED
  : (manual ? STAGGER_MANUAL : STAGGER_SCHEDULED);

let _wlRunning = false;
let _wlPending = {};      // ticker → true while its request is in flight

// Returns true when a fresh quote landed, so callers can tell "the feed is
// unreachable" apart from "this one ticker is bad".
async function refreshOne(ticker) {
  _wlPending[ticker] = true;
  const m = loadMarket();
  m.quotes = m.quotes || {};
  let ok = false;
  try {
    const raw  = await fetchQuote(ticker);
    const legs = raw.chain.length ? buildLegs(raw.price, raw.chain) : null;
    const chg  = raw.changePct != null ? raw.changePct
      : (raw.prevClose > 0 ? (raw.price - raw.prevClose) / raw.prevClose * 100 : null);
    m.quotes[ticker] = {
      ticker, price: raw.price, prevClose: raw.prevClose, changePct: chg,
      source: raw.source, asOf: new Date().toISOString(),
      expiry: legs?.expiry || null, dte: legs?.dte || null,
      offTarget: !!legs?.offTarget, legs: legs?.legs || null,
      error: legs ? null : 'no option chain in the response'
    };
    ok = true;
  } catch (e) {
    // Keep the last good quote — a stale price beats an empty card. Record
    // the failure alongside it so the card can say what went wrong and when.
    const prev = m.quotes[ticker] || { ticker };
    m.quotes[ticker] = { ...prev, error: String(e.message || e).slice(0, 300), errorAt: new Date().toISOString() };
  }
  saveMarket(m);
  delete _wlPending[ticker];
  return ok;
}

/* ── The relay's own collection ──
   When the relay is collecting on a schedule, everything the app needs is
   already sitting there: one request, however long the phone was closed, and
   no rate-limit stagger to sit through. What comes back is the raw filtered
   chain, so strike selection and ROI run here, through the same code that
   handles a direct fetch — one implementation of the maths, not two. */
const relayBase = () => {
  const p = quoteProxy();
  if (!p || proxyIsPublic()) return null;
  try { return new URL(p).origin; } catch (e) { return null; }
};

// The relay collects on a schedule, so it has to know what to collect.
function syncWatchlistToRelay() {
  const base = relayBase();
  if (!base || navigator.onLine === false) return;
  fetch(`${base}/watch?set=${encodeURIComponent(loadWatchlist().join(','))}`,
        { cache: 'no-store', mode: 'cors' }).catch(() => {});
}

/* Returns both how many quotes landed and how many watched tickers the
   snapshot had anything to say about. The second is what decides whether the
   relay has spoken: if it reports a rate limit or a bad symbol, that is the
   answer, and re-asking the feeds directly would only bury a useful message
   under the CORS failures that sent us to a relay in the first place. */
function applySnapshot(snap) {
  const watching = loadWatchlist();
  const m = loadMarket();
  m.quotes = m.quotes || {};
  let n = 0, seen = 0;
  Object.entries(snap?.quotes || {}).forEach(([tk, raw]) => {
    if (!watching.includes(tk) || !raw) return;
    if (!raw.chain?.length) {
      if (raw.error) {
        m.quotes[tk] = { ...(m.quotes[tk] || { ticker: tk }), error: raw.error, errorAt: raw.errorAt };
        seen++;
      }
      return;
    }
    const legs = buildLegs(raw.price, raw.chain);
    m.quotes[tk] = {
      ticker: tk, price: raw.price, prevClose: raw.prevClose ?? null,
      changePct: raw.changePct ?? null,
      source: raw.source || 'relay', asOf: raw.asOf || snap.updated || new Date().toISOString(),
      premarket: !!(raw.premarket ?? snap.premarket),
      expiry: legs?.expiry || null, dte: legs?.dte || null,
      offTarget: !!legs?.offTarget, legs: legs?.legs || null,
      error: legs ? null : 'no usable contracts in the snapshot'
    };
    n++; seen++;
  });
  if (seen) { if (n) m.lastRun = snap.updated || new Date().toISOString(); saveMarket(m); }
  return { fresh: n, seen };
}

async function pullSnapshot() {
  const base = relayBase();
  if (!base) return { fresh: 0, seen: 0 };
  try {
    // Straight to the relay, not through it — this is its own endpoint
    return applySnapshot(await fetchJSON(`${base}/snapshot`, false));
  } catch (e) { return { fresh: 0, seen: 0 }; }
}

// Returns how many tickers came back with a fresh quote.
async function refreshWatchlist(manual, slotLabel) {
  const list = loadWatchlist();
  if (_wlRunning || !list.length) return 0;
  if (navigator.onLine === false) {
    if (manual) showToast('Offline — showing the last prices fetched', null, null, 4000);
    return 0;
  }
  _wlRunning = true;
  renderWatchlist();

  // A collecting relay makes the whole per-ticker walk unnecessary. Once it
  // has answered for anything on the list, its answer stands.
  const snap = await pullSnapshot();
  if (snap.seen) {
    _wlRunning = false;
    if (slotLabel) { const mm = loadMarket(); mm.lastSlot = slotLabel; saveMarket(mm); }
    renderWatchlist(); renderActive();
    return snap.fresh;
  }

  const gap = staggerFor(manual);
  let fresh = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      if (i) await sleep(gap + Math.random() * STAGGER_JITTER);
      if (await refreshOne(list[i])) fresh++;
      renderWatchlist();
    }
  } finally {
    _wlRunning = false;
    if (fresh) {
      const m = loadMarket();
      m.lastRun = new Date().toISOString();
      if (slotLabel) m.lastSlot = slotLabel;
      saveMarket(m);
    }
    renderWatchlist();
    renderActive();          // the close-vs-switch hints move with the quotes
  }
  return fresh;
}

/* ── Schedule: 9:31 am and noon, New York time ──
   A page with no server can only act while it is open, so rather than firing
   on a timer alone every entry point asks the same question: has a slot for
   today gone by without a run? If it has, run it now. Opening the app at 3pm
   catches up the most recent slot rather than replaying both.

   The few minutes of stagger are per install, per day: a stable random offset
   after the slot time, so two phones running this do not hit the same feed on
   the same second. */
/* Through the session rather than only its first half. The regular hours are
   9:30 to 4:00, so these sit about two and a half hours apart, with the last
   deliberately closer to the bell than to the one before it — an evening
   glance at the watchlist should show closing prices, not mid-afternoon ones. */
const MARKET_SLOTS = [
  { key: 'pre',   h: 6,  m: 30, label: '6:30 am ET' },
  { key: 'open',  h: 9,  m: 31, label: '9:31 am ET' },
  { key: 'noon',  h: 12, m: 0,  label: '12:00 pm ET' },
  { key: 'aft',   h: 14, m: 30, label: '2:30 pm ET' },
  { key: 'close', h: 15, m: 58, label: '3:58 pm ET' }
];

// Options do not trade before the opening bell. A quote taken at 6:30 has a
// live underlying and yesterday's closes on the contracts, so the premiums
// and the ROI built from them are last night's, against this morning's price.
const RTH_OPEN = 9 * 60 + 30;
const inPremarket = () => { const m = marketNow(); return !m.weekend && m.minutes < RTH_OPEN; };
const SLOT_SPREAD_MIN = 4;   // up to this many minutes late, on purpose

// Wall clock in New York, whatever the device is set to
function marketNow() {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  const hour = parseInt(parts.hour, 10) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + parseInt(parts.minute, 10),
    weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun'
  };
}

// A stable per-day, per-slot offset so the run lands a few minutes after the
// hour rather than exactly on it.
function slotOffset(m, slot) {
  const store = loadMarket();
  const offs  = store.offsets || {};
  const key   = `${m.date}:${slot.key}`;
  if (offs[key] == null) {
    // Drop yesterday's offsets rather than growing the record forever
    const fresh = {};
    Object.keys(offs).forEach(k => { if (k.startsWith(m.date)) fresh[k] = offs[k]; });
    fresh[key] = Math.floor(Math.random() * (SLOT_SPREAD_MIN + 1));
    store.offsets = fresh;
    saveMarket(store);
    return fresh[key];
  }
  return offs[key];
}

function dueSlots() {
  const m = marketNow();
  if (m.weekend) return [];
  const runs = loadMarket().runs || {};
  return MARKET_SLOTS.filter(s =>
    runs[s.key] !== m.date && m.minutes >= s.h * 60 + s.m + slotOffset(m, s));
}

function markSlotsRun(keys) {
  const m = marketNow();
  const store = loadMarket();
  store.runs = store.runs || {};
  keys.forEach(k => { store.runs[k] = m.date; });
  saveMarket(store);
}

/* ── Telling you when something crosses the target ──
   A scheduled update happens whether or not you are looking at the tab, so
   the one that matters is worth surfacing. Reuses the notification the
   expiry reminder already asked permission for; at most one a day, and only
   for tickers that were not already above the line at the last run. */
const WL_NOTICE_KEY = 'opts_wl_last_notice';

async function notifyTargetHits() {
  const target = watchTarget();
  if (target == null || !notificationsSupported() || Notification.permission !== 'granted') return;

  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(WL_NOTICE_KEY)) || {} } catch (e) {}
  const quotes = marketQuotes();
  const above  = [];
  loadWatchlist().forEach(tk => {
    const l = bestLeg(quotes[tk]);
    if (l && l.roi >= target) above.push({ tk, roi: l.roi, strike: l.strike });
  });

  const day    = todayStr();
  const told   = seen.date === day ? (seen.tickers || []) : [];
  const fresh  = above.filter(a => !told.includes(a.tk)).sort((a,b) => b.roi - a.roi);
  localStorage.setItem(WL_NOTICE_KEY, JSON.stringify({ date: day, tickers: above.map(a => a.tk) }));
  if (!fresh.length) return;

  const lead = fresh[0];
  const body = fresh.length === 1
    ? `${lead.tk} ${fmtMoney(lead.strike)} put — ${fmtPct(lead.roi)} annualized`
    : `${fmtInt(fresh.length)} candidates above ${fmtPct(target)} — ${lead.tk} best at ${fmtPct(lead.roi)}`;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Options Tracker', {
      body, tag: 'watchlist', icon: './icon.svg', badge: './icon.svg'
    });
  } catch (e) { /* a missed notification is not worth breaking the run over */ }
}

async function checkMarketSchedule() {
  if (_wlRunning || !loadWatchlist().length) return;
  const due = dueSlots();
  if (!due.length) return;
  // Missed slots are water under the bridge — one run brings everything
  // current, so take the latest and retire the rest.
  const run   = due[due.length - 1];
  const fresh = await refreshWatchlist(false, run.label);
  // A run that reached nothing at all — no connection, feeds down — leaves
  // the slot due so the next tick tries again rather than writing the day off.
  if (fresh) { markSlotsRun(due.map(s => s.key)); notifyTargetHits(); }
}

// Poll while the app is open; also checked on load and on returning to it
setInterval(checkMarketSchedule, 60000);

/* Human description of where the schedule stands */
function scheduleText() {
  const m     = marketNow();
  const store = loadMarket();
  const runs  = store.runs || {};
  // Built from the slots themselves, so the sentence cannot drift from what
  // actually runs if the times are ever changed.
  const times = MARKET_SLOTS.map(s => `<b>${s.label.replace(' ET', '')}</b>`).join(', ');
  if (m.weekend) {
    return `Markets are closed for the weekend — next update Monday at <b>${MARKET_SLOTS[0].label}</b>.`;
  }
  const next = MARKET_SLOTS.find(s => runs[s.key] !== m.date);
  const done = MARKET_SLOTS.filter(s => runs[s.key] === m.date).length;
  return `Updates through the session at ${times} ET, spread over a few minutes.`
    + (done ? ` ${fmtInt(done)} of ${fmtInt(MARKET_SLOTS.length)} done today.` : '')
    + (next ? ` Next: <b>${next.label}</b>.` : ` All of today's runs are done.`);
}

/* ── Watchlist edits ── */
function openWatchAdd() {
  const el = document.getElementById('wl-ticker');
  if (el) el.value = '';
  openOverlay('m-wladd');
  setTimeout(() => { try { el && el.focus() } catch (e) {} }, 120);
}

function addWatchItem() {
  const el = document.getElementById('wl-ticker');
  const tk = (el.value || '').trim().toUpperCase();
  if (!tk) return;
  if (!TICKER_RE.test(tk)) { alert('Ticker must be 1–6 letters (A–Z), e.g. AAPL or SPY'); return; }
  const list = loadWatchlist();
  if (list.includes(tk)) { el.value = ''; showToast(`${tk} is already on the watchlist`, null, null, 3000); return; }
  if (list.length >= MAX_WATCH) { alert(`The watchlist holds ${MAX_WATCH} tickers. Remove one first.`); return; }
  list.push(tk);
  saveWatchlist(list);
  syncWatchlistToRelay();
  el.value = '';
  closeOverlay('m-wladd');
  renderWatchlist();
  if (navigator.onLine !== false) refreshOne(tk).then(renderWatchlist);
}

/* Remove is a one-tap action sitting under a floating add button, so it
   always offers a way back — the same rule the trade list follows. */
function removeWatchItem(tk) {
  const before = loadWatchlist();
  const idx    = before.indexOf(tk);
  if (idx < 0) return;
  const note   = loadWatchNotes()[tk] || '';
  const quote  = marketQuotes()[tk];

  saveWatchlist(before.filter(x => x !== tk));
  syncWatchlistToRelay();
  saveWatchNote(tk, '');
  const m = loadMarket();
  if (m.quotes) { delete m.quotes[tk]; saveMarket(m); }
  renderWatchlist();

  showToast(`${tk} removed from the watchlist`, 'Undo', () => {
    const list = loadWatchlist();
    if (!list.includes(tk)) list.splice(Math.min(idx, list.length), 0, tk);
    saveWatchlist(list);
    syncWatchlistToRelay();
    if (note) saveWatchNote(tk, note);
    if (quote) { const mm = loadMarket(); mm.quotes = mm.quotes || {}; mm.quotes[tk] = quote; saveMarket(mm); }
    renderWatchlist();
  });
}

/* ── Quote source ──
   A browser may only read another site's data when that site says it may.
   These feeds mostly do not, so the request fails before it leaves the
   device — "Load failed" in Safari, "Failed to fetch" elsewhere — and no
   amount of retrying changes it. A relay re-issues the request from a
   server, where that rule does not apply.

   Which relays work is not something this app can know in advance: it
   depends on the network, and public relays come and go. So rather than
   pick one, offer a short list and a tester that says exactly what each
   feed answered on this device. */
const SOURCE_PRESETS = [
  { id: 'direct', name: 'Direct', prefix: '',
    sub: 'No relay. Works only where the feeds allow browser access — usually they do not.' },
  { id: 'corsproxy', name: 'corsproxy.io', prefix: 'https://corsproxy.io/?url=', pub: true,
    sub: 'Public relay. No sign-up, rate-limited, may be busy. Never carries your API key.' },
  { id: 'allorigins', name: 'allorigins.win', prefix: 'https://api.allorigins.win/raw?url=', pub: true,
    sub: 'Public relay. No sign-up, slower, sometimes down. Never carries your API key.' },
  { id: 'custom', name: 'Custom', prefix: null,
    sub: 'Your own relay — a Cloudflare Worker or anything that takes ?url=.' }
];

let _srcPick = 'direct';

function presetForPrefix(prefix) {
  if (!prefix) return 'direct';
  const hit = SOURCE_PRESETS.find(p => p.prefix === prefix);
  return hit ? hit.id : 'custom';
}

function openQuoteSource() {
  const cur = quoteProxy();
  _srcPick = presetForPrefix(cur);
  document.getElementById('src-custom').value = _srcPick === 'custom' ? cur : '';
  document.getElementById('src-key').value    = massiveKey();
  _srcRelayKey = relayHoldsKey();
  document.getElementById('src-result').innerHTML = '';
  renderSourceOptions();
  openOverlay('m-wlsource');
}

let _srcRelayKey = false;

function toggleRelayKey() {
  _srcRelayKey = !_srcRelayKey;
  document.getElementById('src-result').innerHTML = '';
  renderSourceOptions();
}

// The key is part of "how quotes are fetched", so the sheet applies it before
// testing — otherwise Test would report on a route the user is not proposing.
function applyPendingKey() {
  const k = (document.getElementById('src-key').value || '').trim();
  if (k) localStorage.setItem(MASSIVE_KEY, k); else localStorage.removeItem(MASSIVE_KEY);
  if (_srcRelayKey) localStorage.setItem(RELAY_KEY, '1'); else localStorage.removeItem(RELAY_KEY);
  return k;
}

function renderSourceOptions() {
  document.getElementById('src-list').innerHTML = SOURCE_PRESETS.map(p =>
    `<button class="src-opt${p.id === _srcPick ? ' selected' : ''}" onclick="pickQuoteSource('${p.id}')">
      <div class="src-opt-name">${esc(p.name)}</div>
      <div class="src-opt-sub">${esc(p.sub)}</div>
    </button>`).join('');
  document.getElementById('src-custom-wrap').style.display = _srcPick === 'custom' ? 'block' : 'none';
  document.getElementById('src-relaykey').classList.toggle('selected', _srcRelayKey);
}

function pickQuoteSource(id) {
  _srcPick = id;
  document.getElementById('src-result').innerHTML = '';
  renderSourceOptions();
}

// The prefix the sheet is currently proposing, before it is saved
function pendingPrefix() {
  if (_srcPick === 'custom') return (document.getElementById('src-custom').value || '').trim();
  return (SOURCE_PRESETS.find(p => p.id === _srcPick) || {}).prefix || '';
}

function saveQuoteSource() {
  const prefix = pendingPrefix();
  if (prefix && !/^https:\/\//i.test(prefix)) {
    alert('A relay must be an https:// address ending in something like ?url='); return;
  }
  // A relay-held key only means anything on your own relay
  if (_srcRelayKey && (_srcPick !== 'custom' || !prefix)) {
    alert('"My relay holds the key" needs the Custom route — set your Worker URL first, or untick it.');
    return;
  }
  applyPendingKey();
  if (prefix) localStorage.setItem(PROXY_KEY, prefix); else localStorage.removeItem(PROXY_KEY);
  closeOverlay('m-wlsource');
  renderWatchlist();
  syncWatchlistToRelay();
  if (prefix) refreshWatchlist(true);
}

/* Ask every provider directly, with the route being proposed, and report
   what each one actually said. This is the only way to find out — the
   answer depends on the device and the network, not on the code. */
async function testQuoteSource() {
  const prefix = pendingPrefix();
  if (_srcPick === 'custom' && !prefix) { alert('Enter your relay URL first.'); return; }
  if (prefix && !/^https:\/\//i.test(prefix)) { alert('A relay must be an https:// address.'); return; }

  const box = document.getElementById('src-result');
  box.innerHTML = `<div class="src-res"><div class="src-res-hdr">Testing AAPL…</div></div>`;

  // Point the request layer at the route under test, then put it back
  const saved = quoteProxy();
  applyPendingKey();
  if (prefix) localStorage.setItem(PROXY_KEY, prefix); else localStorage.removeItem(PROXY_KEY);

  const rows = [];
  let winner = null;
  try {
    for (const p of providers()) {
      try {
        const r = await p.fn('AAPL', !!prefix);
        const legs = r.chain.length ? buildLegs(r.price, r.chain) : null;
        rows.push({ name: p.name, ok: true,
          msg: `${fmtMoney(r.price)}${legs ? ` · chain ${fmtInt(legs.dte)}d` : ' · price only'}` });
        if (!winner) winner = p.name;
      } catch (e) {
        rows.push({ name: p.name, ok: false, msg: String(e.message || e).slice(0, 120) });
      }
    }
  } finally {
    if (saved) localStorage.setItem(PROXY_KEY, saved); else localStorage.removeItem(PROXY_KEY);
  }

  const label = _srcPick === 'direct' ? 'Direct' : (SOURCE_PRESETS.find(p => p.id === _srcPick) || {}).name;
  box.innerHTML = `<div class="src-res">
    <div class="src-res-hdr ${winner ? 'ok' : 'bad'}">
      ${winner ? `✓ ${esc(label)} works — ${esc(winner)} answered` : `✗ ${esc(label)} reached nothing`}
    </div>
    ${rows.map(r => `<div class="src-row">
      <div class="src-row-name">${esc(r.name)}</div>
      <div class="src-row-msg${r.ok ? ' ok' : ''}">${esc(r.msg)}</div>
    </div>`).join('')}
  </div>${winner ? '' : `<div class="risk-note" style="margin-top:10px">
    Every feed refused on this route. Try another one above — or enter prices by hand,
    which always works.</div>`}`;
}

/* ── Manual quote entry ──
   The fallback that always works: read the numbers off your broker. */
function openManualQuote(tk) {
  const q = marketQuotes()[tk] || {};
  document.getElementById('wm-ticker').value = tk;
  document.getElementById('wm-title').textContent = tk;
  document.getElementById('wm-note').value  = loadWatchNotes()[tk] || '';
  document.getElementById('wm-price').value = q.price || '';
  document.getElementById('wm-exp').value   = q.expiry || dateOffset(TARGET_DTE);
  const l5  = (q.legs || []).find(l => l.pct === 5);
  const l10 = (q.legs || []).find(l => l.pct === 10);
  document.getElementById('wm-p5').value  = l5?.premium  || '';
  document.getElementById('wm-p10').value = l10?.premium || '';
  wlManualUpdate();
  openOverlay('m-wlmanual');
}

// Strikes are derived so there are only four numbers to type
function manualLegs(price, expiry, p5, p10) {
  const dte = Math.max(1, daysBetween(todayStr(), expiry));
  return [5, 10].map((pct, i) => {
    const premium = i === 0 ? p5 : p10;
    const strike  = Math.round(price * (1 - pct / 100));
    if (!(premium > 0) || !(strike > 0)) return { pct, strike: strike || 0, missing: 'not entered' };
    return {
      pct, strike, otmPct: (price - strike) / price * 100,
      premium, basis: 'manual', oi: null, expiry, dte,
      roi: roiPct(premium, strike, dte)
    };
  });
}

function wlManualUpdate() {
  const price = parseFloat(document.getElementById('wm-price').value);
  const exp   = document.getElementById('wm-exp').value;
  const p5    = parseFloat(document.getElementById('wm-p5').value);
  const p10   = parseFloat(document.getElementById('wm-p10').value);
  const val   = document.getElementById('wm-roi');
  const form  = document.getElementById('wm-formula');
  if (!(price > 0) || !DATE_RE.test(exp || '') || !(p5 > 0 || p10 > 0)) {
    val.textContent  = '—';
    form.textContent = 'enter a price, an expiration and a premium';
    return;
  }
  const legs = manualLegs(price, exp, p5, p10).filter(l => !l.missing);
  val.textContent  = legs.map(l => fmtPct(l.roi)).join('  /  ');
  form.textContent = legs.map(l => `-${l.pct}% at ${fmtMoney(l.strike)} · ${fmtInt(l.dte)}d`).join('   ');
}

function saveManualQuote() {
  const tk    = document.getElementById('wm-ticker').value;
  const price = parseFloat(document.getElementById('wm-price').value);
  const exp   = document.getElementById('wm-exp').value;
  const p5    = parseFloat(document.getElementById('wm-p5').value);
  const p10   = parseFloat(document.getElementById('wm-p10').value);

  // The note always saves; the quote only when a price was actually typed, so
  // editing a note never overwrites a good fetched quote with a hand one.
  saveWatchNote(tk, document.getElementById('wm-note').value);
  if (!(price > 0)) {
    closeOverlay('m-wlmanual');
    renderWatchlist();
    return;
  }
  if (!DATE_RE.test(exp || '') || daysBetween(todayStr(), exp) <= 0) {
    alert('Enter an expiration date in the future.'); return;
  }
  const m = loadMarket();
  m.quotes = m.quotes || {};
  const prev = m.quotes[tk] || {};
  const legs = manualLegs(price, exp, p5, p10);
  m.quotes[tk] = {
    ticker: tk, price,
    prevClose: prev.prevClose ?? null,
    // Re-derive the day's move from the price just typed rather than carrying
    // over a percentage that belonged to a different price
    changePct: prev.prevClose > 0 ? (price - prev.prevClose) / prev.prevClose * 100 : null,
    source: 'entered by hand', asOf: new Date().toISOString(),
    expiry: exp, dte: Math.max(1, daysBetween(todayStr(), exp)),
    offTarget: Math.abs(daysBetween(todayStr(), exp) - TARGET_DTE) > DTE_WINDOW,
    legs, error: null
  };
  saveMarket(m);
  closeOverlay('m-wlmanual');
  renderWatchlist();
  renderActive();
}

/* ── Turning a candidate into a trade ── */
function logWatchTrade(tk, pct) {
  const q = marketQuotes()[tk];
  const l = (q?.legs || []).find(x => x.pct === pct);
  if (!l || l.missing) return;
  openAddModal({
    type: 'put', ticker: tk, strike: l.strike, premium: Math.round(l.premium * 100) / 100,
    qty: 1, dte: l.dte || (q.expiry ? daysBetween(todayStr(), q.expiry) : TARGET_DTE)
  });
}

/* ── The best thing on the list right now ──
   Only quotes fresh enough to act on are allowed to drive a suggestion. */
function quoteAgeDays(q) {
  if (!q?.asOf) return Infinity;
  return (Date.now() - new Date(q.asOf).getTime()) / 86400000;
}

function bestCandidate() {
  const quotes = marketQuotes();
  let best = null;
  loadWatchlist().forEach(tk => {
    const q = quotes[tk];
    if (!q || !q.legs || quoteAgeDays(q) > STALE_DAYS) return;
    // Premarket premiums are yesterday's closes. Fine to look at, not fine to
    // price a decision to close a live position against.
    if (q.premarket) return;
    q.legs.forEach(l => {
      if (l.missing || !(l.roi > 0)) return;
      if (!best || l.roi > best.roi) best = { ...l, ticker: tk, price: q.price, expiry: q.expiry || l.expiry };
    });
  });
  return best;
}

/* ═══════════════════════════════════════
   RENDER: WATCHLIST
═══════════════════════════════════════ */
function renderWatchlist() {
  const el = document.getElementById('wl-list');
  if (!el) return;
  const list   = loadWatchlist();
  const quotes = marketQuotes();
  const store  = loadMarket();

  const notes  = loadWatchNotes();
  const target = watchTarget();
  const sort   = watchSort();
  const best   = bestCandidate();

  document.getElementById('wl-offline-note')?.classList.toggle('show', navigator.onLine === false);

  const btn = document.getElementById('wl-refresh-btn');
  if (btn) {
    btn.classList.toggle('spinning', _wlRunning);
    btn.disabled = _wlRunning || !list.length;
  }

  document.getElementById('wl-stats').innerHTML =
    `<span><b>${fmtInt(list.length)}</b> watching</span>`
    + (best ? `<span>best <b class="amber">${fmtPct(best.roi)}</b> on ${esc(best.ticker)}</span>` : '')
    + (store.lastRun ? `<span>updated ${esc(new Date(store.lastRun)
        .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>` : '');

  document.getElementById('wl-sched').innerHTML = scheduleText()
    + `<br><button class="wl-x wl-ctl${sort === 'roi' ? ' on' : ''}" onclick="toggleWatchSort()"
         >sort: ${sort === 'roi' ? 'yield' : 'added'}</button>`
    + `<button class="wl-x wl-ctl${target != null ? ' on' : ''}" onclick="configureWatchTarget()"
         >target: ${target == null ? 'off' : fmtPct(target)}</button>`
    + `<button class="wl-x wl-ctl${quoteProxy() ? ' on' : ''}" onclick="openQuoteSource()"
         title="How quote requests reach the feeds">source: ${quoteProxy() ? 'relay' : 'direct'}</button>`;

  if (!list.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
      <div class="empty-txt">Nothing on the watchlist yet<br>Tap + to track a ticker's 45-day put premiums</div>
    </div>`;
    document.getElementById('wl-suggest').innerHTML = '';
    return;
  }

  // Sorting by yield puts the best candidate on top; cards with no quote to
  // rank sink to the bottom rather than jumping around as quotes arrive.
  const ordered = sort === 'roi'
    ? list.slice().sort((a, b) => {
        const ra = bestLeg(quotes[a])?.roi ?? -1, rb = bestLeg(quotes[b])?.roi ?? -1;
        return rb - ra || list.indexOf(a) - list.indexOf(b);
      })
    : list;

  el.innerHTML = ordered.map(tk => watchCardHTML(tk, quotes[tk], notes[tk], target)).join('');
  renderWatchSuggestion(best);
}

function watchCardHTML(tk, q, note, target) {
  const pending = !!_wlPending[tk];
  const chg     = q && q.changePct != null ? q.changePct : null;
  const dir     = chg == null ? '' : chg > 0 ? ' up' : chg < 0 ? ' down' : '';
  const cls     = (!q || (q.error && !q.legs)) ? ' err' : dir;
  const age     = q ? quoteAgeDays(q) : Infinity;
  const stale   = age > STALE_DAYS;
  const top     = bestLeg(q);
  const hit     = target != null && top && !stale && top.roi >= target;

  const priceHTML = q?.price > 0 ? `
    <div>
      <div class="wl-px">${fmtMoney(q.price)}</div>
      <div class="wl-chg ${chg == null ? '' : chg > 0 ? 'green' : chg < 0 ? 'red' : ''}">
        ${chg == null ? '—' : (chg > 0 ? '+' : '') + fmtPct(chg)}
      </div>
    </div>` : `<div class="wl-chg" style="color:var(--text3)">${pending ? 'loading…' : 'no price'}</div>`;

  let body = '';
  if (q?.legs?.length) {
    body = `<div class="wl-legs">
      <div class="wl-leg head">
        <div>OTM</div><div class="wl-leg-val">Strike</div>
        <div class="wl-leg-val">Premium</div><div class="wl-leg-val">Ann. ROI</div>
      </div>
      ${q.legs.map(l => legRowHTML(tk, l)).join('')}
    </div>`;
  } else if (q?.price > 0) {
    body = `<div class="wl-err">No option chain for this symbol${q.error ? ` — <b>${esc(q.error)}</b>` : ''}.
      <button class="wl-x" onclick="openManualQuote('${esc(tk)}')">enter by hand</button></div>`;
  } else if (q?.error) {
    // "Load failed" / "Failed to fetch" is the browser refusing to read another
    // site, not the feed being down. Retrying cannot fix it, so point at the
    // two things that can.
    const blocked = /load failed|failed to fetch|networkerror/i.test(q.error);
    body = `<div class="wl-err">
      <b>${blocked ? 'The feeds are blocking this browser.' : "Couldn't fetch a quote."}</b>
      ${blocked ? 'They refused the request before it left the device — a relay or a hand-entered price is the way through.' : esc(q.error)}
      <div style="margin-top:5px">
        <button class="wl-x wl-ctl" onclick="openQuoteSource()">fix the source</button>
        <button class="wl-x wl-ctl" onclick="openManualQuote('${esc(tk)}')">enter by hand</button>
      </div>
      ${blocked ? `<div style="margin-top:5px;color:var(--text3)">${esc(q.error)}</div>` : ''}
    </div>`;
  } else {
    body = `<div class="wl-loading">${pending ? 'Fetching…' : 'No quote yet — tap Refresh.'}</div>`;
  }

  // A premarket snapshot pairs a live underlying with last night's contract
  // quotes, so the premium and the ROI built from it are yesterday's.
  const preNote = q?.premarket && q?.legs?.length
    ? `<div class="wl-note" style="background:rgba(160,96,16,.06);color:var(--amber)">
         Premarket — the price is this morning's, the premiums are yesterday's closes.
         Options do not trade until 9:30.
       </div>` : '';

  const asOf = q?.asOf ? new Date(q.asOf) : null;
  const foot = [
    q?.expiry ? `${esc(q.expiry)} · ${fmtInt(q.dte)}d${q.offTarget ? ' (no ~45d expiry listed)' : ''}` : null,
    q?.source ? esc(q.source) : null,
    asOf ? (stale ? `stale · ${asOf.toLocaleDateString()}` : asOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null
  ].filter(Boolean).join(' · ');

  return `<div class="wl-card${cls}${hit ? ' hit' : ''}">
    <div class="wl-top">
      <div>
        <div class="wl-tkr">${esc(tk)}${hit ? `<span class="wl-hit-badge">≥ ${fmtPct(target)}</span>` : ''}</div>
        <div class="wl-sub">${q?.prevClose > 0 ? 'prev ' + fmtMoney(q.prevClose) : 'put candidate'}</div>
      </div>
      ${priceHTML}
    </div>
    ${body}
    ${preNote}
    ${note ? `<div class="wl-note">${esc(note)}</div>` : ''}
    <div class="wl-foot">
      <div>${foot || '—'}</div>
      <div class="wl-foot-acts">
        <button class="wl-x" onclick="openManualQuote('${esc(tk)}')">edit</button>
        <button class="wl-x danger" onclick="removeWatchItem('${esc(tk)}')">remove</button>
      </div>
    </div>
  </div>`;
}

function legRowHTML(tk, l) {
  if (l.missing) {
    return `<div class="wl-leg">
      <div class="wl-leg-tag">-${fmtInt(l.pct)}%</div>
      <div class="wl-leg-val">${l.strike ? fmtMoney(l.strike) : '—'}</div>
      <div class="wl-leg-val" style="color:var(--text3)">${esc(l.missing)}</div>
      <div class="wl-leg-val">—</div>
    </div>`;
  }
  return `<div class="wl-leg">
    <div class="wl-leg-tag">-${fmtInt(l.pct)}%</div>
    <div class="wl-leg-val">${fmtMoney(l.strike)}
      <div class="wl-leg-sub">${fmtPct(l.otmPct)} otm</div></div>
    <div class="wl-leg-val">${fmtMoney(l.premium)}
      <div class="wl-leg-sub">${esc(l.basis)}${l.oi ? ' · oi ' + fmtInt(l.oi) : ''}</div></div>
    <div class="wl-leg-val roi">${fmtPct(l.roi)}
      <button class="wl-leg-btn" onclick="logWatchTrade('${esc(tk)}',${l.pct})">log</button></div>
  </div>`;
}

/* ── Suggested trade / suggested close ──
   The watchlist is only worth keeping if it changes a decision. It does that
   in one place: capital already committed to a weak position could be earning
   the candidate's rate instead. switchBreakeven() prices exactly that — the
   most you can pay to buy back and still come out ahead. */
function renderWatchSuggestion(best) {
  const el = document.getElementById('wl-suggest');
  if (!el) return;
  if (!best) {
    const anyQuote = Object.keys(marketQuotes()).length > 0;
    el.innerHTML = anyQuote
      ? `<div class="risk-note">No candidate to rank yet — the stored quotes are older than
          ${fmtInt(STALE_DAYS)} days or carry no premiums. Refresh, or enter one by hand.</div>`
      : '';
    return;
  }

  let html = `<div class="bt-preview-hdr">Suggested Trade</div>
    <div class="tc-hint good" style="margin:0 0 10px">
      Best on the list: <b>${esc(best.ticker)}</b> ${fmtMoney(best.strike)} put,
      ${fmtInt(best.dte)} days out at <b>${fmtMoney(best.premium)}</b> —
      ${fmtPct(best.roi)} annualized on ${fmtMoney(best.strike * 100)} of capital
      (${fmtPct(best.otmPct)} out of the money).
    </div>`;

  /* Which open positions are worth closing to fund it. Two positions are
     deliberately never listed: one on the same ticker, because rotating a
     name into itself is not a rotation and doubles the concentration; and
     one the candidate barely beats, because crossing two spreads to chase a
     point of annualized yield loses money in practice. */
  const active = load().trades.filter(t =>
    t.status === 'active' && tradeCapital(t) > 0 && t.ticker !== best.ticker);
  const rows = active.map(t => ({ t, hold: positionRate(t), sw: switchBreakeven(t, best.roi) }))
    .filter(r => r.sw.left > 0 && best.roi >= r.hold * MIN_SWITCH_EDGE)
    .sort((a,b) => a.hold - b.hold);

  if (rows.length) {
    html += breakdownCardHTML('Close to fund it', 'max buy-back price to come out ahead',
      rows.map(r => `<div class="brk-row" style="grid-template-columns:1.5fr 1fr 1fr">
        <div class="brk-name">${esc(r.t.ticker)}
          <div style="font-size:8px;color:var(--text3);font-weight:400">
            ${esc(r.t.type.toUpperCase())} ${fmtMoney(currentStrike(r.t))} ·
            ${fmtInt(r.sw.left)}d left · holding ${fmtPct(r.hold)}</div></div>
        <div class="brk-val">${fmtMoney(r.sw.price)}
          <div class="wl-leg-sub">vs expiry</div></div>
        <div class="brk-val amber">${fmtMoney(r.sw.altPrice)}
          <div class="wl-leg-sub">vs ${esc(best.ticker)}</div></div>
      </div>`), ['Position', 'Break-even', 'With switch', '']);
    html += `<div class="risk-note">Buying one of these back below the right-hand price and
      writing the ${esc(best.ticker)} put instead earns more on the same capital over the same
      days. The left-hand price is the plain hold-to-expiry break-even, with nowhere else
      to put the money.</div>`;
  } else if (active.length) {
    html += `<div class="risk-note">Nothing is worth closing to fund it — every open position
      is either on ${esc(best.ticker)} already or annualizing close enough to ${fmtPct(best.roi)}
      that switching would not cover the spreads.</div>`;
  }
  el.innerHTML = html;
}

/* ═══════════════════════════════════════
   INIT
═══════════════════════════════════════ */
/* ═══════════════════════════════════════
   EXCEL EXPORT  (SheetJS)
═══════════════════════════════════════ */

function loadSheetJS() {
  return new Promise((res, rej) => {
    if (window.XLSX) { res(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function exportExcel() {
  try {
    await loadSheetJS();
  } catch(e) {
    alert('Could not load Excel library — check your internet connection and try again.');
    return;
  }

  const trades = load().trades;
  const date   = new Date().toISOString().split('T')[0];
  const wb     = XLSX.utils.book_new();

  /* ── helper: column widths ── */
  const colW = widths => widths.map(w => ({ wch: w }));

  /* ─────────────────────────────────────
     SHEET 1 — Active Trades
  ───────────────────────────────────── */
  const active = trades.filter(t => t.status === 'active');
  const activeRows = [
    ['Ticker','Type','Strike','Qty','Premium','Total Premium','Income ($)','DTE','Ann. ROI (%)','Date Opened','Expiration','Rolls','Roll Strikes']
  ];
  active.forEach(t => {
    const tp  = totalPremiums(t);
    const td  = Math.max(1, daysBetween(t.dateOpened, currentExpDate(t)));
    const cs  = currentStrike(t);
    const q   = tradeQty(t);
    const roi = roiPct(tp, cs, td);
    const rollStrikes = t.rolls.length
      ? t.rolls.map(r => fmtMoney(r.strikePrice)).join(' → ')
      : '—';
    activeRows.push([
      t.ticker,
      t.type.toUpperCase(),
      cs,
      q,
      t.premium,
      +tp.toFixed(2),
      +(tp * 100 * q).toFixed(2),
      td,
      +roi.toFixed(2),
      t.dateOpened,
      currentExpDate(t),
      t.rolls.length,
      rollStrikes
    ]);
  });
  const ws1 = XLSX.utils.aoa_to_sheet(activeRows);
  ws1['!cols'] = colW([8,6,9,5,10,13,12,6,13,12,12,6,22]);
  // Strike, Qty, Premium, Total Premium, Income, DTE, ROI
  applyNumberFormats(ws1, activeRows.length - 1,
    { 2: XL_MONEY, 3: XL_INT, 4: XL_MONEY, 5: XL_MONEY, 6: XL_MONEY, 7: XL_INT, 8: XL_PCT, 11: XL_INT });
  styleHeaderRow(ws1, activeRows[0].length);
  XLSX.utils.book_append_sheet(wb, ws1, 'Active Trades');

  /* ─────────────────────────────────────
     SHEET 2 — Trade History
  ───────────────────────────────────── */
  const closed = trades
    .filter(t => t.status !== 'active')
    .sort((a,b) => new Date(b.closeInfo?.dateClosed||b.dateOpened) - new Date(a.closeInfo?.dateClosed||a.dateOpened));
  const histRows = [
    ['Ticker','Type','Strike','Qty','Total Premium','Buy Price','P&L ($)','Ann. ROI (%)','Days Open','Status','Date Opened','Date Closed','Rolls']
  ];
  closed.forEach(t => {
    const tp    = totalPremiums(t);
    const cs    = currentStrike(t);
    const ad    = actualDays(t);
    const pnl   = tradePnL(t);
    const profPS = t.status === 'expired' ? tp : tp - (t.closeInfo?.buyingPrice || 0);
    const roi   = roiPct(profPS, cs, ad);
    histRows.push([
      t.ticker,
      t.type.toUpperCase(),
      cs,
      tradeQty(t),
      +tp.toFixed(2),
      t.status === 'closed_early' ? +(t.closeInfo?.buyingPrice || 0).toFixed(2) : '—',
      +pnl.toFixed(2),
      +roi.toFixed(2),
      ad,
      t.status === 'expired' ? 'Expired' : 'Closed Early',
      t.dateOpened,
      t.closeInfo?.dateClosed || '—',
      t.rolls.length
    ]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(histRows);
  ws2['!cols'] = colW([8,6,9,5,14,10,10,13,11,12,12,12,6]);
  // Strike, Qty, Total Premium, Buy Price, P&L, ROI, Days Open, Rolls
  applyNumberFormats(ws2, histRows.length - 1,
    { 2: XL_MONEY, 3: XL_INT, 4: XL_MONEY, 5: XL_MONEY, 6: XL_MONEY, 7: XL_PCT, 8: XL_INT, 12: XL_INT });
  styleHeaderRow(ws2, histRows[0].length);
  XLSX.utils.book_append_sheet(wb, ws2, 'Trade History');

  /* ─────────────────────────────────────
     SHEET 3 — Monthly Analysis
  ───────────────────────────────────── */
  const byMonth = {};
  closed.forEach(t => {
    const key = (t.closeInfo?.dateClosed || t.dateOpened).slice(0,7);
    (byMonth[key] = byMonth[key] || []).push(t);
  });
  const monthRows = [
    ['Month','Trades','P&L ($)','Ann. ROI (%)','Avg Days Open','Expired','Closed Early']
  ];
  Object.keys(byMonth).sort().reverse().forEach(mk => {
    const mT    = byMonth[mk];
    const mPnL  = mT.reduce((s,t) => s + tradePnL(t), 0);
    const mAvgDays = mT.reduce((s,t) => s + actualDays(t), 0) / mT.length;
    const mROI  = annualizedROI(mT);
    const [y,m] = mk.split('-');
    const mName = new Date(+y, +m-1).toLocaleString('default',{month:'long',year:'numeric'});
    monthRows.push([
      mName,
      mT.length,
      +mPnL.toFixed(2),
      +mROI.toFixed(2),
      Math.round(mAvgDays),
      mT.filter(t=>t.status==='expired').length,
      mT.filter(t=>t.status==='closed_early').length
    ]);
  });
  // Totals row
  if (monthRows.length > 1) {
    const { pnl } = weightedStats();
    monthRows.push(['TOTAL', closed.length, +pnl.toFixed(2), '', '', '', '']);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(monthRows);
  ws3['!cols'] = colW([20,8,11,14,15,9,12]);
  // Trades, P&L, ROI, Avg Days Open, Expired, Closed Early
  applyNumberFormats(ws3, monthRows.length - 1,
    { 1: XL_INT, 2: XL_MONEY, 3: XL_PCT, 4: XL_INT, 5: XL_INT, 6: XL_INT });
  styleHeaderRow(ws3, monthRows[0].length);
  XLSX.utils.book_append_sheet(wb, ws3, 'Monthly Analysis');

  /* ─────────────────────────────────────
     SHEET 4 — Share Lots (wheel cycles)
  ───────────────────────────────────── */
  const lots = loadPositions();
  if (lots.length) {
    const lotRows = [
      ['Ticker','Shares','Cost Basis','Premiums','Net Basis','Sale Price','Stock P&L','Cycle P&L','Cycle ROI (%)','Days Held','Status','Acquired','Closed']
    ];
    lots.forEach(p => {
      const prem  = positionPremiums(p, trades);
      const stock = positionStockPnL(p);
      const cycle = stock + prem;
      const days  = positionDays(p);
      const roi   = positionCapital(p) > 0 ? (cycle / positionCapital(p)) * (365 / days) * 100 : 0;
      lotRows.push([
        p.ticker, p.shares, p.costBasis, +prem.toFixed(2),
        +positionNetBasis(p, trades).toFixed(2),
        p.status === 'closed' ? +(p.closeInfo?.pricePerShare || 0).toFixed(2) : '—',
        p.status === 'closed' ? +stock.toFixed(2) : '—',
        p.status === 'closed' ? +cycle.toFixed(2) : '—',
        p.status === 'closed' ? +roi.toFixed(2)   : '—',
        days,
        p.status === 'closed' ? (p.closeInfo?.reason === 'called_away' ? 'Called Away' : 'Sold') : 'Open',
        p.dateAcquired,
        p.closeInfo?.dateClosed || '—'
      ]);
    });
    const ws4 = XLSX.utils.aoa_to_sheet(lotRows);
    ws4['!cols'] = colW([8,8,11,11,10,11,11,11,13,11,12,12,12]);
    applyNumberFormats(ws4, lotRows.length - 1,
      { 1: XL_INT, 2: XL_MONEY, 3: XL_MONEY, 4: XL_MONEY, 5: XL_MONEY,
        6: XL_MONEY, 7: XL_MONEY, 8: XL_PCT, 9: XL_INT });
    styleHeaderRow(ws4, lotRows[0].length);
    XLSX.utils.book_append_sheet(wb, ws4, 'Share Lots');
  }

  /* ── Download ── */
  XLSX.writeFile(wb, `options-tracker-${date}.xlsx`);
}

/* Number formats for the exported sheets, so a workbook reads the same way
   the app does: grouped thousands, two decimals on money and percentages.
   Cells stay real numbers — only their display format is set. */
const XL_MONEY = '#,##0.00';
const XL_PCT   = '#,##0.00';
const XL_INT   = '#,##0';

function applyNumberFormats(ws, rowCount, formats) {
  Object.entries(formats).forEach(([col, fmt]) => {
    for (let r = 1; r <= rowCount; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: +col })];
      if (cell && cell.t === 'n') cell.z = fmt;   // leave '—' placeholders alone
    }
  });
}

/* Apply bold + background to the first (header) row */
function styleHeaderRow(ws, numCols) {
  for (let c = 0; c < numCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[addr]) continue;
    ws[addr].s = {
      font:    { bold: true, color: { rgb: 'FFFFFF' } },
      fill:    { fgColor: { rgb: '1A5FAF' } },
      alignment: { horizontal: 'center' }
    };
  }
}

/* ═══════════════════════════════════════
   SERVICE WORKER REGISTRATION
═══════════════════════════════════════ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        console.log('[SW] Registered, scope:', reg.scope);
        // Listen for messages back from SW
        navigator.serviceWorker.addEventListener('message', event => {
          if (event.data === 'READY_TO_RELOAD') {
            window.location.href = window.location.href.split('?')[0] + '?v=' + Date.now();
          }
        });
      })
      .catch(err => console.warn('[SW] Registration failed:', err));
  });
}

/* ═══════════════════════════════════════
   OFFLINE STATE
   Trades live in localStorage and the app shell is cached by the
   service worker, so everything core keeps working with no connection.
   Surface that state rather than letting features fail silently.
═══════════════════════════════════════ */
function renderOnlineState() {
  const offline = navigator.onLine === false;
  document.getElementById('offline-pill')?.classList.toggle('show', offline);
  document.getElementById('scan-offline-note')?.classList.toggle('show', offline);
  document.getElementById('wl-offline-note')?.classList.toggle('show', offline);
}
window.addEventListener('offline', renderOnlineState);
// Coming back online is the moment to catch up anything the schedule missed
window.addEventListener('online', () => { renderOnlineState(); checkMarketSchedule(); });

/* ═══════════════════════════════════════
   EXPIRY REMINDERS
   The red ≤5-day badge only helps if you happen to open the app. This
   fires a real notification when you come back to it — on launch and
   whenever the app returns to the foreground, at most once a day.
   Genuine background delivery would need a push server and VAPID keys;
   that is the one thing this app deliberately does not have.
═══════════════════════════════════════ */
const NOTIF_KEY = 'opts_last_expiry_notice';

function notificationsSupported() {
  return typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
}

function renderNotifState() {
  const btn = document.getElementById('notif-btn');
  const sub = document.getElementById('notif-sub');
  if (!btn || !sub) return;
  if (!notificationsSupported()) {
    btn.style.display = 'none';
    sub.textContent = 'This browser cannot show notifications. Install the app to your home screen for reminders.';
    return;
  }
  const p = Notification.permission;
  btn.textContent = p === 'granted' ? 'On' : p === 'denied' ? 'Blocked' : 'Enable';
  btn.classList.toggle('on', p === 'granted');
  sub.textContent = p === 'granted'
    ? 'On — you will be reminded when you open the app and something expires within 5 days.'
    : p === 'denied'
      ? 'Blocked in your browser settings. Allow notifications for this site to switch it back on.'
      : 'Get a nudge when a position is within 5 days of expiring.';
}

async function toggleExpiryReminders() {
  if (!notificationsSupported()) return;
  if (Notification.permission === 'granted') {
    // Nothing to revoke from script — send a sample so it is visibly working
    checkExpiryReminders(true);
    return;
  }
  try { await Notification.requestPermission(); } catch (_) {}
  renderNotifState();
  if (Notification.permission === 'granted') checkExpiryReminders(true);
}

async function checkExpiryReminders(force) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  if (!force && localStorage.getItem(NOTIF_KEY) === todayStr()) return;

  const soon = load().trades
    .filter(t => t.status === 'active')
    .map(t => ({ t, dr: daysRemaining(t) }))
    .filter(x => x.dr <= 5)
    .sort((a,b) => a.dr - b.dr);
  if (!soon.length) {
    if (force) showToast('Reminders on — nothing expires in the next 5 days', null, null, 4000);
    return;
  }

  const lead = soon[0];
  const body = soon.length === 1
    ? `${lead.t.ticker} ${lead.t.type.toUpperCase()} ${fmtMoney(currentStrike(lead.t))} — ${
        lead.dr < 0 ? 'past expiration' : lead.dr === 0 ? 'expires today' : `${fmtInt(lead.dr)} day${lead.dr===1?'':'s'} left`}`
    : `${fmtInt(soon.length)} positions expiring soon — ${lead.t.ticker} first (${
        lead.dr < 0 ? 'past expiration' : fmtInt(lead.dr) + 'd'})`;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Options Tracker', {
      body, tag: 'expiry', icon: './icon.svg', badge: './icon.svg'
    });
    localStorage.setItem(NOTIF_KEY, todayStr());
  } catch (_) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderOnlineState(); checkExpiryReminders(); checkMarketSchedule();
  }
});

/* ═══════════════════════════════════════
   HARD REFRESH (pull latest from GitHub)
═══════════════════════════════════════ */
function hardRefresh() {
  // Updating means re-downloading the app; offline it would only clear the
  // cache the app is currently running from.
  if (navigator.onLine === false) {
    alert('You\'re offline — the app is running from its cached copy. Reconnect and try Update App again.');
    return;
  }
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  btn.disabled = true;

  // Also drop the OCR engine's IndexedDB cache ('keyval-store' is
  // tesseract.js's traineddata store); trade data lives in localStorage
  // and is untouched.
  if (window.indexedDB) { try { indexedDB.deleteDatabase('keyval-store'); } catch(_) {} }

  // If service worker is available, tell it to clear cache then reload
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage('CLEAR_AND_RELOAD');
    // Fallback timeout in case SW doesn't respond
    setTimeout(() => {
      window.location.href = window.location.href.split('?')[0] + '?v=' + Date.now();
    }, 3000);
  } else {
    // No SW — plain cache-bust reload
    setTimeout(() => {
      window.location.href = window.location.href.split('?')[0] + '?v=' + Date.now();
    }, 420);
  }
}

/* ═══════════════════════════════════════
   EXPORT / IMPORT
═══════════════════════════════════════ */

function exportData() {
  const d = load();
  const payload = {
    version: 2,
    exported: new Date().toISOString(),
    exportedFrom: 'Options Tracker',
    trades: d.trades,
    positions: loadPositions(d),
    watchlist: loadWatchlist(d),
    watchNotes: loadWatchNotes(d)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const date = new Date().toISOString().split('T')[0];
  a.href     = url;
  a.download = `options-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  // Record last export time
  localStorage.setItem('opts_last_export', new Date().toISOString());
  updateLastExportLabel();
  verifyBackup(payload, d);
}

/* A backup is only worth having if it restores. Read the file we just
   wrote back through the same validation an import would apply, and say
   plainly whether every record survived the round trip. */
function verifyBackup(payload, d) {
  const el = document.getElementById('backup-verify');
  if (!el) return;
  let restored = 0, positions = 0, err = null;
  try {
    const parsed = JSON.parse(JSON.stringify(payload));
    restored  = (parsed.trades || []).map(normalizeTrade).filter(Boolean).length;
    positions = (parsed.positions || []).map(normalizePosition).filter(Boolean).length;
  } catch (e) { err = e.message; }
  const wantT = d.trades.length, wantP = loadPositions(d).length;
  const ok = !err && restored === wantT && positions === wantP;
  el.className   = 'opt-row-sub' + (ok ? '' : ' ');
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
  el.textContent = ok
    ? `✓ Verified restorable — ${fmtInt(restored)} trade${restored===1?'':'s'}`
      + (positions ? ` and ${fmtInt(positions)} share lot${positions===1?'':'s'}` : '') + ' read back cleanly'
    : `⚠ Verify failed — ${fmtInt(restored)} of ${fmtInt(wantT)} trades read back`
      + (err ? ` (${err})` : '') + '. Keep your previous backup.';
}

function updateLastExportLabel() {
  const el = document.getElementById('backup-last-export');
  if (!el) return;
  const ts = localStorage.getItem('opts_last_export');
  if (ts) {
    const d = new Date(ts);
    el.textContent = `Last export: ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
  }
}

// ── Import: preview before committing ──
let _importPayload = null;
let _importMode    = 'merge';

// Validate and coerce one raw trade from a backup file.
// Returns a clean trade object, or null when the record is unusable.
function normalizeTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const ticker  = String(raw.ticker || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 6);
  const strike  = num(raw.strikePrice);
  const premium = num(raw.premium);
  if (!TICKER_RE.test(ticker) || strike == null || strike <= 0 || premium == null) return null;

  const status = ['active', 'expired', 'closed_early', 'assigned'].includes(raw.status) ? raw.status : 'active';
  const dte    = Math.max(1, parseInt(raw.dteAtExecution) || 1);
  const t = {
    id: (typeof raw.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.id)) ? raw.id : uid(),
    ticker, strikePrice: strike, premium,
    type: raw.type === 'call' ? 'call' : 'put',
    qty:  Math.max(1, parseInt(raw.qty) || 1),
    dteAtExecution: dte,
    roiAtExecution: num(raw.roiAtExecution) ?? roiPct(premium, strike, dte),
    dateOpened: DATE_RE.test(raw.dateOpened || '') ? raw.dateOpened : todayStr(),
    expDate:    DATE_RE.test(raw.expDate || '')    ? raw.expDate    : null,
    status, rolls: [], closeInfo: null,
    ...(typeof raw.positionId === 'string' ? { positionId: raw.positionId } : {})
  };
  if (Array.isArray(raw.rolls)) {
    raw.rolls.forEach(r => {
      const s = num(r?.strikePrice), p = num(r?.premium), d = parseInt(r?.dte);
      if (s != null && s > 0 && p != null && d > 0) t.rolls.push({
        strikePrice: s, premium: p, dte: d,
        dateRolled: DATE_RE.test(r.dateRolled || '') ? r.dateRolled : t.dateOpened,
        expDate:    DATE_RE.test(r.expDate || '')    ? r.expDate    : null
      });
    });
  }
  if (status !== 'active') {
    t.closeInfo = {
      buyingPrice: num(raw.closeInfo?.buyingPrice) ?? 0,
      dateClosed:  DATE_RE.test(raw.closeInfo?.dateClosed || '') ? raw.closeInfo.dateClosed : todayStr()
    };
  }
  return t;
}

// Validate one raw share lot from a backup file
function normalizePosition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const ticker = String(raw.ticker || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 6);
  const shares = parseInt(raw.shares);
  const basis  = num(raw.costBasis);
  if (!TICKER_RE.test(ticker) || !(shares > 0) || basis == null || basis <= 0) return null;
  const p = {
    id: (typeof raw.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.id)) ? raw.id : uid(),
    ticker, shares, costBasis: basis,
    dateAcquired: DATE_RE.test(raw.dateAcquired || '') ? raw.dateAcquired : todayStr(),
    sourceTradeId: typeof raw.sourceTradeId === 'string' ? raw.sourceTradeId : null,
    status: raw.status === 'closed' ? 'closed' : 'open',
    closeInfo: null
  };
  if (p.status === 'closed') {
    p.closeInfo = {
      pricePerShare: num(raw.closeInfo?.pricePerShare) ?? 0,
      dateClosed: DATE_RE.test(raw.closeInfo?.dateClosed || '') ? raw.closeInfo.dateClosed : todayStr(),
      reason: raw.closeInfo?.reason === 'called_away' ? 'called_away' : 'sold'
    };
  }
  return p;
}

function previewImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.trades)) throw new Error('Invalid backup file');

      const trades = [];
      let skipped = 0;
      data.trades.forEach(raw => {
        const t = normalizeTrade(raw);
        if (t) trades.push(t); else skipped++;
      });
      const positions = (Array.isArray(data.positions) ? data.positions : [])
        .map(normalizePosition).filter(Boolean);
      const watchlist = Array.from(new Set((Array.isArray(data.watchlist) ? data.watchlist : [])
        .map(v => String(v || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 6))
        .filter(v => TICKER_RE.test(v)))).slice(0, MAX_WATCH);
      const rawNotes = (data.watchNotes && typeof data.watchNotes === 'object') ? data.watchNotes : {};
      const watchNotes = {};
      watchlist.forEach(tk => {
        const n = String(rawNotes[tk] || '').trim().slice(0, 80);
        if (n) watchNotes[tk] = n;
      });
      if (!trades.length) throw new Error('No valid trades in file');
      _importPayload = { trades, positions, watchlist, watchNotes };

      const active  = trades.filter(t => t.status === 'active').length;
      const closed  = trades.filter(t => t.status !== 'active').length;
      const rolled  = trades.filter(t => t.rolls.length > 0).length;
      const expDate = data.exported ? new Date(data.exported).toLocaleDateString() : 'unknown';

      document.getElementById('import-preview-box').innerHTML = `
        <div class="import-preview-row"><span class="import-preview-lbl">File</span><span class="import-preview-val">${esc(file.name)}</span></div>
        <div class="import-preview-row"><span class="import-preview-lbl">Exported on</span><span class="import-preview-val">${esc(expDate)}</span></div>
        <div class="import-preview-row"><span class="import-preview-lbl">Total trades</span><span class="import-preview-val">${trades.length}</span></div>
        <div class="import-preview-row"><span class="import-preview-lbl">Active</span><span class="import-preview-val">${active}</span></div>
        <div class="import-preview-row"><span class="import-preview-lbl">Closed / Expired</span><span class="import-preview-val">${closed}</span></div>
        <div class="import-preview-row"><span class="import-preview-lbl">Rolled trades</span><span class="import-preview-val">${rolled}</span></div>
        ${positions.length ? `<div class="import-preview-row"><span class="import-preview-lbl">Share lots</span><span class="import-preview-val">${positions.length}</span></div>` : ''}
        ${watchlist.length ? `<div class="import-preview-row"><span class="import-preview-lbl">Watchlist</span><span class="import-preview-val">${watchlist.length}</span></div>` : ''}
        ${skipped ? `<div class="import-preview-row"><span class="import-preview-lbl">Skipped (invalid)</span><span class="import-preview-val" style="color:var(--red)">${skipped}</span></div>` : ''}
      `;
      setImportMode('merge');
      openOverlay('m-import');
    } catch(err) {
      alert('Could not read file. Make sure you selected a valid Options Tracker backup (.json).');
    }
  };
  reader.readAsText(file);
  document.getElementById('json-input').value = '';
}

function setImportMode(mode) {
  _importMode = mode;
  document.getElementById('imp-mode-merge').classList.toggle('selected',   mode === 'merge');
  document.getElementById('imp-mode-replace').classList.toggle('selected', mode === 'replace');
  document.getElementById('import-replace-warn').style.display = mode === 'replace' ? 'block' : 'none';
}

function confirmImport() {
  if (!_importPayload) return;
  const incoming = _importPayload.trades || [];
  const incomingPos = _importPayload.positions || [];
  const incomingWatch = _importPayload.watchlist || [];
  const incomingNotes = _importPayload.watchNotes || {};
  if (_importMode === 'replace') {
    save({ trades: incoming, positions: incomingPos,
           watchlist: incomingWatch, watchNotes: incomingNotes });
  } else {
    // Merge: skip any record whose id already exists
    const current = load();
    const existingIds = new Set(current.trades.map(t => t.id));
    current.trades = current.trades.concat(incoming.filter(t => !existingIds.has(t.id)));
    const existingPos = new Set(loadPositions(current).map(p => p.id));
    current.positions = loadPositions(current).concat(incomingPos.filter(p => !existingPos.has(p.id)));
    const watch = loadWatchlist(current);
    current.watchlist = watch.concat(incomingWatch.filter(tk => !watch.includes(tk))).slice(0, MAX_WATCH);
    // A note already on this device wins; the backup only fills the gaps
    current.watchNotes = { ...incomingNotes, ...loadWatchNotes(current) };
    save(current);
  }
  closeOverlay('m-import');
  _importPayload = null;
  renderActive();
  updateStats();
  renderWatchlist();
  alert('Import complete. Your trades have been restored.');
}

/* ═══════════════════════════════════════
   SCAN / OCR FEATURE
═══════════════════════════════════════ */

// ── Lazy-load Tesseract ──
let _tessPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (_tessPromise) return _tessPromise;
  _tessPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = res;
    s.onerror = () => {
      _tessPromise = null;   // allow a retry on the next scan attempt
      s.remove();
      rej(new Error('Could not download the OCR library'));
    };
    document.head.appendChild(s);
  });
  return _tessPromise;
}

// ── Create an OCR worker ──
// First attempt uses tesseract.js's normal IndexedDB cache; if init fails
// (e.g. the cached eng.traineddata was corrupted by an earlier interrupted
// download) retry once with cacheMethod:'refresh' to redownload clean data.
async function createOcrWorker(logger) {
  try {
    return await Tesseract.createWorker('eng', 1, { logger });
  } catch (_) {
    return await Tesseract.createWorker('eng', 1, { logger, cacheMethod: 'refresh' });
  }
}

// ── Date helpers for OCR parsing ──
function parseSlashDate(s) {
  const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  let yr = parseInt(m[3]); if (yr < 100) yr += 2000;
  const d = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
  return isNaN(d) ? null : d;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dteFromToday(d) {
  const today0 = new Date(); today0.setHours(0,0,0,0);
  return Math.max(1, Math.ceil((d - today0) / 86400000));
}

// ── Parse OCR text into trade fields ──
function parseTradeText(raw) {
  const t  = raw;
  const tu = raw.toUpperCase();

  const out = {
    ticker:'', strike:'', premium:'', type:'put',
    dte:'', expDate:'', qty:null, dateOpened: todayStr(),
    action: null,   // 'new_trade' | 'close_trade' | 'roll'
    rawText: raw, thumb: null
  };

  // ── Action ──
  if (/sell\s+to\s+open|\bsto\b/i.test(t))       out.action = 'new_trade';
  else if (/buy\s+to\s+open|\bbto\b/i.test(t))   out.action = 'new_trade';
  else if (/buy\s+to\s+close|\bbtc\b/i.test(t))  out.action = 'close_trade';
  else if (/sell\s+to\s+close|\bstc\b/i.test(t)) out.action = 'close_trade';
  // Detect roll: one image shows BOTH close + open legs (multi-leg / spread confirmation)
  if (/sell\s+to\s+open|\bsto\b/i.test(t) && /buy\s+to\s+close|\bbtc\b/i.test(t)) out.action = 'roll';

  // ── Put / Call ──
  if      (/\bput\b/i.test(t))  out.type = 'put';
  else if (/\bcall\b/i.test(t)) out.type = 'call';

  // ── Structured "Order Status" layout ──
  // Brokerage order screens carry an OCC-style descriptor line with the core
  // fields in one place, e.g. "GOOG 08/28/2026 330.00 P". Trust it over the
  // looser heuristics below whenever it's present.
  const desc = tu.match(/\b([A-Z]{1,6})\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+\$?(\d{1,5}(?:\.\d{1,2})?)\s*([PC])(?:UT|ALL)?\b/);
  if (desc) {
    out.ticker = desc[1];
    out.type   = desc[4] === 'C' ? 'call' : 'put';
    const st = parseFloat(desc[3]);
    if (st >= 1) out.strike = st;
    const ed = parseSlashDate(desc[2]);
    if (ed) { out.expDate = isoDate(ed); out.dte = dteFromToday(ed); }
  }

  // Fill Price is the premium actually received/paid — prefer it over the limit
  const fp = tu.match(/FILL\s*PRICE\s*:?\s*\$?(\d{1,4}(?:\.\d{1,3})?)/);
  if (fp) { const v = parseFloat(fp[1]); if (v > 0) out.premium = v; }

  // Contracts filled
  const qm = tu.match(/FILLED\s*QTY\.?\s*:?\s*(\d{1,4})\b/)
          || tu.match(/(?:BUY|SELL)\s+TO\s+(?:OPEN|CLOSE)\s+(\d{1,4})\s*@/);
  if (qm) out.qty = Math.max(1, parseInt(qm[1]));

  // Fill/Create Time carries the date the order actually executed
  const ft = tu.match(/(?:FILL|CREATE)\s*TIME[^\n]*?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (ft) { const fd = parseSlashDate(ft[1]); if (fd) out.dateOpened = isoDate(fd); }

  // ── Ticker ──
  const SKIP = new Set(['TO','A','PUT','CALL','BUY','SELL','OPEN','CLOSE','LIMIT',
    'MARKET','STOP','TRADE','CONTRACT','CONTRACTS','ORDER','FILL','FILLED','CONFIRM',
    'CONFIRMATION','STRIKE','PRICE','EXPIR','EXPIRATION','DTE','DAY','DAYS',
    'PREMIUM','PER','USD','FEE','NET','DEBIT','CREDIT','STO','BTO','BTC','STC',
    'SOLD','BOUGHT','NEW','GTC','OCO','SHARES','OPTION','OPTIONS','POSITION',
    'TOTAL','AMOUNT','COMMISSION','SYMBOL','QUANTITY','TYPE','SIDE','STATUS',
    'JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC',
    'ROLL','ROLLED','AND','OR','FOR','AT','IN','ON','IS','ARE','THE','OF']);
  // Prefer ticker that precedes put/call/strike/dollar sign
  const m1 = out.ticker ? null : t.match(/\b([A-Z]{1,5})\b(?=\s*(?:put|call|\$\d|\d{2,4}\s*(?:put|call)))/i);
  if (m1 && !SKIP.has(m1[1].toUpperCase())) { out.ticker = m1[1].toUpperCase(); }
  if (!out.ticker) {
    const words = tu.match(/\b[A-Z]{1,5}\b/g) || [];
    for (const w of words) { if (!SKIP.has(w) && /^[A-Z]+$/.test(w)) { out.ticker = w; break; } }
  }

  // ── Strike price ──
  // Patterns: "$150 Put", "Strike: $150", "150 Put", "@150", "150.00"
  const strikePs = [
    /\$(\d{2,4}(?:\.\d{0,2})?)\s*(?:strike|put|call)/i,
    /(?:strike\s*(?:price)?\s*[:\-]?\s*)\$?(\d{2,4}(?:\.\d{0,2})?)/i,
    /\b(\d{2,4}(?:\.\d{0,2})?)\s*(?:PUT|CALL)\b/i,
    /(?:@|at)\s*\$?(\d{2,4}(?:\.\d{0,2})?)\b/i,
  ];
  for (const p of strikePs) {
    if (out.strike) break;
    const m = t.match(p);
    if (m) { const v = parseFloat(m[1]); if (v >= 5) { out.strike = v; break; } }
  }

  // ── Premium (price per contract / fill price) ──
  // Distinguish from strike: premium is usually < $50, has 2 decimal places
  const premPs = [
    /(?:limit|filled?\s*(?:at|@)\s*|premium\s*[:\-]?\s*|price\s*[:\-]?\s*)\$?(\d{1,3}\.\d{2})\b/i,
    /\$(\d{1,3}\.\d{2})\s*(?:\/\s*(?:contract|share|option))/i,
    /(?:credit|debit)\s*(?:of\s*)?\$?(\d{1,3}\.\d{2})/i,
  ];
  for (const p of premPs) {
    if (out.premium) break;
    const m = t.match(p);
    if (m) { const v = parseFloat(m[1]); if (v > 0 && v < 500) { out.premium = v; break; } }
  }
  // Fallback: find any $X.XX that is plausibly a premium (< 50 and != strike)
  if (!out.premium) {
    const allDollar = [...t.matchAll(/\$(\d{1,3}\.\d{2})/g)];
    for (const m of allDollar) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 50 && v !== out.strike) { out.premium = v; break; }
    }
  }

  // ── Expiration date → DTE (fallback when no descriptor line matched) ──
  // Search text with screen-timestamp and execution-time lines removed, so
  // "Updated: … 07/17/2026" or "Fill Time … 07/15/2026" can't masquerade
  // as the expiration.
  if (!out.expDate) {
  const tClean = t.replace(/(?:updated|fill\s*time|create\s*time)[^\n]*/gi, '');
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mRe = new RegExp(`(${MONTHS.join('|')})\\.?\\s*(\\d{1,2})(?:,?\\s*(\\d{2,4}))?`, 'i');
  const nRe = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;
  let expDate = null;

  const mm = tClean.match(mRe);
  const nm = tClean.match(nRe);
  if (mm) {
    const mi = MONTHS.findIndex(x => mm[1].toLowerCase().startsWith(x));
    const day = parseInt(mm[2]);
    let yr = mm[3] ? parseInt(mm[3]) : new Date().getFullYear();
    if (yr < 100) yr += 2000;
    expDate = new Date(yr, mi, day);
  } else if (nm) {
    let yr = nm[3] ? parseInt(nm[3]) : new Date().getFullYear();
    if (yr < 100) yr += 2000;
    expDate = new Date(yr, parseInt(nm[1])-1, parseInt(nm[2]));
  }
  if (expDate && !isNaN(expDate)) {
    out.expDate = isoDate(expDate);
    out.dte = dteFromToday(expDate);
  }
  }

  // ── Date opened (fallback when no Fill/Create Time line matched) ──
  // Try to find "placed" or "order date" near a date
  const oRe = /(?:placed|opened?|order\s+date|date)[:\s]+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i;
  const om = ft ? null : t.match(oRe);
  if (om) {
    const [mo,dy,yr] = om[1].split(/[\/\-]/);
    let year = yr ? parseInt(yr) : new Date().getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, parseInt(mo)-1, parseInt(dy));
    if (!isNaN(d)) out.dateOpened = d.toISOString().split('T')[0];
  }

  return out;
}

// ── Build a thumbnail data-url from a File ──
function fileThumbnail(file) {
  return new Promise(res => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX = 120;
        const scale = MAX / Math.max(img.width, img.height);
        canvas.width  = img.width  * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        res(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Normalize an image before OCR ──
// Re-encodes through a canvas so the OCR engine always receives PNG bytes.
// This makes iPhone HEIC photos work wherever the browser can decode them,
// and turns unreadable files into a clear error instead of a cryptic one.
function normalizeImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const MAX = 2200;   // cap the long edge; plenty for screenshot text
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width  = Math.max(1, Math.round(img.width  * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => b ? res(b) : rej(new Error('Could not convert image')), 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error(`Could not read "${file.name}" — unsupported image format. Use a PNG or JPEG screenshot.`));
    };
    img.src = url;
  });
}

// ── OCR a single file ──
async function ocrFile(file, worker) {
  const blob = await normalizeImage(file);
  const { data: { text } } = await worker.recognize(blob);
  return text;
}

// ── Main handler: files selected ──
let scanResults = [];

async function handleImageFiles(files) {
  if (!files || !files.length) return;
  switchTab('scan');

  // Reset UI
  scanResults = [];
  document.getElementById('scan-results').innerHTML = '';
  document.getElementById('scan-done-banner').style.display = 'none';
  const prog    = document.getElementById('scan-progress');
  const bar     = document.getElementById('scan-bar');
  const label   = document.getElementById('scan-prog-label');
  const countEl = document.getElementById('scan-prog-count');
  const fname   = document.getElementById('scan-file-name');
  prog.classList.add('active');

  let worker = null;
  try {
    await loadTesseract();
    worker = await createOcrWorker(m => {
      if (m.status === 'recognizing text') {
        bar.style.width = ((m.progress * 80) + (currentIdx / files.length * 20)).toFixed(1) + '%';
      }
    });

    for (let i = 0; i < files.length; i++) {
      currentIdx = i;
      label.textContent = `Reading image ${i+1} of ${files.length}…`;
      countEl.textContent = `${i+1} / ${files.length}`;
      fname.textContent   = files[i].name || '';
      bar.style.width = ((i / files.length) * 20) + '%';

      const [thumb, rawText] = await Promise.all([
        fileThumbnail(files[i]),
        ocrFile(files[i], worker)
      ]);
      bar.style.width = ((i+1) / files.length * 100) + '%';

      const parsed = parseTradeText(rawText);
      parsed.thumb = thumb;
      parsed.fileIdx = i;
      scanResults.push(parsed);
    }

    prog.classList.remove('active');
    renderScanResults();

  } catch(err) {
    prog.classList.remove('active');
    document.getElementById('scan-results').innerHTML =
      `<div class="rc-warn" style="padding:12px;border-radius:12px;font-size:11px">
        ⚠ Could not process images. The first scan needs a network connection to download
        the OCR engine — check your connection and try again. If it keeps failing, use the
        <b>Update App</b> button in Backup to clear cached data, then retry.<br><br>
        <span style="opacity:.7">${esc(err.message||err)}</span>
      </div>`;
  } finally {
    if (worker) { try { await worker.terminate(); } catch(_) {} }
  }
  // reset file input so same files can be re-selected
  document.getElementById('img-input').value = '';
}

let currentIdx = 0;

// ── Group results: detect roll pairs across multiple images ──
function groupResults(results) {
  // If we have both a close_trade and new_trade for the same ticker → promote to roll pair
  const grouped = results.map((r, i) => ({ ...r, _idx: i, _skip: false }));
  for (let i = 0; i < grouped.length; i++) {
    if (grouped[i].action === 'close_trade') {
      for (let j = 0; j < grouped.length; j++) {
        if (i !== j && grouped[j].action === 'new_trade'
            && grouped[i].ticker && grouped[j].ticker
            && grouped[i].ticker === grouped[j].ticker) {
          // Mark j as the open leg of a roll linked to i
          grouped[j].action = 'roll';
          grouped[j].rollLinkedTo = i;
          grouped[i]._skip = true; // swallow close into the roll card
          break;
        }
      }
    }
  }
  return grouped.filter(r => !r._skip);
}

// ── Render all result cards ──
function renderScanResults() {
  const grouped = groupResults(scanResults);
  const container = document.getElementById('scan-results');
  if (!grouped.length) {
    container.innerHTML = `<div class="empty"><div class="empty-txt">No trade data found in images</div></div>`;
    return;
  }
  container.innerHTML = `<div class="result-section-hdr">${grouped.length} trade${grouped.length>1?'s':''} detected — review &amp; confirm</div>`;
  grouped.forEach((r, i) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.id = `rc-${i}`;
    card.innerHTML = buildResultCardHTML(r, i);
    container.appendChild(card);
  });
}

// ── Build HTML for one result card ──
function buildResultCardHTML(r, idx) {
  const active = load().trades.filter(t => t.status === 'active');

  // Action badge
  const badges = {
    new_trade:   ['rca-new',     'New Trade'],
    close_trade: ['rca-close',   'Close Trade'],
    roll:        ['rca-roll',    'Roll'],
    null:        ['rca-unknown', 'Unknown'],
  };
  const [badgeCls, badgeTxt] = badges[r.action] || badges[null];

  // Detected summary line
  const expLabel = r.expDate
    ? 'Exp ' + new Date(r.expDate + 'T00:00:00').toLocaleDateString()
    : (r.dte ? `${esc(r.dte)}d` : '');
  const detected = [esc(r.ticker), esc(r.type?.toUpperCase()), r.strike ? fmtMoney(r.strike) : '', expLabel]
    .filter(Boolean).join(' · ') || 'No data detected';

  // Confidence warnings
  let warns = '';
  if (!r.ticker)  warns += `<div class="rc-warn">⚠ Ticker not detected — please enter manually</div>`;
  if (!r.strike)  warns += `<div class="rc-warn">⚠ Strike price not detected — please enter manually</div>`;
  if (!r.premium) warns += `<div class="rc-warn">⚠ Premium not detected — please enter manually</div>`;
  if (!r.expDate && !r.dte) warns += `<div class="rc-warn">⚠ Expiration not detected — please enter manually</div>`;

  // Trade selector for close / roll
  let linkBox = '';
  if (r.action === 'close_trade' || r.action === 'roll') {
    const opts = active.length
      ? active.map(t => `<option value="${esc(t.id)}">${esc(t.ticker)} ${esc(t.type.toUpperCase())} ${fmtMoney(currentStrike(t))} · ${fmtMoney(totalPremiums(t))} prem</option>`).join('')
      : `<option value="">— no active trades —</option>`;
    const lbl = r.action === 'roll' ? 'Link to existing trade being rolled' : 'Select trade being closed';
    linkBox = `
      <div class="rc-link-box">
        <div class="rc-link-lbl">${lbl}</div>
        <select id="rc-link-${idx}">${opts}</select>
      </div>`;
  }

  // Type buttons
  const putSel  = r.type === 'put'  ? 'sel-put'  : '';
  const callSel = r.type === 'call' ? 'sel-call' : '';

  // Action-specific fields
  let extraField = '';
  if (r.action === 'close_trade') {
    extraField = `
      <div class="rc-field rc-field-full">
        <div class="rc-field-lbl">Buying Price (to close)</div>
        <input type="number" id="rc-buyprice-${idx}" placeholder="0.50" step="0.01"
               value="${esc(r.premium || '')}">
      </div>`;
  }

  return `
    <div class="rc-head">
      <img class="rc-thumb" src="${r.thumb||''}" alt="screenshot">
      <div class="rc-head-text">
        <div class="rc-action-badge ${badgeCls}">${badgeTxt}</div>
        <div class="rc-detected">${detected}</div>
      </div>
    </div>
    <div class="rc-body">
      ${warns}
      ${linkBox}
      <div class="rc-type-row">
        <button class="rc-type-btn ${putSel}"  id="rc-put-${idx}"  onclick="rcSetType(${idx},'put')">PUT</button>
        <button class="rc-type-btn ${callSel}" id="rc-call-${idx}" onclick="rcSetType(${idx},'call')">CALL</button>
      </div>
      <div class="rc-fields">
        <div class="rc-field">
          <div class="rc-field-lbl">Ticker</div>
          <input type="text" id="rc-ticker-${idx}" placeholder="AAPL"
                 value="${esc(r.ticker||'')}" style="text-transform:uppercase"
                 oninput="this.value=this.value.toUpperCase()">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Strike Price</div>
          <input type="number" id="rc-strike-${idx}" placeholder="150.00"
                 step="0.01" value="${esc(r.strike||'')}">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Premium</div>
          <input type="number" id="rc-prem-${idx}" placeholder="1.50"
                 step="0.01" value="${esc(r.premium||'')}">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Expiration Date</div>
          <input type="date" id="rc-exp-${idx}"
                 value="${esc(r.expDate || (r.dte ? dateFromDTE(r.dte) : ''))}">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Date Opened</div>
          <input type="date" id="rc-date-${idx}" value="${esc(r.dateOpened||todayStr())}">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Contracts</div>
          <input type="number" id="rc-qty-${idx}" placeholder="1" min="1" step="1" value="${esc(r.qty||1)}">
        </div>
        ${extraField}
      </div>
    </div>
    <div class="rc-actions">
      <button class="rc-btn rc-btn-skip"   onclick="rcSkip(${idx})">Skip</button>
      <button class="rc-btn rc-btn-accept" onclick="rcAccept(${idx},'${r.action||'new_trade'}')">
        ${ r.action==='close_trade' ? 'Close Trade' : r.action==='roll' ? 'Apply Roll' : 'Add Trade' }
      </button>
    </div>`;
}

// ── Card interactions ──
function rcSetType(idx, t) {
  document.getElementById(`rc-put-${idx}`).className  = 'rc-type-btn' + (t==='put'  ? ' sel-put'  : '');
  document.getElementById(`rc-call-${idx}`).className = 'rc-type-btn' + (t==='call' ? ' sel-call' : '');
}

function rcSkip(idx) {
  const card = document.getElementById(`rc-${idx}`);
  if (card) card.remove();
  checkAllHandled();
}

function rcAccept(idx, action) {
  const ticker  = (document.getElementById(`rc-ticker-${idx}`)?.value||'').toUpperCase().trim();
  const strike  = parseFloat(document.getElementById(`rc-strike-${idx}`)?.value);
  const prem    = parseFloat(document.getElementById(`rc-prem-${idx}`)?.value);
  const expSel  = document.getElementById(`rc-exp-${idx}`)?.value || '';
  const dte     = expSel ? dteFromDate(expSel) : NaN;
  const qty     = Math.max(1, parseInt(document.getElementById(`rc-qty-${idx}`)?.value) || 1);
  const dateOp  = document.getElementById(`rc-date-${idx}`)?.value || todayStr();
  const putBtn  = document.getElementById(`rc-put-${idx}`);
  const type    = putBtn?.classList.contains('sel-put') ? 'put' : 'call';
  const linkSel = document.getElementById(`rc-link-${idx}`);
  const linkedId = linkSel?.value || null;

  if (!ticker) { alert('Please enter a ticker symbol'); return; }
  if (!TICKER_RE.test(ticker)) { alert('Ticker must be 1–6 letters (A–Z)'); return; }

  const d = load();

  if (action === 'new_trade' || action === 'roll') {
    if (!strike || !prem || !dte) { alert('Please fill in Strike, Premium, and Expiration Date'); return; }
    const expDate = expSel;

    if (action === 'roll' && linkedId) {
      // Apply as roll to existing trade
      const trade = d.trades.find(t => t.id === linkedId);
      if (trade) {
        trade.rolls.push({ strikePrice: strike, premium: prem, dte, dateRolled: dateOp, expDate });
        save(d);
      }
    } else {
      // Brand-new trade
      d.trades.push({
        id: uid(), ticker, strikePrice: strike, premium: prem, qty,
        type, dteAtExecution: dte, expDate,
        roiAtExecution: roiPct(prem, strike, dte),
        dateOpened: dateOp, status: 'active', rolls: [], closeInfo: null
      });
      save(d);
    }
  }

  else if (action === 'close_trade') {
    const buyPrice = parseFloat(document.getElementById(`rc-buyprice-${idx}`)?.value);
    if (isNaN(buyPrice)) { alert('Please enter the buying price to close'); return; }
    if (!linkedId) { alert('Please select the trade being closed'); return; }
    const trade = d.trades.find(t => t.id === linkedId);
    if (trade) {
      trade.status    = 'closed_early';
      trade.closeInfo = { buyingPrice: buyPrice, dateClosed: dateOp };
      save(d);
    }
  }

  // Remove card
  const card = document.getElementById(`rc-${idx}`);
  if (card) card.style.cssText = 'opacity:.4;pointer-events:none;transition:opacity .3s';
  setTimeout(() => { card?.remove(); checkAllHandled(); }, 350);

  // Refresh portfolio stats
  updateStats();
}

function checkAllHandled() {
  const remaining = document.querySelectorAll('.result-card').length;
  if (remaining === 0) {
    document.getElementById('scan-done-banner').style.display = 'block';
  }
}

// Close overlays on background tap — except those marked data-keep-open,
// where a stray tap would throw away everything typed in
document.querySelectorAll('.overlay, .confirm-overlay').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el && !el.hasAttribute('data-keep-open')) el.classList.remove('open');
  });
});

// Uppercase ticker inputs
['a-ticker','c-ticker','wl-ticker'].forEach(id => {
  document.getElementById(id).addEventListener('input', function(){ this.value = this.value.toUpperCase(); });
});

// Ask the browser not to evict this origin's storage under pressure
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

renderActive();
updateStats();
updateLastExportLabel();
renderOnlineState();
renderNotifState();
checkExpiryReminders();
renderWatchlist();
checkMarketSchedule();

// Handle ?tab= from manifest shortcuts
(function(){
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab && ['watch','roi','analysis','scan'].includes(tab)) switchTab(tab);
})();

// ── Generate & inject PWA home screen icon ──
(function(){
  const sz = 180, r = 36;
  const c  = document.createElement('canvas');
  c.width = c.height = sz;
  const x = c.getContext('2d');

  // Rounded rect background
  x.beginPath();
  x.moveTo(r, 0); x.lineTo(sz-r, 0);
  x.arcTo(sz,0,sz,r,r); x.lineTo(sz,sz-r);
  x.arcTo(sz,sz,sz-r,sz,r); x.lineTo(r,sz);
  x.arcTo(0,sz,0,sz-r,r); x.lineTo(0,r);
  x.arcTo(0,0,r,0,r); x.closePath();
  const grad = x.createLinearGradient(0,0,sz,sz);
  grad.addColorStop(0,'#e8eef8'); grad.addColorStop(1,'#d0ddf2');
  x.fillStyle = grad; x.fill();

  // Grid lines (subtle)
  x.strokeStyle = 'rgba(26,95,175,.1)'; x.lineWidth = 1;
  [45,90,135].forEach(y=>{ x.beginPath(); x.moveTo(18,y); x.lineTo(162,y); x.stroke(); });

  // Chart area fill
  const pts = [[18,138],[42,108],[66,120],[96,72],[126,52],[162,34]];
  x.beginPath(); x.moveTo(pts[0][0],pts[0][1]);
  pts.slice(1).forEach(p=>x.lineTo(p[0],p[1]));
  x.lineTo(162,152); x.lineTo(18,152); x.closePath();
  const areaGrad = x.createLinearGradient(0,34,0,152);
  areaGrad.addColorStop(0,'rgba(26,95,175,.22)'); areaGrad.addColorStop(1,'rgba(26,95,175,.03)');
  x.fillStyle = areaGrad; x.fill();

  // Chart line
  x.beginPath(); x.moveTo(pts[0][0],pts[0][1]);
  pts.slice(1).forEach(p=>x.lineTo(p[0],p[1]));
  x.strokeStyle='#1a5faf'; x.lineWidth=5.5; x.lineJoin='round'; x.lineCap='round'; x.stroke();

  // Dot at tip
  x.beginPath(); x.arc(162,34,6,0,Math.PI*2);
  x.fillStyle='#1a5faf'; x.fill();
  x.beginPath(); x.arc(162,34,3,0,Math.PI*2);
  x.fillStyle='#fff'; x.fill();

  // Upward tick arrow (top-right corner hint)
  x.strokeStyle='rgba(26,127,75,.7)'; x.lineWidth=3; x.lineCap='round'; x.lineJoin='round';
  x.beginPath(); x.moveTo(148,22); x.lineTo(160,12); x.lineTo(160,20); x.stroke();
  x.beginPath(); x.moveTo(160,12); x.lineTo(152,12); x.stroke();

  const link = document.createElement('link');
  link.rel='apple-touch-icon'; link.href=c.toDataURL('image/png');
  document.head.appendChild(link);
})();
