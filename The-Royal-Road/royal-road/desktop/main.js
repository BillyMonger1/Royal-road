/* The Royal Road — desktop app (Electron).
   Owns the window, the journal, settings, pictures, starting with Windows, and every call to an
   outside service (AI, pictures, transcription). The interface in ui/ never sees the disk or makes
   those calls itself. */
const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeTheme, protocol, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

protocol.registerSchemesAsPrivileged([
  { scheme: 'royal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

const DATA = () => app.getPath('userData');                  // %APPDATA%\The Royal Road
const JOURNAL = () => path.join(DATA(), 'journal.json');
const SETTINGS = () => path.join(DATA(), 'settings.json');
const IMAGES = () => path.join(DATA(), 'images');
const UI = path.join(__dirname, 'ui');
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;

let win = null;

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

/* ---------- files ---------- */
function readJson(file, fallback) {
  for (const f of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* try the backup */ }
  }
  return fallback;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* keep going */ } }
  fs.renameSync(tmp, file);
}

/* ---------- settings: keys are sealed with the Windows account ---------- */
const SECRET = ['aiKey', 'pairSecret', 'cloudKey', 'pairOld', 'imgKey', 'sttKey'];
const lock = v => !v ? '' : safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(v).toString('base64') : 'raw:' + v;
function unlock(v) {
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return v.slice(4);
  } catch (e) { /* sealed by another account */ }
  return '';
}
function loadSettings() { const s = readJson(SETTINGS(), {}); for (const f of SECRET) s[f] = unlock(s[f]); return s; }
function saveSettings(s) { const o = Object.assign({}, s); for (const f of SECRET) o[f] = lock(o[f]); writeJson(SETTINGS(), o); }
const str = (s, k) => String(s[k] || '').trim();

/* ---------- talking to services ---------- */
async function call(url, opts, ms, what) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  let res;
  try { res = await fetch(url, Object.assign({ signal: ctl.signal }, opts)); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'The ' + what + ' took too long to answer.' : 'Could not reach the ' + what + ' at ' + new URL(url).host + '.'); }
  finally { clearTimeout(t); }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) { /* plain text */ }
    if (res.status === 401 || res.status === 403) throw new Error('The ' + what + ' rejected the key. Check it in Setup.');
    if (res.status === 404) throw new Error('The ' + what + ' does not know that model name. Check it in Setup.');
    if (res.status === 429) throw new Error('The ' + what + ' is rate limiting or out of credit. Try again shortly.');
    const err = new Error('The ' + what + ' said: ' + String(msg).slice(0, 200)); err.status = res.status; throw err;
  }
  try { return JSON.parse(text); } catch (e) { throw new Error('The ' + what + ' sent back something unreadable.'); }
}
function checkBase(base, what) {
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error('The ' + what + ' address in Setup is not a web address.');
  return base.replace(/\/+$/, '');
}

const AI_BASE = { anthropic: 'https://api.anthropic.com/v1', openai: 'https://api.openai.com/v1', ollama: 'http://localhost:11434/v1' };

/* req = { system, messages: [{ role, content }], maxTokens } -> text */
async function aiComplete(req) {
  const s = loadSettings(), p = str(s, 'aiProvider');
  if (!p || p === 'none') throw new Error('No AI is connected. Choose one in Setup.');
  const model = str(s, 'aiModel'); if (!model) throw new Error('No AI model name is set. Add one in Setup.');
  const key = str(s, 'aiKey');
  if ((p === 'anthropic' || p === 'openai') && !key) throw new Error('No AI key is saved. Add one in Setup.');
  const base = checkBase((p === 'custom' || p === 'ollama') && str(s, 'aiBase') ? str(s, 'aiBase') : AI_BASE[p] || '', 'AI');
  const max = Math.min(8000, req.maxTokens || 1200);
  if (p === 'anthropic') {
    const j = await call(base + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: max, system: req.system, messages: req.messages }) }, 90000, 'AI');
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const headers = Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {});
  const messages = [{ role: 'system', content: req.system }].concat(req.messages);
  let j;
  try { j = await call(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages, max_completion_tokens: max }) }, 90000, 'AI'); }
  catch (e) {
    if (e.status !== 400) throw e;   // older and local servers only know the previous parameter name
    j = await call(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages, max_tokens: max }) }, 90000, 'AI');
  }
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

