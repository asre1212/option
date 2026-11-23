// Dependency-free regression tests for calendar accounting and persisted marks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const nodes = new Map(), listeners = {};
let data = {trades:[],boxSpreads:[]};
const node = id => { if(!nodes.has(id)) nodes.set(id,{value:'',textContent:'',innerHTML:'',hidden:false});return nodes.get(id); };
const ctx = vm.createContext({console,Date,Map,Number,Object,Math,String,
  DATE_RE:/^\d{4}-\d{2}-\d{2}$/, uid:()=> 'newbox',load:()=>data,save:d=>{data=d;},
  document:{getElementById:node,addEventListener:(name,fn)=>{listeners[name]=fn;},querySelector:()=>({open:false})},
  window:{addEventListener(){}},setInterval(){},fmtMoney:n=>`$${n.toFixed(2)}`,fmtPct:n=>`${n.toFixed(2)}%`,fmtInt:String,esc:String,
  renderAnalysis(){},renderActive(){},updateStats(){},renderAnalysisIfOpen(){},closeOverlay(){},alert:m=>{throw Error(m);}
});
vm.runInContext(src.slice(src.indexOf('const loadBoxSpreads'),src.indexOf('/* ═',src.indexOf('const loadBoxSpreads'))),ctx);
const run = code => JSON.parse(JSON.stringify(vm.runInContext(code,ctx)));
const box = {id:'b',ticker:'$SPX',creditReceived:10000,interest:900,dateOpened:'2026-07-01',expDate:'2028-07-01',yearEndValues:{2026:10300,2027:10200}};
ctx.box=box;
assert.deepEqual(run("boxYearRows(box,'2028-07-01').map(r=>r.final)"),[300,-100,700]);
assert.equal(run("boxYearRows(box).reduce((s,r)=>s+Math.round(r.estimate*100),0)"),90000);
assert.equal(run("boxYearRows(box).reduce((s,r)=>s+r.days,0)"),731);
assert.deepEqual(run("boxYearRows(box,'2026-09-30').map(r=>r.final)"),[null,null,null]);
assert.deepEqual(run("boxYearRows({...box,yearEndValues:{}},'2028-07-01').map(r=>r.final)"),[null,null,null]);
assert.deepEqual(run("boxYearRows({...box,dateOpened:null})"),[]);
assert.equal(run("boxDaysRemaining({expDate:'2026-11-02'},'2026-10-31')"),2);
assert.deepEqual(run("boxYearRows({...box,dateOpened:'2026-12-31',expDate:'2027-01-01',interest:100},'2027-01-01').map(r=>r.estimate)"),[100,0]);
assert.deepEqual(run("normalizeBoxSpread({...box,yearEndValues:{2026:0,2027:-1,bad:2}}).yearEndValues"),{'2026':0});
assert.equal(run("boxYearTotals([box,{...box,yearEndValues:{}}],'2028-07-01')[0].final"),null);
assert.deepEqual(run("boxYearRows({...box,dateOpened:'2026-01-01',expDate:'2026-12-31'},'2026-12-31').map(r=>r.final)"),[900]);
data.boxSpreads=[box,{...box,id:'past',expDate:'2025-07-01'}];
vm.runInContext("renderBoxSpreads()",ctx);
assert.match(node('box-list').innerHTML,/data-box-edit="b"/);
assert.doesNotMatch(node('box-list').innerHTML,/data-box-edit="past"/);
assert.match(run('boxAnalysisHTML()'),/data-box-edit="past"/);
// Save edits and verify mark preservation through normalizer and JSON roundtrip.
data.boxSpreads=[box];
vm.runInContext("editingBoxId='b'",ctx);
for(const [id,value] of Object.entries({'box-opened':'2026-07-01','box-expdate':'2028-07-01','box-ticker':'$SPX','box-credit':'10000','box-interest':'950'})) node(id).value=value;
vm.runInContext('saveBoxSpread()',ctx);
assert.equal(data.boxSpreads[0].interest,950);
assert.equal(data.boxSpreads[0].yearEndValues[2026],10300);
ctx.backup=JSON.parse(JSON.stringify(data.boxSpreads[0]));
assert.deepEqual(run('normalizeBoxSpread(backup).yearEndValues'),{'2026':10300,'2027':10200});
// Change handler persists zero and allows deleting a mark.
const input={dataset:{boxMark:'b',year:'2026'},value:'0'};
listeners.change({target:{closest:()=>input}});assert.equal(data.boxSpreads[0].yearEndValues[2026],0);
input.value='';listeners.change({target:{closest:()=>input}});assert.equal(data.boxSpreads[0].yearEndValues[2026],undefined);
const card = run('boxPositionCard(box,"2026-09-30")');
for (const label of ['Credit Received','Interest Cost','Expiration','Days to Expiry','data-box-edit="b"','data-box-delete="b"']) assert.ok(card.includes(label));
assert.match(card,/Expected annualized interest rate/);
data.boxSpreads=[box,{...box,id:'second',creditReceived:20000}, {...box,id:'expired',dateOpened:'2024-07-01',expDate:'2025-07-01'}];
vm.runInContext('renderBoxSpreads()',ctx);
assert.equal((node('box-list').innerHTML.match(/class="trade-card"/g)||[]).length,2);
const analysis = run('boxAnalysisHTML()');
assert.equal((analysis.match(/class="trade-card"/g)||[]).length,3);
assert.ok(analysis.indexOf('class="trade-card"') < analysis.indexOf('<details'));
const html = fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
assert.ok(html.indexOf('id="box-list"') < html.indexOf('id="box-yearly"'));
console.log('PASS: accounting, persistence, full per-position cards, annualized rates, card counts, open-only Portfolio and visible Analysis history.');

