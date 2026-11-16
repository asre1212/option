// Dependency-free scanner tests. Fixtures are synthetic, not customer screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
let data = {trades:[],boxSpreads:[]}, alerts=[], saves=0;
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id,{value:'',checked:false,disabled:false,dataset:{},style:{},innerHTML:'',textContent:'',classList:{contains:()=>true},remove(){nodes.delete(id);}});
  return nodes.get(id);
};
const ctx = vm.createContext({console,Date,Map,Set,Math,Number,Object,String,Array,JSON,
  DATE_RE:/^\d{4}-\d{2}-\d{2}$/,TICKER_RE:/^[A-Z.]{1,6}$/,uid:()=> 'testbox',
  load:()=>data,save:d=>{data=d;saves++;},todayStr:()=> '2026-11-16',
  daysBetween:(a,b)=>(Date.parse(b)-Date.parse(a))/86400000,
  dteFromDate:exp=>Math.max(1,(Date.parse(exp)-Date.parse('2026-11-16'))/86400000),
  document:{getElementById:node,addEventListener(){},querySelector:()=>({dataset:{boxScanCount:'4'}}),querySelectorAll:()=>[]},
  window:{addEventListener(){}},setInterval(){},setTimeout:fn=>fn(),alert:msg=>alerts.push(msg),
  fmtMoney:n=>`$${Number(n).toFixed(2)}`,fmtSigned:n=>`${n<0?'-':'+'}$${Math.abs(n).toFixed(2)}`,
  fmtPct:n=>`${n.toFixed(2)}%`,fmtInt:String,esc:v=>String(v??'').replace(/</g,'&lt;'),
  renderActive(){},renderAnalysisIfOpen(){},renderAnalysis(){},updateStats(){},checkAllHandled(){},
  tradeQty:t=>t.qty || 1,spotAtEntry:()=>null,ensureQuote(){},backfillSpots(){},roiPct:()=>1
});
vm.runInContext(source.slice(source.indexOf('function currentStrike'),source.indexOf('function daysRemaining')),ctx);
vm.runInContext(source.slice(source.indexOf('const loadBoxSpreads'),source.indexOf('/* ═',source.indexOf('const loadBoxSpreads'))),ctx);
vm.runInContext(source.slice(source.indexOf('function parseSlashDate'),source.indexOf('// ── Build a thumbnail')),ctx);
vm.runInContext(source.slice(source.indexOf('function groupResults'),source.indexOf('// Close overlays on background tap')),ctx);
vm.runInContext(source.slice(source.indexOf('function normalizeTrade'),source.indexOf('// Validate one raw share lot')),ctx);
const run = code => JSON.parse(JSON.stringify(vm.runInContext(code,ctx)));
const block = (strike,type,action,price,qty=2,date='12/17/2027')=>`SPX ${date} ${strike}.00 ${type}\n${action} ${qty}\nFilled Qty.\nFill Price\nFill Time\n${qty}\n$${price}\n10:08 AM ET 11/16/2026\n`;
ctx.raw = [block(6000,'P','Buy To Open','100.25'),block(6000,'C','Sell To Open','1,000.50'),block(6500,'P','Sell To Open','200.25'),block(6500,'C','Buy To Open','650.50')].join('\n');
const parsed = run('parseTradeText(raw)');
assert.equal(parsed.action,'box_spread');
assert.equal(parsed.dateOpened,'2026-11-16');
assert.equal(parsed.assessment.valid,true);
assert.equal(parsed.assessment.credit,90000);
assert.equal(parsed.assessment.repayment,100000);
assert.equal(parsed.assessment.interest,10000);
assert.equal(parsed.assessment.maxLoss,10000);
assert.equal(parsed.fees,null);
ctx.legs=parsed.legs;
assert.equal(run('assessScannedBox(legs,12.34).maxLoss'),10012.34);
// Verify payoff independent of settlement price, below, between and above strikes.
for (const price of [0,5999,6000,6250,6500,7000,1e6]) {
  const payoff=parsed.legs.reduce((sum,l)=>sum+(l.action==='buy_open'?1:-1)*Math.max(0,l.type==='call'?price-l.strike:l.strike-price)*100*l.qty,0);
  assert.equal(payoff,-100000);
}
for (const [name,expr] of [
  ['missing leg','legs.slice(1)'],['duplicate leg','[legs[0],legs[0],legs[2],legs[3]]'],
  ['unequal quantity','legs.map((l,i)=>({...l,qty:i?l.qty:1}))'],
  ['missing quantity','legs.map((l,i)=>({...l,qty:i?l.qty:null}))'],
  ['fractional quantity','legs.map(l=>({...l,qty:1.5}))'],
  ['wrong expiry','legs.map((l,i)=>({...l,expDate:i?l.expDate:"2028-01-01"}))'],
  ['mixed series','legs.map((l,i)=>({...l,symbol:i?l.symbol:"SPXW"}))'],
  ['wrong underlying','legs.map(l=>({...l,symbol:"SPY"}))'],
  ['invalid strike','legs.map((l,i)=>({...l,strike:i?l.strike:null}))'],
  ['wrong direction','legs.map((l,i)=>({...l,action:i?l.action:"sell_open"}))'],
  ['closing leg','legs.map((l,i)=>({...l,action:i?l.action:"buy_close"}))'],
  ['missing action','legs.map((l,i)=>({...l,action:i?l.action:""}))'],
  ['missing fill','legs.map((l,i)=>({...l,price:i?l.price:null}))'],
  ['implausible credit','legs.map(l=>({...l,price:l.action==="sell_open"?10000:0}))']
]) {
  const result=run(`assessScannedBox(${expr})`);
  assert.equal(result.valid,false,name);assert.equal(result.maxLoss,null,name);
}
assert.equal(run('assessScannedBox(legs.map(l=>({...l,action:l.action==="buy_open"?"sell_open":"buy_open"}))).direction'),'long');
assert.equal(run('assessScannedBox(legs.map(l=>({...l,action:l.action==="buy_open"?"sell_open":"buy_open"}))).valid'),false);
ctx.partial=ctx.raw.replace(/SPX 12\/17\/2027 6500.00 C/,'unreadable descriptor');
assert.equal(run('parseTradeText(partial).action'),'box_spread');
assert.equal(run('parseTradeText(partial).assessment.valid'),false);
ctx.noQty=ctx.raw.replace('Fill Time\n2\n','Fill Time\n?\n');
assert.equal(run('parseTradeText(noQty).assessment.valid'),false,'Never replace unreadable filled quantity with order quantity');
for (const [text,expected] of [['Total Fees $12.50',12.5],['Commission $4.00\nExchange Fees $1.25',5.25],['Total Commissions and Fees $5.25\nCommission $4.00\nFees $1.25',5.25],['Total Fees $5\nTotal Fees $5',null],['No fees on image',null],['Total Fees $0.00',0]]) {
  ctx.text=text;assert.equal(run('scanFees(text)'),expected,text);
}
assert.equal(run('scanDate("02/30/2027")'),null);
assert.equal(run('scanDate("Dec 17, 2027")'),'2027-12-17');
ctx.roll=`SAMPLE Rollout Put\nCredit @ Limit $2.20\nSAMPLE 11/27/2026 235.00 P\nBuy To Close 1\nBid $10.00 Ask $11.00\nSAMPLE 12/04/2026 240.00 P\nSell To Open 1\nBid $13.00 Ask $14.00\nOrder Status Filled\nFill Price $2.15\nCreate Time 7:36 AM ET 11/16/2026`;
const roll=run('parseTradeText(roll)');
assert.equal(roll.expDate,'2026-12-04');assert.equal(roll.strike,240);assert.equal(roll.premium,2.15);assert.equal(roll.dateOpened,'2026-11-16');assert.equal(roll.action,'roll');
ctx.reverse=ctx.roll.replace(/SAMPLE 11\/27\/2026[\s\S]*?Order Status/,'SAMPLE 12/04/2026 240.00 P\nSell To Open 1\nSAMPLE 11/27/2026 235.00 P\nBuy To Close 1\nOrder Status');
assert.equal(run('parseTradeText(reverse).expDate'),'2026-12-04','Opening date wins in either leg order');
ctx.ambiguous=ctx.roll.replace('Sell To Open','Action unreadable');
assert.equal(run('parseTradeText(ambiguous).expDate'),'','Never reuse closing expiry for an unclear roll');
ctx.noFill=ctx.roll.replace('Order Status Filled\nFill Price $2.15','Order Status Working');
assert.equal(run('parseTradeText(noFill).premium'),'','Do not use a bid or limit as an executed roll premium');
// Card values are editable and confirmation is required; HTML from OCR is escaped.
ctx.parsed=parsed;ctx.parsed.rawText='<script>evil()</script>';
const cardHTML=run('buildBoxScanCard(parsed,0)');
assert.match(cardHTML,/Maximum loss at expiry/);assert.match(cardHTML,/unknown fees/);assert.match(cardHTML,/&lt;script>/);
assert.match(cardHTML,/id="rc-box-confirm-0"/);
for(const [i,l] of parsed.legs.entries()) for (const [k,v] of Object.entries(l)) node(`rc-box-0-${i}-${k}`).value=String(v??'');
node('rc-box-date-0').value='2026-11-16';node('rc-box-fees-0').value='12.34';
vm.runInContext('rcAcceptBox(0)',ctx);assert.equal(data.boxSpreads.length,0);assert.ok(alerts.length);
node('rc-box-confirm-0').checked=true;
vm.runInContext('rcAcceptBox(0)',ctx);
assert.equal(data.boxSpreads.length,1);assert.equal(data.trades.length,0,'One financing record; no naked option trades');
assert.equal(data.boxSpreads[0].fees,12.34);assert.equal(data.boxSpreads[0].legs.length,4);
ctx.backup=JSON.parse(JSON.stringify(data.boxSpreads[0]));
assert.deepEqual(run('normalizeBoxSpread(backup)'),JSON.parse(JSON.stringify(data.boxSpreads[0])));
vm.runInContext('renderBoxSpreads()',ctx);
assert.match(node('spx-financing-yearly').innerHTML,/90000.00/);
assert.match(node('spx-fees-total').textContent,/12.34/);
assert.deepEqual(run('loggedFeeTotals()'),{total:12.34,missing:0});
ctx.feesData={trades:[{fees:1,rolls:[{fees:2},{fees:null}],closeInfo:{fees:3}}],boxSpreads:[{fees:12.34}]};
assert.deepEqual(run('loggedFeeTotals(feesData)'),{total:18.34,missing:1});
// Backup preserves option fees for initial fills, rolls and close fills too.
ctx.trade={ticker:'SAMPLE',strikePrice:235,premium:3,dteAtExecution:30,dateOpened:'2026-11-16',expDate:'2026-12-16',fees:1.25,status:'closed_early',rolls:[{strikePrice:240,premium:1,dte:40,fees:2.5,dateRolled:'2026-11-20',expDate:'2026-12-30'}],closeInfo:{buyingPrice:0.25,dateClosed:'2026-12-15',fees:0.75}};
const restored=run('normalizeTrade(trade)');assert.equal(restored.fees,1.25);assert.equal(restored.rolls[0].fees,2.5);assert.equal(restored.closeInfo.fees,0.75);
// A roll cannot silently fall through to a new trade when the link is missing.
for(const [id,value] of Object.entries({'rc-ticker-1':'SAMPLE','rc-strike-1':'240','rc-prem-1':'2.15','rc-exp-1':'2026-12-04','rc-date-1':'2026-11-16','rc-qty-1':'1','rc-fees-1':'2.60'})) node(id).value=value;
const before=saves;vm.runInContext('rcAccept(1,"roll")',ctx);assert.equal(saves,before);
data.trades=[{id:'old',ticker:'SAMPLE',type:'put',qty:1,status:'active',rolls:[]}];
node('rc-link-1').value='old';node('rc-link-confirm-1').checked=true;vm.runInContext('rcAccept(1,"roll")',ctx);
assert.equal(data.trades[0].rolls[0].expDate,'2026-12-04');assert.equal(data.trades[0].rolls[0].fees,2.6);
assert.equal(data.trades[0].rolls[0].dte,18);
console.log('PASS: roll opening-date extraction; actual fills; four-leg box math and payoff; rejection of invalid/uncertain structures; fee totals, backup persistence, confirmation and save integration.');

