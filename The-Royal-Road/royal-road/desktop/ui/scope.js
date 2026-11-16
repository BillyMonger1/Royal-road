/* The Royal Road — the cathode-ray tube.
   Draws the dream graph as a phosphor trace with real depth: nodes sit at different
   distances behind the glass, the graticule is printed on the glass, and the two
   slide against each other as the eye (the pointer) moves, as on a real scope. */
(function () {
  'use strict';

  /* Royal palette: gold dreams on violet glass. Each kind keeps its own clear hue. */
  const COLORS = {
    dream: [255, 200, 92], theme: [178, 140, 255], archetype: [255, 236, 170],
    character: [255, 128, 172], place: [110, 214, 255], symbol: [212, 200, 240]
  };
  const BEAM = [200, 170, 255];      // links and graticule: lilac
  const SWEEP = [255, 206, 110];     // the timebase trace: gold
  const TUBE = [11, 8, 22];
  const FADE = 0.42;               // how much of the last frame the phosphor forgets
  const CAM = 920;                 // eye distance from the middle of the tube, graph units
  const FONT = '"Segoe UI Variable Display", "Segoe UI", "Inter", system-ui, sans-serif';

  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; }

  function makeSprite(c) {
    const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const g = cv.getContext('2d'), grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.07, rgba(c.map(v => Math.round(v + (255 - v) * 0.6)), 0.98));
    grad.addColorStop(0.15, rgba(c, 0.62));
    grad.addColorStop(0.34, rgba(c, 0.17));
    grad.addColorStop(0.62, rgba(c, 0.045));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    return cv;
  }

  /* The settled layout is remembered on this computer, so the picture opens exactly as it was left. */
  function loadLayout() { try { return JSON.parse(localStorage.getItem('rr.layout')) || null; } catch (e) { return null; } }
  function saveLayout(nodes) {
    const o = {}; for (const n of nodes) o[n.id] = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
    try { localStorage.setItem('rr.layout', JSON.stringify(o)); } catch (e) { /* layout is only a convenience */ }
  }

  class Scope {
    constructor(host) {
      this.host = host;
      this.trace = host.querySelector('.trace');
      this.grat = host.querySelector('.graticule');
      this.ctx = this.trace.getContext('2d', { alpha: false });
      this.nodes = []; this.links = []; this.byId = new Map(); this.adj = new Map();
      this.timeline = [];
      this.sprites = {}; for (const t in COLORS) this.sprites[t] = makeSprite(COLORS[t]);
      this.hidden = new Set();
      this.knobs = { scale: 1, intensity: 1, depth: 1 };
      this.yaw = 0; this.pitch = 0; this.eyeX = 0; this.eyeY = 0; this.eyeTX = 0; this.eyeTY = 0;
      this.alpha = 0; this.fit = 1; this.panX = 0; this.panY = 0; this.selected = null; this.hover = null;
      this.onSelect = () => {}; this.counts = { dreams: 0, threads: 0, links: 0 };
      this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.t0 = performance.now();
      this._bind();
      new ResizeObserver(() => this.resize()).observe(host);
      this.resize();
      requestAnimationFrame(t => this._frame(t));
    }

    /* ----- data ----- */
    setData(db, Engine) {
      const stats = Engine.stats(db), old = this.byId, now = performance.now();
      const nodes = [], byId = new Map(), adj = new Map();
      const first = old.size === 0;
      const cache = first ? loadLayout() : null; let fresh = 0, cached = 0;
      const add = (id, type, name, date) => {
        const s = stats.get(id) || { deg: 0, weight: 0 };
        let n = old.get(id);
        if (!n) {
          const c = cache && cache[id];
          n = { id, x: c ? c[0] : NaN, y: c ? c[1] : 0, z: c ? c[2] : 0, vx: 0, vy: 0, vz: 0, born: first ? 0 : now };
          if (c) cached++; else fresh++;
        }
        n.type = type; n.name = name; n.date = date; n.deg = s.deg; n.weight = s.weight;
        n.r = Engine.nodeRadius(type, s);
        nodes.push(n); byId.set(id, n); adj.set(id, new Set());
      };
      for (const d of db.dreams) add(d.id, 'dream', d.title, d.date);
      for (const n of db.nodes) add(n.id, n.type, n.name);
      const links = [];
      for (const [a, b, w] of db.links) {
        const s = byId.get(a), t = byId.get(b); if (!s || !t) continue;
        links.push({ s, t, w }); adj.get(a).add(b); adj.get(b).add(a);
      }
      // New nodes appear beside whatever they connect to, so the picture grows rather than jumps.
      for (const n of nodes) {
        if (!isNaN(n.x)) continue;
        let anchor = null;
        for (const id of adj.get(n.id)) { const o = byId.get(id); if (o && !isNaN(o.x)) { anchor = o; break; } }
        const a = hash(n.id) * Math.PI * 2, b = hash(n.id + 'z') * 2 - 1, rad = anchor ? 40 : 60 + 240 * hash(n.id + 'r');
        n.x = (anchor ? anchor.x : 0) + Math.cos(a) * rad; n.y = (anchor ? anchor.y : 0) + Math.sin(a) * rad * 0.8;
        n.z = (anchor ? anchor.z : 0) + b * rad * 0.8;
      }
      this.nodes = nodes; this.links = links; this.byId = byId; this.adj = adj;
      this.counts = { dreams: db.dreams.length, threads: db.nodes.length, links: db.links.length };
      this.timeline = db.dreams.map(d => ({ id: d.id, t: Date.parse(d.date) || 0, w: (stats.get(d.id) || { weight: 1 }).weight }))
        .sort((p, q) => p.t - q.t);
      if (this.selected && !byId.has(this.selected)) this.selected = null;
      this.hover = null;
      // A remembered layout only needs settling; a new node needs room; an edit only needs a nudge.
      if (first) this.alpha = cached > nodes.length * 0.8 ? 0.2 : 1;
      else this.alpha = Math.max(this.alpha, fresh ? (nodes.length > 450 ? 0.22 : 0.5) : 0.08);
      if (first) {
        const until = performance.now() + 140;           // never block the window for long
        for (let i = 0; i < 320 && performance.now() < until; i++) this._tick();
        this.fit = this._fitTarget();
      }
      this.saved = false;
      this.host.classList.toggle('no-signal', nodes.length === 0);
    }

    setFilter(type, on) { if (on) this.hidden.delete(type); else this.hidden.add(type); }
    setKnob(name, v) { this.knobs[name] = v; }
    select(id, quiet) {
      this.selected = id && this.byId.has(id) ? id : null;
      if (!quiet) this.onSelect(this.selected ? this.byId.get(this.selected) : null);
    }
    resetView() { this.yaw = 0; this.pitch = 0; this.panX = 0; this.panY = 0; }

    /* ----- physics: repulsion between all nodes, springs along links, a pull to the middle ----- */
    _tick() {
      const N = this.nodes, a = this.alpha, n = N.length;
      const push = (p, q) => {
        let dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1) { dx = hash(p.id + q.id) - 0.5; dy = hash(q.id + p.id) - 0.5; dz = 0.3; d2 = 1; }
        const f = Math.min(6, (1500 + 60 * (p.r + q.r)) / d2) * a, d = Math.sqrt(d2);
        dx = dx / d * f; dy = dy / d * f; dz = dz / d * f;
        p.vx += dx; p.vy += dy; p.vz += dz; q.vx -= dx; q.vy -= dy; q.vz -= dz;
      };
      if (n <= 450) {
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) push(N[i], N[j]);
      } else {
        // Large journals: only nearby nodes push each other (a 3D grid), so each step stays cheap.
        const C = 85, grid = new Map(), key = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
        for (let i = 0; i < n; i++) {
          const p = N[i]; p.gx = Math.floor(p.x / C); p.gy = Math.floor(p.y / C); p.gz = Math.floor(p.z / C); p.gi = i;
          const k = key(p.gx, p.gy, p.gz); let cell = grid.get(k); if (!cell) grid.set(k, cell = []); cell.push(p);
        }
        for (const p of N) for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
          const cell = grid.get(key(p.gx + x, p.gy + y, p.gz + z)); if (!cell) continue;
          for (const q of cell) if (q.gi > p.gi) push(p, q);
        }
      }
      for (const l of this.links) {
        const s = l.s, t = l.t;
        const dx = t.x - s.x, dy = t.y - s.y, dz = t.z - s.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const rest = 30 + s.r + t.r + (1 - l.w) * 26;
        const k = (d - rest) / d * 0.5 * a / Math.sqrt(Math.min(s.deg, t.deg) || 1);
        const bias = s.deg / (s.deg + t.deg || 1);
        s.vx += dx * k * (1 - bias); s.vy += dy * k * (1 - bias); s.vz += dz * k * (1 - bias);
        t.vx -= dx * k * bias; t.vy -= dy * k * bias; t.vz -= dz * k * bias;
      }
      for (const p of N) {
        p.vx -= p.x * 0.011 * a; p.vy -= p.y * 0.016 * a; p.vz -= p.z * 0.026 * a;
        p.vx *= 0.62; p.vy *= 0.62; p.vz *= 0.62;
        p.x += p.vx; p.y += p.vy; p.z += p.vz;
      }
      this.alpha = a < 0.004 ? 0 : a * 0.988;
      if (this.alpha === 0 && !this.saved) { this.saved = true; saveLayout(this.nodes); }
    }

    /* How much to magnify so the whole graph fills the screen, whatever its size. */
    _fitTarget() {
      const n = this.nodes.length; if (!n) return 1;
      const xs = this.nodes.map(p => Math.max(Math.abs(p.x), Math.abs(p.z) * 0.7) + p.r).sort((a, b) => a - b);
      const ys = this.nodes.map(p => Math.abs(p.y) + p.r).sort((a, b) => a - b);
      const q = a => a[Math.min(n - 1, Math.floor(n * 0.96))] || 1;
      return Math.max(0.5, Math.min(5, Math.min(this.w * 0.43 / q(xs), this.h * 0.36 / q(ys))));
    }

    /* ----- layout of the canvas ----- */
    resize() {
      const r = this.host.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = Math.max(10, r.width); this.h = Math.max(10, r.height); this.dpr = dpr;
      for (const cv of [this.trace, this.grat]) { cv.width = Math.round(this.w * dpr); cv.height = Math.round(this.h * dpr); }
      this.ctx.fillStyle = 'rgb(' + TUBE.join(',') + ')'; this.ctx.fillRect(0, 0, this.trace.width, this.trace.height);
      this._graticule();
    }

    /* The graticule: 10 by 8 divisions, with fine ticks on the centre axes. Drawn once. */
    _graticule() {
      const g = this.grat.getContext('2d'), d = this.dpr, W = this.w * d, H = this.h * d;
      g.clearRect(0, 0, W, H);
      const m = 0.045, x0 = W * m, x1 = W * (1 - m), y0 = H * 0.06, y1 = H * 0.86;
      const dx = (x1 - x0) / 10, dy = (y1 - y0) / 8;
      this.plot = { x0: x0 / d, x1: x1 / d, y0: y0 / d, y1: y1 / d };
      // A quiet dotted grid: a dot every fifth of a division, a small cross where divisions meet.
      g.fillStyle = 'rgba(200,170,255,0.16)';
      const dot = Math.max(1, d * 0.9);
      for (let i = 0; i <= 10; i++) for (let k = 0; k <= 40; k++) g.fillRect(Math.round(x0 + i * dx) - dot / 2, y0 + k * dy / 5 - dot / 2, dot, dot);
      for (let j = 0; j <= 8; j++) for (let k = 0; k <= 50; k++) g.fillRect(x0 + k * dx / 5 - dot / 2, Math.round(y0 + j * dy) - dot / 2, dot, dot);
      g.strokeStyle = 'rgba(210,185,255,0.30)'; g.lineWidth = Math.max(1, d * 0.8); g.beginPath();
      const arm = 4 * d;
      for (let i = 0; i <= 10; i++) for (let j = 0; j <= 8; j++) {
        const x = Math.round(x0 + i * dx) + 0.5, y = Math.round(y0 + j * dy) + 0.5;
        g.moveTo(x - arm, y); g.lineTo(x + arm, y); g.moveTo(x, y - arm); g.lineTo(x, y + arm);
      }
      const cx = Math.round(x0 + 5 * dx) + 0.5, cy = Math.round(y0 + 4 * dy) + 0.5, tk = 2.6 * d;
      for (let i = 0; i <= 50; i++) { const x = x0 + i * dx / 5; g.moveTo(x, cy - tk); g.lineTo(x, cy + tk); }
      for (let j = 0; j <= 40; j++) { const y = y0 + j * dy / 5; g.moveTo(cx - tk, y); g.lineTo(cx + tk, y); }
      g.stroke();
    }

    /* ----- pointer ----- */
    _bind() {
      const el = this.host; let drag = null;
      const pos = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      el.addEventListener('pointermove', e => {
        const [x, y] = pos(e);
        this.eyeTX = (x / this.w) * 2 - 1; this.eyeTY = (y / this.h) * 2 - 1;
        if (drag) {
          const mx = e.clientX - drag.x, my = e.clientY - drag.y;
          if (Math.abs(mx) + Math.abs(my) > 4) drag.moved = true;
          if (drag.pan) { this.panX = drag.px + mx; this.panY = drag.py + my; }
          else { this.yaw = drag.yaw + mx * 0.006; this.pitch = Math.max(-1.1, Math.min(1.1, drag.pitch + my * 0.005)); }
        } else {
          const h = this._pick(x, y); this.hover = h ? h.id : null;
          el.style.cursor = h ? 'pointer' : 'grab';
        }
      });
      el.addEventListener('pointerleave', () => { this.eyeTX = 0; this.eyeTY = 0; this.hover = null; });
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0 && e.button !== 2) return;
        // Drag turns the graph. Right-drag or Shift-drag slides it.
        drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, px: this.panX, py: this.panY, pan: e.button === 2 || e.shiftKey, moved: false };
        el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing';
      });
      el.addEventListener('pointerup', e => {
        if (!drag) return;
        const moved = drag.moved; drag = null; el.style.cursor = 'grab';
        if (!moved && e.button === 0) { const [x, y] = pos(e); const h = this._pick(x, y); this.select(h ? h.id : null); }
      });
      el.addEventListener('pointercancel', () => { drag = null; });
      el.addEventListener('contextmenu', e => e.preventDefault());
      el.addEventListener('dblclick', () => this.resetView());
      el.addEventListener('wheel', e => {
        e.preventDefault();
        const old = this.knobs.scale, v = Math.max(0.4, Math.min(4, old * Math.exp(-e.deltaY * 0.0012)));
        // Zoom toward the pointer: the point under it stays put.
        const [x, y] = pos(e), cx = this.w / 2 + this.panX, cy = this.h * 0.46 + this.panY, k = v / old;
        this.panX += (x - cx) * (1 - k); this.panY += (y - cy) * (1 - k);
        this.knobs.scale = v; if (this.onScale) this.onScale(v);
      }, { passive: false });
    }

    _pick(x, y) {
      let best = null, bd = Infinity;
      for (const n of this.nodes) {
        if (!n.vis) continue;
        const d = Math.hypot(n.sx - x, n.sy - y), reach = Math.max(n.sr + 5, 11);
        if (d < reach && d - n.sr * 0.5 < bd) { bd = d - n.sr * 0.5; best = n; }
      }
      return best;
    }

    /* ----- one frame ----- */
    _frame(now) {
      requestAnimationFrame(t => this._frame(t));
      if (document.hidden) return;
      // In the background the screen keeps glowing, at a tenth of the work.
      if (!document.hasFocus() && this.alpha === 0) { this._skip = (this._skip || 0) + 1; if (this._skip % 6) return; }
      // Very large journals settle on every other frame so the screen stays smooth.
      this._f = (this._f || 0) + 1;
      if (this.alpha > 0 && (this.nodes.length < 800 || this._f % 2)) this._tick();
      const ctx = this.ctx, d = this.dpr, W = this.w, H = this.h, K = this.knobs;
      const time = (now - this.t0) / 1000;
      this.eyeX += (this.eyeTX - this.eyeX) * 0.06; this.eyeY += (this.eyeTY - this.eyeY) * 0.06;
      const drift = this.still ? 0 : Math.sin(time / 11) * 0.07;
      const yaw = this.yaw + drift + this.eyeX * 0.2 * K.depth, pitch = this.pitch + this.eyeY * 0.13 * K.depth;
      // The graticule sits on the glass, in front of the trace, so it shifts the other way.
      this.grat.style.transform = 'translate(' + (-this.eyeX * 7 * K.depth).toFixed(2) + 'px,' + (-this.eyeY * 5 * K.depth).toFixed(2) + 'px)';

      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(' + TUBE.join(',') + ',' + FADE + ')'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';

      const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      if (this.alpha > 0 || Math.abs(this._fw - W) > 1) { this._ft = this._fitTarget(); this._fw = W; }
      this.fit += ((this._ft || this.fit) - this.fit) * 0.08;
      const cx = W / 2 + this.panX, cyc = H * 0.46 + this.panY, unit = this.fit * K.scale, zk = 0.25 + 0.75 * K.depth;
      const sel = this.selected, near = sel ? this.adj.get(sel) : null;
      const gain = K.intensity * FADE;

      // Keep the picture centred on the graph's own middle, eased so it never jumps.
      let mx = 0, my = 0, mz = 0; const cnt = this.nodes.length || 1;
      for (const n of this.nodes) { mx += n.x; my += n.y; mz += n.z; }
      const c0 = this.mid || (this.mid = { x: mx / cnt, y: my / cnt, z: mz / cnt });
      c0.x += (mx / cnt - c0.x) * 0.08; c0.y += (my / cnt - c0.y) * 0.08; c0.z += (mz / cnt - c0.z) * 0.08;
      for (const n of this.nodes) {
        const px = n.x - c0.x, py = n.y - c0.y, pz = (n.z - c0.z) * zk;
        const x = px * cy0 + pz * sy0, z1 = -px * sy0 + pz * cy0;
        const y = py * cp - z1 * sp, z = py * sp + z1 * cp;
        const f = CAM / (CAM - z * (0.3 + 0.7 * K.depth));
        n.sx = cx + x * unit * f; n.sy = cyc + y * unit * f; n.f = f;
        n.near = Math.max(0, Math.min(1, 0.5 + z / 520));          // 0 far, 1 close to the glass
        const grow = n.born ? Math.min(1, (now - n.born) / 900) : 1;
        n.sr = n.r * unit * f * (0.3 + 0.7 * grow);
        n.vis = !this.hidden.has(n.type) && n.sx > -40 && n.sx < W + 40 && n.sy > -40 && n.sy < H + 40;
        n.lit = !sel || n.id === sel || near.has(n.id);
      }

      // Links: thin beam strokes, brighter for stronger and nearer connections.
      ctx.lineWidth = 1;
      for (const l of this.links) {
        const s = l.s, t = l.t;
        if (this.hidden.has(s.type) || this.hidden.has(t.type)) continue;
        if (!s.vis && !t.vis) continue;
        const hot = sel && (s.id === sel || t.id === sel);
        const depth = 0.3 + 0.7 * (s.near + t.near) / 2;
        const a = (hot ? 0.75 : sel ? 0.05 : 0.13 + 0.22 * l.w) * depth * gain;
        ctx.strokeStyle = rgba(hot ? COLORS[t.type] : BEAM, a);
        ctx.lineWidth = hot ? 1.4 : 1;
        ctx.beginPath(); ctx.moveTo(s.sx, s.sy); ctx.lineTo(t.sx, t.sy); ctx.stroke();
      }

      // Nodes, far to near. Distant ones are softer and dimmer, as if out of focus.
      const order = this.nodes.filter(n => n.vis).sort((p, q) => p.near - q.near);
      for (const n of order) {
        const dim = n.lit ? 1 : 0.16, blur = 1 + (1 - n.near) * 0.9 * K.depth;
        const a = (0.42 + 0.58 * n.near) * dim * gain * (n.id === this.hover ? 1.5 : 1) * (0.72 + 0.28 * Math.min(1, n.deg / 4));
        const size = Math.max(9, n.sr * 6.4 * blur);
        ctx.globalAlpha = Math.min(1, a * (n.type === 'dream' ? 1.35 : 1.05));
        ctx.drawImage(this.sprites[n.type], n.sx - size / 2, n.sy - size / 2, size, size);
        ctx.globalAlpha = 1;
        if (n.born && now - n.born < 2400) {                        // a new arrival rings once
          const k = (now - n.born) / 2400;
          ctx.strokeStyle = rgba(COLORS[n.type], (1 - k) * 0.9 * gain); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(n.sx, n.sy, n.sr + k * 70, 0, 6.2832); ctx.stroke();
        }
      }
      if (sel) {
        const n = this.byId.get(sel);
        if (n && n.vis) {
          ctx.strokeStyle = rgba(COLORS[n.type], 0.9 * gain); ctx.lineWidth = 1.2;
          const rr = n.sr + 7 + (this.still ? 0 : Math.sin(time * 2.4) * 1.5);
          ctx.beginPath(); ctx.arc(n.sx, n.sy, rr, 0, 6.2832); ctx.stroke();
        }
      }

      this._labels(ctx, order, gain);
      // Keep the readout and the timebase clear: the graph fades out before it reaches them.
      ctx.globalCompositeOperation = 'source-over';
      const tc = TUBE.join(','), t0 = H * 0.075, b0 = H * 0.84;
      let gr = ctx.createLinearGradient(0, 0, 0, t0); gr.addColorStop(0, 'rgba(' + tc + ',1)'); gr.addColorStop(0.55, 'rgba(' + tc + ',.92)'); gr.addColorStop(1, 'rgba(' + tc + ',0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, t0);
      gr = ctx.createLinearGradient(0, b0, 0, H); gr.addColorStop(0, 'rgba(' + tc + ',0)'); gr.addColorStop(0.3, 'rgba(' + tc + ',.94)'); gr.addColorStop(1, 'rgba(' + tc + ',1)');
      ctx.fillStyle = gr; ctx.fillRect(0, b0, W, H - b0);
      ctx.globalCompositeOperation = 'lighter';
      const clear = Math.min(1, this.knobs.intensity * 0.85);   // these strips are redrawn from clean glass each frame
      this._timebase(ctx, time, clear);
      this._readout(ctx, clear);
    }

    _labels(ctx, order, gain) {
      const sel = this.selected, hov = this.hover, zoom = this.knobs.scale;
      const cand = [];
      for (const n of order) {
        let pr = 0;
        if (n.id === sel) pr = 1000; else if (n.id === hov) pr = 900;
        else if (sel && n.lit) pr = 500 + n.weight;
        else if (sel) continue;
        else if (n.type === 'dream') pr = 100 + n.weight * 4 + n.near * 20;
        else if (n.deg >= 2 || zoom > 1.5) pr = n.weight * 6 * zoom + n.near * 10;
        else continue;
        cand.push([pr, n]);
      }
      cand.sort((a, b) => b[0] - a[0]);
      const placed = []; let count = 0;
      const discs = order.filter(n => n.lit && n.sr > 1.5).map(n => { const r = n.sr * 0.95 + 3; return [n.sx - r, n.sy - r, n.sx + r, n.sy + r, n.id]; });
      const top = this.h * 0.065, bottom = this.h * 0.855;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.globalCompositeOperation = 'source-over'; ctx.lineJoin = 'round';
      for (const [pr, n] of cand) {
        if (count >= 70) break;
        const big = n.type === 'dream' || pr >= 900, px = big ? 12 : 11;
        ctx.font = (big ? '600 ' : '400 ') + px + 'px ' + FONT;
        const text = n.name.length > 30 ? n.name.slice(0, 29) + '…' : n.name;
        // Try below, above, right and left of the node; use the first spot clear of other labels and of bright cores.
        // A dream whose name has nowhere clear to go waits until it is hovered or selected.
        const tw = ctx.measureText(text).width, off = Math.max(6, n.sr * 1.6) + 3, hgt = px + 5;
        const spots = [
          [n.sx - tw / 2 - 5, n.sy + off - 2], [n.sx - tw / 2 - 5, n.sy - off - hgt + 2],
          [n.sx + off + 2, n.sy - hgt / 2], [n.sx - off - tw - 12, n.sy - hgt / 2]
        ].map(([x0, y0]) => [x0, y0, x0 + tw + 10, y0 + hgt]);
        const score = box => {
          if (box[1] < top || box[3] > bottom || box[0] < 4 || box[2] > this.w - 4) return 99;
          let c = 0;
          for (const b of placed) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) c += 10;
          for (const b of discs) if (b[4] !== n.id && box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) c += 1;
          return c;
        };
        let box = null, best = 999;
        for (const b of spots) { const sc = score(b); if (sc < best) { best = sc; box = b; } if (sc === 0) break; }
        if (best > 0 && pr < 500) continue;
        if (best >= 10 && pr < 900) continue;
        const x = (box[0] + box[2]) / 2, y = box[1] + 2;
        placed.push(box); count++;
        const a = (pr >= 500 ? 1 : 0.62 + 0.38 * n.near) * (big ? 1 : 0.9) * Math.min(1, 0.35 + gain * 1.6);
        const c = COLORS[n.type].map(v => Math.round(v + (255 - v) * 0.25));
        ctx.shadowColor = rgba(COLORS[n.type], 0.75 * a); ctx.shadowBlur = 8;
        ctx.fillStyle = rgba(c, a); ctx.fillText(text, x, y);
        ctx.shadowBlur = 0;
      }
    }

    /* The sweep along the bottom is the journal over time: one pulse per dream,
       taller for dreams with more threads. The selected dream is marked. */
    _timebase(ctx, time, gain) {
      const W = this.w, H = this.h, x0 = W * 0.045, x1 = W * 0.955, base = H * 0.935, amp = H * 0.05;
      const T = this.timeline, n = T.length;
      ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
      const sweep = this.still ? 2 : (time % 7) / 7;
      const lo = n ? T[0].t : 0, span = Math.max(n ? T[n - 1].t - lo : 0, 14 * 864e5);
      const pad = span * 0.04, at = t => x0 + (x1 - x0) * ((t - lo + pad) / (span + 2 * pad));
      const pulses = T.map(p => ({ id: p.id, x: at(p.t), h: Math.min(1, 0.35 + p.w / 9) }));
      const steps = Math.floor((x1 - x0) / 2), sig = Math.max(3, (x1 - x0) / 240);
      const ys = new Array(steps + 1), hums = new Array(steps + 1); let peak = 1;
      for (let i = 0; i <= steps; i++) {
        const x = x0 + (x1 - x0) * i / steps; let v = 0;
        for (const p of pulses) { const d = (x - p.x) / sig; if (d > -4 && d < 4) v += p.h * Math.exp(-d * d); }
        const hum = this.still ? 0 : Math.sin(x * 0.11 + time * 2.1) * 0.012 + Math.sin(x * 0.043 - time * 1.3) * 0.01;
        ys[i] = v; if (v > peak) peak = v; hums[i] = hum;
      }
      for (let i = 0; i <= steps; i++) ys[i] = base - (ys[i] / peak + hums[i]) * amp;
      // Drawn in short runs so the trace is brightest just behind the sweeping beam.
      for (let i = 0; i < steps; i += 6) {
        const u = i / steps, behind = ((sweep - u) % 1 + 1) % 1;
        const a = (this.still ? 0.75 : 0.42 + 0.58 * Math.pow(1 - behind, 3)) * gain;
        ctx.strokeStyle = rgba(SWEEP, a); ctx.beginPath();
        for (let j = i; j <= Math.min(steps, i + 6); j++) { const x = x0 + (x1 - x0) * j / steps; if (j === i) ctx.moveTo(x, ys[j]); else ctx.lineTo(x, ys[j]); }
        ctx.stroke();
      }
      if (!this.still && sweep <= 1) {
        const i = Math.min(steps, Math.round(sweep * steps)), sx = x0 + (x1 - x0) * sweep;
        ctx.globalAlpha = Math.min(1, gain * 1.6); ctx.drawImage(this.sprites.dream, sx - 10, ys[i] - 10, 20, 20); ctx.globalAlpha = 1;
      }
      const mark = this.selected || this.hover;
      for (const p of pulses) if (p.id === mark) {
        ctx.strokeStyle = rgba(COLORS.dream, 0.95 * gain); ctx.beginPath(); ctx.moveTo(p.x, base + 5); ctx.lineTo(p.x, base - amp - 7); ctx.stroke();
      }
      if (n) {
        const fmt = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        ctx.font = '400 11px ' + FONT; ctx.textBaseline = 'top'; ctx.fillStyle = rgba(BEAM, 0.55 * gain * 1.4);
        ctx.textAlign = 'left'; ctx.fillText(fmt(T[0].t), x0, base + 9);
        if (n > 1) { ctx.textAlign = 'right'; ctx.fillText(fmt(T[n - 1].t), x1, base + 9); }
      }
    }

    _readout(ctx, gain) {
      const c = this.counts, a = 0.7 * gain * 1.4;
      const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
      ctx.font = '400 12px ' + FONT; ctx.textBaseline = 'top'; ctx.fillStyle = rgba(BEAM, a);
      ctx.textAlign = 'left';
      ctx.fillText(pl(c.dreams, 'dream') + '      ' + pl(c.threads, 'thread') + '      ' + pl(c.links, 'link'), this.w * 0.045, this.h * 0.025);
      const n = this.byId.get(this.hover || this.selected);
      if (n) {
        ctx.textAlign = 'right'; ctx.fillStyle = rgba(COLORS[n.type], a * 1.2);
        ctx.fillText(n.name + '      ' + pl(n.deg, 'link'), this.w * 0.955, this.h * 0.025);
      }
    }
  }

  window.Scope = Scope;
  window.ScopeColors = COLORS;
})();
