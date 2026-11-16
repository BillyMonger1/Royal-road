/* The Royal Road — phone. Record, read back, send. Dreams stay on this phone until the desktop has them,
   and are sealed before they leave it. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const ANDROID = /Android/i.test(navigator.userAgent);
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  let dreams = store.get('rr.dreams', []);        // [{ id, text, date, sent, row, via, delivered }]
  let pair = store.get('rr.pair', null);          // { url, key, secret }
  let rec = null, recording = false, base = '', session = '', interim = '', startedAt = 0, ticker = null, wake = null;
  let quickEnds = 0, lastStart = 0, flushing = false, toastTimer = null, lastError = '';
  let finishing = null, onDevice = false, shots = [];   // pictures for the dream being reviewed (data URLs)

  const view = v => { document.body.dataset.view = v; window.scrollTo(0, 0); };
  const join = (a, b) => (a.trim() + ' ' + b.trim()).trim();
  const starts = (long, short) => !!short && long.toLowerCase().startsWith(short.toLowerCase());
  const newId = () => 'd' + Array.from(crypto.getRandomValues(new Uint8Array(9)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
  function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
  function saveDreams() { if (!store.set('rr.dreams', dreams)) toast('This phone is out of storage. Send or remove older dreams.'); }

  /* ---------- the little screen in the record button ----------
     A gold trace on violet glass. Idle, it is a slow flat line. While listening, each burst of
     recognised speech kicks the amplitude up and it decays back, so the trace answers your voice. */
  const wave = (function () {
    const cv = $('wave'), g = cv.getContext('2d'); let level = 0, t = 0, w = 0, h = 0;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function size() { const r = cv.getBoundingClientRect(), d = Math.min(3, devicePixelRatio || 1); w = r.width; h = r.height; cv.width = w * d; cv.height = h * d; g.setTransform(d, 0, 0, d, 0, 0); }
    function frame() {
      requestAnimationFrame(frame); if (document.hidden || !w) return;
      t += 0.045; level *= 0.94;
      const live = document.body.dataset.state === 'recording', y0 = h * 0.66, amp = h * (0.018 + (live ? 0.04 + 0.16 * Math.min(1, level) : 0));
      g.fillStyle = 'rgba(11,8,22,.45)'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(200,170,255,.14)'; g.lineWidth = 1; g.beginPath(); g.moveTo(w * 0.12, y0); g.lineTo(w * 0.88, y0); g.stroke();
      g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,206,110,.95)'; g.shadowColor = 'rgba(255,200,92,.9)'; g.shadowBlur = 8; g.beginPath();
      for (let x = w * 0.1; x <= w * 0.9; x += 2) {
        const u = x / w, env = Math.sin(Math.PI * (u - 0.1) / 0.8);
        const y = y0 - env * amp * (Math.sin(u * 22 + t * (live ? 5 : 1.4)) + 0.45 * Math.sin(u * 51 - t * 3.1) * (live ? 1 : 0.2));
        if (x === w * 0.1) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke(); g.shadowBlur = 0;
    }
    new ResizeObserver(size).observe(cv); size();
    if (!still) requestAnimationFrame(frame); else { w && frame(); }
    return { kick(v) { level = Math.min(1.4, level + v); } };
  })();
  window.__waveKick = v => wave.kick(v);

  /* ---------- status ---------- */
  function paintStatus() {
    const waiting = dreams.filter(d => !d.sent).length;
    const lamp = $('lamp');
    let state = 'off', label = 'Not paired';
    if (pair) { state = lastError ? 'error' : waiting ? 'waiting' : 'ok'; label = lastError ? 'Sending failed' : waiting ? 'Waiting to send' : 'Everything sent'; }
    lamp.dataset.state = state; lamp.setAttribute('aria-label', label);
    $('count').textContent = waiting ? waiting + ' waiting' : dreams.length ? String(dreams.length) : '';
    $('pairStatus').textContent = !pair ? 'Not paired with a desktop yet. Tap to pair.'
      : lastError ? lastError
      : waiting ? (navigator.onLine ? 'Sending to the cloud' : 'Offline. Dreams will send when you are back online.')
      : 'Paired. Dreams are encrypted before they go to the cloud.' + (onDevice ? ' Speech is turned into text on this phone.' : ' Your phone\'s speech service turns speech into text.');
  }

  /* ---------- sending ---------- */
  async function flush() {
    if (flushing || !pair || !navigator.onLine) { paintStatus(); return; }
    flushing = true;
    try {
      for (const d of dreams.filter(x => !x.sent)) {
        d.row = String(await Relay.push(pair, pair.secret, { id: d.id, text: d.text, date: d.date, images: d.images || [] }));
        d.via = pair.secret; d.sent = true;
        if (d.images) { d.pics = d.images.length; delete d.images; }   // sent sealed with the dream; no need to keep the copies here
        saveDreams();
      }
      // Ask the cloud which dreams are still waiting; the rest are safely on the desktop.
      const pending = dreams.filter(x => x.sent && !x.delivered && x.row && x.via);
      for (const via of new Set(pending.map(x => x.via))) {
        const mine = pending.filter(x => x.via === via), still = await Relay.waiting(pair, via, mine.map(x => x.row));
        if (still) for (const d of mine) if (!still.has(d.row)) d.delivered = true;
      }
      saveDreams();
      lastError = '';
    } catch (e) { lastError = e.message; }
    flushing = false; paintStatus(); if (document.body.dataset.view === 'past') paintPast();
  }

  /* ---------- recording ---------- */
  function paintLive() {
    const live = $('live'); live.replaceChildren();
    const done = join(base, session);
    if (done) live.append(done + ' ');
    if (interim) { const s = document.createElement('span'); s.className = 'interim'; s.textContent = interim; live.append(s); }
    live.scrollTop = live.scrollHeight;
  }
  function paintClock() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('lead').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function startEngine() {
    rec = new SR();
    rec.lang = navigator.language || 'en-AU'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    if (onDevice) { try { rec.processLocally = true; } catch (e) { onDevice = false; } }
    lastStart = Date.now();
    rec.onresult = e => {
      if (ANDROID) {
        // Some Android versions repeat everything said so far in each result and some send only
        // the new phrase. Looking at the newest result and comparing handles both.
        const r = e.results[e.results.length - 1], t = r[0].transcript.trim();
        if (r.isFinal) {
          if (starts(t, session)) session = t; else if (!session.toLowerCase().endsWith(t.toLowerCase())) session = join(session, t);
          interim = '';
        } else interim = starts(t, session) ? t.slice(session.length).trim() : t;
      } else {
        let fin = '', part = '';
        for (let i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' '; else part += e.results[i][0].transcript; }
        session = fin; interim = part;
      }
      wave.kick(0.55);
      paintLive();
    };
    rec.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      const why = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'The microphone is blocked. Allow it in the browser\'s site settings, or type the dream instead.'
        : e.error === 'network' ? 'Speech recognition needs a connection on this phone. Type the dream instead.'
        : e.error === 'audio-capture' ? 'No microphone was found. Type the dream instead.'
        : 'Listening stopped unexpectedly. What you said so far is kept.';
      stop(why);
    };
    rec.onend = () => {
      base = join(base, join(session, interim)); session = ''; interim = '';
      if (!recording) { if (finishing) finish(); return; }
      // The phone ends a session after a pause. Carry on listening until the person taps stop.
      quickEnds = Date.now() - lastStart < 700 ? quickEnds + 1 : 0;
      if (quickEnds >= 4) { stop('Listening keeps stopping on this phone. What you said so far is kept.'); return; }
      setTimeout(() => { if (recording) { try { startEngine(); } catch (err) { stop('Listening could not restart. What you said so far is kept.'); } } }, 180);
    };
    rec.start();
  }

  async function start(keep) {
    if (!SR) { toType('Speech recognition is not available in this browser. Type the dream, or use the microphone key on your keyboard.'); return; }
    if (!keep) base = '';
    session = ''; interim = ''; quickEnds = 0; recording = true; startedAt = Date.now();
    document.body.dataset.state = 'recording'; view('home');
    $('rec').setAttribute('aria-label', 'Stop recording'); $('sub').textContent = ''; paintLive(); paintClock();
    ticker = setInterval(paintClock, 1000);
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* screen may dim */ }
    try { startEngine(); } catch (e) { stop('Listening could not start. Type the dream instead.'); }
  }

  function stop(note) {
    if (!recording && !note) return;
    recording = false; clearInterval(ticker);
    try { if (rec) rec.stop(); } catch (e) { /* already stopped */ }
    if (wake) { try { wake.release(); } catch (e) { /* gone */ } wake = null; }
    document.body.dataset.state = 'idle';
    $('rec').setAttribute('aria-label', 'Start recording'); $('lead').textContent = 'Finishing'; $('sub').textContent = '';
    // Android often hands over the last phrase after it stops, so wait for it to say it has finished.
    finishing = { note: note || '', timer: setTimeout(finish, 1500) };
    if (!rec) finish();
  }

  function finish() {
    if (!finishing) return;
    const note = finishing.note; clearTimeout(finishing.timer); finishing = null;
    $('lead').textContent = 'Tap to record'; $('sub').textContent = 'A place to remember your dreams';
    const text = join(base, join(session, interim)); base = text; session = ''; interim = ''; $('live').replaceChildren();
    if (!text && !note) { toast('Nothing was heard. Try again a little closer to the phone.'); return; }
    toReview(text, note);
  }

  /* Pictures are shrunk on the phone (longest side 1280 px) so they send quickly. */
  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }
  function paintShots() {
    const box = $('shots'); box.replaceChildren();
    shots.forEach((src, i) => {
      const fig = document.createElement('figure'), img = document.createElement('img'), x = document.createElement('button');
      img.src = src; img.alt = 'Picture ' + (i + 1);
      x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove picture ' + (i + 1));
      x.addEventListener('click', () => { shots.splice(i, 1); paintShots(); });
      fig.append(img, x); box.append(fig);
    });
    $('addShot').textContent = shots.length ? 'Add another picture' : 'Add a picture';
  }

  function toReview(text, note) {
    $('draft').value = text; $('reviewNote').textContent = note;
    paintShots();
    $('resume').hidden = !SR; $('send').textContent = pair ? 'Send to desktop' : 'Save on this phone';
    view('review');
  }
  function toType(note) { base = ''; toReview('', note || ''); setTimeout(() => $('draft').focus(), 60); }

  /* ---------- past dreams ---------- */
  function paintPast() {
    const list = $('pastList'); list.replaceChildren();
    const waiting = dreams.filter(d => !d.sent).length, cloud = dreams.filter(d => d.sent && !d.delivered);
    const stale = cloud.filter(d => Date.now() - Date.parse(d.date) > 14 * 864e5).length;
    $('pastNote').textContent = !dreams.length ? 'Nothing recorded on this phone yet.'
      : waiting ? waiting + (waiting === 1 ? ' dream is' : ' dreams are') + ' waiting to send.'
      : stale ? 'Some dreams have waited in the cloud for over two weeks. Open the desktop app, and check this phone is paired with its current code.'
      : cloud.length ? (cloud.length === 1 ? 'One dream is' : cloud.length + ' dreams are') + ' in the cloud, waiting for your desktop to open.'
      : 'Everything here is on your desktop.';
    $('clearSent').hidden = !dreams.some(d => d.delivered);
    for (const d of dreams.slice().reverse()) {
      const li = document.createElement('li'), meta = document.createElement('div'), when = document.createElement('span'), st = document.createElement('span'), p = document.createElement('p');
      meta.className = 'meta';
      when.textContent = new Date(d.date).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      st.textContent = d.delivered ? 'On your desktop' : d.sent ? 'In the cloud' : 'Waiting to send';
      st.className = d.delivered ? 'sent' : d.sent ? 'cloud' : 'wait';
      const n = d.pics || (d.images ? d.images.length : 0);
      p.textContent = d.text; meta.append(when, st); li.append(meta, p);
      if (n) { const pc = document.createElement('div'); pc.className = 'pics-note'; pc.textContent = n === 1 ? 'With 1 picture' : 'With ' + n + ' pictures'; li.append(pc); }
      li.addEventListener('click', () => li.classList.toggle('open'));
      list.append(li);
    }
  }

  /* ---------- pairing ---------- */
  function applyPair(code, quiet) {
    try { pair = Relay.decodePair(code); store.set('rr.pair', pair); lastError = ''; if (!quiet) toast('Paired with your desktop.'); paintStatus(); flush(); return true; }
    catch (e) { $('pairNote').textContent = e.message; return false; }
  }
  // Android app: scan the code the computer shows.
  if (window.RoyalScan) {
    $('pairScan').hidden = false;
    $('pairScan').addEventListener('click', async () => {
      $('pairNote').textContent = '';
      const r = await window.RoyalScan();
      if (r.error) $('pairNote').textContent = r.error;
      else if (r.text && applyPair(r.text)) view('home');
    });
  }
  // Android back button: step back inside the app first.
  window.__royalBack = () => {
    if (recording) { stop(); return true; }
    if (document.body.dataset.view === 'review' && $('draft').value.trim()) { $('reviewNote').textContent = 'Send it, or tap Discard to throw it away.'; return true; }
    if (document.body.dataset.view !== 'home') { view('home'); return true; }
    return false;
  };

  function openPairing() { $('pairCode').value = ''; $('pairNote').textContent = pair ? 'This phone is paired. Paste a new code to pair it with a different desktop.' : ''; $('unpair').hidden = !pair; view('pairing'); }

  /* ---------- wiring ---------- */
  $('rec').addEventListener('click', () => { if (finishing) return; recording ? stop() : start(false); });
  $('typeInstead').addEventListener('click', () => toType(''));
  $('resume').addEventListener('click', () => { base = $('draft').value; start(true); });
  $('discard').addEventListener('click', () => {
    if ($('draft').value.trim() && $('discard').dataset.armed !== '1') { $('discard').dataset.armed = '1'; $('discard').textContent = 'Tap again to discard'; return; }
    $('discard').dataset.armed = ''; $('discard').textContent = 'Discard'; base = ''; shots = []; view('home');
  });
  $('addShot').addEventListener('click', () => $('shotInput').click());
  $('shotInput').addEventListener('change', async () => {
    const files = [...$('shotInput').files].slice(0, 6 - shots.length); $('shotInput').value = '';
    for (const f of files) { try { shots.push(await shrink(f)); } catch (e) { $('reviewNote').textContent = 'One picture could not be opened.'; } }
    if (shots.length >= 6) $('reviewNote').textContent = 'Six pictures is the most for one dream.';
    paintShots();
  });
  $('send').addEventListener('click', () => {
    const text = $('draft').value.trim();
    if (text.length < 3) { $('reviewNote').textContent = 'There is nothing to send yet.'; return; }
    const rec = { id: newId(), text, date: new Date().toISOString(), sent: false };
    if (shots.length) rec.images = shots.slice();
    dreams.push(rec); shots = []; saveDreams();
    base = ''; $('discard').dataset.armed = ''; $('discard').textContent = 'Discard'; view('home'); paintStatus();
    toast(!pair ? 'Saved on this phone. Pair with your desktop to send it.' : navigator.onLine ? 'Sent to the cloud. It will be waiting for your desktop.' : 'Saved. It will send when you are back online.');
    flush();
  });
  $('openPast').addEventListener('click', () => { paintPast(); view('past'); flush(); });
  $('pastBack').addEventListener('click', () => view('home'));
  $('clearSent').addEventListener('click', () => { dreams = dreams.filter(d => !d.delivered); saveDreams(); paintPast(); paintStatus(); });
  $('pairStatus').addEventListener('click', () => { if (lastError && pair) { lastError = ''; flush(); } else openPairing(); });
  $('pairBack').addEventListener('click', () => view('home'));
  $('pairSave').addEventListener('click', () => { if (applyPair($('pairCode').value)) view('home'); });
  $('unpair').addEventListener('click', () => { pair = null; localStorage.removeItem('rr.pair'); paintStatus(); view('home'); toast('Unpaired. Dreams stay on this phone until you pair again.'); });

  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { if (recording) stop(); } else flush(); });

  // A pairing link from the desktop's code carries everything after the # sign; it never reaches a server.
  // Checked on load and whenever the link arrives while the app is already open.
  function pairFromLink() {
    const m = location.hash.match(/pair=([A-Za-z0-9_-]+)/);
    if (!m) return;
    const ok = applyPair(m[1], true); history.replaceState(null, '', location.pathname + location.search);
    if (ok) { view('home'); toast('Paired with your desktop.'); } else openPairing();
  }
  window.addEventListener('hashchange', pairFromLink);
  pairFromLink();

  if ('serviceWorker' in navigator && !window.RoyalAndroid) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Where the phone can recognise speech without sending audio anywhere, use that.
  (async () => {
    try {
      if (SR && SR.available) {
        const lang = navigator.language || 'en-AU';
        onDevice = (await SR.available({ langs: [lang], processLocally: true })) === 'available';
        paintStatus();
      }
    } catch (e) { onDevice = false; }
  })();

  paintStatus(); flush();
})();
