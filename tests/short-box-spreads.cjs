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
    const baseline = await page.evaluate(()=>weightedStats());
    await page.click('#fab');
    await page.selectOption('#a-entry-mode','box');
    await page.fill('#box-credit','10000');
    await page.fill('#box-interest','500');
    await page.fill('#box-expdate','2027-09-25');
    assert.equal(await page.textContent('#box-rate-preview-value'),'5.00%');
    await page.click('#add-submit');
    assert.match(await page.textContent('#box-yearly'),/2026/);
    assert.match(await page.textContent('#box-yearly'),/2027/);
    assert.deepEqual(await page.evaluate(()=>weightedStats()),baseline);
    const calculations = await page.evaluate(()=>{
      const box = {creditReceived:10000,interest:900,dateOpened:'2026-07-01',expDate:'2028-07-01',yearEndValues:{2026:10300,2027:10200}};
      const rows = boxYearRows(box,'2028-07-01');
      return {
        costs:rows.map(r=>r.final), sum:Math.round(rows.reduce((a,r)=>a+r.estimate,0)*100)/100,
        days:rows.reduce((a,r)=>a+r.days,0), term:boxTermDays(box),
        missing:boxYearRows({...box,yearEndValues:{}},'2028-07-01').map(r=>r.final),
        future:boxYearRows(box,'2026-09-30').map(r=>r.final),
        invalid:boxYearRows({...box,dateOpened:null}),
        dst:boxDaysRemaining({expDate:'2026-11-02'},'2026-10-31'),
        jan:boxYearRows({...box,dateOpened:'2026-12-31',expDate:'2027-01-01',interest:100},'2027-01-01').map(r=>r.estimate),
        zeroMark:normalizeBoxSpread({ticker:'$SPX',...box,yearEndValues:{2026:0,2027:-1,bad:12}}).yearEndValues
      };
    });
    assert.deepEqual(calculations.costs,[300,-100,700]);
    assert.equal(calculations.sum,900); assert.equal(calculations.days,calculations.term);
    assert.deepEqual(calculations.missing,[null,null,null]);
    assert.deepEqual(calculations.future,[null,null,null]);
    assert.deepEqual(calculations.invalid,[]); assert.equal(calculations.dst,2);
    assert.deepEqual(calculations.jan,[100,0]); assert.deepEqual(calculations.zeroMark,{'2026':0});
    // Expiration removes portfolio cards without deleting history; box-only Analysis works.
    await page.clock.setSystemTime(new Date('2027-09-25T12:00:00-04:00'));
    await page.evaluate(()=>{refreshBoxCalendar();renderAnalysis();});
    assert.equal(await page.locator('#box-list .trade-card').count(),0);
    assert.equal(await page.evaluate(()=>loadBoxSpreads().length),1);
    assert.match(await page.textContent('#box-analysis'),/Needs year-end values/);
    await page.evaluate(()=>{document.getElementById('tab-analysis').classList.add('active');document.querySelector('#box-analysis details').open=true;});
    await page.locator('[data-box-mark]').fill('10100');
    await page.locator('[data-box-mark]').dispatchEvent('change');
    assert.match(await page.textContent('#box-analysis'),/\$100.00/);
    assert.match(await page.textContent('#box-analysis'),/\$400.00/);
    assert.equal(await page.evaluate(()=>loadBoxSpreads()[0].yearEndValues[2026]),10100);
    // Editing other fields preserves marks.
    await page.evaluate(()=>editBoxSpread(loadBoxSpreads()[0].id));
    await page.fill('#box-interest','600'); await page.click('#add-submit');
    assert.equal(await page.evaluate(()=>loadBoxSpreads()[0].yearEndValues[2026]),10100);
    await page.reload();
    assert.equal(await page.evaluate(()=>loadBoxSpreads()[0].yearEndValues[2026]),10100);
    assert.deepEqual(await page.evaluate(()=>weightedStats()),baseline);
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(()=>exportData());
    const download = await downloadPromise;
    const payload = JSON.parse(fs.readFileSync(await download.path(),'utf8'));
    assert.equal(payload.boxSpreads[0].yearEndValues[2026],10100);
    page.on('dialog',d=>d.accept());
    await page.evaluate(p=>previewImport(new File([JSON.stringify(p)],'boxes.json')),payload);
    await page.waitForSelector('#m-import.open');
    await page.evaluate(()=>{setImportMode('replace');confirmImport();});
    assert.equal(await page.evaluate(()=>loadBoxSpreads()[0].yearEndValues[2026]),10100);
    // Open contract survives until expiration date; daily refresh catches up offline.
    await page.clock.setSystemTime(new Date('2027-09-24T23:59:58-04:00'));
    await page.evaluate(()=>{refreshBoxCalendar();renderAnalysis();});
    assert.equal(await page.locator('#box-list .trade-card').count(),1);
    await page.clock.runFor(3000);
    assert.equal(await page.locator('#box-list .trade-card').count(),0);
    await page.evaluate(()=>{renderAnalysis();document.getElementById('tab-analysis').classList.add('active');});
    await page.screenshot({path:'/tmp/box-analysis.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: calendar allocations, leap years, DST, cents, missing marks/dates, gains, year-end entry, edit persistence, backup restore, maturity rollover, open-only portfolio, box-only Analysis and P&L isolation.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