/* Speech to text. audio = ArrayBuffer (webm/opus), or null to only check the settings and key. */
const STT = { openai: ['https://api.openai.com/v1', 'gpt-transcribe'], groq: ['https://api.groq.com/openai/v1', 'whisper-large-v3-turbo'] };
async function transcribe(audio, mime) {
  const s = loadSettings(), p = str(s, 'sttProvider');
  if (!p || p === 'none') throw new Error('No transcription service is chosen. Pick one in Setup.');
  const base = checkBase(p === 'custom' ? str(s, 'sttBase') : STT[p][0], 'transcription service');
  const model = str(s, 'sttModel') || (STT[p] ? STT[p][1] : '');
  if (!model) throw new Error('No transcription model name is set. Add one in Setup.');
  let key = str(s, 'sttKey');
  if (!key && p === 'openai' && str(s, 'aiProvider') === 'openai') key = str(s, 'aiKey');
  if (!key && p !== 'custom') throw new Error('No key for the transcription service. Add one in Setup.');
  const auth = key ? { Authorization: 'Bearer ' + key } : {};
  if (!audio) {   // the Setup test: list models, which needs a working key but costs nothing
    await call(base + '/models', { headers: auth }, 20000, 'transcription service');
    return '';
  }
  const form = new FormData();
  const lang = (app.getLocale() || 'en').slice(0, 2);
  form.append('file', new Blob([Buffer.from(audio)], { type: mime || 'audio/webm' }), 'dream.webm');
  form.append('model', model);
  form.append('language', lang);
  form.append('prompt', 'A dream, told just after waking. Punctuate naturally.');
  const j = await call(base + '/audio/transcriptions', { method: 'POST', headers: auth, body: form }, 180000, 'transcription service');
  return String(j.text || '').trim();
}

/* Pictures: saved as files beside the journal; the journal only lists their ids. */
function sniff(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) return '.jpg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return '.webp';
  return '';
}
function saveImageBytes(b) {
  const ext = sniff(b); if (!ext) throw new Error('That file is not a picture this app can show (JPEG, PNG or WebP).');
  if (b.length > 25 * 1024 * 1024) throw new Error('That picture is larger than 25 MB.');
  fs.mkdirSync(IMAGES(), { recursive: true });
  const id = 'i' + crypto.randomBytes(10).toString('hex');
  fs.writeFileSync(path.join(IMAGES(), id + ext), b);
  return id;
}
function findImage(id) {
  if (!/^[a-z0-9]{8,40}$/.test(id)) return '';
  for (const ext of ['.jpg', '.png', '.webp']) { const p = path.join(IMAGES(), id + ext); if (fs.existsSync(p)) return p; }
  return '';
}
async function generateImage(prompt) {
  const s = loadSettings(), p = str(s, 'imgProvider');
  if (!p || p === 'none') throw new Error('No picture service is connected. Choose one in Setup.');
  const base = checkBase(p === 'custom' ? str(s, 'imgBase') : 'https://api.openai.com/v1', 'picture service');
  let key = str(s, 'imgKey');
  if (!key && p === 'openai' && str(s, 'aiProvider') === 'openai') key = str(s, 'aiKey');
  if (!key && p === 'openai') throw new Error('No key for the picture service. Add one in Setup.');
  const j = await call(base + '/images/generations', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
    body: JSON.stringify({ model: str(s, 'imgModel') || 'gpt-image-2', prompt: String(prompt).slice(0, 4000), n: 1, size: '1024x1024' }) }, 180000, 'picture service');
  const d = j.data && j.data[0];
  if (!d) throw new Error('The picture service sent back no picture.');
  if (d.b64_json) return saveImageBytes(Buffer.from(d.b64_json, 'base64'));
  if (d.url) { const r = await fetch(d.url); return saveImageBytes(Buffer.from(await r.arrayBuffer())); }
  throw new Error('The picture service sent back no picture.');
}

