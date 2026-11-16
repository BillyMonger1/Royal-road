/* End-to-end in real browsers: pair → record on the phone → cloud holds it → desktop collects and files it. */
const { chromium } = require('/opt/npm-tools/node_modules/playwright'); const fs=require('fs'); const path=require('path'); const http=require('http');
const serve=(dir,port)=>http.createServer((q,r)=>{let f=path.join(dir,decodeURIComponent(q.url.split(/[?#]/)[0]));if(f.endsWith('/'))f+='index.html';
  fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);r.end();return;}const t={html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',webmanifest:'application/manifest+json'}[f.split('.').pop()]||'text/plain';r.writeHead(200,{'Content-Type':t});r.end(d);});}).listen(port);
(async()=>{
  const s1=serve(path.join(__dirname,'../desktop/ui'),4701), s2=serve(path.join(__dirname,'../mobile'),4702);
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
  const rows=[]; let id=0; const errs=[];
  const cloud=async route=>{const q=route.request(); if(q.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    const fn=q.url().split('/rpc/')[1], a=q.postDataJSON(); let out;
    if(fn==='push_dream'){rows.push({id:'00000000-0000-0000-0000-00000000000'+(++id),route:a.p_route,payload:a.p_payload});out=rows[rows.length-1].id;}
    else if(fn==='pull_dreams')out=rows.filter(r=>r.route===a.p_route).map(r=>({id:r.id,payload:r.payload}));
    else if(fn==='waiting_dreams')out=rows.filter(r=>r.route===a.p_route&&a.p_ids.includes(r.id)).map(r=>r.id);
    else if(fn==='ack_dreams'){let c=0;for(let i=rows.length-1;i>=0;i--)if(rows[i].route===a.p_route&&a.p_ids.includes(rows[i].id)){rows.splice(i,1);c++;}out=c;}
    route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(out)});};
  const watch=(p,name)=>{p.on('console',m=>{if(m.type()==='error')errs.push(name+': '+m.text())});p.on('pageerror',e=>errs.push(name+' PAGEERR '+e.message));};

  // desktop
  const dctx=await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1.5}); await dctx.route('https://abcdefgh.supabase.co/**',cloud);
  const d=await dctx.newPage(); watch(d,'desktop');
  await d.addInitScript(j=>{if(!localStorage.getItem('rr.journal'))localStorage.setItem('rr.journal',j)},fs.readFileSync(path.join(__dirname,'demo-journal.json'),'utf8'));
  await d.goto('http://localhost:4701/'); await d.waitForTimeout(1500);
  await d.click('#openSetup'); await d.fill('#cloudUrl','https://abcdefgh.supabase.co'); await d.fill('#cloudKey','eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijklmnopqrstuvwxyz0123456789'); await d.fill('#phoneUrl','http://localhost:4702/'); await d.locator('#phoneUrl').blur();
  await d.click('#testCloud'); await d.waitForTimeout(600);
  console.log('relay test:',await d.textContent('#cloudResult'));
  // phone address must be https in the real app; for this test build the link by hand from the code
  const code=await d.evaluate(()=>document.getElementById('copyPair').dataset.value);
  console.log('pair value is a bare code (http address refused):',!code.includes('#pair='));

  // phone
  const mctx=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'});
  await mctx.route('https://abcdefgh.supabase.co/**',cloud);
  await mctx.addInitScript(()=>{ // a pretend recogniser that behaves like Android: cumulative results, ends after a pause
    const phrases=['I was standing in the old school','and a hag was watching me through the window','then Ebb opened a door and a dragon flew out of the kitchen'];
    let k=0; window.SpeechRecognition=class{start(){const self=this;let said='';const step=()=>{ if(self.dead)return; if(k>=phrases.length)return; said=(said+' '+phrases[k]).trim();
        self.onresult({results:[[{transcript:said.slice(0,said.length-6)}]].map(r=>Object.assign(r,{isFinal:false}))});
        setTimeout(()=>{ if(self.dead)return; self.onresult({results:[Object.assign([{transcript:said}],{isFinal:true})]}); k++; if(k===2){self.dead=true;setTimeout(()=>self.onend(),200);} else setTimeout(step,500);},350);};
      setTimeout(step,300);} stop(){this.dead=true;setTimeout(()=>this.onend&&this.onend(),50);}}; });
  const m=await mctx.newPage(); watch(m,'phone');
  await m.goto('http://localhost:4702/'); await m.waitForTimeout(700); await m.screenshot({path:'/tmp/m1.png'});
  await m.goto('http://localhost:4702/#pair='+code); await m.waitForTimeout(900);
  console.log('phone paired:',await m.evaluate(()=>!!localStorage.getItem('rr.pair')),'| hash stripped:',await m.evaluate(()=>location.hash===''));
  await m.waitForTimeout(3000);
  await m.click('#rec'); await m.waitForTimeout(3600); await m.screenshot({path:'/tmp/m2.png'});
  await m.click('#rec'); await m.waitForTimeout(700); await m.screenshot({path:'/tmp/m3.png'});
  console.log('transcript:',JSON.stringify(await m.inputValue('#draft')));
  await m.click('#send'); await m.waitForTimeout(900); await m.screenshot({path:'/tmp/m4.png'});
  console.log('cloud rows after send:',rows.length,'| readable in cloud:',JSON.stringify(rows).includes('hag'));
  await m.click('#openPast'); await m.waitForTimeout(300); await m.screenshot({path:'/tmp/m5.png'});
  await m.emulateMedia({colorScheme:'dark'}); await m.click('#pastBack'); await m.waitForTimeout(300); await m.screenshot({path:'/tmp/m6.png'});

  // desktop collects when Setup closes
  await d.click('.setup-head .key'); await d.waitForTimeout(2500);
  console.log('desktop status:',await d.textContent('#statusText'));
  console.log('desktop opened:',await d.textContent('#paper h2'),'| threads:',await d.locator('.thread').count(),'| cloud rows after collect:',rows.length);
  await d.mouse.move(600,420); await d.waitForTimeout(600); await d.screenshot({path:'/tmp/e1.png'});
  // chat tab, compose, thread
  await d.click('#tabChat'); await d.waitForTimeout(200); await d.screenshot({path:'/tmp/e2.png'});
  await d.click('#tabJournal'); await d.click('.back'); await d.click('#addDream'); await d.fill('#composeText','I was falling through a forest and a wolf was chasing me. My father stood at the bridge holding a key.');
  // a phone dream arrives while typing: the draft must survive
  await m.click('#typeInstead'); await m.fill('#draft','A second dream about a golden staircase in the manor.'); fs.writeFileSync('/tmp/rr-phone.jpg', await require('/opt/npm-tools/node_modules/sharp')({create:{width:1600,height:1200,channels:3,background:'#5f40b8'}}).jpeg().toBuffer()); await m.setInputFiles('#shotInput','/tmp/rr-phone.jpg'); await m.waitForTimeout(500); console.log('phone pictures attached:', await m.locator('#shots figure').count()); await m.screenshot({path:'/tmp/m8.png'}); await m.click('#send'); await m.waitForTimeout(800);
  await d.click('#status'); await d.waitForTimeout(1500);
  console.log('desktop got phone picture:', await d.evaluate(()=>{const j=JSON.parse(localStorage.getItem('rr.journal'));return j.dreams.some(x=>x.images&&x.images[0]&&x.images[0].from==='phone')}), '| phone kept a copy:', await m.evaluate(()=>JSON.parse(localStorage.getItem('rr.dreams')).some(x=>x.images)));
  console.log('draft kept while a dream arrived:', (await d.inputValue('#composeText')).startsWith('I was falling'), '| status:', await d.textContent('#statusText')); await d.click('.actions .key'); await d.waitForTimeout(1500);
  console.log('typed dream filed as:',await d.textContent('#paper h2'),'| threads:',await d.locator('.thread').count());
  await d.locator('.thread button').first().click(); await d.waitForTimeout(800); await d.screenshot({path:'/tmp/e3.png'});
  await d.reload(); await d.waitForTimeout(1500); await m.click('#openPast'); await m.waitForTimeout(1200); console.log('phone after desktop collected:', await m.textContent('#pastNote'), '|', (await m.locator('.list .meta span:last-child').allTextContents()).join(', ')); await m.screenshot({path:'/tmp/m7.png'});
  console.log('after restart dreams:',await d.locator('.entry').count());
  await d.setViewportSize({width:1100,height:700}); await d.waitForTimeout(600); await d.screenshot({path:'/tmp/e5.png'});
  // empty state
  const ectx=await b.newContext({viewport:{width:1280,height:760}}); const e=await ectx.newPage(); watch(e,'empty'); await e.goto('http://localhost:4701/'); await e.waitForTimeout(2200); await e.screenshot({path:'/tmp/e4.png'});
  console.log('errors:',errs.length?errs:'none'); await b.close(); s1.close(); s2.close();
})().catch(e=>{console.error(e);process.exit(1)});
