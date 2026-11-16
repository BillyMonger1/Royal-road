/* Run with: node tools/test.js   — checks the engine, the encryption, and the phone → cloud → desktop path. */
const assert = require('assert');
const E = require('../desktop/ui/engine.js');
const R = require('../desktop/ui/relay.js');
const QR = require('../desktop/ui/qr.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

/* A stand-in for the Supabase relay that follows cloud/setup.sql exactly. */
function fakeCloud() {
  const rows = []; let id = 0;
  global.fetch = async (url, opt) => {
    const fn = url.split('/rpc/')[1], a = JSON.parse(opt.body);
    if (!opt.headers.apikey) return { ok: false, status: 401, text: async () => '' };
    let out;
    if (fn === 'push_dream') {
      if (!/^[0-9a-f]{64}$/.test(a.p_route)) return { ok: false, status: 400, text: async () => 'bad route' };
      rows.push({ id: 'row' + (++id), route: a.p_route, payload: a.p_payload }); out = 'row' + id;
    } else if (fn === 'pull_dreams') out = rows.filter(r => r.route === a.p_route).map(r => ({ id: r.id, payload: r.payload }));
    else if (fn === 'waiting_dreams') out = rows.filter(r => r.route === a.p_route && a.p_ids.includes(r.id)).map(r => r.id);
    else if (fn === 'ack_dreams') { let c = 0; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].route === a.p_route && a.p_ids.includes(rows[i].id)) { rows.splice(i, 1); c++; } out = c; }
    else return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(out) };
  };
  return rows;
}

