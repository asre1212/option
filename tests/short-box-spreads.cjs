// Run with: node tests/short-box-spreads.cjs (requires Playwright + Chromium).
// Serves this checkout locally, blocks external requests, uses isolated storage.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req,res) => {
  const name = new URL(req.url,'http://localhost').pathname;
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file,(err,data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'text/plain');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless:true, ...(process.env.TEST_CHROMIUM_PATH ? {executablePath:process.env.TEST_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']} : {})});
  try {
    const context = await browser.newContext({ viewport:{width:390,height:844},timezoneId:'America/New_York',serviceWorkers:'block'});
    await context.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
    const page = await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date('2026-09-25T23:59:58-04:00')});
    await page.goto(origin);
    const result = await page.evaluate(() => {
      const t = normalizeTrade({id:'regular',ticker:'AAPL',strikePrice:150,premium:2,qty:1,
        status:'expired',type:'put',dateOpened:'2026-09-01',expDate:'2026-09-20',dteAtExecution:19,
        closeInfo:{dateClosed:'2026-09-20',buyingPrice:0}});
      save({trades:[t]}); renderActive(); updateStats(); return weightedStats();
    });
    await page.click('#fab');
    await page.selectOption('#a-entry-mode','box');
    assert.equal(await page.inputValue('#box-ticker'),'$SPX');
    assert.equal(await page.locator('#a-option-fields').isVisible(),false);
    assert.equal(await page.locator('#add-batch-link').isVisible(),false);
    assert.equal(await page.locator('#a-box-fields input:visible').count(),4);
    await page.fill('#box-credit','99500'); await page.fill('#box-interest','500');
    assert.equal(await page.locator('#box-rate-preview').isVisible(),false);
    await page.fill('#box-expdate','2026-09-26');
    assert.equal(await page.locator('#box-rate-preview').isVisible(),true);
    assert.equal(await page.textContent('#box-rate-preview-value'),'183.42%');
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),0);
    await page.fill('#box-interest','0');
    assert.equal(await page.textContent('#box-rate-preview-value'),'0.00%');
    await page.fill('#box-credit','0');
    assert.equal(await page.locator('#box-rate-preview').isVisible(),false);
    await page.fill('#box-credit','99500');
    await page.fill('#box-interest','500');
    await page.fill('#box-expdate','2026-09-25');
    assert.equal(await page.locator('#box-rate-preview').isVisible(),false);
    await page.fill('#box-expdate','2026-09-26');
    await page.screenshot({path:'/tmp/box-entry.png'});
    await page.click('#add-submit');
    assert.equal(await page.textContent('#box-ytd-rate'),'—');
    assert.equal(await page.textContent('#box-ytd-interest'),'$0.00');
    assert.match(await page.textContent('#box-list'),/Days to Expiry1/);
    assert.match(await page.textContent('#box-list'),/\$500\.00 \(183\.42%\)/);
    assert.deepEqual(await page.evaluate(()=>weightedStats()),result);
    // Crossing local midnight realizes exactly once, even though UTC is already Sept 26.
    await page.clock.runFor(3000);
    assert.equal(await page.textContent('#box-ytd-interest'),'$500.00');
    assert.match(await page.textContent('#box-list'),/Days to Expiry0/);
    await page.evaluate(()=>{renderBoxSpreads();renderBoxSpreads();});
    assert.equal(await page.textContent('#box-ytd-interest'),'$500.00');
    assert.deepEqual(await page.evaluate(()=>weightedStats()),result);
    // Calendar math ignores DST and YTD excludes both prior years and future expirations.
    assert.deepEqual(await page.evaluate(()=>({
      dst:boxDaysRemaining({expDate:'2026-11-02'},'2026-10-31'),
      ytd:boxInterestYTD([
        {expDate:'2025-12-31',interest:100},{expDate:'2026-01-01',interest:200},
        {expDate:'2026-09-26',interest:500},{expDate:'2026-12-31',interest:1000}
      ],'2026-09-26'),
      invalid:['2026-02-30','bad'].map(expDate=>normalizeBoxSpread({ticker:'$SPX',creditReceived:10,interest:1,expDate})),
      missing:normalizeBoxSpread({ticker:'$SPX',creditReceived:10,interest:'',expDate:'2026-10-01'})
    })),{dst:2,ytd:700,invalid:[null,null],missing:null});
    assert.equal(await page.textContent('#box-ytd-rate'),'183.42%');
    assert.deepEqual(await page.evaluate(()=>{
      const boxes = [
        {creditReceived:10000,interest:500,dateOpened:'2025-09-26',expDate:'2026-09-26'},
        {creditReceived:20000,interest:1000,dateOpened:'2024-09-26',expDate:'2026-09-26'}
      ];
      return {
        weighted:boxRateYTD(boxes,'2026-09-26'),
        future:boxRateYTD(boxes,'2026-09-25'),
        nextYear:boxRateYTD(boxes,'2027-01-01'),
        missing:boxRateYTD([...boxes,{creditReceived:100,interest:1,expDate:'2026-09-26'}],'2026-09-26'),
        zero:boxRateYTD([{creditReceived:100,interest:1,dateOpened:'2026-09-26',expDate:'2026-09-26'}],'2026-09-26')
      };
    }),{weighted:3,future:null,nextYear:null,missing:null,zero:null});
    // Corrections replace the record rather than duplicating interest.
    await page.click('[data-box-edit]');
    assert.equal(await page.textContent('#box-rate-preview-value'),'183.42%');
    await page.fill('#box-interest','600');
    assert.equal(await page.textContent('#box-rate-preview-value'),'220.10%');
    await page.click('#add-submit');
    assert.equal(await page.textContent('#box-ytd-interest'),'$600.00');
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),1);
    await page.reload();
    assert.equal(await page.textContent('#box-ytd-interest'),'$600.00');
    assert.deepEqual(await page.evaluate(()=>weightedStats()),result);
    // Export and restore a box-only backup, then merge it twice without duplication.
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(()=>exportData());
    const download=await downloadPromise;
    const payload=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(payload.boxSpreads[0].interest,600);
    assert.equal(payload.boxSpreads[0].dateOpened,'2026-09-25');
    payload.trades=[];
    await page.evaluate(p=>previewImport(new File([JSON.stringify(p)],'boxes.json',{type:'application/json'})),payload);
    await page.waitForSelector('#m-import.open');
    page.on('dialog',d=>d.accept());
    await page.evaluate(()=>{setImportMode('replace');confirmImport();});
    assert.equal(await page.evaluate(()=>load().trades.length),0);
    for(let i=0;i<2;i++) {
      await page.evaluate(p=>previewImport(new File([JSON.stringify(p)],'boxes.json')),payload);
      await page.waitForSelector('#m-import.open');
      await page.evaluate(()=>confirmImport());
    }
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),1);
    assert.equal(await page.textContent('#box-ytd-interest'),'$600.00');
    await page.locator('#box-heading').scrollIntoViewIfNeeded();
    await page.screenshot({path:'/tmp/box-portfolio.png'});
    // Reopening after a year boundary resets YTD without losing the record.
    await page.clock.setSystemTime(new Date('2027-01-01T00:00:01-05:00'));
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.textContent('#box-ytd-interest'),'$0.00');
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),1);
    await page.click('[data-box-delete]');
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),0);
    await page.click('#fab');
    assert.equal(await page.inputValue('#a-entry-mode'),'option');
    assert.equal(await page.locator('#a-option-fields').isVisible(),true);
    // Older box entries never receive a made-up start date; editing supplies it.
    await page.evaluate(()=>{
      closeOverlay('m-add');
      save({trades:[],boxSpreads:[{id:'oldbox',ticker:'$SPX',creditReceived:10000,interest:500,expDate:'2026-09-26'}]});
    });
    await page.clock.setSystemTime(new Date('2026-09-26T12:00:00-04:00'));
    await page.evaluate(()=>renderBoxSpreads());
    assert.equal(await page.textContent('#box-ytd-rate'),'—');
    assert.equal(await page.textContent('#box-ytd-interest'),'$500.00');
    await page.click('[data-box-edit]');
    assert.equal(await page.inputValue('#box-opened'),'');
    assert.equal(await page.locator('#box-rate-preview').isVisible(),false);
    await page.fill('#box-opened','2025-09-26');
    assert.equal(await page.textContent('#box-rate-preview-value'),'5.00%');
    await page.click('#add-submit');
    assert.match(await page.textContent('#box-list'),/\$500\.00 \(5\.00%\)/);
    assert.equal(await page.textContent('#box-ytd-rate'),'5.00%');
    // A legacy backup with no box collection still restores safely.
    await page.evaluate(()=>previewImport(new File([JSON.stringify({version:2,trades:[{
      id:'legacy',ticker:'AAPL',strikePrice:150,premium:2,type:'put',status:'active',
      expDate:'2027-02-01',dateOpened:'2027-01-01',dteAtExecution:31
    }]})],'legacy.json')));
    await page.waitForSelector('#m-import.open');
    await page.evaluate(()=>{setImportMode('replace');confirmImport();});
    assert.equal(await page.evaluate(()=>load().trades.length),1);
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: entry, local midnight, DTE/DST, YTD, isolation, corrections, persistence, backup replace/merge, year rollover, deletion, regular form, weighted rates, missing dates, date correction.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
