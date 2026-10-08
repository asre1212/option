// Run with node tests/scan-notes.cjs (requires Playwright + Chromium).
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
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless:true,
    ...(process.env.TEST_CHROMIUM_PATH ? {executablePath:process.env.TEST_CHROMIUM_PATH} : {})});
  try {
    const context = await browser.newContext({viewport:{width:390,height:844}, serviceWorkers:'block'});
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + '/?tab=scan');
    const editor = page.locator('#scan-notes-editor');
    const summary = page.locator('#scan-notes summary');
    assert.equal(await editor.isVisible(), false);
    assert.equal(await summary.textContent(), 'Notes');
    assert.equal(await page.evaluate(() => !!(document.getElementById('scan-notes').compareDocumentPosition(
      document.querySelector('.bc-export')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await summary.click();
    await editor.fill('My notes');
    await editor.selectText();
    await page.locator('[data-notes-command="bold"]').click();
    assert.match(await editor.innerHTML(), /<(b|strong)>My notes<\/(b|strong)>/);
    await page.locator('[data-notes-command="underline"]').click();
    assert.match(await editor.innerHTML(), /<u>/);
    await page.locator('[data-notes-command="plain"]').click();
    assert.equal(await editor.innerHTML(), 'My notes');
    await editor.selectText();
    await page.locator('[data-notes-command="bold"]').click();
    await page.reload();
    assert.equal(await editor.isVisible(), false);
    await summary.click();
    assert.match(await editor.innerHTML(), /<(b|strong)>My notes/);
    // List prefixes indent automatically, preserve starting numbers/letters,
    // continue on Enter, and leave a list on an empty item.
    for (const [prefix, type, start] of [['1.) ', '1', '1'], ['3. ', '1', '3'], ['a. ', 'a', '1'], ['b. ', 'a', '2']]) {
      await editor.evaluate(el => {el.replaceChildren(); el.focus();});
      await editor.click();
      await editor.pressSequentially(prefix + 'First');
      assert.equal(await editor.locator('ol').getAttribute('type'), type);
      assert.equal(await editor.locator('ol').getAttribute('start'), start);
      await page.keyboard.press('Enter');
      await page.keyboard.type('Second');
      assert.equal(await editor.locator('li').count(), 2);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Regular paragraph');
      assert.equal(await editor.locator('li').count(), 2);
      assert.match(await editor.innerText(), /Regular paragraph/);
    }
    await editor.evaluate(el => {el.replaceChildren(); el.focus();});
    await editor.click();
    await editor.pressSequentially('1.) Number');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await editor.pressSequentially('a. Letter');
    assert.equal(await editor.locator('ol[type="1"]').count(), 1);
    assert.equal(await editor.locator('ol[type="a"]').count(), 1);
    const saved = await page.evaluate(() => load().scanNotes);
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => exportData());
    const download = await downloadPromise;
    const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(backup.scanNotes, saved);
    assert.match(await page.textContent('#backup-verify'), /Verified restorable/);
    // A notes-only backup restores safely, even if it contains hostile HTML.
    const notesBackup = {trades:[], scanNotes:'<b>Restored</b><u>note</u><img src=x onerror="window.bad=true"><script>window.bad=true</script><ol type="a" start="2"><li>Item</li></ol>'};
    await page.locator('#json-input').setInputFiles({name:'notes.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(notesBackup))});
    assert.match(await page.textContent('#import-preview-box'), /Notes/);
    await page.evaluate(() => confirmImport());
    assert.equal(await page.evaluate(() => load().scanNotes), saved); // Merge keeps existing notes.
    await page.locator('#json-input').setInputFiles({name:'notes.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(notesBackup))});
    await page.evaluate(() => {setImportMode('replace'); confirmImport();});
    assert.equal(await editor.innerHTML(), '<b>Restored</b><u>note</u><ol type="a" start="2"><li>Item</li></ol>');
    assert.equal(await page.evaluate(() => window.bad), undefined);
    // Long notes expand naturally without clipping or an internal scroll box.
    await editor.fill(Array.from({length:40}, (_, i) => 'Line ' + i).join('\n'));
    assert.equal(await editor.evaluate(el => el.scrollHeight <= el.clientHeight + 2), true);
    await summary.click();
    assert.equal(await editor.isVisible(), false);
    await summary.click();
    assert.match(await editor.innerText(), /Line 39/);
    assert.deepEqual(errors, []);
    console.log('PASS: collapsed Notes, formatting, lists, persistence, backups, sanitization, and full-text expansion.');
  } finally { await browser.close(); server.close(); }
})().catch(error => {console.error(error); server.close(); process.exitCode = 1;});