/* ---------- starting with Windows ---------- */
const LOGIN = () => ({ path: process.execPath, args: ['--at-login'], name: 'The Royal Road' });
const autostart = () => PORTABLE ? { supported: false, on: false } : { supported: true, on: app.getLoginItemSettings(LOGIN()).openAtLogin };
function setAutostart(on) {
  if (!PORTABLE) app.setLoginItemSettings(Object.assign(LOGIN(), { openAtLogin: !!on }));
  return autostart();
}

/* ---------- the window ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serveFile(file) {
  if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': 'royal://app' } });
}
function overlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#1d1928' : '#ebe7f3', symbolColor: dark ? '#ece6f8' : '#2a2238', height: 64 };
}

function createWindow() {
  const b = readJson(SETTINGS(), {}).bounds || {};
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y, minWidth: 1080, minHeight: 680,
    show: false, title: 'The Royal Road', icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: overlay().color,
    // On Windows the system draws its own window buttons over the top bar, so snap layouts keep working.
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: overlay() } : {}),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true }
  });
  if (b.maximized) win.maximize();
  win.loadURL('royal://app/index.html');
  const atLogin = process.argv.includes('--at-login');
  // Started with Windows: open quietly on the taskbar and collect dreams, without taking focus.
  win.once('ready-to-show', () => { if (atLogin) { win.showInactive(); win.minimize(); } else win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', () => {
    try { const cur = readJson(SETTINGS(), {}); cur.bounds = Object.assign(win.getNormalBounds(), { maximized: win.isMaximized() }); writeJson(SETTINGS(), cur); }
    catch (e) { /* not worth blocking exit */ }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  protocol.handle('royal', req => {
    const u = new URL(req.url);
    if (u.host === 'img') return serveFile(findImage(decodeURIComponent(u.pathname.slice(1))));
    if (u.host === 'app') {
      const file = path.normalize(path.join(UI, decodeURIComponent(u.pathname)));
      return file.startsWith(UI + path.sep) ? serveFile(file) : new Response('Forbidden', { status: 403 });
    }
    return new Response('Not found', { status: 404 });
  });
  // The only permission the page may have is the microphone, for Transcribe.
  session.defaultSession.setPermissionRequestHandler((wc, perm, done, details) => done(perm === 'media' && (!details.mediaTypes || details.mediaTypes.every(t => t === 'audio'))));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media');
  nativeTheme.on('updated', () => { if (win && process.platform === 'win32') { try { win.setTitleBarOverlay(overlay()); } catch (e) { /* older Windows */ } } });

  const raw = readJson(SETTINGS(), {});
  if (!raw.autostartInit && app.isPackaged && !PORTABLE) { setAutostart(true); raw.autostartInit = true; writeJson(SETTINGS(), raw); }
  createWindow();
});
app.on('window-all-closed', () => app.quit());

