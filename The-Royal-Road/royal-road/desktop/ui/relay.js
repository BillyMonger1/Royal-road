/* The Royal Road — cloud relay client. Shared by the phone app and the desktop app.
   The phone seals each dream with a key only the two devices hold, so the cloud
   only ever stores unreadable text. The desktop collects, opens and then deletes it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Relay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const enc = new TextEncoder(); const dec = new TextDecoder();

  function b64(bytes) {
    let s = ''; const b = new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str); const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const b64url = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = str => unb64(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));

  function newSecret() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }

  async function sha(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))); }

  /* One secret gives two unrelated values: a mailbox address the cloud sees, and a key it never sees. */
  async function derive(secret) {
    const route = Array.from(await sha('royal-road/route/' + secret), b => b.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.importKey('raw', await sha('royal-road/seal/' + secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { route, key };
  }

  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
    return b64(out);
  }
  async function open(key, payload) {
    const raw = unb64(payload);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12));
    return JSON.parse(dec.decode(pt));
  }

  function cleanUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

  function describe(status, body) {
    if (status === 401 || status === 403) return 'The cloud rejected the key. Check the project key in Setup.';
    if (status === 404) return 'The cloud is reachable but the relay is not installed. Run cloud/setup.sql in Supabase.';
    return 'Cloud error ' + status + (body ? ': ' + String(body).slice(0, 140) : '');
  }

  /* Older Supabase keys are JWTs (eyJ...) and go in both headers. Newer sb_publishable_ keys go in apikey only. */
  function headersFor(key) {
    const h = { 'Content-Type': 'application/json', apikey: key };
    if (/^eyJ/.test(key)) h.Authorization = 'Bearer ' + key;
    return h;
  }

  async function rpc(cfg, fn, args) {
    const url = cleanUrl(cfg.url);
    if (!/^https:\/\//.test(url) || !cfg.key) throw new Error('The cloud relay is not set up yet.');
    let res;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      res = await fetch(url + '/rest/v1/rpc/' + fn, {
        method: 'POST', signal: ctl.signal,
        headers: headersFor(cfg.key.trim()),
        body: JSON.stringify(args)
      });
    } catch (e) {
      throw new Error('Could not reach the cloud. Check the connection and the project URL.');
    } finally { clearTimeout(timer); }
    if (!res.ok) { let body = ''; try { body = await res.text(); } catch (e) {} throw new Error(describe(res.status, body)); }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /* dream = { id, text, date }. Safe to call twice: the desktop ignores an id it has already filed. */
  async function push(cfg, secret, dream) {
    const { route, key } = await derive(secret);
    return rpc(cfg, 'push_dream', { p_route: route, p_payload: await seal(key, dream) });
  }

  /* Returns { dreams: [{ rowId, dream }], unreadable: [rowId] }. Nothing is deleted until ack(). */
  async function pull(cfg, secret) {
    const { route, key } = await derive(secret);
    const rows = (await rpc(cfg, 'pull_dreams', { p_route: route })) || [];
    const dreams = []; const unreadable = [];
    for (const r of rows) {
      try { dreams.push({ rowId: r.id, dream: await open(key, r.payload) }); }
      catch (e) { unreadable.push(r.id); }
    }
    return { dreams, unreadable };
  }

  async function ack(cfg, secret, rowIds) {
    if (!rowIds.length) return 0;
    const { route } = await derive(secret);
    return rpc(cfg, 'ack_dreams', { p_route: route, p_ids: rowIds });
  }

  /* Phone: of these cloud rows, which are still waiting for the desktop? Returns a Set, or null if the relay is older. */
  async function waiting(cfg, secret, rowIds) {
    if (!rowIds.length) return new Set();
    const { route } = await derive(secret);
    try { return new Set(((await rpc(cfg, 'waiting_dreams', { p_route: route, p_ids: rowIds })) || []).map(String)); }
    catch (e) { if (/relay is not installed/.test(e.message)) return null; throw e; }
  }

  /* Pairing code: everything the phone needs, carried in the part of a link that is never sent to a server. */
  function encodePair(p) { return b64url(enc.encode(JSON.stringify({ u: cleanUrl(p.url), k: p.key.trim(), s: p.secret }))); }
  function decodePair(code) {
    const m = String(code || '').trim().match(/(?:#pair=)?([A-Za-z0-9_-]{40,})$/);
    if (!m) throw new Error('That is not a pairing code.');
    let o;
    try { o = JSON.parse(dec.decode(unb64url(m[1]))); } catch (e) { throw new Error('That pairing code is damaged.'); }
    if (!o || !/^https:\/\//.test(o.u) || !o.k || !o.s) throw new Error('That pairing code is incomplete.');
    return { url: o.u, key: o.k, secret: o.s };
  }

  return { newSecret, derive, seal, open, rpc, push, pull, ack, waiting, encodePair, decodePair, cleanUrl };
});
