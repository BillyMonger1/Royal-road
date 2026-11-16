/* The Royal Road — dream engine.
   Pure data logic: no DOM, no network. Runs in the app and in Node (tests).

   Database shape (kept deliberately small):
     dreams: [{ id, title, date, text, summary, by, images? }]   by = "ai" | "local"; images = [{ id, from, prompt? }]
     nodes:  [{ id, key, name, type }]                     type = theme|archetype|character|place|symbol
     links:  [[dreamId, nodeId, weight]]                   weight 0.15 – 1
   Everything else (node size, resonance between dreams) is derived on demand. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = ['dream', 'theme', 'archetype', 'character', 'place', 'symbol'];
  const THREAD_TYPES = TYPES.slice(1);
  const MAX_THREADS = 14;

  function emptyDb() { return { v: 1, dreams: [], nodes: [], links: [] }; }

  function uid(prefix) {
    const r = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('')
      : Math.random().toString(36).slice(2, 14);
    return prefix + r.slice(0, 10);
  }

  /* Canonical key: how two differently written names are recognised as one thread. */
  function canon(name) {
    let s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    s = s.replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(the|a|an|my|our)\s+/, '');
    const words = s.split(' ');
    let last = words[words.length - 1] || '';
    if (last.length > 4 && /ies$/.test(last)) last = last.slice(0, -3) + 'y';
    else if (last.length > 3 && /[^su]s$/.test(last) && !/(is|ss)$/.test(last)) last = last.slice(0, -1);
    words[words.length - 1] = last;
    return words.join(' ');
  }

  function tidyName(name, type) {
    let s = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!s) return '';
    s = s.charAt(0).toUpperCase() + s.slice(1);
    if (type === 'archetype' && !/^the\s/i.test(s)) s = 'The ' + s;
    return s;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function normaliseAnalysis(a) {
    const out = { title: '', summary: '', entities: [] };
    if (!a || typeof a !== 'object') return out;
    out.title = String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    out.summary = String(a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (typeof a.text === 'string') out.text = a.text.trim();
    const seen = new Map();
    for (const e of Array.isArray(a.entities) ? a.entities : []) {
      if (!e) continue;
      const type = THREAD_TYPES.includes(e.type) ? e.type : 'symbol';
      const name = tidyName(e.name, type);
      const key = canon(name);
      if (!key) continue;
      let sal = Number(e.salience);
      if (!isFinite(sal)) sal = 0.5;
      sal = Math.round(clamp(sal, 0.15, 1) * 100) / 100;
      const prev = seen.get(key);
      if (!prev || prev.salience < sal) seen.set(key, { name, type, salience: sal, key });
    }
    out.entities = [...seen.values()].sort((x, y) => y.salience - x.salience).slice(0, MAX_THREADS);
    return out;
  }

  /* Add an analysed dream to the graph. Existing threads are reused, new ones are created. */
  function ingest(db, dream, analysis) {
    const a = normaliseAnalysis(analysis);
    const existing = db.dreams.find(d => d.id === (dream.id || ''));
    // A name the person gave the dream is kept; otherwise the analysis names it.
    const named = dream.titled || (dream.titled === undefined && existing && existing.titled);
    const ownTitle = dream.titled ? dream.title : existing && existing.title;
    const rec = {
      id: dream.id || uid('d'),
      title: named && ownTitle ? String(ownTitle).slice(0, 80) : (a.title || fallbackTitle(dream.text)),
      date: dream.date || new Date().toISOString(),
      text: String(dream.text || '').trim(),
      summary: a.summary,
      by: dream.by || 'local'
    };
    if (named && ownTitle) rec.titled = true;
    const images = Array.isArray(dream.images) ? dream.images : existing && existing.images;
    if (images && images.length) rec.images = images.filter(i => i && typeof i.id === 'string').slice(0, 40);
    if (existing) removeDream(db, rec.id);
    const byKey = new Map(db.nodes.map(n => [n.key, n]));
    const created = [], titleKey = canon(rec.title);
    for (const e of a.entities) {
      let node = byKey.get(e.key);
      if (!node && e.key === titleKey) continue;     // would just repeat the dream's own name
      if (!node) {
        node = { id: uid('n'), key: e.key, name: e.name, type: e.type };
        db.nodes.push(node); byKey.set(e.key, node); created.push(node);
      }
      db.links.push([rec.id, node.id, e.salience]);
    }
    db.dreams.push(rec);
    db.dreams.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
    return { dream: rec, created };
  }

  function pruneOrphans(db) {
    const used = new Set(db.links.map(l => l[1]));
    db.nodes = db.nodes.filter(n => used.has(n.id));
  }

  /* Returns the picture ids the dream had, so their files can be removed too. */
  function removeDream(db, dreamId) {
    const gone = db.dreams.find(d => d.id === dreamId);
    db.dreams = db.dreams.filter(d => d.id !== dreamId);
    db.links = db.links.filter(l => l[0] !== dreamId);
    pruneOrphans(db);
    return gone && gone.images ? gone.images.map(i => i.id) : [];
  }

  /* Add a thread by hand. An existing thread with the same name is reused, so the dream links up. */
  function addThread(db, dreamId, name, type) {
    type = THREAD_TYPES.includes(type) ? type : 'symbol';
    const clean = tidyName(name, type), key = canon(clean);
    if (!key || !db.dreams.some(d => d.id === dreamId)) return null;
    let node = db.nodes.find(n => n.key === key);
    if (!node) { node = { id: uid('n'), key, name: clean, type }; db.nodes.push(node); }
    if (!db.links.some(l => l[0] === dreamId && l[1] === node.id)) db.links.push([dreamId, node.id, 0.7]);
    return node;
  }

  function unlink(db, dreamId, nodeId) {
    db.links = db.links.filter(l => !(l[0] === dreamId && l[1] === nodeId));
    pruneOrphans(db);
  }

  /* Per-node connection count and summed weight. This is what makes nodes grow. */
  function stats(db) {
    const m = new Map();
    const bump = (id, w) => {
      const s = m.get(id) || { deg: 0, weight: 0 };
      s.deg += 1; s.weight += w; m.set(id, s);
    };
    for (const [d, n, w] of db.links) { bump(d, w); bump(n, w); }
    return m;
  }

  /* Radius in graph units. Square root keeps heavily shared threads large but not absurd. */
  function nodeRadius(type, s) {
    const w = s ? s.weight : 0;
    return type === 'dream' ? 6.5 + 1.5 * Math.sqrt(w) : 2.1 + 3.3 * Math.sqrt(Math.max(0, w - 0.3));
  }

  /* Dreams that share threads with this one. A thread shared by few dreams counts for
     more than one that appears everywhere (inverse document frequency). */
  function resonance(db, dreamId, limit) {
    const mine = new Map();
    const df = new Map();
    for (const [d, n, w] of db.links) {
      df.set(n, (df.get(n) || 0) + 1);
      if (d === dreamId) mine.set(n, w);
    }
    const N = Math.max(1, db.dreams.length);
    const scores = new Map();
    for (const [d, n, w] of db.links) {
      if (d === dreamId || !mine.has(n)) continue;
      const idf = Math.log(1 + N / df.get(n));
      const s = scores.get(d) || { id: d, score: 0, shared: [] };
      s.score += mine.get(n) * w * idf; s.shared.push(n);
      scores.set(d, s);
    }
    return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit || 5);
  }

  function threadsOf(db, dreamId) {
    const byId = new Map(db.nodes.map(n => [n.id, n]));
    return db.links.filter(l => l[0] === dreamId)
      .map(l => ({ node: byId.get(l[1]), weight: l[2] }))
      .filter(t => t.node).sort((a, b) => b.weight - a.weight);
  }

  function dreamsOf(db, nodeId) {
    const byId = new Map(db.dreams.map(d => [d.id, d]));
    return db.links.filter(l => l[1] === nodeId)
      .map(l => ({ dream: byId.get(l[0]), weight: l[2] }))
      .filter(t => t.dream).sort((a, b) => (a.dream.date < b.dream.date ? 1 : -1));
  }

  function fallbackTitle(text) {
    const first = String(text || '').trim().split(/(?<=[.!?])\s|\n/)[0] || 'Untitled dream';
    const words = first.replace(/[.!?,;:]+$/, '').split(/\s+/);
    const t = words.slice(0, 6).join(' ');
    return (t.charAt(0).toUpperCase() + t.slice(1)) + (words.length > 6 ? '…' : '');
  }

  /* Accept the AI's punctuated version only if every word is the same, in the same order.
     Spoken transcripts arrive without punctuation; this makes them readable without letting the AI edit the dream. */
  function tidyText(raw, punctuated) {
    if (typeof punctuated !== 'string' || !punctuated.trim()) return raw;
    const words = t => String(t).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean).join(' ');
    return words(raw) === words(punctuated) ? punctuated.trim() : raw;
  }

  /* ---------- Built-in analysis (no AI needed) ----------
     A small lexicon pass so the engine works offline and before an AI is connected. */
  const LEX = {
    archetype: [
      ['The Shadow', /\b(shadow\w*|dark figure|stranger|intruder|monster|demon|pursuer|creature|parasite)\b/g],
      ['The Mother', /\b(mother|mum|mom|mama)\b/g],
      ['The Father', /\b(father|dad|papa)\b/g],
      ['The Child', /\b(child|children|baby|infant|little (?:boy|girl)|kid)\b/g],
      ['The Elder', /\b(old (?:man|woman)|elder|wizard|sage|grand(?:mother|father|ma|pa))\b/g],
      ['The Trickster', /\b(clown|joker|trickster|jester|fox)\b/g],
      ['The Warrior', /\b(fight\w*|fought|battle|sword|warrior|soldier|weapon)\b/g],
      ['The Beloved', /\b(kiss\w*|lover|girlfriend|boyfriend|wife|husband|crush|beloved)\b/g],
      ['The Healer', /\b(doctor|nurse|heal\w*|medicine|surgeon)\b/g],
      ['The Judge', /\b(judge|court|trial|police|verdict|jury)\b/g],
      ['The Ruler', /\b(king|queen|throne|crown|emperor|royal)\b/g],
      ['The Seeker', /\b(search\w*|looking for|journey|quest|path|wander\w*)\b/g],
      ['The Creator', /\b(paint\w*|draw\w*|sculpt\w*|compos\w*|invent\w*|craft\w*)\b/g],
      ['The Threshold Guardian', /\b(guard\w*|gatekeeper|bouncer|sentry)\b/g]
    ],
    theme: [
      ['Loss of control', /\b(fall\w*|fell|slipp\w*|crash\w*|brakes?)\b/g],
      ['Escape', /\b(chas\w*|running from|escap\w*|flee\w*|fled|hid(?:e|ing))\b/g],
      ['Exposure', /\b(naked|exposed|embarrass\w*|humiliat\w*|everyone (?:was )?watching)\b/g],
      ['Unreadiness', /\b(exam|test|late|unprepared|forgot\w*|missed)\b/g],
      ['Decay', /\b(rot\w*|decay\w*|mould|mold|crumbl\w*|teeth)\b/g],
      ['Freedom', /\b(fly\w*|flew|float\w*|soar\w*|weightless)\b/g],
      ['Endings', /\b(death|dying|dead|died|funeral|grave|corpse)\b/g],
      ['Overwhelm', /\b(flood\w*|drown\w*|wave|tsunami|sinking|swallow\w*)\b/g],
      ['Purification', /\b(clean\w*|wash\w*|purif\w*|scrub\w*|bath\w*)\b/g],
      ['Hidden knowledge', /\b(secret\w*|hidden|buried|locked away|decipher\w*|booklet|diagram)\b/g],
      ['Transformation', /\b(transform\w*|turn(?:ed|ing) into|became|becoming|chang\w* shape|melt\w*)\b/g],
      ['Entrapment', /\b(trapp\w*|stuck|cage\w*|locked in|unable to (?:move|walk)|paraly\w*)\b/g],
      ['Guilt', /\b(guilt\w*|asham\w*|shame|blame\w*|sorry)\b/g],
      ['Family system', /\b(family|sibling|brother|sister|parents?)\b/g],
      ['Anger', /\b(anger|angry|rage|furious|scream\w*|shout\w*)\b/g],
      ['Fear', /\b(fear|afraid|terrif\w*|scared|dread|panic\w*)\b/g],
      ['Vocation', /\b(work|job|boss|career|office|refinery|factory)\b/g],
      ['Renewal', /\b(reborn|renew\w*|spring|bloom\w*|dawn|fountain)\b/g],
      ['Loss of innocence', /\b(childhood|innocen\w*|school(?:yard)?|playground)\b/g]
    ],
    place: ['house', 'home', 'school', 'kitchen', 'bedroom', 'bathroom', 'garden', 'forest', 'beach', 'ocean', 'sea',
      'city', 'street', 'church', 'hospital', 'office', 'basement', 'attic', 'mountain', 'river', 'lake', 'bridge',
      'cave', 'castle', 'tower', 'shop', 'airport', 'hotel', 'classroom', 'field', 'desert', 'island', 'corridor',
      'hallway', 'staircase', 'elevator', 'library', 'park', 'farm', 'manor', 'refinery', 'labyrinth', 'station',
      'underworld', 'village', 'cliff', 'temple', 'pool'],
    symbol: ['snake', 'dog', 'cat', 'bird', 'horse', 'wolf', 'spider', 'fish', 'worm', 'dragon', 'frog', 'butterfly',
      'bear', 'lion', 'rat', 'door', 'key', 'mirror', 'window', 'fire', 'water', 'moon', 'sun', 'tree', 'flower',
      'blood', 'knife', 'gun', 'sword', 'phone', 'book', 'clock', 'ring', 'mask', 'egg', 'ladder', 'wall', 'box',
      'car', 'boat', 'plane', 'train', 'light', 'storm', 'rain', 'snow', 'stone', 'gold', 'money', 'crown', 'wound',
      'ghost', 'fence', 'locker', 'staff', 'hoof', 'hooves', 'mouth', 'eye', 'hand', 'rope', 'thread', 'yarn',
      'beanstalk', 'chimera', 'clothing', 'jewel', 'fountain', 'weapon', 'path', 'road', 'stairs', 'letter']
  };
  const NOT_NAMES = new Set(('i im ive id the a an and but then when there it he she they we my this that so in on at ' +
    'after before suddenly monday tuesday wednesday thursday friday saturday sunday january february march april may ' +
    'june july august september october november december god english australia sydney christmas lsd bpd').split(' '));

  function localAnalyze(text, db) {
    const raw = String(text || '');
    const lower = ' ' + raw.toLowerCase() + ' ';
    const found = [];
    const add = (name, type, count, firstAt) => {
      if (!count) return;
      const early = 1 - clamp(firstAt / Math.max(1, lower.length), 0, 1);
      found.push({ name, type, salience: clamp(0.34 + 0.16 * count + 0.14 * early, 0.2, 1) });
    };
    for (const type of ['archetype', 'theme']) {
      for (const [name, re] of LEX[type]) {
        re.lastIndex = 0; let m, c = 0, at = -1;
        while ((m = re.exec(lower))) { c++; if (at < 0) at = m.index; }
        add(name, type, c, at);
      }
    }
    for (const type of ['place', 'symbol']) {
      for (const w of LEX[type]) {
        const re = new RegExp('\\b' + w + '(?:s|es)?\\b', 'g'); let m, c = 0, at = -1;
        while ((m = re.exec(lower))) { c++; if (at < 0) at = m.index; }
        add(w === 'hooves' ? 'Hoof' : w, type, c, at);
      }
    }
    // People: capitalised words that are not sentence starters.
    const names = new Map();
    const reName = /(^|[.!?]\s+|\n\s*)?\b([A-Z][a-z]{2,})\b/g; let m;
    while ((m = reName.exec(raw))) {
      const starts = m[1] !== undefined; const w = m[2];
      if (NOT_NAMES.has(w.toLowerCase())) continue;
      const n = names.get(w) || { c: 0, mid: 0, at: m.index };
      n.c++; if (!starts) n.mid++; names.set(w, n);
    }
    for (const [w, n] of names) if (n.mid > 0) add(w, 'character', n.c, n.at);
    // Anything the journal already knows about gets recognised again.
    if (db) for (const node of db.nodes) {
      if (node.key.length < 3) continue;
      const esc = node.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('\\b' + esc + '(?:s|es)?\\b').test(lower.replace(/[^a-z0-9\s'-]/g, ' '))) found.push({ name: node.name, type: node.type, salience: 0.5 });
    }
    const first = raw.trim().split(/(?<=[.!?])\s/)[0] || '';
    return normaliseAnalysis({
      title: fallbackTitle(raw),
      summary: first.length > 200 ? first.slice(0, 197) + '…' : first,
      entities: found
    });
  }

  /* ---------- AI analysis: prompt and parser ---------- */
  function analysisPrompt(text, db) {
    const s = stats(db);
    const known = db.nodes.map(n => ({ n, w: (s.get(n.id) || {}).weight || 0 }))
      .sort((a, b) => b.w - a.w).slice(0, 160).map(x => x.n.name + ' (' + x.n.type + ')').join('; ');
    const system =
      'You index dreams for a personal dream journal that draws a graph of recurring material. ' +
      'Read the dream and reply with one JSON object and nothing else:\n' +
      '{"title": string, "summary": string, "text": string, "entities": [{"name": string, "type": string, "salience": number}]}\n' +
      'Rules:\n' +
      '- title: 2 to 5 words, concrete, taken from the dream\'s strongest image. No quotes, no date.\n' +
      '- summary: one plain sentence saying what happens.\n' +
      '- entities: 6 to 14 items. type is exactly one of: theme, archetype, character, place, symbol.\n' +
      '  theme = the psychological subject (e.g. "Shadow integration", "Escape"). ' +
      'archetype = a Jungian figure, named "The ..." (e.g. "The Shadow"). ' +
      'character = a named or specific person. place = a location. symbol = a notable object, animal or image.\n' +
      '- name: 1 to 3 words, singular, Title Case.\n' +
      '- salience: 0.2 to 1.0, how central this is to the dream.\n' +
      '- The journal already contains the threads listed by the user. When the dream contains the same thing, ' +
      'use the existing name exactly so the dreams link up. Only invent a new name when nothing fits.\n' +
      '- Index only what is in the dream. Do not interpret beyond the theme and archetype entries.\n' +
      '- text: the dream exactly as given, with punctuation, capital letters and paragraph breaks added so it reads well. ' +
      'Do not add, remove, reorder or change any word.';
    const user = 'Existing threads: ' + (known || '(none yet)') + '\n\nDream:\n' + String(text).slice(0, 12000);
    return { system, user };
  }

  function parseAnalysis(raw) {
    const s = String(raw || '');
    const start = s.indexOf('{'); const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The AI reply was not JSON.');
    let obj;
    try { obj = JSON.parse(s.slice(start, end + 1)); }
    catch (e) { throw new Error('The AI reply was not valid JSON.'); }
    const a = normaliseAnalysis(obj);
    if (!a.entities.length) throw new Error('The AI reply contained no threads.');
    return a;
  }

  /* Context handed to the chat model: the dream in focus plus the shape of the journal. */
  function chatContext(db, focusDreamId) {
    const s = stats(db);
    const top = db.nodes.map(n => ({ n, st: s.get(n.id) || { deg: 0 } }))
      .sort((a, b) => b.st.deg - a.st.deg).slice(0, 30)
      .map(x => x.n.name + ' [' + x.n.type + ', ' + x.st.deg + ' dreams]').join('; ');
    const list = db.dreams.slice(0, 40).map(d =>
      '- ' + d.date.slice(0, 10) + ' "' + d.title + '": ' + (d.summary || d.text.slice(0, 160))).join('\n');
    let focus = '';
    const d = db.dreams.find(x => x.id === focusDreamId);
    if (d) {
      focus = '\n\nThe dream currently open is "' + d.title + '" (' + d.date.slice(0, 10) + '):\n' + d.text.slice(0, 6000) +
        '\nIts threads: ' + threadsOf(db, d.id).map(t => t.node.name).join(', ');
      const rel = resonance(db, d.id, 4).map(r => {
        const o = db.dreams.find(x => x.id === r.id); return o ? '"' + o.title + '"' : '';
      }).filter(Boolean).join(', ');
      if (rel) focus += '\nIt shares the most material with: ' + rel;
    }
    return 'You are a thoughtful companion for exploring a personal dream journal, informed by Jungian ideas. ' +
      'Speak plainly and briefly. Offer interpretations as possibilities, tie them to specific images from the dreams, ' +
      'and point out patterns across dreams when you see them. You are not a therapist and do not diagnose.\n\n' +
      'Journal overview: ' + db.dreams.length + ' dreams.\nMost recurring threads: ' + (top || 'none yet') +
      '\n\nRecent dreams:\n' + (list || '(none)') + focus;
  }

  return {
    TYPES, THREAD_TYPES, emptyDb, uid, canon, ingest, removeDream, unlink, addThread, stats, nodeRadius,
    resonance, threadsOf, dreamsOf, localAnalyze, tidyText, analysisPrompt, parseAnalysis, chatContext, fallbackTitle
  };
});
