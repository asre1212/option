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
console.log('PASS: 19 accounting, rendering, persistence and validation checks.');
