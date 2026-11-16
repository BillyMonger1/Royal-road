const { chromium } = require('/opt/npm-tools/node_modules/playwright'); const fs=require('fs'); const path=require('path');
(async()=>{
  const b = await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--allow-file-access-from-files']});
  const demo = fs.readFileSync(path.join(__dirname,'demo-journal.json'),'utf8');
  const mode = process.argv[2]||'all';
  const ctx = await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1.5});
  const p = await ctx.newPage(); const errs=[];
  p.on('console',m=>{if(m.type()==='error')errs.push(m.text())}); p.on('pageerror',e=>errs.push('PAGEERR '+e.message));
  await p.addInitScript(d=>{ if(!localStorage.getItem('rr.journal')&&!window.__empty) localStorage.setItem('rr.journal',d)},demo);
  await p.goto('file://'+path.join(__dirname,'../desktop/ui/index.html'));
  await p.waitForTimeout(2600);
  await p.mouse.move(520,380); await p.waitForTimeout(700);
  await p.screenshot({path:'/tmp/d1.png'});
  // open a dream
  await p.locator('.entry').nth(2).click(); await p.waitForTimeout(900);
  await p.screenshot({path:'/tmp/d2.png'});
  await p.click('#openSetup'); await p.fill('#cloudUrl','https://abcdefgh.supabase.co'); await p.fill('#cloudKey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiY2RlZmdoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MjAwMDAwMDAwMH0.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'); await p.fill('#phoneUrl','https://royal-road.netlify.app'); await p.locator('#phoneUrl').blur(); await p.waitForTimeout(500);
  await p.screenshot({path:'/tmp/d3.png'});
  await p.locator('.setup-body').evaluate(e=>e.scrollTop=9999); await p.waitForTimeout(200); await p.screenshot({path:'/tmp/d4.png'});
  console.log('errors:',errs.length?errs:'none');
  await b.close();
})();
