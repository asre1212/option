const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const handlers = {}, requests = [], writes = [], messages = [];
let releaseWrites;
const writeGate = new Promise(resolve => { releaseWrites = resolve; });
let fail = false;
const context = vm.createContext({URL, console,
  self:{location:{origin:'https://example.com',href:'https://example.com/option/service-worker.js'},addEventListener:(name,fn)=>handlers[name]=fn},
  caches:{open:async()=>({put:async(key,value)=>{await writeGate; writes.push(key);}})},
  fetch:async(url,options)=>{requests.push({url:String(url),options});return {ok:!fail,clone(){return this;}};}
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8'),context);
(async()=>{
  let pending;
  handlers.message({data:'CLEAR_AND_RELOAD',waitUntil:p=>{pending=p;},source:{postMessage:m=>messages.push(m)}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(messages.length,0,'Do not reload before writes finish');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(r=>r.options.cache === 'reload'));
  assert.ok(requests.some(r=>r.url.endsWith('app.js?v=20261016-total-due')));
  releaseWrites(); await pending;
  assert.equal(writes.length,requests.length);
  assert.deepEqual(messages,['READY_TO_RELOAD']);
  fail = true; messages.length = 0; writes.length = 0;
  handlers.message({data:'CLEAR_AND_RELOAD',waitUntil:p=>{pending=p;},source:{postMessage:m=>messages.push(m)}});
  await pending;
  assert.equal(writes.length,0,'Failed download preserves offline shell');
  assert.equal(messages.length,0,'Failed update must not claim success');
  fail = false;
  handlers.fetch({request:{method:'GET',url:'https://example.com/option/app.js'},respondWith:p=>{pending=p;}});
  await pending;
  assert.equal(requests.at(-1).options.cache,'no-cache');
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.ok(html.includes('src="./app.js?v=20261016-total-due"'));
  console.log('PASS: app updates bypass HTTP cache, await cache writes, preserve shell on download failure, and version scripts.');
})().catch(error=>{console.error(error);process.exitCode=1;});