// A scanned NVDA roll must never offer or update MU, or the wrong NVDA contract.
ctx.nvda = {ticker:'NVDA',type:'put',qty:1,closingLeg:{symbol:'NVDA',type:'put',qty:1,strike:120,expDate:'2026-11-27'}};
ctx.positions = {trades:[
 {id:'mu',ticker:'MU',type:'put',qty:1,status:'active',strikePrice:120,expDate:'2026-11-27'},
 {id:'nvda-right',ticker:'NVDA',type:'put',qty:1,status:'active',strikePrice:120,expDate:'2026-11-27'},
 {id:'nvda-wrong-exp',ticker:'NVDA',type:'put',qty:1,status:'active',strikePrice:120,expDate:'2026-12-04'},
 {id:'nvda-call',ticker:'NVDA',type:'call',qty:1,status:'active',strikePrice:120,expDate:'2026-11-27'},
 {id:'nvda-closed',ticker:'NVDA',type:'put',qty:1,status:'closed_early',strikePrice:120,expDate:'2026-11-27'}
]};
assert.deepEqual(run('matchingScanTrades(nvda,positions).map(t=>t.id)'),['nvda-right']);
ctx.positions.trades[1].rolls=[{strikePrice:125,expDate:'2026-12-11'}];
assert.deepEqual(run('matchingScanTrades(nvda,positions).map(t=>t.id)'),[],'Match the current rolled contract, not the original one');
ctx.nvda.closingLeg.strike=125;ctx.nvda.closingLeg.expDate='2026-12-11';
assert.deepEqual(run('matchingScanTrades(nvda,positions).map(t=>t.id)'),['nvda-right']);
data=ctx.positions;
vm.runInContext('scanReviews=[nvda]',ctx);
node('rc-ticker-0').value='NVDA';node('rc-qty-0').value='1';
vm.runInContext('refreshScanLink(0)',ctx);
assert.equal(node('rc-link-0').value,'nvda-right','Exactly one closing-leg match is selected');
assert.doesNotMatch(node('rc-link-0').innerHTML,/value="mu"/);
assert.equal(node('rc-link-confirm-0').checked,false);
assert.equal(node('rc-accept-0').disabled,true,'Auto-selection still requires confirmation');
node('rc-link-confirm-0').checked=true;vm.runInContext('confirmScanLink(0)',ctx);
assert.equal(node('rc-accept-0').disabled,false);
ctx.positions.trades.push({...ctx.positions.trades[1],id:'nvda-duplicate'});
node('rc-link-0').value='';vm.runInContext('refreshScanLink(0)',ctx);
assert.equal(node('rc-link-0').value,'','Ambiguous matches are never auto-selected');
console.log('PASS: ticker-specific link options, current-contract matching, unique-match selection and explicit confirmation; MU cannot be chosen for an NVDA scan.');