// Repayment is principal plus full interest in the expiration year.
const repaymentTable = run('boxYearTable([box,{...box,creditReceived:20000,interest:1800},{...box,expDate:"2027-01-01",creditReceived:5000,interest:100}])');
assert.match(repaymentTable, /<th>Est\. interest<\/th><th>Open boxes expiring<\/th>/);
assert.match(repaymentTable, /<td>2026<\/td><td>[^<]+<\/td><td aria-label="No open boxes expire this year">—<\/td>/);
assert.match(repaymentTable, /<td>2027<\/td><td>[^<]+<\/td><td class="box-maturity"><span>Financed <strong>\$5000\.00<\/strong><\/span><span>Total due <strong>\$5100\.00/);
assert.match(repaymentTable, /<td>2028<\/td><td>[^<]+<\/td><td class="box-maturity"><span>Financed <strong>\$30000\.00<\/strong><\/span><span>Total due <strong>\$32700\.00/);
assert.match(run('boxYearTable([{...box,dateOpened:null,fees:123}])'), /<td>2028<\/td><td>Needs trade dates<\/td><td class="box-maturity"><span>Financed <strong>\$10000\.00<\/strong><\/span><span>Total due <strong>\$10900\.00/);
assert.equal(run('boxYearTable([])'), '');
assert.doesNotMatch(run('boxYearTable([box],true)'), /Total due by year/);
assert.match(run('boxYearTable([box],true)'), /Final MTM cost/);
assert.match(node('box-yearly').innerHTML, /\$31800\.00/);
assert.doesNotMatch(node('box-yearly').innerHTML, /<td>2025<\/td>/);
console.log('PASS: maturity repayments, aggregation, missing dates, column order and open-only filtering.');

