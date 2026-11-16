/* Checks journal search, renaming, adding threads, backup with pictures (desktop preview),
   and the Android bridge in the phone app (with a stand-in for Android). */
const { chromium } = require('/opt/npm-tools/node_modules/playwright'); const fs = require('fs'); const path = require('path');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const errs = [];
  const d = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, acceptDownloads: true })).newPage();
  d.on('pageerror', e => errs.push('desktop ' + e.message));
  await d.addInitScript(j => { if (!localStorage.getItem('rr.journal')) localStorage.setItem('rr.journal', j); }, fs.readFileSync(path.join(__dirname, 'demo-journal.json'), 'utf8'));
  await d.goto('file://' + path.join(__dirname, '../desktop/ui/index.html')); await d.waitForTimeout(1500);

  await d.fill('.search', 'worm'); await d.waitForTimeout(200);
  console.log('search "worm":', await d.locator('.entry').count(), 'dreams'); await d.screenshot({ path: '/tmp/u1.png' });
  await d.fill('.search', 'zzzz'); console.log('no match message:', await d.locator('.entries .note').textContent());
  await d.fill('.search', 'chimera'); await d.locator('.entry').first().click(); await d.waitForTimeout(400);

  // rename via pencil, then analyse again: name must stick
  await d.click('.rename'); await d.fill('#editTitle', 'The beast behind the fence'); await d.click('text=Save changes'); await d.waitForTimeout(400);
  console.log('renamed to:', await d.textContent('.title-row span'));
  await d.click('text=Analyze again'); await d.waitForTimeout(1200);
  console.log('after analysing again:', await d.textContent('.title-row span'));
  // add a thread, reusing an existing one
  const before = await d.locator('.thread').count();
  await d.fill('.thread-name', 'Dragon'); await d.press('.thread-name', 'Enter'); await d.waitForTimeout(400);
  console.log('threads before/after adding "Dragon":', before, '/', await d.locator('.thread').count(), '| kind picked:', await d.evaluate(() => JSON.parse(localStorage.getItem('rr.journal')).nodes.filter(n => n.name === 'Dragon').map(n => n.type + ' x' + 1).join()));
  // a picture, then backup and restore
  fs.writeFileSync('/tmp/rr-pic.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const [fc] = await Promise.all([d.waitForEvent('filechooser'), d.click('text=Add a picture')]); await fc.setFiles('/tmp/rr-pic.png'); await d.waitForTimeout(600);
  await d.screenshot({ path: '/tmp/u2.png' });
  await d.click('#openSetup'); await d.locator('.setup-body').evaluate(e => e.scrollTop = 9999);
  const [dl] = await Promise.all([d.waitForEvent('download'), d.click('#exportBackup')]); const file = await dl.path();
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('backup:', backup.dreams.length, 'dreams,', Object.keys(backup.pictures).length, 'picture(s)', '| result:', await d.textContent('#backupResult'));
  await d.evaluate(() => { localStorage.removeItem('rr.images'); });
  const [fc2] = await Promise.all([d.waitForEvent('filechooser'), d.click('#importBackup')]); await fc2.setFiles(file); await d.waitForTimeout(800);
  console.log('restore:', await d.textContent('#backupResult'));
  console.log('obsidian button hidden in preview:', await d.locator('#exportObsidian').isHidden());

  // phone inside the Android app (stand-in bridge)
  const m = await (await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36' })).newPage();
  m.on('pageerror', e => errs.push('phone ' + e.message));
  await m.addInitScript(() => {
    const said = ['the house was full of', 'the house was full of golden water'];
    window.__calls = [];
    window.RoyalAndroid = {
      speechAvailable: () => true,
      startListening(lang) { window.__calls.push('start:' + lang); let i = 0; const go = () => { if (i < said.length) { window.__royal.emit('level', { v: .8 }); window.__royal.emit('result', { text: said[i], final: false }); i++; setTimeout(go, 150); } }; setTimeout(go, 100); },
      stopListening() { window.__calls.push('stop'); setTimeout(() => { window.__royal.emit('result', { text: said[1], final: true }); window.__royal.emit('end', {}); }, 300); },
      abortListening() {}, scanCode() { window.__calls.push('scan'); setTimeout(() => window.__royal.emit('scan', { error: 'The code scanner is not available on this phone. Paste the pairing code instead.' }), 50); }
    };
  });
  await m.goto('file://' + path.join(__dirname, '../mobile/index.html')); await m.waitForTimeout(600);
  await m.click('#rec'); await m.waitForTimeout(700); await m.click('#rec'); await m.waitForTimeout(900);
  console.log('android transcript:', JSON.stringify(await m.inputValue('#draft')), '| calls:', (await m.evaluate(() => window.__calls)).join(' '));
  console.log('back from review handled in app:', await m.evaluate(() => window.__royalBack()), '| now on:', await m.evaluate(() => document.body.dataset.view));
  console.log('back on home leaves app:', await m.evaluate(() => window.__royalBack()));
  await m.click('#pairStatus'); console.log('scan button shown:', await m.locator('#pairScan').isVisible());
  await m.click('#pairScan'); await m.waitForTimeout(200); console.log('scan failure message:', await m.textContent('#pairNote'));
  await m.screenshot({ path: '/tmp/u3.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