ctx.prefixRaw = [
 'Buy To Open 2\nSPX 12/17/2027 6000.00 P\nFill Price $100.25',
 'Sell To Open 2\nSPX 12/17/2027 6000.00 C\nFill Price $1,000.50',
 'Sell To Open 2\nSPX 12/17/2027 6500.00 P\nFill Price $200.25',
 'Buy To Open 2\nSPX 12/17/2027 6500.00 C\nFill Price $650.50'
].join('\n');
assert.equal(run('parseTradeText(prefixRaw).assessment.credit'),90000,'Prefix actions keep each leg fill in its own block');
assert.equal(run('assessScannedBox(legs,-5).valid'),false);
assert.equal(run('normalizeRecordedFees(false)'),null);
assert.equal(run('scanOptionLegs("SPXW271217C06000000\\nSell To Open 1")[0].expDate'),'2027-12-17');
console.log('PASS: prefix-action confirmations, OCC symbols, non-numeric fee rejection and invalid-fee validation.');

ctx.singleClose = 'NVDA 11/27/2026 120.00 P\nBuy To Close 1\nFill Price $1.25\nFill Time 10:08 AM ET 11/16/2026\nTotal Fees $1.10';
ctx.singleOpen = 'NVDA 12/04/2026 125.00 P\nSell To Open 1\nFill Price $3.00\nFill Time 10:09 AM ET 11/16/2026\nTotal Fees $1.20';
const pair = run('groupResults([parseTradeText(singleClose),parseTradeText(singleOpen)])');
assert.equal(pair.length,1);assert.equal(pair[0].action,'roll');assert.equal(pair[0].expDate,'2026-12-04');assert.equal(pair[0].premium,1.75);assert.equal(pair[0].fees,2.3);
assert.equal(run('groupResults([parseTradeText(singleClose),parseTradeText(singleOpen),parseTradeText(singleOpen)]).length'),3,'Ambiguous separate images are not arbitrarily paired');
ctx.thirdDecimalLegs = parsed.legs.map(l=>({...l,price:l.price+(l.action==='sell_open'?0.005:0)}));
assert.equal(run('assessScannedBox(thirdDecimalLegs).credit'),90002,'Average fill prices retain sub-cent quote precision before contract multiplication');
console.log('PASS: separate-image roll pairing, ambiguity handling, total order fees and average-fill precision.');