/* ---------- Export to Obsidian: one note per dream and per thread, linked with [[ ]] ---------- */
const safeName = t => String(t || 'Untitled').replace(/[\\/:*?"<>|#^\[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled';
async function exportObsidian(b) {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your Obsidian vault (or any folder)', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return {};
  const root = path.join(r.filePaths[0], 'The Royal Road');
  for (const sub of ['Dreams', 'Threads', 'Pictures']) fs.mkdirSync(path.join(root, sub), { recursive: true });
  const nodes = new Map(b.nodes.map(n => [n.id, n]));
  const dreams = new Map(b.dreams.map(d => [d.id, d]));
  // Names must be unique; a thread and a dream with the same name get told apart.
  const used = new Set(), name = (base) => { let n = base, i = 2; while (used.has(n.toLowerCase())) n = base + ' ' + i++; used.add(n.toLowerCase()); return n; };
  const dreamName = new Map(b.dreams.map(d => [d.id, name(safeName(d.date.slice(0, 10) + ' ' + d.title))]));
  const nodeName = new Map(b.nodes.map(n => [n.id, name(safeName(n.name))]));
  const byDream = new Map(), byNode = new Map();
  for (const [d, n, w] of b.links) {
    if (!byDream.has(d)) byDream.set(d, []); byDream.get(d).push([n, w]);
    if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(d);
  }
  const yaml = v => JSON.stringify(String(v));
  for (const d of b.dreams) {
    const threads = (byDream.get(d.id) || []).sort((x, y) => y[1] - x[1]);
    const pics = [];
    for (const it of d.images || []) {
      const data = b.pictures && b.pictures[it.id]; if (!data) continue;
      const ext = /^data:image\/png/.test(data) ? '.png' : /^data:image\/webp/.test(data) ? '.webp' : '.jpg';
      const file = it.id + ext;
      fs.writeFileSync(path.join(root, 'Pictures', file), Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64'));
      pics.push('![[' + file + ']]');
    }
    const md = ['---', 'date: ' + d.date.slice(0, 10), 'title: ' + yaml(d.title), 'tags: [dream]', '---', '',
      d.summary ? '> ' + d.summary + '\n' : '', d.text, '', pics.join('\n'), '',
      '## Threads', threads.map(([n, w]) => nodes.get(n) ? '- [[' + nodeName.get(n) + ']] (' + nodes.get(n).type + ', ' + Math.round(w * 100) + '%)' : '').filter(Boolean).join('\n'), ''].join('\n');
    fs.writeFileSync(path.join(root, 'Dreams', dreamName.get(d.id) + '.md'), md);
  }
  for (const n of b.nodes) {
    const list = (byNode.get(n.id) || []).map(id => dreams.get(id)).filter(Boolean).sort((x, y) => (x.date < y.date ? 1 : -1));
    const md = ['---', 'type: ' + n.type, 'tags: [' + n.type + ']', '---', '', 'Appears in ' + list.length + (list.length === 1 ? ' dream:' : ' dreams:'), '',
      list.map(d => '- [[' + dreamName.get(d.id) + ']]').join('\n'), ''].join('\n');
    fs.writeFileSync(path.join(root, 'Threads', nodeName.get(n.id) + '.md'), md);
  }
  return { path: root, dreams: b.dreams.length, threads: b.nodes.length };
}

/* ---------- bridge (see preload.js) ---------- */
const wrap = fn => async (e, ...a) => { try { return Object.assign({ ok: true }, await fn(...a)); } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('journal:load', () => readJson(JOURNAL(), null));
ipcMain.handle('journal:save', (e, db) => { writeJson(JOURNAL(), db); return true; });
ipcMain.handle('settings:load', () => { const s = loadSettings(); delete s.bounds; delete s.autostartInit; return s; });
ipcMain.handle('settings:save', (e, patch) => { const cur = loadSettings(); Object.assign(cur, patch); saveSettings(cur); return true; });
ipcMain.handle('ai', wrap(async req => ({ text: await aiComplete(req) })));
ipcMain.handle('transcribe', wrap(async (audio, mime) => ({ text: await transcribe(audio, mime) })));
ipcMain.handle('image:save', wrap(async data => ({ id: saveImageBytes(Buffer.from(String(data).replace(/^data:[^,]*,/, ''), 'base64')) })));
ipcMain.handle('image:generate', wrap(async prompt => ({ id: await generateImage(prompt) })));
ipcMain.handle('image:delete', (e, ids) => { for (const id of ids || []) { const p = findImage(id); if (p) fs.rmSync(p, { force: true }); } return true; });
ipcMain.handle('export:obsidian', wrap(async b => exportObsidian(b)));
ipcMain.handle('autostart:get', () => autostart());
ipcMain.handle('autostart:set', (e, on) => setAutostart(on));
