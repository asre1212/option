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
function totalDTE(t) {
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
function tradePnL(t) {
  const q = tradeQty(t);
  if (t.status === 'expired')      return totalPremiums(t) * 100 * q;
  if (t.status === 'closed_early') return (totalPremiums(t) - (t.closeInfo?.buyingPrice||0)) * 100 * q;
  return 0;
}
function actualDays(t) {
  if (t.status === 'closed_early' && t.closeInfo?.dateClosed) {
    const d = Math.ceil((new Date(t.closeInfo.dateClosed) - new Date(t.dateOpened)) / 86400000);
    return d > 0 ? d : 1;
  }
  return totalDTE(t);
}

// Annualized return weighted by capital-days: each trade counts by the
// dollars it committed (strike × 100 × qty) for the days it was open.
function annualizedROI(trades) {
  const profit  = trades.reduce((s,t) => s + tradePnL(t), 0);
  const capDays = trades.reduce((s,t) => s + currentStrike(t) * 100 * tradeQty(t) * actualDays(t), 0);
  return capDays > 0 ? (profit / capDays) * 365 * 100 : 0;
}

function weightedStats() {
  const closed = load().trades.filter(t => t.status !== 'active');
  if (!closed.length) return { roi:0, monthly:0, pnl:0 };
  const pnl = closed.reduce((s,t) => s + tradePnL(t), 0);
  const roi = annualizedROI(closed);
  return { roi, monthly: roi / 12, pnl };
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
  // Accept prefill as DTE number or expiration date string
  const dte = prefill?.dte || '';
  document.getElementById('a-dte').value     = dte;
  document.getElementById('a-expdate').value = dte ? dateFromDTE(dte) : '';
  setTypeBtn('a', addType);
  addROIUpdate();
  openOverlay('m-add');
}

function setAddType(t) { addType = t; setTypeBtn('a', t); addROIUpdate(); }
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
    document.getElementById('a-roi-val').textContent = r.toFixed(2) + '%';
    document.getElementById('a-roi-formula').textContent = `(365/${d}) × (${p.toFixed(2)}×100/${s}) → ${r.toFixed(2)}%`;
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
  d.trades.push({
    id: uid(), ticker, strikePrice: strike, premium, qty,
    type: addType, dteAtExecution: dte, expDate,
    roiAtExecution: roiPct(premium, strike, dte),
    dateOpened: todayStr(), status: 'active', rolls: [], closeInfo: null
  });
  save(d);
  closeOverlay('m-add');
  renderActive(); updateStats();
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
    `<b>${esc(t.ticker)}</b> ${esc(t.type.toUpperCase())}${tradeQty(t)>1?' ×'+tradeQty(t):''} &nbsp;|&nbsp; Current strike: <b>$${currentStrike(t)}</b><br>
     Premiums so far: <b>$${totalPremiums(t).toFixed(2)}</b> &nbsp;|&nbsp; Total DTE: <b>${totalDTE(t)}d</b>`;
  openOverlay('m-roll');
}

