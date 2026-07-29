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

/* ═══════════════════════════════════════
   UI STATE
═══════════════════════════════════════ */
let addType  = 'put';
let calcTypeVal = 'put';

/* ═══════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════ */
function switchTab(tab) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('n-' + tab).classList.add('active');
  document.getElementById('fab').style.display = tab === 'portfolio' ? 'flex' : 'none';
  if (tab === 'portfolio') { renderActive(); updateStats(); }
  if (tab === 'history')   { renderHistory(); }
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
    renderActive(); updateStats(); renderHistory();
  });
}

/* ═══════════════════════════════════════
   RENDER: ACTIVE TRADES
═══════════════════════════════════════ */
function renderActive() {
  const d = load();
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
  const td  = Math.max(1, daysBetween(t.dateOpened, currentExpDate(t)));
  const cs  = currentStrike(t);
  const q   = tradeQty(t);
  const rolled = t.rolls && t.rolls.length > 0;
  const roi = rolled ? roiPct(tp, cs, td) : t.roiAtExecution;
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
   RENDER: HISTORY
═══════════════════════════════════════ */
function renderHistory() {
  const items = realizedItems().sort((a,b) => new Date(b.date) - new Date(a.date));
  const { roi, monthly, pnl } = weightedStats();

  const hp = document.getElementById('h-pnl');
  hp.textContent = fmtSigned(pnl);
  hp.className   = 'sum-val ' + (pnl>0?'green':pnl<0?'red':'');

  const hr = document.getElementById('h-roi');
  hr.textContent = items.length ? fmtPct(roi) : '—';
  hr.className   = 'sum-val ' + (roi>0?'green':roi<0?'red':'');

  const hm = document.getElementById('h-monthly');
  hm.textContent = items.length ? fmtPct(monthly) : '—';
  hm.className   = 'sum-val amber';

  const el = document.getElementById('history-list');
  if (!items.length) {
    el.innerHTML = `<div class="empty"><div class="empty-txt">No closed trades yet</div></div>`;
    return;
  }
  el.innerHTML = items.map(i => i.kind === 'shares' ? shareHistCardHTML(i) : optionHistCardHTML(i)).join('');
}

function optionHistCardHTML(i) {
  const t   = i.ref;
  const tp  = totalPremiums(t);
  const cs  = currentStrike(t);
  const ad  = i.days;
  const pnl = i.pnl;
  const profPS = t.status === 'closed_early' ? tp - (t.closeInfo?.buyingPrice||0) : tp;
  const roi = roiPct(profPS, cs, ad);
  const rolled = t.rolls && t.rolls.length;
  const q = tradeQty(t);
  const stateTxt = t.status === 'expired' ? 'Expired' : t.status === 'assigned' ? 'Assigned' : 'Closed';
  const stateCls = t.status === 'expired' ? 'green' : t.status === 'assigned' ? 'blue' : 'amber';
  return `<div class="hist-card">
    <div class="hc-row1">
      <div>
        <div class="hc-ticker">${esc(t.ticker)}</div>
        <div class="hc-meta-lbl">${esc(t.type.toUpperCase())} · ${fmtMoney(cs)}${q>1?' ×'+fmtInt(q):''} · ${esc(t.dateOpened)}${t.closeInfo?.dateClosed?' → '+esc(t.closeInfo.dateClosed):''}</div>
      </div>
      <div>
        <div class="hc-pnl ${pnl>=0?'green':'red'}">${fmtSigned(pnl)}</div>
        <div class="hc-roi">${fmtPct(roi)} ROI</div>
      </div>
    </div>
    <div class="hc-grid">
      <div class="hc-item">
        <div class="hc-item-lbl">Status</div>
        <div class="hc-item-val ${stateCls}">${stateTxt}</div>
      </div>
      <div class="hc-item">
        <div class="hc-item-lbl">Premiums</div>
        <div class="hc-item-val">${fmtMoney(tp)}</div>
      </div>
      <div class="hc-item">
        <div class="hc-item-lbl">Days</div>
        <div class="hc-item-val">${fmtInt(ad)}d</div>
      </div>
      <div class="hc-item">
        <div class="hc-item-lbl">Rolls</div>
        <div class="hc-item-val">${rolled ? fmtInt(rolled)+'×' : '—'}</div>
      </div>
    </div>
  </div>`;
}

// A completed wheel leg: shares acquired by assignment and later sold or
// called away. P&L here is the stock move; the premiums that lowered the
// basis are shown alongside, already counted on their own option legs.
function shareHistCardHTML(i) {
  const p     = i.ref;
  const prem  = positionPremiums(p);
  const cycle = i.pnl + prem;
  const roi   = positionCapital(p) > 0
    ? (cycle / positionCapital(p)) * (365 / i.days) * 100 : 0;
  return `<div class="hist-card" style="border-left:3px solid var(--blue)">
    <div class="hc-row1">
      <div>
        <div class="hc-ticker">${esc(p.ticker)}</div>
        <div class="hc-meta-lbl">${fmtInt(p.shares)} SHARES · ${fmtMoney(p.costBasis)} → ${fmtMoney(p.closeInfo?.pricePerShare||0)} · ${esc(p.dateAcquired)} → ${esc(p.closeInfo?.dateClosed||'')}</div>
      </div>
      <div>
        <div class="hc-pnl ${cycle>=0?'green':'red'}">${fmtSigned(cycle)}</div>
        <div class="hc-roi">${fmtPct(roi)} cycle ROI</div>
      </div>
    </div>
    <div class="hc-grid">
      <div class="hc-item">
        <div class="hc-item-lbl">Status</div>
        <div class="hc-item-val blue">${p.closeInfo?.reason === 'called_away' ? 'Called Away' : 'Sold'}</div>
      </div>
      <div class="hc-item">
        <div class="hc-item-lbl">Stock</div>
        <div class="hc-item-val ${i.pnl>=0?'green':'red'}">${fmtSigned(i.pnl)}</div>
      </div>
      <div class="hc-item">
        <div class="hc-item-lbl">Premiums</div>
        <div class="hc-item-val">${fmtMoney(prem)}</div>
      </div>
      <div class="hc-item">
        <div class="hc-item-lbl">Held</div>
        <div class="hc-item-val">${fmtInt(i.days)}d</div>
      </div>
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

  const { monthly: overallMonthly, pnl: overallPnL } = weightedStats();
  const wins    = items.filter(i => i.pnl > 0).length;
  const avgDays = items.length ? items.reduce((s,i) => s + i.days, 0) / items.length : 0;

  let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div class="stat-card">
        <div class="stat-label">Total Realized P&L</div>
        <div class="stat-value ${overallPnL>=0?'pos':'neg'}">${fmtSigned(overallPnL)}</div>
        <div class="stat-sub">${fmtInt(items.length)} closed</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Monthly ROI</div>
        <div class="stat-value ${overallMonthly>=0?'pos':'neg'}">${fmtPct(overallMonthly)}</div>
        <div class="stat-sub">weighted by capital-days</div>
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
    const ranked = active.map(t => {
      const span = Math.max(1, daysBetween(t.dateOpened, currentExpDate(t)));
      return { t, capital: tradeCapital(t),
               roi: roiPct(totalPremiums(t), currentStrike(t), span) };
    }).sort((a,b) => b.roi - a.roi);
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
            <div><b>${esc(i.ticker)}</b><span class="muted"> · ${label}</span></div>
            <div><span class="${i.pnl>=0?'green':'red'}">${fmtSigned(i.pnl)}</span>
              <span class="muted"> · ${state}</span></div>
          </div>`;}).join('')}
      </div>
    </div>`;
  });
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
   SERVICE WORKER + AUTOMATIC UPDATES
   There is no version number to maintain. The service worker derives one
   from the validators the host sends for the deployed files, so it moves
   by itself on every deploy. When it changes, the app either reloads
   straight away or — if you are in the middle of something — offers the
   update rather than yanking the page out from under you.
═══════════════════════════════════════ */
let appVersion   = null;
let _swReg       = null;
let _reloading   = false;

// Never reload out from under an open sheet, a confirm dialog, or a
// half-typed batch of trades.
function updateWouldInterrupt() {
  if (document.querySelector('.overlay.open, .confirm-overlay.open')) return true;
  const paste = document.getElementById('bt-paste');
  if (paste && paste.value.trim()) return true;
  return [...document.querySelectorAll('#bt-rows input')].some(i => i.value.trim());
}

function applyUpdate() {
  if (_reloading) return;
  _reloading = true;
  // Cache-bust so the reload cannot be answered from the HTTP cache
  window.location.href = window.location.href.split('?')[0] + '?v=' + Date.now();
}

function onUpdateReady(version) {
  if (_reloading || version && version === appVersion) return;
  if (!updateWouldInterrupt()) { applyUpdate(); return; }
  showToast('A new version is ready.', 'Reload', applyUpdate, 60000);
}

function renderVersionLabel() {
  const el = document.getElementById('app-version');
  if (el) el.textContent = appVersion ? `Version ${appVersion}` : 'Version — checking…';
}

function askVersion() {
  navigator.serviceWorker?.controller?.postMessage('GET_VERSION');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then(reg => {
        _swReg = reg;

        // A new worker script (i.e. this file's own logic changed) — let it
        // take over as soon as it is ready.
        reg.addEventListener('updatefound', () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', () => {
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              incoming.postMessage('SKIP_WAITING');
            }
          });
        });
        if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage('SKIP_WAITING');

        reg.update().catch(() => {});
        askVersion();
      })
      .catch(err => console.warn('[SW] Registration failed:', err));

    navigator.serviceWorker.addEventListener('message', event => {
      const data = event.data;
      if (data === 'READY_TO_RELOAD') { applyUpdate(); return; }
      if (data && data.type === 'VERSION') {
        appVersion = data.version || null;
        renderVersionLabel();
        return;
      }
      if (data && data.type === 'UPDATE_READY') onUpdateReady(data.version);
    });

    // The worker that took over is serving newer files than this page was
    // built from, so this page is the stale one.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (appVersion !== null) onUpdateReady(null); else askVersion();
    });
  });
}

// Check again whenever the app comes back to the foreground — that is when
// a phone left open for days notices a deploy.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  _swReg?.update().catch(() => {});
  askVersion();
});

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
}
window.addEventListener('online',  renderOnlineState);
window.addEventListener('offline', renderOnlineState);

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
  if (document.visibilityState === 'visible') { renderOnlineState(); checkExpiryReminders(); }
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
    positions: loadPositions(d)
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
      if (!trades.length) throw new Error('No valid trades in file');
      _importPayload = { trades, positions };

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
  if (_importMode === 'replace') {
    save({ trades: incoming, positions: incomingPos });
  } else {
    // Merge: skip any record whose id already exists
    const current = load();
    const existingIds = new Set(current.trades.map(t => t.id));
    current.trades = current.trades.concat(incoming.filter(t => !existingIds.has(t.id)));
    const existingPos = new Set(loadPositions(current).map(p => p.id));
    current.positions = loadPositions(current).concat(incomingPos.filter(p => !existingPos.has(p.id)));
    save(current);
  }
  closeOverlay('m-import');
  _importPayload = null;
  renderActive();
  updateStats();
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
['a-ticker','c-ticker'].forEach(id => {
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

// Handle ?tab= from manifest shortcuts
(function(){
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  if (tab && ['history','roi','analysis','scan'].includes(tab)) switchTab(tab);
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
