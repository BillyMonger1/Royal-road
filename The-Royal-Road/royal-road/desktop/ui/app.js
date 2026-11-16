/* The Royal Road — interface logic: journal, sync, analysis, chat, setup. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const TYPE_LABEL = { dream: 'Dreams', theme: 'Themes', archetype: 'Archetypes', character: 'Characters', place: 'Places', symbol: 'Symbols' };
  const TYPE_ONE = { theme: 'Theme', archetype: 'Archetype', character: 'Character', place: 'Place', symbol: 'Symbol' };
  const AI_DEFAULT = {
    anthropic: { model: 'claude-sonnet-5-5', modelHint: 'e.g. claude-sonnet-5-5', keyHint: 'Starts with sk-ant-' },
    openai: { model: '', modelHint: 'The model name from your OpenAI account', keyHint: 'Starts with sk-' },
    ollama: { model: '', modelHint: 'A model you have pulled, e.g. llama3.1', base: 'http://localhost:11434/v1' },
    custom: { model: '', modelHint: 'Model name', base: '' }
  };

  /* Backups are plain files: saved through the browser's download, restored by picking a file. */
  function downloadBackup(db) {
    const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'royal-road-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { ok: true };
  }
  function pickBackup() {
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
      input.onchange = () => {
        const f = input.files[0]; if (!f) { resolve({ ok: false }); return; }
        f.text().then(t => { try { resolve({ ok: true, db: JSON.parse(t) }); } catch (e) { resolve({ ok: false, error: 'That file is not a journal backup.' }); } });
      };
      input.click();
    });
  }

  /* In the desktop app the page talks to the app through a small bridge (preload.js).
     Opened as a plain file (preview), everything stays in the browser instead. */
  const host = window.royal ? (function () {
    const R = window.royal;
    return {
      loadJournal: R.loadJournal, saveJournal: R.saveJournal, loadSettings: R.loadSettings, saveSettings: R.saveSettings,
      ai: R.ai, getAutostart: R.getAutostart, setAutostart: R.setAutostart,
      exportBackup: async db => downloadBackup(db), importBackup: pickBackup,
      saveImage: R.saveImage, generateImage: R.generateImage, deleteImages: ids => ids.length ? R.deleteImages(ids) : null,
      imageSrc: id => 'royal://img/' + encodeURIComponent(id),
      transcribe: R.transcribe, exportObsidian: R.exportObsidian
    };
  })() : (function () {
    const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
    const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* preview only */ } };
    return {
      preview: true,
      loadJournal: async () => get('rr.journal', null),
      saveJournal: async db => set('rr.journal', db),
      loadSettings: async () => get('rr.settings', {}),
      saveSettings: async patch => set('rr.settings', Object.assign(get('rr.settings', {}), patch)),
      ai: async () => ({ ok: false, error: 'The AI connection works in the Windows app.' }),
      getAutostart: async () => ({ supported: false, on: false }),
      setAutostart: async () => ({ supported: false, on: false }),
      exportBackup: async db => downloadBackup(db), importBackup: pickBackup,
      saveImage: async data => { const id = Engine.uid('i'); const m = get('rr.images', {}); m[id] = data; set('rr.images', m); return { ok: true, id }; },
      generateImage: async () => ({ ok: false, error: 'Creating pictures works in the Windows app.' }),
      deleteImages: async ids => { const m = get('rr.images', {}); ids.forEach(i => delete m[i]); set('rr.images', m); },
      imageSrc: id => get('rr.images', {})[id] || ''
    };
  })();

  /* A backup is one file: the journal plus every picture inside it. */
  async function makeBackup() {
    const pictures = {};
    for (const d of S.db.dreams) for (const it of d.images || []) {
      try {
        const src = host.imageSrc(it.id);
        if (src.startsWith('data:')) { pictures[it.id] = src; continue; }
        const blob = await (await fetch(src)).blob();
        pictures[it.id] = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
      } catch (e) { /* a missing picture should not stop the backup */ }
    }
    return Object.assign({ v: 1, saved: new Date().toISOString() }, S.db, { pictures });
  }
  async function restoreBackup(b) {
    const old = S.db.dreams.flatMap(d => (d.images || []).map(i => i.id));
    const map = {};
    for (const [id, data] of Object.entries(b.pictures || {})) { const r = await host.saveImage(data); if (r.ok) map[id] = r.id; }
    const dreams = b.dreams.map(d => {
      const out = Object.assign({}, d);
      if (d.images) { out.images = d.images.filter(i => map[i.id]).map(i => Object.assign({}, i, { id: map[i.id] })); if (!out.images.length) delete out.images; }
      return out;
    });
    S.db = { v: 1, dreams, nodes: b.nodes, links: b.links };
    await saveDb(); host.deleteImages(old);
    return Object.keys(map).length;
  }

  /* ---------- pictures ---------- */
  /* Large photos are scaled down before saving: plenty for a journal, and the folder stays small. */
  async function prepImage(file) {
    if (!/^image\//.test(file.type)) throw new Error(file.name + ' is not a picture.');
    if (file.size < 600 * 1024 && /jpeg|webp/.test(file.type)) return readAsDataURL(file);
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { throw new Error(file.name + ' could not be opened.'); }
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  }
  function readAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error(file.name + ' could not be read.')); r.readAsDataURL(file); });
  }
  function pickFiles() {
    return new Promise(resolve => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true;
      input.onchange = () => resolve([...input.files]); input.click();
    });
  }
  /* Saves the files and returns [{ id, from }] plus any problem to report. */
  async function storeFiles(files, from) {
    const out = []; let problem = '';
    for (const f of files.slice(0, 12)) {
      try { const r = await host.saveImage(await prepImage(f)); if (r.ok) out.push({ id: r.id, from: from || 'upload' }); else problem = r.error; }
      catch (e) { problem = e.message; }
    }
    return { images: out, problem };
  }
  async function attachImages(dreamId, images) {
    const d = S.db.dreams.find(x => x.id === dreamId); if (!d || !images.length) return;
    d.images = (d.images || []).concat(images).slice(0, 40); await saveDb();
  }
  function imgPrompt(d) {
    const what = (d.summary && d.summary.length > 30 ? d.summary + ' ' : '') + d.text.slice(0, 600);
    return 'A dreamlike, painterly image of this dream: ' + what.trim() + ' Soft, surreal light. No text or lettering.';
  }
  function openViewer(images, start) {
    let i = start;
    const dlg = h('dialog', { class: 'viewer', 'aria-label': 'Picture' });
    const img = h('img', { alt: '' }), cap = h('p', { class: 'viewer-cap' });
    const show = () => { const it = images[i]; img.src = host.imageSrc(it.id); cap.textContent = it.from === 'ai' ? 'Created with AI' + (it.prompt ? ': ' + it.prompt.slice(0, 160) + (it.prompt.length > 160 ? '…' : '') : '') : it.from === 'phone' ? 'From your phone' : 'Added from this computer'; };
    const step = n => { i = (i + n + images.length) % images.length; show(); };
    dlg.append(img, cap,
      images.length > 1 && h('button', { class: 'viewer-nav prev', type: 'button', 'aria-label': 'Previous picture', onclick: () => step(-1), text: '‹' }),
      images.length > 1 && h('button', { class: 'viewer-nav next', type: 'button', 'aria-label': 'Next picture', onclick: () => step(1), text: '›' }),
      h('button', { class: 'viewer-close key', type: 'button', text: 'Close', onclick: () => dlg.close() }));
    dlg.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); show(); dlg.showModal();
  }
  function gallery(images, onRemove) {
    return h('div', { class: 'gallery' }, images.map((it, idx) => h('figure', { class: 'pic' },
      h('button', { class: 'pic-open', type: 'button', 'aria-label': 'Open picture ' + (idx + 1), onclick: () => openViewer(images, idx) },
        h('img', { src: host.imageSrc(it.id), alt: '', loading: 'lazy' })),
      it.from === 'ai' && h('span', { class: 'pic-tag', text: 'AI' }),
      onRemove && h('button', { class: 'pic-drop', type: 'button', 'aria-label': 'Remove this picture', title: 'Remove this picture', onclick: () => onRemove(it), text: '×' }))));
  }

  const S = { db: Engine.emptyDb(), settings: {}, view: { name: 'list' }, tab: 'journal', focus: null, chat: [], chatBusy: false, syncing: false, lastSync: 0 };
  let scope;

  /* ---------- small DOM helper: text is always set as text, never as markup ---------- */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'css') for (const p in v) el.style.setProperty(p, v[p]);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(x => x != null && x !== false && el.append(x));
    }
    return el;
  }
  const color = t => 'rgb(' + ScopeColors[t].join(',') + ')';
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const clock = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  function status(state, text) { $('lamp').dataset.state = state; $('statusText').textContent = text; }
  async function saveDb() { await host.saveJournal(S.db); }
  async function saveSettings(patch) { Object.assign(S.settings, patch); await host.saveSettings(patch); }
  function refresh() { scope.setData(S.db, Engine); renderChannels(); render(); }

  /* ---------- analysis ---------- */
  const aiReady = () => { const s = S.settings; return !host.preview && s.aiProvider && s.aiProvider !== 'none' && !!s.aiModel; };

  async function analyze(text) {
    let why = '';
    if (aiReady()) {
      const p = Engine.analysisPrompt(text, S.db);
      const r = await host.ai({ system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 1000 });
      if (r.ok) { try { return { analysis: Engine.parseAnalysis(r.text), by: 'ai' }; } catch (e) { why = e.message; } }
      else why = r.error;
    }
    return { analysis: Engine.localAnalyze(text, S.db), by: 'local', why };
  }

  async function fileDream(d) {
    const r = await analyze(d.text);
    const text = Engine.tidyText(d.text, r.analysis.text);
    const out = Engine.ingest(S.db, { id: d.id, text, date: d.date, by: r.by, images: d.images, title: d.title, titled: d.titled }, r.analysis);
    await saveDb();
    return { dream: out.dream, why: r.why };
  }

  /* ---------- sync with the cloud ---------- */
  const cloud = () => ({ url: S.settings.cloudUrl, key: S.settings.cloudKey });
  const paired = () => !!(S.settings.cloudUrl && S.settings.cloudKey && S.settings.pairSecret);
  /* A replaced pairing code keeps being checked for 60 days, so a phone that has not re-paired yet never loses a dream. */
  const RETIRE_MS = 60 * 864e5;
  function oldSecrets() {
    let list = []; try { list = JSON.parse(S.settings.pairOld || '[]'); } catch (e) { /* none */ }
    return list.filter(o => o && o.s && o.until > Date.now());
  }
  const allSecrets = () => [S.settings.pairSecret].concat(oldSecrets().map(o => o.s)).filter(Boolean);

  async function sync(manual) {
    if (S.syncing) return;
    if (!paired()) { status('off', 'Phone not paired. Open Setup'); if (manual) openSetup(); return; }
    S.syncing = true; S.lastSync = Date.now();
    status('busy', 'Checking the cloud');
    try {
      const have = new Set(S.db.dreams.map(d => d.id));
      let filed = 0, last = null, why = '';
      for (const secret of allSecrets()) {
      const got = await Relay.pull(cloud(), secret);
      const done = got.unreadable.slice();
      const fresh = got.dreams.filter(x => x.dream && typeof x.dream.text === 'string' && x.dream.text.trim());
      for (const item of got.dreams) if (!fresh.includes(item)) done.push(item.rowId);
      for (let i = 0; i < fresh.length; i++) {
        const { rowId, dream } = fresh[i];
        if (!have.has(dream.id)) {
          status('busy', 'Analyzing dream ' + (i + 1) + ' of ' + fresh.length);
          const pics = [];
          for (const data of (Array.isArray(dream.images) ? dream.images : []).slice(0, 12)) {
            if (typeof data !== 'string') continue;
            const s = await host.saveImage(data); if (s.ok) pics.push({ id: s.id, from: 'phone' });
          }
          const r = await fileDream({ id: String(dream.id || Engine.uid('d')), text: dream.text, date: dream.date, images: pics.length ? pics : undefined });
          have.add(r.dream.id); filed++; last = r.dream; why = r.why || why;
          refresh();
        }
        done.push(rowId);
      }
      // Only now, with everything safely on disk, is the cloud copy deleted.
      await Relay.ack(cloud(), secret, done);
      }
      if (filed) {
        S.focus = last.id;
        // Never pull the person away from a dream they are typing.
        if (S.tab === 'journal' && S.view.name !== 'compose') { scope.select(last.id, true); S.view = { name: 'dream', id: last.id }; render(); }
        status('ok', plural(filed, 'new dream') + ' filed' + (why ? ' with the built-in analyzer: ' + why : ''));
      } else status('ok', 'Up to date. Checked ' + clock());
    } catch (e) {
      status('error', e.message);
    } finally { S.syncing = false; }
  }

  /* ---------- journal views ---------- */
  function go(view) { if (view.name !== 'compose' && dict && dict.listening) dict.stop(); S.view = view; if (view.name === 'dream') S.focus = view.id; render(); $('paper').scrollTop = 0; }
  function showDream(id) { scope.select(id, true); go({ name: 'dream', id }); }
  function showThread(id) { scope.select(id, true); go({ name: 'thread', id }); }
  function backToList() { scope.select(null, true); go({ name: 'list' }); }

  function render() {
    const paper = $('paper');
    $('tabJournal').setAttribute('aria-selected', S.tab === 'journal');
    $('tabChat').setAttribute('aria-selected', S.tab === 'chat');
    $('addDream').hidden = S.tab !== 'journal' || S.view.name === 'compose';
    // A dream being typed is never rebuilt, so nothing that arrives in the meantime can erase it.
    if (S.tab === 'journal' && S.view.name === 'compose' && paper.querySelector('#composeText')) return;
    let body;
    if (S.tab === 'chat') body = viewChat();
    else if (S.view.name === 'dream') body = viewDream(S.view.id);
    else if (S.view.name === 'thread') body = viewThread(S.view.id);
    else if (S.view.name === 'compose') body = viewCompose();
    else body = viewList();
    if (!(S.tab === 'journal' && (S.view.name === 'dream' || S.view.name === 'compose'))) S.dropTarget = null;
    paper.replaceChildren(body);
    if (S.tab === 'chat') { paper.scrollTop = paper.scrollHeight; }
  }

  function viewList() {
    if (!S.db.dreams.length) {
      return h('div', null,
        h('h2', { text: 'Nothing filed yet' }),
        h('p', { class: 'note', text: 'Record a dream on your phone and it will arrive here the next time this window is open. You can also press Transcribe, or type one with the button below.' }),
        !paired() && h('p', { class: 'note' }, 'Your phone is not paired yet. ', h('button', { class: 'link', type: 'button', onclick: openSetup, text: 'Open Setup' }), ' to connect it.'));
    }
    const counts = new Map(); for (const l of S.db.links) counts.set(l[0], (counts.get(l[0]) || 0) + 1);
    const names = new Map(S.db.nodes.map(n => [n.id, n.name.toLowerCase()]));
    const threadText = new Map();
    for (const [d, n] of S.db.links) threadText.set(d, (threadText.get(d) || '') + ' ' + names.get(n));
    const results = h('ul', { class: 'entries' });
    const fill = () => {
      const q = (S.query || '').toLowerCase().trim();
      const hits = !q ? S.db.dreams : S.db.dreams.filter(d => (d.title + ' ' + d.text + ' ' + (d.summary || '') + (threadText.get(d.id) || '')).toLowerCase().includes(q));
      results.replaceChildren(...(hits.length ? hits.map(d => h('li', null,
        h('button', { class: 'entry', type: 'button', onclick: () => showDream(d.id) },
          h('span', { class: 'entry-text' },
            h('span', { class: 'entry-meta' }, h('span', { class: 'when', text: fmtDate(d.date) }), h('span', { class: 'when', text: plural(counts.get(d.id) || 0, 'thread') })),
            h('span', { class: 'entry-title', text: d.title }),
            h('span', { class: 'entry-sum', text: d.summary || d.text.slice(0, 160) })),
          d.images && d.images.length ? h('img', { class: 'entry-thumb', src: host.imageSrc(d.images[0].id), alt: '', loading: 'lazy' }) : null)))
        : [h('li', { class: 'note', text: 'No dream mentions “' + S.query.trim() + '”.' })]));
    };
    const search = h('input', { type: 'search', class: 'search', placeholder: 'Search dreams and threads', 'aria-label': 'Search dreams and threads', value: S.query || '' });
    search.addEventListener('input', () => { S.query = search.value; fill(); });
    fill();
    return h('div', null, search, results);
  }

  function chip(node, dreamId) {
    return h('span', { class: 'thread', css: { '--c': color(node.type) } },
      h('button', { type: 'button', title: TYPE_ONE[node.type], onclick: () => showThread(node.id) }, h('span', { class: 'dot' }), node.name),
      dreamId && h('button', { class: 'drop', type: 'button', 'aria-label': 'Remove ' + node.name + ' from this dream', title: 'Remove from this dream',
        onclick: async () => { Engine.unlink(S.db, dreamId, node.id); await saveDb(); refresh(); } }, '×'));
  }

  /* Editing: the name, the night, and the words. Changed words are analysed again; a given name is kept. */
  function viewEdit(d) {
    const title = h('input', { type: 'text', id: 'editTitle', value: d.title, maxlength: '80', spellcheck: 'true' });
    const day = new Date(d.date); const local = new Date(day - day.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const date = h('input', { type: 'date', id: 'editDate', value: local });
    const ta = h('textarea', { id: 'editText', spellcheck: 'true' }); ta.value = d.text;
    const msg = h('span', { class: 'note', role: 'status' });
    const save = h('button', { class: 'key', type: 'button', text: 'Save changes', onclick: async () => {
      const name = title.value.replace(/\s+/g, ' ').trim(), text = ta.value.trim();
      if (!name) { msg.textContent = 'Give the dream a name.'; title.focus(); return; }
      if (text.length < 3) { msg.textContent = 'The dream has no words yet.'; ta.focus(); return; }
      const when = new Date((date.value || local) + 'T' + day.toTimeString().slice(0, 8));
      const iso = isNaN(when) ? d.date : when.toISOString();
      const renamed = name !== d.title;
      if (renamed) { d.title = name; d.titled = true; }
      if (text !== d.text) {
        save.disabled = true; save.textContent = 'Analyzing';
        const r = await fileDream({ id: d.id, text, date: iso, images: d.images, title: d.title, titled: d.titled });
        S.view = { name: 'dream', id: d.id, msg: r.why ? 'The AI did not answer (' + r.why + '), so the built-in analyzer was used.' : 'Saved and analyzed again.' };
      } else {
        d.date = iso; S.db.dreams.sort((x, y) => (x.date < y.date ? 1 : -1)); await saveDb();
        S.view = { name: 'dream', id: d.id, msg: renamed ? 'Renamed.' : 'Saved.' };
      }
      refresh(); scope.select(d.id, true);
    } });
    setTimeout(() => { title.focus(); title.select(); }, 0);
    title.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
    return h('div', { class: 'compose' },
      h('h2', { text: 'Edit dream' }),
      h('label', { for: 'editTitle', text: 'Name' }), title,
      h('label', { for: 'editDate', text: 'Night of' }), date,
      h('label', { for: 'editText', text: 'The dream' }), ta,
      h('div', { class: 'actions' }, save, h('button', { class: 'key quiet', type: 'button', text: 'Cancel', onclick: () => { S.view = { name: 'dream', id: d.id }; render(); } }), msg));
  }

  function viewDream(id) {
    const d = S.db.dreams.find(x => x.id === id);
    if (!d) return viewList();
    if (S.view.editing) return viewEdit(d);
    const threads = Engine.threadsOf(S.db, id), rel = Engine.resonance(S.db, id, 5);
    const nodeName = new Map(S.db.nodes.map(n => [n.id, n.name]));
    const busy = S.view.busy;
    return h('article', null,
      h('button', { class: 'back', type: 'button', onclick: backToList, text: '‹ All dreams' }),
      h('div', { class: 'when', text: fmtDate(d.date) }),
      h('h2', { class: 'title-row' }, h('span', { text: d.title }),
        h('button', { class: 'rename', type: 'button', 'aria-label': 'Edit this dream', title: 'Rename or edit', onclick: () => { S.view = { name: 'dream', id, editing: true }; render(); } },
          h('span', { class: 'pencil', 'aria-hidden': 'true' }))),
      d.summary && h('p', { class: 'note', text: d.summary }),
      h('div', { class: 'body', text: d.text }),
      viewPictures(d),
      h('div', { class: 'section', text: 'Threads' }),
      threads.length ? h('div', { class: 'threads' }, threads.map(t => chip(t.node, id))) : h('p', { class: 'note', text: 'No threads were found in this dream.' }),
      addThreadForm(id),
      rel.length ? [h('div', { class: 'section', text: 'Shares the most with' }),
        h('ul', { class: 'plain' }, rel.map(r => {
          const o = S.db.dreams.find(x => x.id === r.id);
          return o && h('li', null, h('button', { class: 'link', type: 'button', onclick: () => showDream(o.id), text: o.title }),
            h('div', { class: 'shared', text: r.shared.map(n => nodeName.get(n)).filter(Boolean).slice(0, 4).join(', ') }));
        }))] : null,
      h('p', { class: 'note', css: { 'margin-top': '22px' }, text: S.view.msg || (d.by === 'ai' ? 'Threads named by the AI.' : 'Threads found by the built-in analyzer.') }),
      h('div', { class: 'actions' },
        h('button', { class: 'key quiet', type: 'button', disabled: busy, text: busy ? 'Analyzing' : (aiReady() ? 'Analyze again with AI' : 'Analyze again'),
          onclick: async () => {
            S.view = { name: 'dream', id, busy: true }; render();
            const r = await fileDream({ id: d.id, text: d.text, date: d.date });
            S.view = { name: 'dream', id, msg: r.why ? 'The AI did not answer (' + r.why + '), so the built-in analyzer was used.' : '' };
            refresh(); scope.select(id, true);
          } }),
        h('button', { class: 'key quiet', type: 'button', text: 'Edit', onclick: () => { S.view = { name: 'dream', id, editing: true }; render(); } }),
        h('button', { class: 'key quiet', type: 'button', text: 'Ask about this dream', onclick: () => { S.focus = id; S.tab = 'chat'; render(); } }),
        h('button', { class: 'key quiet danger', type: 'button', text: S.view.confirm ? 'Delete for good' : 'Delete dream',
          onclick: async () => {
            if (!S.view.confirm) { S.view = { name: 'dream', id, confirm: true, msg: 'Deleting cannot be undone. Press again to delete this dream.' }; render(); return; }
            host.deleteImages(Engine.removeDream(S.db, id)); await saveDb(); if (S.focus === id) S.focus = null; S.view = { name: 'list' }; refresh(); scope.select(null, true);
          } })));
  }

  function viewPictures(d) {
    const v = S.view, images = d.images || [];
    const status = h('p', { class: 'note pic-status', role: 'status', text: v.picMsg || '' });
    const redraw = patch => { S.view = Object.assign({ name: 'dream', id: d.id }, patch); render(); };
    const add = async files => {
      if (!files.length) return;
      redraw({ picMsg: 'Adding ' + plural(files.length, 'picture') + '…' });
      const r = await storeFiles(files, 'upload'); await attachImages(d.id, r.images);
      redraw({ picMsg: r.problem || '' });
    };
    S.dropTarget = add;
    const remove = async it => {
      d.images = images.filter(x => x !== it); if (!d.images.length) delete d.images;
      await saveDb(); host.deleteImages([it.id]); redraw({});
    };
    const canCreate = !host.preview && S.settings.imgProvider && S.settings.imgProvider !== 'none';
    let creator = null;
    if (v.creating) {
      const ta = h('textarea', { class: 'pic-prompt', 'aria-label': 'Describe the picture', spellcheck: 'true' });
      ta.value = v.prompt || imgPrompt(d);
      const go = h('button', { class: 'key', type: 'button', text: v.generating ? 'Creating… (up to a minute)' : 'Create picture', disabled: v.generating,
        onclick: async () => {
          const prompt = ta.value.trim(); if (!prompt) return;
          redraw({ creating: true, generating: true, prompt });
          const r = await host.generateImage(prompt);
          if (r.ok) { await attachImages(d.id, [{ id: r.id, from: 'ai', prompt }]); redraw({ picMsg: '' }); }
          else redraw({ creating: true, prompt, picMsg: r.error });
        } });
      creator = h('div', { class: 'pic-create' }, ta,
        h('div', { class: 'actions tight' }, go, h('button', { class: 'key quiet', type: 'button', text: 'Cancel', disabled: v.generating, onclick: () => redraw({}) })));
    }
    return h('section', { class: 'pics' },
      h('div', { class: 'section', text: 'Pictures' }),
      images.length ? gallery(images, remove) : null,
      creator,
      !v.creating && h('div', { class: 'actions tight' },
        h('button', { class: 'key quiet', type: 'button', text: 'Add a picture', onclick: async () => add(await pickFiles()) }),
        h('button', { class: 'key quiet', type: 'button', text: 'Create one with AI', title: canCreate ? '' : 'Connect a picture service in Setup',
          onclick: () => canCreate ? redraw({ creating: true }) : (host.preview ? redraw({ picMsg: 'Creating pictures works in the Windows app.' }) : openSetup()) })),
      !images.length && !v.creating && !v.picMsg && h('p', { class: 'note', text: 'Drop or paste pictures here too.' }),
      status);
  }

  function addThreadForm(dreamId) {
    const name = h('input', { type: 'text', class: 'thread-name', placeholder: 'Add a thread', 'aria-label': 'New thread name', maxlength: '48', list: 'threadNames' });
    const kind = h('select', { class: 'thread-kind', 'aria-label': 'Kind of thread' },
      Engine.THREAD_TYPES.map(t => h('option', { value: t, text: TYPE_ONE[t] })));
    kind.value = 'symbol';
    // Picking a name the journal already knows also picks its kind.
    const known = new Map(S.db.nodes.map(n => [n.name.toLowerCase(), n.type]));
    name.addEventListener('input', () => { const t = known.get(name.value.trim().toLowerCase()); if (t) kind.value = t; });
    const list = h('datalist', { id: 'threadNames' }, S.db.nodes.slice(0, 400).map(n => h('option', { value: n.name })));
    const add = async () => {
      if (!name.value.trim()) { name.focus(); return; }
      Engine.addThread(S.db, dreamId, name.value, kind.value); await saveDb();
      S.view = { name: 'dream', id: dreamId }; refresh(); scope.select(dreamId, true);
      const again = $('paper').querySelector('.thread-name'); if (again) again.focus();
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    return h('div', { class: 'add-thread' }, name, kind, h('button', { class: 'key quiet', type: 'button', text: 'Add', onclick: add }), list);
  }

  function viewThread(id) {
    const n = S.db.nodes.find(x => x.id === id);
    if (!n) return viewList();
    const list = Engine.dreamsOf(S.db, id);
    return h('article', null,
      h('button', { class: 'back', type: 'button', onclick: backToList, text: '‹ All dreams' }),
      h('div', { class: 'when', text: TYPE_ONE[n.type] }),
      h('h2', { text: n.name }),
      h('p', { class: 'note', text: 'Appears in ' + plural(list.length, 'dream') + '.' }),
      h('ul', { class: 'entries' }, list.map(t => h('li', null,
        h('button', { class: 'entry', type: 'button', onclick: () => showDream(t.dream.id) },
          h('span', { class: 'when', text: fmtDate(t.dream.date) }),
          h('span', { class: 'entry-title', text: t.dream.title }),
          h('span', { class: 'entry-sum', text: t.dream.summary || t.dream.text.slice(0, 160) }))))));
  }

  /* ---------- adding a dream: speak it or type it ---------- */
  let dict = null, clockTimer = null, traceRaf = 0;

  function viewCompose() {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const ta = h('textarea', { id: 'composeText', placeholder: 'Press the screen above and tell the dream, or type it here.', spellcheck: 'true' });
    ta.value = S.draft || ''; ta.addEventListener('input', () => { S.draft = ta.value; });
    const date = h('input', { type: 'date', id: 'composeDate', value: today, max: today });
    const msg = h('span', { class: 'note', role: 'status' });
    const hearing = h('p', { class: 'hearing', 'aria-live': 'polite' });
    const canvas = h('canvas', { class: 'mini-trace', 'aria-hidden': 'true' });
    const mic = h('button', { class: 'mini-scope', type: 'button', 'aria-label': 'Start transcribing', title: 'Start transcribing' }, canvas,
      h('span', { class: 'mini-icon', 'aria-hidden': 'true' }));
    const recorder = !!host.transcribe, can = recorder ? Recorder.supported() : Dictation.supported();
    const sttReady = () => !recorder || (S.settings.sttProvider && S.settings.sttProvider !== 'none');
    const idleHint = !can ? 'Transcription is not available here. Type the dream instead.' : !sttReady() ? 'Choose a transcription service in Setup first' : 'Press to start, press again to stop';
    const state = h('div', { class: 'mini-state' }, h('strong', { text: 'Transcribe' }), h('span', { text: idleHint }));
    const setState = on => {
      document.body.classList.toggle('listening', on);
      mic.setAttribute('aria-label', on ? 'Stop transcribing' : 'Start transcribing');
      clearInterval(clockTimer);
      if (on) {
        const t0 = Date.now();
        const tick = () => { const s = Math.floor((Date.now() - t0) / 1000); state.firstChild.textContent = (recorder ? 'Recording ' : 'Listening ') + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
        tick(); clockTimer = setInterval(tick, 1000); state.lastChild.textContent = 'Press again to stop';
      } else { state.firstChild.textContent = 'Transcribe'; state.lastChild.textContent = recorder ? 'Text appears a moment after you stop' : 'Press to start, press again to stop'; }
    };
    dict = new (recorder ? Recorder : Dictation)({
      meter: true, transcribe: host.transcribe,
      onState: setState,
      onText: (text, interim) => { ta.value = text; S.draft = text; hearing.textContent = interim; ta.scrollTop = ta.scrollHeight; },
      onDone: (text, note) => { ta.value = text; S.draft = text; hearing.textContent = ''; msg.textContent = note; if (!note) ta.focus(); }
    });
    mic.addEventListener('click', () => {
      if (dict.listening) { dict.stop(); return; }
      if (dict.finishing) return;
      if (!sttReady()) { msg.textContent = 'Choose a transcription service in Setup, then press the screen again.'; openSetup(); return; }
      msg.textContent = ''; dict.start(ta.value);
    });
    drawMiniTrace(canvas);

    const save = h('button', { class: 'key', type: 'button', text: 'File this dream', onclick: async () => {
      if (dict.listening) { dict.stop(); await new Promise(r => setTimeout(r, 1600)); }
      const text = ta.value.trim();
      if (text.length < 12) { msg.textContent = 'Say or write a little more first.'; ta.focus(); return; }
      save.disabled = true; save.textContent = 'Analyzing';
      const when = new Date((date.value || today) + 'T' + new Date().toTimeString().slice(0, 8));
      const r = await fileDream({ id: Engine.uid('d'), text, date: (isNaN(when) ? new Date() : when).toISOString(), images: S.pending });
      S.pending = []; S.draft = ''; S.view = { name: 'list' }; refresh(); scope.select(r.dream.id, true);
      S.view = { name: 'dream', id: r.dream.id, msg: r.why ? 'The AI did not answer (' + r.why + '), so the built-in analyzer was used.' : '' }; S.focus = r.dream.id; render();
    } });
    S.pending = S.pending || [];
    const picBox = h('div', { class: 'compose-pics' });
    const paintPics = () => picBox.replaceChildren(S.pending.length ? gallery(S.pending, it => { S.pending = S.pending.filter(x => x !== it); host.deleteImages([it.id]); paintPics(); }) : '');
    const addPics = async files => { if (!files.length) return; msg.textContent = 'Adding ' + plural(files.length, 'picture') + '…'; const r = await storeFiles(files, 'upload'); S.pending = S.pending.concat(r.images); paintPics(); msg.textContent = r.problem || ''; };
    S.dropTarget = addPics; paintPics();
    const cancel = () => { if (dict) dict.stop(); host.deleteImages((S.pending || []).map(i => i.id)); S.pending = []; S.draft = ''; S.view = { name: 'list' }; backToList(); };
    if (S.listenNow) { S.listenNow = false; setTimeout(() => mic.click(), 60); } else setTimeout(() => ta.focus(), 0);
    return h('div', { class: 'compose' },
      h('h2', { text: 'Add a dream' }),
      h('div', { class: 'mini' }, mic, state),
      h('label', { for: 'composeText', text: 'The dream' }), ta, hearing,
      picBox,
      h('button', { class: 'key quiet add-pic', type: 'button', text: 'Add pictures', onclick: async () => addPics(await pickFiles()) }),
      h('label', { for: 'composeDate', text: 'Night of' }), date,
      h('div', { class: 'actions' }, save, h('button', { class: 'key quiet', type: 'button', text: 'Cancel', onclick: cancel }), msg));
  }

  /* The little screen on the Transcribe button: your voice as a gold trace on violet glass. */
  function drawMiniTrace(cv) {
    cancelAnimationFrame(traceRaf);
    const g = cv.getContext('2d'); let t = 0;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let seen = false;
    const frame = () => {
      if (cv.isConnected) seen = true; else if (seen) return;   // stop once the screen is taken away
      traceRaf = requestAnimationFrame(frame);
      if (!seen) return;
      const d = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, hh = cv.clientHeight;
      if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(hh * d); }
      g.setTransform(d, 0, 0, d, 0, 0);
      g.fillStyle = 'rgba(11,8,22,.42)'; g.fillRect(0, 0, w, hh);
      const live = dict && dict.listening, data = live ? dict.samples() : null, y0 = hh * 0.5;
      t += 0.05; if (dict) dict.level *= 0.94;
      g.strokeStyle = 'rgba(200,170,255,.16)'; g.lineWidth = 1; g.beginPath(); g.moveTo(w * .12, y0); g.lineTo(w * .88, y0); g.stroke();
      g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,206,110,.95)'; g.shadowColor = 'rgba(255,200,92,.9)'; g.shadowBlur = 7; g.beginPath();
      for (let x = w * 0.1, i = 0; x <= w * 0.9; x += 1.5, i++) {
        const u = (x - w * 0.1) / (w * 0.8), env = Math.sin(Math.PI * u);
        let v;
        if (data) v = data[Math.floor(u * (data.length - 1))] * 3.2;
        else v = (still ? 0 : Math.sin(u * 18 + t * (live ? 5 : 1.2))) * (live ? 0.18 + 0.5 * Math.min(1, dict.level) : 0.06);
        const y = y0 - env * Math.max(-1, Math.min(1, v)) * hh * 0.36;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke(); g.shadowBlur = 0;
    };
    frame();
  }

  /* ---------- chat ---------- */
  function viewChat() {
    const focus = S.db.dreams.find(d => d.id === S.focus);
    const log = h('div', { class: 'chat-log' },
      h('div', { class: 'when', text: focus ? 'About “' + focus.title + '” and the journal' : 'About the whole journal' }),
      h('div', { css: { height: '14px' } }));
    if (!aiReady()) {
      log.append(h('p', { class: 'note' }, host.preview ? 'Chat works in the installed app once an AI is connected.' : 'Chat needs an AI. ',
        !host.preview && h('button', { class: 'link', type: 'button', onclick: openSetup, text: 'Connect one in Setup' }), !host.preview && '.'));
      return h('div', { class: 'chat' }, log);
    }
    if (!S.chat.length) log.append(h('p', { class: 'note', text: focus ? 'Ask what this dream might be pointing at, or how it connects to the others.' : 'Ask what keeps returning, or open a dream first to talk about that one.' }));
    for (const m of S.chat) log.append(h('p', { class: 'msg ' + (m.role === 'user' ? 'you' : m.error ? 'err' : 'ai'), text: m.content }));
    if (S.chatBusy) log.append(h('p', { class: 'msg ai typing' }));
    const ta = h('textarea', { placeholder: 'Ask about your dreams', 'aria-label': 'Message', disabled: S.chatBusy });
    const send = async () => {
      const text = ta.value.trim(); if (!text || S.chatBusy) return;
      S.chat.push({ role: 'user', content: text }); S.chatBusy = true; render();
      const turns = S.chat.filter(m => !m.error).slice(-14).map(m => ({ role: m.role, content: m.content }));
      const r = await host.ai({ system: Engine.chatContext(S.db, S.focus), messages: turns, maxTokens: 900 });
      S.chatBusy = false;
      S.chat.push(r.ok && r.text.trim() ? { role: 'assistant', content: r.text.trim() } : { role: 'assistant', error: true, content: r.error || 'The AI sent an empty reply. Try again.' });
      render(); const box = $('paper').querySelector('.chat-form textarea'); if (box) box.focus();
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    return h('div', { class: 'chat' }, log,
      h('form', { class: 'chat-form', onsubmit: e => { e.preventDefault(); send(); } }, ta, h('button', { class: 'key', type: 'submit', disabled: S.chatBusy, text: 'Send' })));
  }

  /* ---------- controls under the tube ---------- */
  function renderChannels() {
    const hiddenTypes = new Set(S.settings.hiddenTypes || []);
    const counts = { dream: S.db.dreams.length }; for (const n of S.db.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
    $('channels').replaceChildren(...Engine.TYPES.map(t => {
      const on = !hiddenTypes.has(t);
      return h('button', { class: 'key channel', type: 'button', 'aria-pressed': String(on), css: { '--c': color(t) },
        title: (on ? 'Hide ' : 'Show ') + TYPE_LABEL[t].toLowerCase(), 'aria-label': TYPE_LABEL[t],
        onclick: () => {
          if (on) hiddenTypes.add(t); else hiddenTypes.delete(t);
          scope.setFilter(t, !on); saveSettings({ hiddenTypes: [...hiddenTypes] }); renderChannels();
        } }, h('span', { class: 'lamp' }), h('span', { class: 'channel-name', text: TYPE_LABEL[t] }), h('span', { class: 'count', text: String(counts[t] || 0) }));
    }));
  }

  /* A knob turns 270 degrees. Drag up or down, scroll, or use the arrow keys. */
  function knob(el, opt) {
    let t = opt.toT(opt.value);
    const paint = () => {
      t = Math.max(0, Math.min(1, t)); el.style.setProperty('--a', (-135 + 270 * t) + 'deg'); el.style.setProperty('--sweep', (270 * t) + 'deg');
      el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100'); el.setAttribute('aria-valuenow', String(Math.round(t * 100)));
    };
    const emit = () => { paint(); opt.change(opt.fromT(t)); };
    let start = null;
    el.addEventListener('pointerdown', e => { start = { y: e.clientY, t }; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointermove', e => { if (start) { t = start.t + (start.y - e.clientY) / 160; emit(); } });
    el.addEventListener('pointerup', () => { start = null; opt.commit(opt.fromT(t)); });
    el.addEventListener('wheel', e => { e.preventDefault(); t -= Math.sign(e.deltaY) * 0.04; emit(); opt.commit(opt.fromT(t)); }, { passive: false });
    el.addEventListener('keydown', e => {
      const step = { ArrowUp: .04, ArrowRight: .04, ArrowDown: -.04, ArrowLeft: -.04, Home: -1, End: 1 }[e.key];
      if (!step) return; e.preventDefault(); t += step; emit(); opt.commit(opt.fromT(t));
    });
    el.addEventListener('dblclick', () => { t = opt.toT(opt.reset); emit(); opt.commit(opt.fromT(t)); });
    paint();
    return { set: v => { t = opt.toT(v); paint(); } };
  }

  function setupKnobs() {
    const k = Object.assign({ scale: 1, intensity: 1, depth: 1 }, S.settings.knobs || {});
    const make = (id, name, toT, fromT) => {
      scope.setKnob(name, k[name]);
      return knob($(id), { value: k[name], reset: 1, toT, fromT, change: v => scope.setKnob(name, v), commit: v => { k[name] = v; saveSettings({ knobs: k }); } });
    };
    const scaleKnob = make('knobScale', 'scale', v => Math.log(v / 0.4) / Math.log(7.5), t => 0.4 * Math.pow(7.5, t));
    make('knobIntensity', 'intensity', v => (v - 0.4) / 1.4, t => 0.4 + 1.4 * t);
    make('knobDepth', 'depth', v => v / 1.5, t => 1.5 * t);
    let timer; scope.onScale = v => { scaleKnob.set(v); k.scale = v; clearTimeout(timer); timer = setTimeout(() => saveSettings({ knobs: k }), 500); };
  }

  /* ---------- setup ---------- */
  function say(id, ok, text) { const el = $(id); el.dataset.ok = String(ok); el.textContent = text; }

  function paintAiFields() {
    const p = $('aiProvider').value, d = AI_DEFAULT[p];
    $('aiBaseRow').hidden = !(p === 'ollama' || p === 'custom');
    $('aiKeyRow').hidden = p === 'none' || p === 'ollama';
    $('aiModelRow').hidden = $('aiTestRow').hidden = p === 'none';
    if (d) { $('aiModel').placeholder = d.modelHint; $('aiKey').placeholder = d.keyHint || 'API key, if the service needs one'; $('aiBase').placeholder = p === 'ollama' ? d.base : 'https://example.com/v1'; }
  }

  function paintSttFields() {
    const p = $('sttProvider').value;
    $('sttBaseRow').hidden = p !== 'custom'; $('sttKeyRow').hidden = $('sttModelRow').hidden = $('sttTestRow').hidden = p === 'none';
    $('sttModel').placeholder = p === 'groq' ? 'whisper-large-v3-turbo' : p === 'openai' ? 'gpt-transcribe' : 'Model name';
    $('sttKey').placeholder = p === 'openai' ? 'Leave empty to use the OpenAI key above' : p === 'groq' ? 'Starts with gsk_ (free at console.groq.com)' : 'API key, if the service needs one';
  }

  function paintImgFields() {
    const p = $('imgProvider').value;
    $('imgBaseRow').hidden = p !== 'custom'; $('imgKeyRow').hidden = $('imgModelRow').hidden = p === 'none';
    $('imgKey').placeholder = p === 'openai' ? 'Leave empty to use the OpenAI key above' : 'API key, if the service needs one';
  }

  async function paintPair() {
    const s = S.settings, ready = !!(s.cloudUrl && s.cloudKey);
    $('pair').hidden = !ready; $('pairWait').hidden = ready;
    if (!ready) return;
    if (!s.pairSecret) await saveSettings({ pairSecret: Relay.newSecret() });
    const code = Relay.encodePair({ url: s.cloudUrl, key: s.cloudKey, secret: s.pairSecret });
    const base = /^https:\/\//.test(s.phoneUrl || '') ? s.phoneUrl.trim().replace(/[#?].*$/, '') : '';
    const link = base ? base + '#pair=' + code : code;
    $('copyPair').textContent = base ? 'Copy pairing link' : 'Copy pairing code';
    $('copyPair').dataset.value = link;
    $('pairHint').textContent = (base
      ? 'In the Royal Road Android app, tap Pair › Scan code and point it here. A phone camera also works: it opens the web version already paired.'
      : 'In the Royal Road Android app, tap Pair › Scan code and point it here.')
      + ' Treat the code like a password: anyone holding it can send dreams to this journal.';
    const qr = $('qr'); qr.hidden = false;
    {
      try {
        const q = QR.encode(base ? link : code), m = 3, size = q.size + m * 2, ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size); svg.setAttribute('shape-rendering', 'crispEdges');
        const path = document.createElementNS(ns, 'path'); path.setAttribute('d', QR.svgPath(q, m)); path.setAttribute('fill', '#000');
        svg.append(path); qr.replaceChildren(svg);
      } catch (e) { qr.hidden = true; }
    }
  }

  async function openSetup() {
    const s = S.settings;
    $('cloudUrl').value = s.cloudUrl || ''; $('cloudKey').value = s.cloudKey || ''; $('phoneUrl').value = s.phoneUrl || '';
    $('sttSection').hidden = !host.transcribe;
    $('sttProvider').value = s.sttProvider || 'none'; $('sttKey').value = s.sttKey || ''; $('sttModel').value = s.sttModel || ''; $('sttBase').value = s.sttBase || ''; paintSttFields();
    $('imgProvider').value = s.imgProvider || 'none'; $('imgKey').value = s.imgKey || ''; $('imgModel').value = s.imgModel || ''; $('imgBase').value = s.imgBase || ''; paintImgFields();
    $('aiProvider').value = s.aiProvider || 'none'; $('aiKey').value = s.aiKey || ''; $('aiModel').value = s.aiModel || ''; $('aiBase').value = s.aiBase || '';
    for (const id of ['cloudResult', 'pairResult', 'aiResult', 'backupResult']) $(id).textContent = '';
    paintAiFields(); await paintPair();
    const a = await host.getAutostart(); $('autostart').checked = a.on; $('autostart').disabled = !a.supported; $('autostartHint').hidden = a.supported;
    if (!$('setup').open) $('setup').showModal();
  }

  function bindSetup() {
    const text = id => $(id).value.trim();
    const keep = async () => {
      await saveSettings({ cloudUrl: Relay.cleanUrl(text('cloudUrl')), cloudKey: text('cloudKey'), phoneUrl: text('phoneUrl'),
        aiProvider: $('aiProvider').value, aiKey: text('aiKey'), aiModel: text('aiModel'), aiBase: text('aiBase'),
        sttProvider: $('sttProvider').value, sttKey: text('sttKey'), sttModel: text('sttModel'), sttBase: text('sttBase'),
        imgProvider: $('imgProvider').value, imgKey: text('imgKey'), imgModel: text('imgModel'), imgBase: text('imgBase') });
    };
    for (const id of ['cloudUrl', 'cloudKey', 'phoneUrl']) $(id).addEventListener('change', async () => { await keep(); await paintPair(); });
    for (const id of ['aiKey', 'aiModel', 'aiBase', 'imgKey', 'imgModel', 'imgBase']) $(id).addEventListener('change', keep);
    $('imgProvider').addEventListener('change', async () => { paintImgFields(); await keep(); });
    for (const id of ['sttKey', 'sttModel', 'sttBase']) $(id).addEventListener('change', keep);
    $('sttProvider').addEventListener('change', async () => { $('sttModel').value = ''; $('sttResult').textContent = ''; paintSttFields(); await keep(); });
    $('testStt').addEventListener('click', async () => {
      await keep(); say('sttResult', true, 'Testing');
      const r = await host.transcribe(null, 'test');
      say('sttResult', r.ok, r.ok ? 'Connected. The service is ready.' : r.error);
    });
    $('aiProvider').addEventListener('change', async () => {
      const p = $('aiProvider').value, d = AI_DEFAULT[p];
      if (d) { $('aiModel').value = d.model; $('aiBase').value = d.base || ''; $('aiKey').value = ''; }
      $('aiResult').textContent = ''; paintAiFields(); await keep();
    });
    $('testCloud').addEventListener('click', async () => {
      await keep(); await paintPair(); say('cloudResult', true, 'Testing');
      try { await Relay.pull(cloud(), S.settings.pairSecret || Relay.newSecret()); say('cloudResult', true, 'Connected. The relay is installed.'); }
      catch (e) { say('cloudResult', false, e.message); }
    });
    $('testAi').addEventListener('click', async () => {
      await keep(); say('aiResult', true, 'Testing');
      const r = await host.ai({ system: 'Reply with the single word: ready', messages: [{ role: 'user', content: 'Are you there?' }], maxTokens: 64 });
      say('aiResult', r.ok, r.ok ? 'Connected. The AI answered.' : r.error);
    });
    $('copyPair').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('copyPair').dataset.value); say('pairResult', true, 'Copied.'); }
      catch (e) { say('pairResult', false, 'Copying was blocked. Scan the code instead.'); }
    });
    $('newPair').addEventListener('click', async () => {
      if ($('newPair').dataset.armed !== '1') { $('newPair').dataset.armed = '1'; $('newPair').textContent = 'Really? The phone must pair again'; return; }
      $('newPair').dataset.armed = ''; $('newPair').textContent = 'Make a new code';
      const keep = oldSecrets().concat(S.settings.pairSecret ? [{ s: S.settings.pairSecret, until: Date.now() + RETIRE_MS }] : []);
      await saveSettings({ pairSecret: Relay.newSecret(), pairOld: JSON.stringify(keep) }); await paintPair();
      say('pairResult', true, 'New code made. Scan it with the phone. Dreams sent with the old code still arrive for 60 days.');
    });
    $('autostart').addEventListener('change', async () => { const a = await host.setAutostart($('autostart').checked); $('autostart').checked = a.on; });
    $('exportBackup').addEventListener('click', async () => {
      say('backupResult', true, 'Preparing the backup');
      const b = await makeBackup(); const r = await host.exportBackup(b);
      if (r.ok) say('backupResult', true, 'Backup saved with ' + plural(Object.keys(b.pictures).length, 'picture') + '.');
    });
    $('exportObsidian').hidden = !host.exportObsidian;
    $('exportObsidian').addEventListener('click', async () => {
      say('backupResult', true, 'Choose a folder');
      const r = await host.exportObsidian(await makeBackup());
      if (r.ok && r.path) say('backupResult', true, 'Exported ' + plural(r.dreams, 'dream') + ' and ' + plural(r.threads, 'thread') + ' to ' + r.path + '.');
      else if (r.error) say('backupResult', false, r.error); else $('backupResult').textContent = '';
    });
    $('importBackup').addEventListener('click', async () => {
      const r = await host.importBackup();
      if (!r.ok) { if (r.error) say('backupResult', false, r.error); return; }
      const db = r.db;
      if (!db || !Array.isArray(db.dreams) || !Array.isArray(db.nodes) || !Array.isArray(db.links)) { say('backupResult', false, 'That file is not a journal backup.'); return; }
      say('backupResult', true, 'Restoring');
      const n = await restoreBackup(db); S.view = { name: 'list' }; refresh();
      say('backupResult', true, 'Restored ' + plural(db.dreams.length, 'dream') + ' and ' + plural(n, 'picture') + '.');
    });
    $('setup').addEventListener('close', async () => { await keep(); render(); sync(false); });
  }

  /* ---------- start ---------- */
  async function start() {
    S.settings = (await host.loadSettings()) || {};
    const db = await host.loadJournal();
    if (db && Array.isArray(db.dreams)) S.db = Object.assign(Engine.emptyDb(), db);

    scope = new Scope($('crt'));
    window.__scope = scope;
    for (const t of S.settings.hiddenTypes || []) scope.setFilter(t, false);
    setupKnobs();
    scope.onSelect = n => {
      S.tab = 'journal';
      if (!n) go({ name: 'list' }); else if (n.type === 'dream') go({ name: 'dream', id: n.id }); else go({ name: 'thread', id: n.id });
    };
    refresh();

    $('tabJournal').addEventListener('click', () => { S.tab = 'journal'; render(); });
    $('tabChat').addEventListener('click', () => { S.tab = 'chat'; render(); });
    $('addDream').addEventListener('click', () => { scope.select(null, true); S.tab = 'journal'; go({ name: 'compose' }); });
    $('transcribe').addEventListener('click', () => {
      scope.select(null, true); S.tab = 'journal';
      if (S.view.name === 'compose' && dict) { if (!dict.listening) $('paper').querySelector('.mini-scope').click(); return; }
      S.listenNow = true; go({ name: 'compose' });
    });
    $('openSetup').addEventListener('click', openSetup);
    $('status').addEventListener('click', () => sync(true));
    // Drop or paste pictures onto an open dream (or a dream being added).
    const imagesIn = list => [...(list || [])].filter(f => f && /^image\//.test(f.type));
    document.addEventListener('dragover', e => { if (S.dropTarget && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    document.addEventListener('drop', e => { document.body.classList.remove('dropping'); if (!S.dropTarget) return; e.preventDefault(); const f = imagesIn(e.dataTransfer.files); if (f.length) S.dropTarget(f); });
    document.addEventListener('paste', e => { if (!S.dropTarget || !e.clipboardData) return; const f = imagesIn([...e.clipboardData.items].map(i => i.kind === 'file' ? i.getAsFile() : null)); if (f.length) { e.preventDefault(); S.dropTarget(f); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !S.view.editing && S.tab === 'journal' && S.view.name !== 'list' && S.view.name !== 'compose') backToList(); });
    bindSetup();

    // Collect from the cloud on launch, whenever the window comes back, and every few minutes while open.
    sync(false);
    window.addEventListener('focus', () => { if (Date.now() - S.lastSync > 30000) sync(false); });
    window.addEventListener('online', () => sync(false));
    setInterval(() => sync(false), 180000);
  }
  start();
})();