(async () => {
  console.log('engine');
  await t('names that differ only in form are one thread', () => {
    assert.strictEqual(E.canon('The Dragons'), E.canon('dragon'));
    assert.strictEqual(E.canon('Old  School'), 'old school');
    assert.notStrictEqual(E.canon('Glass'), E.canon('Gla'));
  });
  await t('dreams that share a thread link through one node, and it grows', () => {
    const db = E.emptyDb();
    E.ingest(db, { id: 'a', text: 'x', date: '2026-01-01T00:00:00Z' }, { title: 'A', entities: [{ name: 'Dragon', type: 'symbol', salience: .9 }, { name: 'House', type: 'place', salience: .5 }] });
    const before = E.nodeRadius('symbol', E.stats(db).get(db.nodes[0].id));
    E.ingest(db, { id: 'b', text: 'y', date: '2026-01-02T00:00:00Z' }, { title: 'B', entities: [{ name: 'the dragons', type: 'symbol', salience: .8 }] });
    assert.strictEqual(db.nodes.length, 2); assert.strictEqual(db.links.length, 3);
    const s = E.stats(db).get(db.nodes[0].id);
    assert.strictEqual(s.deg, 2); assert.ok(E.nodeRadius('symbol', s) > before);
    assert.strictEqual(E.resonance(db, 'a')[0].id, 'b');
    assert.strictEqual(db.dreams[0].id, 'b', 'newest first');
  });
  await t('filing the same dream twice does not duplicate it', () => {
    const db = E.emptyDb(), an = { title: 'A', entities: [{ name: 'Key', type: 'symbol', salience: .6 }] };
    E.ingest(db, { id: 'a', text: 'x' }, an); E.ingest(db, { id: 'a', text: 'x' }, an);
    assert.strictEqual(db.dreams.length, 1); assert.strictEqual(db.links.length, 1); assert.strictEqual(db.nodes.length, 1);
  });
  await t('deleting a dream removes threads nothing else uses', () => {
    const db = E.emptyDb();
    E.ingest(db, { id: 'a', text: 'x' }, { entities: [{ name: 'Key', type: 'symbol' }, { name: 'Door', type: 'symbol' }] });
    E.ingest(db, { id: 'b', text: 'y' }, { entities: [{ name: 'Door', type: 'symbol' }] });
    E.removeDream(db, 'a');
    assert.deepStrictEqual(db.nodes.map(x => x.name), ['Door']); assert.strictEqual(db.links.length, 1);
  });
  await t('built-in analyzer finds threads without any AI', () => {
    const a = E.localAnalyze('I was in the old house and a snake chased me down the staircase. My mother was watching. Then Tayleur opened a door and I was falling.', E.emptyDb());
    const names = a.entities.map(e => e.name);
    for (const want of ['House', 'Snake', 'The Mother', 'Escape', 'Tayleur', 'Door', 'Loss of control']) assert.ok(names.includes(want), 'missing ' + want + ' in ' + names);
    assert.ok(a.title.length > 3);
  });
  await t('built-in analyzer recognises threads the journal already has', () => {
    const db = E.emptyDb(); E.ingest(db, { id: 'a', text: 'x' }, { entities: [{ name: 'Sun-Moon Spine Diagram', type: 'symbol' }] });
    const a = E.localAnalyze('Again I saw the sun-moon spine diagram on the wall.', db);
    assert.ok(a.entities.some(e => e.name === 'Sun-Moon Spine Diagram'));
  });
  await t('AI replies are parsed, cleaned and capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: 'thing ' + i, type: 'symbol', salience: i / 30 }));
    const a = E.parseAnalysis('Here you go:\n```json\n' + JSON.stringify({ title: 'T', summary: 'S', entities: [{ name: 'shadow', type: 'archetype', salience: 9 }, { name: 'x', type: 'nonsense' }].concat(many) }) + '\n```');
    assert.strictEqual(a.entities.length, 14); assert.strictEqual(a.entities[0].name, 'The Shadow'); assert.strictEqual(a.entities[0].salience, 1);
    assert.throws(() => E.parseAnalysis('I cannot do that.')); assert.throws(() => E.parseAnalysis('{"entities": []}'));
  });
  await t('hostile text in a dream stays text', () => {
    const db = E.emptyDb();
    E.ingest(db, { id: 'a', text: '<img src=x onerror=alert(1)>' }, { title: '<b>x</b>', entities: [{ name: '<script>', type: 'symbol' }] });
    assert.ok(typeof db.dreams[0].title === 'string');   // rendering uses textContent only (see app.js h())
  });

  await t('AI punctuation is only accepted when no word changed', () => {
    assert.strictEqual(E.tidyText('i fell then woke', 'I fell. Then woke.'), 'I fell. Then woke.');
    assert.strictEqual(E.tidyText('i fell then woke', 'I fell, then I woke.'), 'i fell then woke');
    assert.strictEqual(E.tidyText('x', undefined), 'x');
  });
  await t('a thread that only repeats its dream\'s title is skipped', () => {
    const db = E.emptyDb();
    E.ingest(db, { id: 'a', text: 'x' }, { title: 'Tall locker', entities: [{ name: 'Tall Locker', type: 'symbol' }, { name: 'Henry', type: 'character' }] });
    assert.deepStrictEqual(db.nodes.map(x => x.name), ['Henry']);
  });
  await t('known threads match whole words only', () => {
    const db = E.emptyDb(); E.ingest(db, { id: 'a', text: 'x' }, { entities: [{ name: 'Cat', type: 'symbol' }] });
    assert.ok(!E.localAnalyze('a category of things', db).entities.some(e => e.name === 'Cat'));
  });

  console.log('relay');
  const cfg = { url: 'https://example.supabase.co', key: 'anon' };
  await t('a sealed dream cannot be read without the pairing secret', async () => {
    const a = await R.derive(R.newSecret()), b = await R.derive(R.newSecret());
    const sealed = await R.seal(a.key, { text: 'the hag at the window' });
    assert.ok(!sealed.includes('hag')); assert.notStrictEqual(a.route, b.route);
    assert.deepStrictEqual(await R.open(a.key, sealed), { text: 'the hag at the window' });
    await assert.rejects(R.open(b.key, sealed));
  });
  await t('pairing code survives the trip to the phone', () => {
    const p = { url: 'https://abc.supabase.co/', key: ' eyJ.x.y ', secret: R.newSecret() };
    const code = R.encodePair(p);
    assert.deepStrictEqual(R.decodePair('https://me.netlify.app/#pair=' + code), { url: 'https://abc.supabase.co', key: 'eyJ.x.y', secret: p.secret });
    assert.throws(() => R.decodePair('hello')); assert.throws(() => R.decodePair('A'.repeat(60)));
  });
  await t('phone → cloud → desktop: held until collected, deleted after, never duplicated', async () => {
    const rows = fakeCloud(), secret = R.newSecret(), other = R.newSecret();
    const d1 = { id: 'd1', text: 'A dragon fell from a beanstalk.', date: '2026-06-26T06:00:00Z' };
    await R.push(cfg, secret, d1); await R.push(cfg, secret, d1);                 // phone retried
    await R.push(cfg, secret, { id: 'd2', text: 'I cleaned the kitchen and found hidden rot.', date: '2026-06-25T06:00:00Z' });
    await R.push(cfg, other, { id: 'zz', text: 'someone else' });
    assert.strictEqual(rows.length, 4); assert.ok(!JSON.stringify(rows).includes('dragon'), 'cloud holds only sealed text');
    // desktop
    const db = E.emptyDb(), got = await R.pull(cfg, secret), have = new Set(), done = [];
    assert.strictEqual(got.dreams.length, 3);
    for (const { rowId, dream } of got.dreams) {
      if (!have.has(dream.id)) { E.ingest(db, dream, E.localAnalyze(dream.text, db)); have.add(dream.id); }
      done.push(rowId);
    }
    assert.strictEqual(rows.length, 4, 'nothing deleted before the desktop confirms');
    assert.strictEqual((await R.waiting(cfg, secret, ['row1', 'row3'])).size, 2, 'phone sees its dreams still waiting');
    assert.strictEqual(await R.ack(cfg, secret, done), 3);
    assert.strictEqual(rows.length, 1); assert.strictEqual(db.dreams.length, 2);
    assert.strictEqual((await R.waiting(cfg, secret, ['row1', 'row3'])).size, 0, 'phone sees them delivered');
    assert.strictEqual((await R.pull(cfg, secret)).dreams.length, 0);
    assert.ok(db.nodes.some(x => x.name === 'Dragon') && db.nodes.some(x => x.name === 'Kitchen'));
  });
  await t('newer sb_publishable_ keys are not sent as a login token', async () => {
    let seen; global.fetch = async (u, o) => { seen = o.headers; return { ok: true, status: 200, text: async () => '[]' }; };
    await R.pull({ url: cfg.url, key: 'sb_publishable_abc' }, R.newSecret());
    assert.strictEqual(seen.apikey, 'sb_publishable_abc'); assert.ok(!seen.Authorization);
    await R.pull({ url: cfg.url, key: 'eyJabc' }, R.newSecret());
    assert.strictEqual(seen.Authorization, 'Bearer eyJabc');
  });
  await t('clear messages when the cloud is wrong', async () => {
    await assert.rejects(R.pull({ url: '', key: '' }, 's'), /not set up/);
    global.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(R.pull(cfg, 's'), /setup\.sql/);
    global.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(R.pull(cfg, 's'), /Could not reach/);
  });

  console.log('pairing code');
  await t('QR generator handles a full pairing link', () => {
    const q = QR.encode('https://royal-road.netlify.app/#pair=' + 'A'.repeat(400));
    assert.ok(q.size >= 57 && q.dark(0, 0) && !q.dark(1, 1) && q.dark(3, 3));
  });
  console.log('\n' + n + ' checks passed');
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