function rollROIUpdate() {
  const id = document.getElementById('r-id').value;
  const t  = load().trades.find(x => x.id === id);
  if (!t) return;
  const np = parseFloat(document.getElementById('r-premium').value);
  const ns = parseFloat(document.getElementById('r-strike').value);
  const nd = parseInt(document.getElementById('r-dte').value);
  if (np && ns && nd) {
    const tp = totalPremiums(t) + np;
    const td = totalDTE(t) + nd;
    const r  = roiPct(tp, ns, td);
    document.getElementById('r-roi-val').textContent = r.toFixed(2) + '%';
    document.getElementById('r-roi-formula').textContent =
      `(365/${td}) × ($${tp.toFixed(2)}/$${ns}) × 100`;
  }
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
    `<b>${esc(t.ticker)}</b> ${esc(t.type.toUpperCase())}${tradeQty(t)>1?' ×'+tradeQty(t):''} &nbsp;|&nbsp; Strike: <b>$${currentStrike(t)}</b><br>
     Total premiums collected: <b>$${totalPremiums(t).toFixed(2)}</b>`;
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
  pnlEl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
  pnlEl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('cl-formula').textContent =
    `($${tp.toFixed(2)} − $${buy.toFixed(2)}) × 100${q>1?' × '+q:''}`;
  const roiEl = document.getElementById('cl-roi');
  roiEl.textContent = roi.toFixed(2) + '%';
  roiEl.style.color = roi >= 0 ? 'var(--blue)' : 'var(--red)';
  document.getElementById('cl-roi-formula').textContent = `${d} actual days open`;
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
    `${t.ticker} expired worthless. Record +$${pnl.toFixed(2)} profit ($${totalPremiums(t).toFixed(2)} × 100${q>1?' × '+q:''})?`;
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
   DELETE
═══════════════════════════════════════ */
function openDelete(id) {
  document.getElementById('del-id').value = id;
  openConfirm('cd-delete');
}
function confirmDelete() {
  const id = document.getElementById('del-id').value;
  const d  = load();
  d.trades = d.trades.filter(t => t.id !== id);
  save(d);
  closeConfirm('cd-delete');
  renderActive(); updateStats();
}

/* ═══════════════════════════════════════
   RENDER: ACTIVE TRADES
═══════════════════════════════════════ */
function renderActive() {
  const trades = load().trades.filter(t => t.status === 'active');
  document.getElementById('active-count').textContent = trades.length + ' position' + (trades.length !== 1 ? 's' : '');
  const el = document.getElementById('active-list');
  if (!trades.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
      <div class="empty-txt">No active trades yet<br>Tap + to add your first position</div>
    </div>`;
    return;
  }
  el.innerHTML = trades.map(tradeCardHTML).join('');
}

function tradeCardHTML(t) {
  const tp  = totalPremiums(t);
  const td  = totalDTE(t);
  const cs  = currentStrike(t);
  const q   = tradeQty(t);
  const rolled = t.rolls && t.rolls.length > 0;
  const roi = rolled ? roiPct(tp, cs, td) : t.roiAtExecution;
  const dr  = daysRemaining(t);
  const drVal = dr < 0 ? 'past exp' : dr + 'd';
  const drCls = dr <= 5 ? ' red' : '';

  const rollHistHTML = rolled ? `
    <div class="roll-hist">
      <div class="roll-lbl">Roll History — ${t.rolls.length}×</div>
      <div class="roll-row orig">
        <span>Original</span>
        <span>$${t.strikePrice} strike · $${t.premium.toFixed(2)} prem · ${t.dteAtExecution}d</span>
      </div>
      ${t.rolls.map((r,i) => `
        <div class="roll-row">
          <span class="blue">Roll ${i+1} &nbsp;<span style="color:var(--text3);font-size:9px">${esc(r.dateRolled)}</span></span>
          <span>$${r.strikePrice} · $${r.premium.toFixed(2)} · ${r.dte}d</span>
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
          <div class="m-val">$${cs}</div>
        </div>
        <div class="metric">
          <div class="m-label">${rolled ? 'Total Prem' : 'Premium'}</div>
          <div class="m-val">$${tp.toFixed(2)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Ann. ROI</div>
          <div class="m-val amber">${roi.toFixed(1)}%</div>
        </div>
        <div class="metric">
          <div class="m-label">Days Left</div>
          <div class="m-val${drCls}">${drVal}</div>
        </div>
        <div class="metric">
          <div class="m-label">Income</div>
          <div class="m-val green">$${(tp*100*q).toFixed(0)}</div>
        </div>
        <div class="metric">
          <div class="m-label">Opened</div>
          <div class="m-val" style="font-size:10px;color:var(--text3)">${esc(t.dateOpened)}</div>
        </div>
      </div>
    </div>
    ${rollHistHTML}
    <div class="tc-actions">
      <button class="act-btn grn" onclick="openExpire('${t.id}')">Expired</button>
      <button class="act-btn blu" onclick="openRoll('${t.id}')">Roll</button>
      <button class="act-btn red" onclick="openClose('${t.id}')">Close</button>
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

  // P&L
  const pnlEl = document.getElementById('s-pnl');
  pnlEl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
  pnlEl.className   = 'stat-value ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'neu');
  document.getElementById('s-pnl-sub').textContent = closed.length + ' closed';

  // ROI
  const roiEl = document.getElementById('s-roi');
  if (closed.length) {
    roiEl.textContent = roi.toFixed(1) + '%';
    roiEl.className   = 'stat-value ' + (roi >= 0 ? 'pos' : 'neg');
  } else {
    roiEl.textContent = '—';
    roiEl.className   = 'stat-value neu';
  }

  // Committed
  const committed = active.reduce((s,t) => s + currentStrike(t)*100*tradeQty(t), 0);
  document.getElementById('s-committed').textContent = '$' + committed.toLocaleString();
  document.getElementById('s-committed-sub').textContent =
    active.length + ' position' + (active.length!==1?'s':'') + ' × strike × 100 × qty';

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
  const closed = load().trades
    .filter(t => t.status !== 'active')
    .sort((a,b) => new Date(b.closeInfo?.dateClosed||b.dateOpened) - new Date(a.closeInfo?.dateClosed||a.dateOpened));

  const { roi, monthly, pnl } = weightedStats();

  const hp = document.getElementById('h-pnl');
  hp.textContent = (pnl>=0?'+$':'-$') + Math.abs(pnl).toFixed(2);
  hp.className   = 'sum-val ' + (pnl>0?'green':pnl<0?'red':'');

  const hr = document.getElementById('h-roi');
  hr.textContent = closed.length ? roi.toFixed(1)+'%' : '—';
  hr.className   = 'sum-val ' + (roi>0?'green':roi<0?'red':'');

  const hm = document.getElementById('h-monthly');
  hm.textContent = closed.length ? monthly.toFixed(1)+'%' : '—';
  hm.className   = 'sum-val amber';

  const el = document.getElementById('history-list');
  if (!closed.length) {
    el.innerHTML = `<div class="empty"><div class="empty-txt">No closed trades yet</div></div>`;
    return;
  }

  el.innerHTML = closed.map(t => {
    const tp  = totalPremiums(t);
    const cs  = currentStrike(t);
    const ad  = actualDays(t);
    const pnl = tradePnL(t);
    const profPS = t.status==='expired' ? tp : tp-(t.closeInfo?.buyingPrice||0);
    const roi = roiPct(profPS, cs, ad);
    const rolled = t.rolls && t.rolls.length;
    const q = tradeQty(t);
    return `<div class="hist-card">
      <div class="hc-row1">
        <div>
          <div class="hc-ticker">${esc(t.ticker)}</div>
          <div class="hc-meta-lbl">${esc(t.type.toUpperCase())} · $${cs}${q>1?' ×'+q:''} · ${esc(t.dateOpened)}${t.closeInfo?.dateClosed?' → '+esc(t.closeInfo.dateClosed):''}</div>
        </div>
        <div>
          <div class="hc-pnl ${pnl>=0?'green':'red'}">${pnl>=0?'+$':'-$'}${Math.abs(pnl).toFixed(2)}</div>
          <div class="hc-roi">${roi.toFixed(1)}% ROI</div>
        </div>
      </div>
      <div class="hc-grid">
        <div class="hc-item">
          <div class="hc-item-lbl">Status</div>
          <div class="hc-item-val ${t.status==='expired'?'green':'amber'}">${t.status==='expired'?'Expired':'Closed'}</div>
        </div>
        <div class="hc-item">
          <div class="hc-item-lbl">Premiums</div>
          <div class="hc-item-val">$${tp.toFixed(2)}</div>
        </div>
        <div class="hc-item">
          <div class="hc-item-lbl">Days</div>
          <div class="hc-item-val">${ad}d</div>
        </div>
        <div class="hc-item">
          <div class="hc-item-lbl">Rolls</div>
          <div class="hc-item-val">${rolled ? rolled+'×' : '—'}</div>
        </div>
      </div>
    </div>`;
  }).join('');
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

    elRoiA.textContent = roiA != null ? roiA.toFixed(2) + '%' : '—';
    elRoiB.textContent = roiB != null ? roiB.toFixed(2) + '%' : '—';
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
      const diff = Math.abs(roiA - roiB).toFixed(2);
      if (roiA >= roiB) {
        elResA.classList.add('winner');
        elRoiA.classList.add('winner-val');
        elSubA.innerHTML = '<span class="vs-winner-badge">Better ▲</span>';
        elSubB.textContent = `$${(p2*100).toFixed(2)} income`;
        document.getElementById('vs-diff-label').textContent = `${tickA} leads by`;
      } else {
        elResB.classList.add('winner');
        elRoiB.classList.add('winner-val');
        elSubB.innerHTML = '<span class="vs-winner-badge">Better ▲</span>';
        elSubA.textContent = `$${(p*100).toFixed(2)} income`;
        document.getElementById('vs-diff-label').textContent = `${tickB} leads by`;
      }
      document.getElementById('vs-diff-val').textContent = diff + '% annualized ROI';
      diffRow.classList.add('show');
    } else {
      if (roiA != null) elSubA.textContent = `$${(p*100).toFixed(2)} income · ${d}d`;
      if (roiB != null) elSubB.textContent = `$${(p2*100).toFixed(2)} income · ${d2}d`;
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
  document.getElementById('c-roi').textContent     = roi.toFixed(2) + '%';
  document.getElementById('c-roi-sub').textContent = `$${income.toFixed(2)} income on $${s} strike · ${d}d`;
  bd.style.display = 'grid';
  document.getElementById('c-income').textContent  = '$' + income.toFixed(2);
  document.getElementById('c-period').textContent  = ((p/s)*100).toFixed(2) + '%';
  document.getElementById('c-monthly').textContent = (roi/12).toFixed(2) + '%';
  document.getElementById('c-weekly').textContent  = (roi/52).toFixed(2) + '%';
}

function renderCalcAverages() {
  const { roi, monthly } = weightedStats();
  document.getElementById('c-avg-roi').textContent     = roi     ? roi.toFixed(1)+'%'     : '—';
  document.getElementById('c-avg-monthly').textContent = monthly ? monthly.toFixed(1)+'%' : '—';
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
function renderAnalysis() {
  const trades = load().trades.filter(t => t.status !== 'active');
  const el = document.getElementById('analysis-content');
  if (!trades.length) {
    el.innerHTML = `<div class="empty"><div class="empty-txt">No closed trades to analyze yet</div></div>`;
    return;
  }

  // Group by close month
  const byMonth = {};
  trades.forEach(t => {
    const key = (t.closeInfo?.dateClosed || t.dateOpened).slice(0,7);
    (byMonth[key] = byMonth[key]||[]).push(t);
  });

  const { roi: overallROI, monthly: overallMonthly, pnl: overallPnL } = weightedStats();
  let html = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-label">Total Realized P&L</div>
        <div class="stat-value ${overallPnL>=0?'pos':'neg'}">${overallPnL>=0?'+$':'-$'}${Math.abs(overallPnL).toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Monthly ROI</div>
        <div class="stat-value pos">${overallMonthly.toFixed(2)}%</div>
      </div>
    </div>`;

  Object.keys(byMonth).sort().reverse().forEach(mk => {
    const mTrades = byMonth[mk];
    const mPnL    = mTrades.reduce((s,t) => s + tradePnL(t), 0);
    const mROI    = annualizedROI(mTrades);
    const [y,m] = mk.split('-');
    const mName = new Date(+y, +m-1).toLocaleString('default',{month:'long',year:'numeric'});
    html += `<div class="month-card">
      <div class="mc-hdr">
        <div class="mc-name">${mName}</div>
        <div class="mc-stats">
          <div class="mc-stat">
            <div class="mc-stat-val ${mROI>=0?'amber':'red'}">${mROI.toFixed(1)}%</div>
            <div class="mc-stat-lbl">ROI</div>
          </div>
          <div class="mc-stat">
            <div class="mc-stat-val ${mPnL>=0?'green':'red'}">${mPnL>=0?'+$':'-$'}${Math.abs(mPnL).toFixed(0)}</div>
            <div class="mc-stat-lbl">P&L</div>
          </div>
        </div>
      </div>
      <div class="mc-trades">
        ${mTrades.map(t => {
          const p = tradePnL(t);
          return `<div class="mc-trade-row">
            <div><b>${esc(t.ticker)}</b><span class="muted"> · ${esc(t.type.toUpperCase())} $${currentStrike(t)}${tradeQty(t)>1?' ×'+tradeQty(t):''}</span></div>
            <div><span class="${p>=0?'green':'red'}">${p>=0?'+$':'-$'}${Math.abs(p).toFixed(2)}</span>
              <span class="muted"> · ${t.status==='expired'?'exp':'closed'}</span></div>
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
    const td  = totalDTE(t);
    const cs  = currentStrike(t);
    const q   = tradeQty(t);
    const roi = roiPct(tp, cs, td);
    const rollStrikes = t.rolls.length
      ? t.rolls.map(r => `$${r.strikePrice}`).join(' → ')
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
  styleHeaderRow(ws3, monthRows[0].length);
  XLSX.utils.book_append_sheet(wb, ws3, 'Monthly Analysis');

  /* ── Download ── */
  XLSX.writeFile(wb, `options-tracker-${date}.xlsx`);
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
   HARD REFRESH (pull latest from GitHub)
═══════════════════════════════════════ */
function hardRefresh() {
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
    version: 1,
    exported: new Date().toISOString(),
    exportedFrom: 'Options Tracker',
    trades: d.trades
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

  const status = ['active', 'expired', 'closed_early'].includes(raw.status) ? raw.status : 'active';
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
    status, rolls: [], closeInfo: null
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
      if (!trades.length) throw new Error('No valid trades in file');
      _importPayload = { trades };

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
  if (_importMode === 'replace') {
    save({ trades: incoming });
  } else {
    // Merge: skip any trade whose id already exists
    const current = load();
    const existingIds = new Set(current.trades.map(t => t.id));
    const newTrades   = incoming.filter(t => !existingIds.has(t.id));
    current.trades    = current.trades.concat(newTrades);
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

// ── Parse OCR text into trade fields ──
function parseTradeText(raw) {
  const t  = raw;
  const tu = raw.toUpperCase();

  const out = {
    ticker:'', strike:'', premium:'', type:'put',
    dte:'', dateOpened: todayStr(),
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
  const m1 = t.match(/\b([A-Z]{1,5})\b(?=\s*(?:put|call|\$\d|\d{2,4}\s*(?:put|call)))/i);
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

  // ── Expiration date → DTE ──
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const mRe = new RegExp(`(${MONTHS.join('|')})\\.?\\s*(\\d{1,2})(?:,?\\s*(\\d{2,4}))?`, 'i');
  const nRe = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;
  let expDate = null;

  const mm = t.match(mRe);
  const nm = t.match(nRe);
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
    const today0 = new Date(); today0.setHours(0,0,0,0);
    out.dte = Math.max(1, Math.ceil((expDate - today0) / 86400000));
  }

  // ── Date opened ──
  // Try to find "placed" or "order date" near a date
  const oRe = /(?:placed|opened?|order\s+date|date)[:\s]+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i;
  const om = t.match(oRe);
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
  const detected = [esc(r.ticker), esc(r.type?.toUpperCase()), r.strike ? `$${esc(r.strike)}` : '', r.dte ? `${esc(r.dte)}d` : '']
    .filter(Boolean).join(' · ') || 'No data detected';

  // Confidence warnings
  let warns = '';
  if (!r.ticker)  warns += `<div class="rc-warn">⚠ Ticker not detected — please enter manually</div>`;
  if (!r.strike)  warns += `<div class="rc-warn">⚠ Strike price not detected — please enter manually</div>`;
  if (!r.premium) warns += `<div class="rc-warn">⚠ Premium not detected — please enter manually</div>`;
  if (!r.dte)     warns += `<div class="rc-warn">⚠ Expiration not detected — please enter manually</div>`;

  // Trade selector for close / roll
  let linkBox = '';
  if (r.action === 'close_trade' || r.action === 'roll') {
    const opts = active.length
      ? active.map(t => `<option value="${esc(t.id)}">${esc(t.ticker)} ${esc(t.type.toUpperCase())} $${currentStrike(t)} · ${totalPremiums(t).toFixed(2)} prem</option>`).join('')
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
          <div class="rc-field-lbl">Days to Expiration</div>
          <input type="number" id="rc-dte-${idx}" placeholder="30"
                 value="${esc(r.dte||'')}">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Date Opened</div>
          <input type="date" id="rc-date-${idx}" value="${esc(r.dateOpened||todayStr())}">
        </div>
        <div class="rc-field">
          <div class="rc-field-lbl">Contracts</div>
          <input type="number" id="rc-qty-${idx}" placeholder="1" min="1" step="1" value="1">
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
  const dte     = parseInt(document.getElementById(`rc-dte-${idx}`)?.value);
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
    if (!strike || !prem || !dte) { alert('Please fill in Strike, Premium, and DTE'); return; }
    const expDate = dateFromDTE(dte);

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

// Close overlays on background tap
document.querySelectorAll('.overlay, .confirm-overlay').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
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
