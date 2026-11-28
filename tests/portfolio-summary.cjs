const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, {textContent:'', innerHTML:''});
  return nodes.get(id);
};
const share = {ticker:'SHARES', status:'open', qty:100, price:215};
const data = {trades:[], positions:[share]};
const context = vm.createContext({
  load:()=>data, loadPositions:d=>d.positions, positionCapital:p=>p.qty*p.price,
  weightedStats:()=>({roi:0, monthly:0, pnl:0}), realizedItems:()=>[], ytdPnL:()=>0,
  fmtMoney:n=>n.toLocaleString('en-US',{style:'currency',currency:'USD'}),
  fmtSigned:String, fmtInt:String, fmtPct:String, esc:String,
  breakdownCardHTML:(label, detail, rows)=>label+rows.join(''),
  document:{getElementById:node}
});
function section(start, end) {
  const a=src.indexOf(start), b=src.indexOf(end,a);
  assert.ok(a>=0 && b>a, 'Missing source section');
  vm.runInContext(src.slice(a,b),context);
}
section('const tradeQty =', '\n');
section('function currentStrike(', 'function currentExpDate(');
section('function tradeCapital(', '/* ── The stock behind');
section('function updateStats(', '/* ═');
const update=()=>vm.runInContext('updateStats()',context);
update();
assert.equal(node('s-committed').textContent,'$0.00','Share holdings alone are not committed capital');
assert.equal(node('s-committed-sub').textContent,'0 open option chains');
data.trades = [
  {status:'active', ticker:'ROLLED', type:'put', qty:1, strikePrice:800, rolls:[{strikePrice:825},{strikePrice:840}]},
  {status:'active', ticker:'OPEN', type:'put', qty:1, strikePrice:235},
  {status:'assigned', type:'put', qty:1, strikePrice:500}
];
update();
assert.equal(node('s-committed').textContent,'$107,500.00','Use only the current contract in each open chain');
assert.equal(node('s-committed-sub').textContent,'2 open option chains');
data.trades=[{status:'active', type:'call', positionId:'shares', qty:1, strikePrice:315}];
update();
assert.equal(node('s-committed').textContent,'$0.00','Covered calls add no new capital');
assert.equal(node('s-committed-sub').textContent,'1 open option chain');
assert.doesNotMatch(src,/If every open put is assigned|One earnings miss moves most of the book|renderBackupReminder/);
assert.doesNotMatch(html,/id="backup-reminder"/);
assert.match(src,/breakdownCardHTML\('Concentration', 'capital at risk by ticker'/);
assert.match(html,/Data Backup/);
assert.match(html,/options-auto-backup/);
console.log('PASS: Portfolio counts current open option chains only; removes requested banners and retains backup tools and Concentration.');
