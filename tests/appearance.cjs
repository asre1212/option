const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(root, name === '/' ? 'index.html' : name);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, bytes) => {
    if (err) { res.writeHead(404).end(); return; }
    const type = {'.js':'text/javascript','.html':'text/html','.woff2':'font/woff2'};
    res.setHeader('Content-Type', type[path.extname(file)] || 'application/octet-stream');
    res.end(bytes);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({headless:true,
    ...(process.env.TEST_CHROMIUM_PATH ? {executablePath:process.env.TEST_CHROMIUM_PATH} : {})});
  try {
    const context = await browser.newContext({viewport:{width:320,height:780},isMobile:true,hasTouch:true});
    await context.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const face = async name => {
      const status = await page.evaluate(async family => {
        await document.fonts.ready;
        return {current:getComputedStyle(document.body).fontFamily,
          loaded:[...document.fonts].some(f => f.family.replace(/['"]/g, '') === family && f.status === 'loaded')};
      }, name);
      assert.ok(status.current.includes(name) && status.loaded, JSON.stringify(status));
    };
    await page.goto(origin);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await face('Manrope');
    const digits = await page.evaluate(() => {
      const el = document.createElement('span');
      el.style.cssText='position:absolute;font-size:20px;white-space:nowrap';
      document.body.append(el);
      el.textContent='11111'; const a=el.getBoundingClientRect().width;
      el.textContent='88888'; const b=el.getBoundingClientRect().width;
      el.remove();
      return [a,b];
    });
    assert.equal(digits[0],digits[1],'Manrope uses equal-width digits');
    const settings = page.getByRole('button',{name:'Settings',exact:true});
    const dialog = page.getByRole('dialog',{name:'Settings'});
    const select = dialog.getByLabel('Font',{exact:true});
    await page.evaluate(() => {
      localStorage.setItem('opts_v2',JSON.stringify({trades:[],scanNotes:'Keep this test note'}));
      document.getElementById('s-pnl-ytd').textContent = '+$1,234,567.89';
    });
    assert.ok(await page.locator('#s-pnl-ytd').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await settings.tap();
    assert.equal(await select.inputValue(),'manrope');
    await select.selectOption('geist-mono');
    await face('Geist Mono');
    assert.ok(await page.locator('#s-pnl-ytd').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await dialog.getByRole('button',{name:'Done'}).tap();
    assert.equal(await dialog.isVisible(),false);
    assert.equal(await settings.evaluate(el=>document.activeElement===el),true);

    await page.setViewportSize({width:390,height:844});
    await page.reload();
    await face('Geist Mono');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('opts_v2')).scanNotes),'Keep this test note');
    const cached = await page.evaluate(async () => {
      const key=(await caches.keys()).find(k=>/^options-tracker-v\d+$/.test(k));
      const cache=await caches.open(key);
      return (await cache.keys()).filter(r=>r.url.endsWith('.woff2')).map(r=>r.url.split('/').pop()).sort();
    });
    assert.deepEqual(cached,['GeistMono.woff2','Manrope.woff2']);
    await context.setOffline(true);
    await page.reload();
    await face('Geist Mono');
    await settings.tap();
    assert.equal(await select.inputValue(),'geist-mono');
    await select.selectOption('manrope');
    await face('Manrope');
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(),false);
    await page.reload();
    await face('Manrope');
    assert.deepEqual(errors,[]);
    console.log('PASS: Manrope default, aligned numbers, 320px layout, Settings switch, focus, storage isolation, both fonts offline, and persistence.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