// Opening-year financing includes matured SPX records, never prorates to expiry.
ctx.financingBoxes = [
  {...box,creditReceived:50000,dateOpened:'2026-11-01',expDate:'2027-11-01'},
  {...box,ticker:'SPX',creditReceived:123.45,dateOpened:'2026-12-31'},
  {...box,creditReceived:10000,dateOpened:'2027-01-01'},
  {...box,creditReceived:20000,dateOpened:'2024-01-01',expDate:'2025-01-01'},
  {...box,ticker:'NDX',creditReceived:99999},
  {...box,dateOpened:null}, {...box,dateOpened:'2026-02-30'}
];
assert.deepEqual(run('spxFinancingTotals(financingBoxes)'), {
  rows:[{year:2024,total:20000,expiries:[{year:2025,total:20000}]},{year:2026,total:50123.45,expiries:[{year:2027,total:50000},{year:2028,total:123.45}]},{year:2027,total:10000,expiries:[{year:2028,total:10000}]}], missing:2
});
const before = JSON.stringify(ctx.financingBoxes);
assert.match(run('spxFinancingTable(financingBoxes)'), /2 SPX entries need an opening date/);
assert.equal(JSON.stringify(ctx.financingBoxes),before,'Summary does not mutate saved records');
assert.deepEqual(run('spxFinancingTotals([])'),{rows:[],missing:0});
data.boxSpreads=JSON.parse(JSON.stringify(ctx.financingBoxes));
vm.runInContext('renderBoxSpreads()',ctx);
assert.match(node('spx-financing-yearly').innerHTML, /data-spx-expiry="2024"[\s\S]*?>\$20000.00<\/summary>/);
assert.match(node('spx-financing-yearly').innerHTML, /data-spx-expiry="2026"[\s\S]*?>\$50123.45<\/summary>/);
assert.match(html, /id="box-yearly-summary"[^>]*>[\s\S]*?id="box-yearly"[\s\S]*?<details class="box-financing-history">[\s\S]*?id="spx-financing-yearly"/);
console.log('PASS: SPX opening-year financing, historical matured entries, missing dates, ticker filtering, persistence and Portfolio rendering.');

// Each opening year's breakdown reconciles to its principal and groups matching expiries.
ctx.expiryBoxes = [
 {...box,creditReceived:50000,dateOpened:'2026-11-01',expDate:'2027-11-01'},
 {...box,creditReceived:100.11,dateOpened:'2026-12-01',expDate:'2027-12-01'},
 {...box,creditReceived:200.22,dateOpened:'2026-12-15',expDate:'2028-01-01'},
 {...box,creditReceived:300,dateOpened:'2027-01-01',expDate:'2028-01-01'}
];
const expiryRows = run('spxFinancingTotals(expiryBoxes).rows');
assert.deepEqual(expiryRows[0],{year:2026,total:50300.33,expiries:[{year:2027,total:50100.11},{year:2028,total:200.22}]});
for (const row of expiryRows) assert.equal(Math.round(row.expiries.reduce((sum,e)=>sum+e.total,0)*100),Math.round(row.total*100));
const expiryHTML = run('spxFinancingTable(expiryBoxes)');
assert.match(expiryHTML,/<details data-spx-expiry="2026">/);
assert.doesNotMatch(expiryHTML,/<details[^>]* open/);
assert.match(expiryHTML,/<th>Expiry year<\/th><th>Amount financed<\/th>/);
assert.match(expiryHTML,/<td>2027<\/td><td>\$50100.11<\/td>/);
assert.match(expiryHTML,/<td>2028<\/td><td>\$200.22<\/td>/);
console.log('PASS: collapsed expiry breakdown, aggregation, principal reconciliation and opening-year isolation.');

// Keep the same local-year cutoff for the dashboard and its historical ledger.
ctx.rolloverOpen = {...box,dateOpened:'2026-07-01',expDate:'2027-07-01',interest:365};
ctx.rolloverMatured = {...box,id:'matured-2026',dateOpened:'2026-01-01',expDate:'2026-12-15',interest:25};
assert.match(run("boxYearTable([rolloverOpen],false,'2026-12-31')"), /<td>2026<\/td><td>\$184\.00/);
const rolled = run("boxYearTable([rolloverOpen],false,'2027-01-01')");
assert.doesNotMatch(rolled, /<td>2026<\/td>/);
assert.match(rolled, /<td>2027<\/td><td>\$181\.00/);
assert.equal(run("boxHistoricalInterestTable([rolloverOpen,rolloverMatured],'2026-12-31')"),'');
assert.match(run("boxHistoricalInterestTable([rolloverOpen,rolloverMatured],'2027-01-01')"), /<th scope="row">2026<\/th><td>\$209\.00/);
assert.match(run("boxYearTable([rolloverOpen],true,'2027-01-01')"), /<td>2026<\/td>/);
assert.match(html, /<details class="box-financing-history">[\s\S]*?id="box-history-interest"[\s\S]*?<\/details>/);
console.log('PASS: January 1 cutover, all recorded historical interest, and unchanged Analysis history.');
