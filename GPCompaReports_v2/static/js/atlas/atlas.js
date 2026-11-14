// atlas.js: the GPCRome Atlas page. Camera, layouts and their transitions, hover and selection,
// the position lens, the receptor panel, search and the URL hash. Drawing helpers live in
// atlas-render.js, data and layouts in atlas-core.js. One requestAnimationFrame loop that runs
// only while something moves.
(function() {
  'use strict';

  var A = window.GPCAtlas;
  var root = document.getElementById('atlas');
  if (!root || !A || !A.decode || !A.drawGlyphs) return;

  function $(id) { return document.getElementById(id); }
  var stage = $('atlas-stage'), canvas = $('atlas-canvas'), ctx = canvas.getContext('2d');
  var rulerCv = $('atlas-ruler'), tip = $('atlas-tip'), legendEl = $('atlas-legend');
  var panel = $('atlas-panel');
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var VIEWS = ['families', 'similarity', 'tree', 'ranked', 'fingerprints'];
  var COLORS = ['activation', 'ligand', 'group', 'cons', 'am', 'share'];
  var K_MIN = 4, K_MAX = 40, K_DEFAULT = 12;
  var FONT = (getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif');
  var SERIF = (getComputedStyle(root).getPropertyValue('--font-serif') || 'Georgia, serif').trim();

  var st = {
    data: null, P: null, n: 0, m: 0,
    view: 'families', metric: 'n_above', color: 'activation',
    lensPin: -1, lensHover: -1, sel: -1, hover: -1, hoverCell: null,
    layouts: {},
    trans: null, decoA: { families: 0, similarity: 0, tree: 0, ranked: 0, fingerprints: 0 },
    rules: {}, ruleOrder: [], rule: 'pattern', k: K_DEFAULT, cut: null, rulesState: 'none', groupCount: 0,
    cam: { x: 0, y: 0, k: 1 }, fly: null, zoom: null, inertia: null,
    W: 0, H: 0, dpr: 1,
    hoverA: 0, hoverShown: -1,     // the focused receptor (hovered, else selected) and its fade
    rowHover: -1,
    heat: {}, heatIdx: null, halos: null, groupText: [],
    lastT: 0, raf: 0, legendKey: '', tipKey: '', userMoved: false,
    stats: { frames: 0, drawMs: 0, maxDrawMs: 0 }   // draw time per frame, read by tests
  };
  var X, Y, S, vis, colors, gx, gy, gs, fx, fy, fs, tx, ty, ts, delay;

  // ================================================================== loop

  function schedule() { if (!st.raf) st.raf = requestAnimationFrame(tick); }
  function invalidate() { schedule(); }

  function tick(now) {
    st.raf = 0;
    var dt = st.lastT ? Math.min(64, now - st.lastT) : 16;
    st.lastT = now;
    var busy = false;
    if (!st.data) return;
    busy = updateCamera(now, dt) || busy;
    busy = updateGlyphs(now) || busy;
    busy = updateFades(dt) || busy;
    var t0 = performance.now();
    draw(now);
    var dms = performance.now() - t0, S0 = st.stats;
    S0.frames++; S0.drawMs += dms; if (dms > S0.maxDrawMs) S0.maxDrawMs = dms;
    if (busy) schedule(); else st.lastT = 0;
  }

  // ================================================================== camera

  function sx(x) { return (x - st.cam.x) * st.cam.k + st.W / 2; }
  function sy(y) { return (y - st.cam.y) * st.cam.k + st.H / 2; }
  function wx(px) { return (px - st.W / 2) / st.cam.k + st.cam.x; }
  function wy(py) { return (py - st.H / 2) / st.cam.k + st.cam.y; }

  function insets(viewKey) {
    viewKey = viewKey || st.view;
    var round = viewKey === 'families' || viewKey === 'similarity' || viewKey === 'tree';
    var r = stage.getBoundingClientRect(), ins = { l: 16, r: 16, t: 16, b: 16 };
    var top = root.querySelector('.atlas-top');
    if (top) {
      var cards = top.children, mb = 0;
      for (var i = 0; i < cards.length; i++) {
        var cr = cards[i].getBoundingClientRect();
        var central = !round || (cr.right > r.left + r.width * 0.3 && cr.left < r.left + r.width * 0.7);
        if (cr.height && central) mb = Math.max(mb, cr.bottom - r.top);
      }
      if (st.W < 700) mb = Math.max(mb, top.getBoundingClientRect().bottom - r.top);
      ins.t = mb + 12;
    }
    var lens = $('atlas-lens').getBoundingClientRect();
    ins.b = r.bottom - lens.top + 12;
    if (st.W < 700 && legendEl.offsetHeight) ins.b = Math.max(ins.b, r.bottom - legendEl.getBoundingClientRect().top + 8);
    if (panelOpen()) {
      var pr = panel.getBoundingClientRect();
      if (st.W >= 700) ins.r = r.right - pr.left + 12;
      else ins.b = Math.max(ins.b, r.bottom - pr.top + 8);
    }
    if (st.W >= 900 && !round && !legendEl.hidden && legendEl.offsetWidth) {
      var lr = legendEl.getBoundingClientRect();
      ins.l = Math.max(ins.l, lr.right - r.left + 8);
    }
    return ins;
  }

  function layoutK(L) { return L.key === 'fingerprints' ? { max: 48 } : { max: 170 / L.s }; }

  // Families: the wheel is a disc, so fit it to the largest circle that avoids every floating card,
  // between the top of the stage and the lens bar, with a margin.
  function fitCircle(L) {
    var r = stage.getBoundingClientRect(), obs = [], m = st.W < 700 ? 8 : 16;
    function add(el) {
      if (!el || el.hidden || !el.offsetWidth) return;
      var b = el.getBoundingClientRect();
      obs.push([b.left - r.left, b.top - r.top, b.right - r.left, b.bottom - r.top]);
    }
    Array.prototype.forEach.call(root.querySelectorAll('.atlas-top > .atlas-card'), add);
    add(legendEl); add(root.querySelector('.atlas-zoom'));
    var hd = $('atlas-hint');
    if (hd.classList.contains('is-docked') && !hd.classList.contains('is-leaving')) add(hd);
    if (panelOpen()) add(panel);
    var x0 = 6, x1 = st.W - 6, y0 = 6, y1 = $('atlas-lens').getBoundingClientRect().top - r.top - 6;
    function radius(cx, cy) {
      var rr = Math.min(cx - x0, x1 - cx, cy - y0, y1 - cy);
      for (var q = 0; q < obs.length; q++) {
        var o = obs[q], dx = Math.max(o[0] - cx, 0, cx - o[2]), dy = Math.max(o[1] - cy, 0, cy - o[3]);
        rr = Math.min(rr, Math.sqrt(dx * dx + dy * dy));
      }
      return rr - m;
    }
    var best = { r: -1, x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, stepX = (x1 - x0) / 40, stepY = (y1 - y0) / 30;
    for (var pass = 0; pass < 3; pass++) {
      var bx = best.x, by = best.y, nx = pass ? 8 : 40, ny = pass ? 8 : 30;
      for (var i = 0; i <= nx; i++) for (var j = 0; j <= ny; j++) {
        var cx = pass ? bx + (i - nx / 2) * stepX : x0 + i * stepX;
        var cy = pass ? by + (j - ny / 2) * stepY : y0 + j * stepY;
        var rr = radius(cx, cy);
        if (rr > best.r) best = { r: rr, x: cx, y: cy };
      }
      stepX /= 4; stepY /= 4;
    }
    // the tree keeps room outside its rim for the group names
    var ext = (L.key === 'tree' ? L.R + 2.6 : L.Rout + 2.3), room = L.key === 'tree' ? Math.min(90, best.r * 0.22) : 0;
    var k = Math.max(0.5, best.r - room) / ext;
    return { x: -(best.x - st.W / 2) / k, y: -(best.y - st.H / 2) / k, k: k };
  }

  function fitView(L, ins) {
    if ((L.key === 'families' || L.key === 'tree') && !ins) return fitCircle(L);
    ins = ins || insets(L.key);
    var b = L.bounds, w = Math.max(80, st.W - ins.l - ins.r), h = Math.max(80, st.H - ins.t - ins.b);
    // the heat map keeps room for its labels: group names on the left, family names on the right
    var padL = L.key === 'fingerprints' ? (st.W < 700 ? 30 : 110) : 0, padR = L.key === 'fingerprints' ? (st.W < 700 ? 10 : 200) : 0;
    var padT = L.key === 'fingerprints' ? 20 : 0;
    var k = Math.min((w - padL - padR) / (b[2] - b[0]), (h - padT) / (b[3] - b[1]));
    var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    var ux = ins.l + padL + (w - padL - padR) / 2, uy = ins.t + padT + (h - padT) / 2;
    return { x: cx - (ux - st.W / 2) / k, y: cy - (uy - st.H / 2) / k, k: k };
  }

  function limits() {
    var L = st.layouts[st.view], f = fitView(L);
    return { min: f.k * 0.45, max: layoutK(L).max };
  }

  // van Wijk and Nuij smooth zoom (as in d3.interpolateZoom): pans at a comfortable height.
  function zoomPath(p0, p1) {
    var rho = Math.SQRT2, rho2 = 2, rho4 = 4;
    var ux0 = p0[0], uy0 = p0[1], w0 = p0[2], ux1 = p1[0], uy1 = p1[1], w1 = p1[2];
    var dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy, f, S;
    function cosh(x) { return ((x = Math.exp(x)) + 1 / x) / 2; }
    function sinh(x) { return ((x = Math.exp(x)) - 1 / x) / 2; }
    function tanh(x) { return ((x = Math.exp(2 * x)) - 1) / (x + 1); }
    if (d2 < 1e-9) {
      S = Math.log(w1 / w0) / rho;
      f = function(t) { return [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)]; };
    } else {
      var d1 = Math.sqrt(d2);
      var b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
      var b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
      var r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
      S = (r1 - r0) / rho;
      f = function(t) {
        var s = t * S, c0 = cosh(r0), u = w0 / (rho2 * d1) * (c0 * tanh(rho * s + r0) - sinh(r0));
        return [ux0 + u * dx, uy0 + u * dy, w0 * c0 / cosh(rho * s + r0)];
      };
    }
    f.duration = Math.abs(S) * 1000 * rho / Math.SQRT2;
    return f;
  }

  function flyTo(c, dur) {
    st.zoom = null; st.inertia = null;
    if (reduced || dur === 0) { st.cam.x = c.x; st.cam.y = c.y; st.cam.k = c.k; st.fly = null; invalidate(); return; }
    var w = st.W || 1;
    var path = zoomPath([st.cam.x, st.cam.y, w / st.cam.k], [c.x, c.y, w / c.k]);
    var d = dur || A.clamp(path.duration * 0.9, 550, 1500);
    st.fly = { path: path, t0: performance.now(), dur: d };
    invalidate();
  }

  function updateCamera(now, dt) {
    var c = st.cam;
    if (st.fly) {
      var p = A.clamp((now - st.fly.t0) / st.fly.dur, 0, 1), e = A.easeInOut(p), v = st.fly.path(e);
      c.x = v[0]; c.y = v[1]; c.k = st.W / v[2];
      if (p >= 1) st.fly = null;
      return true;
    }
    if (st.zoom) {
      var z = st.zoom, lk = Math.log(c.k), lg = Math.log(z.k);
      var a = 1 - Math.exp(-dt / 90);
      lk += (lg - lk) * a;
      if (Math.abs(lg - lk) < 0.0008) { lk = lg; st.zoom = null; }
      c.k = Math.exp(lk);
      c.x = z.wx - (z.sx - st.W / 2) / c.k;
      c.y = z.wy - (z.sy - st.H / 2) / c.k;
      return true;
    }
    if (st.inertia) {
      var iv = st.inertia;
      c.x -= iv.vx * dt / c.k; c.y -= iv.vy * dt / c.k;
      var dec = Math.exp(-dt / 300);
      iv.vx *= dec; iv.vy *= dec;
      if (Math.abs(iv.vx) + Math.abs(iv.vy) < 0.015) st.inertia = null;
      return true;
    }
    return false;
  }

  function zoomAt(px, py, factor, smooth) {
    st.fly = null; st.inertia = null; userMoved();
    var lim = limits();
    var base = st.zoom ? st.zoom.k : st.cam.k;
    var k = A.clamp(base * factor, lim.min, lim.max);
    var z = { k: k, sx: px, sy: py, wx: wx(px), wy: wy(py) };
    if (!smooth || reduced) {
      st.cam.k = k; st.cam.x = z.wx - (px - st.W / 2) / k; st.cam.y = z.wy - (py - st.H / 2) / k;
      st.zoom = null;
    } else st.zoom = z;
    invalidate();
  }

  function zoomBy(f) {
    var ins = insets();
    var px = ins.l + (st.W - ins.l - ins.r) / 2, py = ins.t + (st.H - ins.t - ins.b) / 2;
    var lim = limits(), k = A.clamp(st.cam.k * f, lim.min, lim.max);
    var w0x = wx(px), w0y = wy(py);
    flyTo({ k: k, x: w0x - (px - st.W / 2) / k, y: w0y - (py - st.H / 2) / k }, 480);
  }

  function fit(dur) {
    st.userMoved = false;
    flyTo(fitView(st.layouts[st.view]), dur);
  }

  // ================================================================== layouts + transitions

  function glyphOrder(L) { return L.order; }
  function freeAspect() {
    var ins = insets('ranked');
    return Math.max(80, st.W - ins.l - ins.r) / Math.max(80, st.H - ins.t - ins.b);
  }

  function setView(view, opts) {
    opts = opts || {};
    if (VIEWS.indexOf(view) < 0) view = 'families';
    if (view === 'tree' && !st.layouts.tree) {
      $('atlas-caption').textContent = 'Loading the trees';
      loadRules().then(function(ok) { if (ok && st.layouts.tree) setView('tree', opts); });
      return;
    }
    var prev = st.view;
    st.view = view;
    syncViewUI();
    if (view !== 'families' && !$('atlas-hint').hidden) dockHint();
    positionOverlays();
    if (view === 'ranked') st.layouts.ranked = A.layoutRanked(st.data, st.metric, freeAspect());
    var L = st.layouts[view], n = st.n, ord = glyphOrder(L);
    var stagger = opts.intro ? 650 : 360, dur = opts.intro ? 1150 : 900;
    for (var i = 0; i < n; i++) {
      fx[i] = gx[i]; fy[i] = gy[i]; fs[i] = gs[i];
      tx[i] = L.xy[2 * i]; ty[i] = L.xy[2 * i + 1]; ts[i] = L.s;
      delay[i] = ord[i] * stagger;
    }
    if (reduced || opts.instant) {
      for (i = 0; i < n; i++) { gx[i] = tx[i]; gy[i] = ty[i]; gs[i] = ts[i]; }
      st.trans = null;
      for (var key in st.decoA) st.decoA[key] = key === view ? 1 : 0;
    } else {
      st.trans = { t0: performance.now(), dur: dur, total: dur + stagger, from: prev, intro: !!opts.intro };
    }
    // the camera follows the glyphs to the new layout's overview, unless a receptor is selected
    if (opts.camera !== false) {
      var target = fitView(L);
      if (reduced || opts.instant) { st.cam.x = target.x; st.cam.y = target.y; st.cam.k = target.k; st.fly = null; st.zoom = null; }
      else flyTo(target, (dur + stagger) * 0.95);
    }
    st.userMoved = false;
    writeHash();
    invalidate();
  }

  function updateGlyphs(now) {
    var T = st.trans;
    if (!T) return false;
    var n = st.n, done = true, bend = T.intro ? 0.0 : 0.1;
    for (var i = 0; i < n; i++) {
      var p = (now - T.t0 - delay[i]) / T.dur;
      if (p < 1) done = false;
      p = A.clamp(p, 0, 1);
      var e = A.easeInOut(p), dx = tx[i] - fx[i], dy = ty[i] - fy[i], b = Math.sin(Math.PI * e) * bend;
      gx[i] = fx[i] + dx * e - dy * b;
      gy[i] = fy[i] + dy * e + dx * b;
      gs[i] = fs[i] + (ts[i] - fs[i]) * e;
    }
    T.p = A.clamp((now - T.t0) / T.total, 0, 1);
    if (done) { st.trans = null; updateLegend(); }
    return true;
  }

  function updateFades(dt) {
    var busy = false, T = st.trans, a = 1 - Math.exp(-dt / 160);
    for (var key in st.decoA) {
      var target = key === st.view && (!T || T.p > 0.5) ? 1 : 0;
      if (T && key === T.from && T.p < 0.25 && key !== st.view) target = 0;
      var v = st.decoA[key];
      if (Math.abs(target - v) > 0.003) { st.decoA[key] = v + (target - v) * a; busy = true; }
      else st.decoA[key] = target;
    }
    var f = st.hover >= 0 ? st.hover : (T ? -1 : st.sel);
    var ht = f >= 0 ? 1 : 0;
    if (f >= 0) st.hoverShown = f;
    if (Math.abs(ht - st.hoverA) > 0.01) { st.hoverA += (ht - st.hoverA) * (1 - Math.exp(-dt / 110)); busy = true; }
    else { st.hoverA = ht; if (!ht) st.hoverShown = -1; }
    return busy;
  }

  // ================================================================== grouping rules

  function rule() { return st.rules[st.rule] || st.rules.pattern; }
  function neighbors(i) { var r = rule(); return (r && r.similar[i]) || []; }

  function ruleSimilarity(id) {
    var r = st.rules[id];
    if (!r.simLayout) r.simLayout = A.layoutSimilarity(st.data, r.xy, id);
    return r.simLayout;
  }

  function recut() {
    var r = rule();
    st.cut = r && r.tree ? A.cutTree(st.data, r, st.k) : null;
    st.groupCount = st.cut ? st.cut.groups.length : 0;
    st.groupField = null;
    st.legendKey = '';
    invalidate();
  }

  // atlas/rules.json: every rule's map, links, neighbor lists and tree; fetched after first paint
  function loadRules() {
    if (st.rulesPromise) return st.rulesPromise;
    var url = root.getAttribute('data-rules');
    st.rulesState = 'loading';
    st.rulesPromise = fetch(url).then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function(raw) {
      var sel = $('atlas-rule');
      sel.innerHTML = '';
      st.ruleOrder = [];
      (raw.rules || []).forEach(function(rr) {
        var prev = st.rules[rr.id];
        var pr = A.prepareRule(st.data, rr);
        if (prev && prev.simLayout && rr.id === 'pattern') pr.simLayout = prev.simLayout;
        st.rules[rr.id] = pr;
        st.ruleOrder.push(rr.id);
        var o = document.createElement('option');
        o.value = rr.id; o.textContent = rr.label;
        sel.appendChild(o);
      });
      st.rulesNotes = raw.notes || {};
      if (!st.rules[st.rule]) st.rule = raw['default'] || 'pattern';
      sel.value = st.rule;
      sel.disabled = false; $('atlas-k').disabled = false;
      $('atlas-tree-btn').disabled = false;
      st.rulesState = 'ready';
      // the other rules' maps (overlap removal) are prepared one at a time while the page is idle
      var pending = st.ruleOrder.slice();
      (function next() {
        var id = pending.shift();
        if (!id) return;
        var idle = window.requestIdleCallback || function(f) { return setTimeout(f, 120); };
        idle(function() { ruleSimilarity(id); next(); });
      })();
      st.layouts.tree = A.layoutTree(st.data, rule());
      recut();
      syncRuleUI();
      return true;
    }).catch(function(err) {
      st.rulesState = 'failed';
      $('atlas-rule-desc').textContent = 'The grouping rules could not be loaded; the map shows the contact-pattern layout.';
      if (window.console) console.error(err);
      return false;
    });
    return st.rulesPromise;
  }

  function setRule(id, opts) {
    opts = opts || {};
    if (!st.rules[id]) return;
    st.rule = id;
    st.layouts.similarity = ruleSimilarity(id);
    if (rule().tree) st.layouts.tree = A.layoutTree(st.data, rule());
    recut();
    syncRuleUI();
    if (!opts.quiet && (st.view === 'similarity' || st.view === 'tree')) {
      var sel = st.sel;
      setView(st.view, { camera: sel < 0 });
      if (sel >= 0) setTimeout(function() { if (st.sel === sel) flyToReceptor(sel); }, reduced ? 0 : 900);
    }
    if (st.sel >= 0 && !panel.hidden) fillNeighbors(st.sel);
    st.tipKey = '';
    writeHash();
  }

  function setK(k) {
    k = A.clamp(Math.round(k) || K_DEFAULT, K_MIN, K_MAX);
    if (k === st.k && st.cut) return;
    st.k = k;
    $('atlas-k').value = String(k);
    $('atlas-k-out').textContent = String(k);
    recut();
    writeHash();
  }

  function syncRuleUI() {
    var r = rule(), show = st.view === 'similarity' || st.view === 'tree' || st.color === 'group';
    $('atlas-rule-wrap').hidden = !show;
    $('atlas-rule').value = st.rule;
    $('atlas-k').value = String(st.k);
    $('atlas-k-out').textContent = String(st.k);
    if (st.rulesState !== 'failed') $('atlas-rule-desc').textContent = r && r.description ? r.description : '';
    $('atlas-caption').textContent = caption();
    $('atlas-newick').hidden = !(st.view === 'tree' && st.rule === 'sequence');
    st.legendKey = '';
  }

  // ================================================================== colors per glyph

  function lens() { return st.lensHover >= 0 ? st.lensHover : st.lensPin; }
  var HELIX_OF = { TM1: 0, TM2: 1, TM3: 2, TM4: 3, TM5: 4, TM6: 5, TM7: 6, H8: 7 };

  function computeColors() {
    var P = st.P, D = st.data, Ly = D.layers, m = Ly.m, R = D.receptors, j = lens(), mode = st.color;
    var lh = j >= 0 ? (HELIX_OF[D.positions[j].segment] != null ? HELIX_OF[D.positions[j].segment] : -1) : -1;
    for (var i = 0; i < st.n; i++) {
      var c = colors[i], r = R[i], present = true, k = i * m + j;
      c.dim = false; c.lensHelix = -1;
      if (j >= 0) {
        present = Ly.aa[k] !== 45;
        if (!present) c.dim = true; else c.lensHelix = lh;
      }
      var lig = P.ligBase + r.group;
      switch (mode) {
        case 'ligand':
          c.scalar = c.dot = lig; break;
        case 'group':
          c.scalar = c.dot = st.cut ? P.grpBase + st.cut.groups[st.cut.group[i]].hue % P.nGroupHues : P.neutralId; break;
        case 'share':
          c.scalar = c.dot = A.divId(P, r.share_active - 0.5, A.SCALE.share); break;
        case 'cons':
          if (j < 0 || !present || Ly.cons[k] === 255) c.scalar = c.dot = P.missingId;
          else c.scalar = c.dot = A.seqId(P.consBase, Ly.cons[k] / 100);
          break;
        case 'am':
          if (j < 0 || !present || Ly.am[k] === 255) c.scalar = c.dot = P.missingId;
          else c.scalar = c.dot = A.seqId(P.amBase, Ly.am[k] / 100);
          break;
        default:
          if (j >= 0) {
            if (!present) { c.scalar = c.dot = P.neutralId; }
            else {
              var v = Ly.net[k] / Ly.netScale;
              if (!Ly.hit[k]) v *= 0.26;
              c.scalar = c.dot = A.divId(P, v, A.SCALE.posNet);
            }
          } else { c.scalar = -1; c.dot = lig; }
      }
    }
  }

  // ================================================================== drawing

  function heatFor(layer) {
    if (!st.heat[layer]) st.heat[layer] = A.buildHeat(st.data, st.P, layer, st.layouts.fingerprints.rows);
    return st.heat[layer];
  }
  function heatByIndex() {
    if (!st.heatIdx) st.heatIdx = A.buildHeat(st.data, st.P, 'net', null);
    return st.heatIdx;
  }
  function heatLayer() { return st.color === 'cons' ? 'cons' : st.color === 'am' ? 'am' : 'net'; }

  function draw(now) {
    var W = st.W, H = st.H, k = st.cam.k, P = st.P, n = st.n, R = st.data.receptors;
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var i, margin = 40;
    var medS = 0, cnt = 0;
    for (i = 0; i < n; i++) {
      X[i] = sx(gx[i]); Y[i] = sy(gy[i]); S[i] = gs[i] * k;
      var rr = S[i] * 1.2 + margin;
      vis[i] = (X[i] > -rr && X[i] < W + rr && Y[i] > -rr && Y[i] < H + rr) ? 1 : 0;
      if (vis[i]) { medS += S[i]; cnt++; }
    }
    st.meanS = cnt ? medS / cnt : 0;
    computeColors();

    if (st.decoA.families > 0.004) drawFamiliesDeco(st.decoA.families);
    if (st.decoA.similarity > 0.004) {
      if (st.cut && st.layouts.similarity.rule === st.rule) drawGroupHalos(st.decoA.similarity);
      else drawHalos(st.decoA.similarity);
      drawLinks(st.decoA.similarity);
    }
    if (st.decoA.tree > 0.004 && st.layouts.tree) drawTree(st.decoA.tree);
    if (st.decoA.fingerprints > 0.004) drawHeat(st.decoA.fingerprints);

    // hover glow + lines to the most similar receptors, under the glyphs
    var h = st.hoverShown;
    if (h >= 0 && st.hoverA > 0.01) drawHoverUnder(h, st.hoverA);

    A.drawGlyphs({ ctx: ctx, P: P, data: st.data, n: n, X: X, Y: Y, S: S, vis: vis, colors: colors });

    // focus: the rest of the map recedes gently, the receptor and its neighbors come forward
    if (h >= 0 && st.hoverA > 0.01 && st.view !== 'fingerprints') {
      ctx.fillStyle = P.dark ? 'rgba(9,13,20,' + (0.5 * st.hoverA).toFixed(3) + ')' : 'rgba(248,248,245,' + (0.55 * st.hoverA).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      drawFocusEdges(h, st.hoverA);
      var fv = st.focusVis || (st.focusVis = new Uint8Array(n));
      fv.fill(0);
      fv[h] = vis[h];
      neighbors(h).forEach(function(o) { fv[o.j] = vis[o.j]; });
      A.drawGlyphs({ ctx: ctx, P: P, data: st.data, n: n, X: X, Y: Y, S: S, vis: fv, colors: colors });
    } else if (h >= 0 && st.hoverA > 0.01) drawFocusEdges(h, st.hoverA);

    if (h >= 0 && st.hoverA > 0.01) drawHoverOver(h, st.hoverA);
    if (st.sel >= 0 && vis[st.sel]) {
      ctx.strokeStyle = P.accentCss; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X[st.sel], Y[st.sel], Math.max(S[st.sel] * 1.16 + 2, 6), 0, Math.PI * 2); ctx.stroke();
    }
    var placed = [];
    if (st.decoA.similarity > 0.004 && st.cut && st.layouts.similarity.rule === st.rule) drawGroupLabels(st.decoA.similarity, placed);
    if (st.decoA.tree > 0.004 && st.cut && st.layouts.tree) drawTreeLabels(st.decoA.tree);
    drawGlyphLabels(placed);
    if (st.decoA.fingerprints > 0.004) drawHeatOverlay(st.decoA.fingerprints);
    if (st.decoA.families > 0.004) drawFamiliesLabels(st.decoA.families);
    if (!st.trans) maybeLegend();
    placeHint();
  }

  // The first-visit hint sits in the empty middle of the wheel, under the center caption, and only
  // while the Families view is shown; any interaction dismisses it.
  var hintPos = '';
  // Where the wheel's middle is too small for it, the hint is docked into the controls instead, so it
  // never covers the map.
  function dockHint() {
    var hint = $('atlas-hint');
    if (hint.classList.contains('is-docked')) return;
    hint.classList.add('is-docked');
    hint.style.left = hint.style.top = hint.style.width = ''; hint.style.visibility = '';
    var host = st.W < 700 ? root.querySelector('.atlas-top') : root.querySelector('.atlas-brand');
    host.appendChild(hint);
  }

  function placeHint() {
    var hint = $('atlas-hint');
    if (hint.hidden || hint.classList.contains('is-docked')) return;
    if (st.view !== 'families' || st.decoA.families < 0.5 || st.trans) { hint.style.visibility = 'hidden'; hintPos = ''; return; }
    var L = st.layouts.families, k = st.cam.k, cx = sx(0), cy = sy(0);
    var key = Math.round(cx) + ',' + Math.round(cy) + ',' + k.toFixed(3);
    if (key === hintPos) return;
    hintPos = key;
    var ri = (L.R0 - 2.4) * k - 8, boxes = (st.glBoxes || []).slice();
    if (st.capBox) boxes.push(st.capBox);
    function fits(x0, y0, x1, y1) {
      var corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
      for (var c = 0; c < 4; c++) if (Math.hypot(corners[c][0] - cx, corners[c][1] - cy) > ri) return false;
      for (var q = 0; q < boxes.length; q++) {
        var b2 = boxes[q];
        if (x0 < b2[2] + 4 && x1 > b2[0] - 4 && y0 < b2[3] + 4 && y1 > b2[1] - 4) return false;
      }
      return true;
    }
    var widths = [280, 240, 200], found = null;
    for (var wi = 0; wi < widths.length && !found; wi++) {
      var w = widths[wi];
      hint.style.width = w + 'px';
      var h = hint.offsetHeight;
      var tops = st.capBox ? [st.capBox[3] + 8, st.capBox[1] - 8 - h] : [cy - h / 2, cy + 10, cy - h - 10];
      for (var t = 0; t < tops.length; t++) {
        if (fits(cx - w / 2, tops[t], cx + w / 2, tops[t] + h)) { found = { w: w, top: tops[t] }; break; }
      }
    }
    if (!found) {
      dockHint();
      if (!st.userMoved && st.sel < 0) fit(700);
      return;
    }
    hint.style.width = found.w + 'px';
    hint.style.left = Math.round(cx) + 'px';
    hint.style.top = Math.round(found.top) + 'px';
    hint.style.visibility = '';
  }

  function groupText(g) { return st.groupText[g]; }

  function drawFamiliesDeco(alpha) {
    var L = st.layouts.families, k = st.cam.k, P = st.P, cx = sx(0), cy = sy(0);
    var mid = (L.R0 + L.Rout) / 2 * k, band = (L.Rout - L.R0 + 2.9) * k;
    ctx.save();
    ctx.lineCap = 'butt';
    L.deco.groups.forEach(function(g) {
      var col = st.data.groups[g.group].color;
      ctx.globalAlpha = alpha * (P.dark ? 0.12 : 0.08);
      ctx.strokeStyle = col; ctx.lineWidth = band;
      ctx.beginPath(); ctx.arc(cx, cy, mid, g.a0, g.a1); ctx.stroke();
      ctx.globalAlpha = alpha * 0.85;
      ctx.lineWidth = Math.max(2, Math.min(5, 0.5 * k));
      ctx.beginPath(); ctx.arc(cx, cy, (L.R0 - 2.1) * k, g.a0, g.a1); ctx.stroke();
    });
    // family arcs just outside the outer ring
    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = P.mutedCss; ctx.lineWidth = 1.2;
    var gapA = 0.25 / (L.Rout + 1.7);
    L.deco.fams.forEach(function(f) {
      ctx.beginPath(); ctx.arc(cx, cy, (L.Rout + 1.7) * k, f.a0 + gapA, f.a1 - gapA); ctx.stroke();
    });
    ctx.restore();
  }

  function drawFamiliesLabels(alpha) {
    var L = st.layouts.families, k = st.cam.k, P = st.P, cx = sx(0), cy = sy(0), W = st.W, H = st.H;
    ctx.save();
    // ligand group names inside the ring. Each name looks for a spot clear of every glyph and of
    // the names already placed (larger groups first): it starts just inside its arc and moves along
    // the arc and inward toward the center until nothing is under it; if no spot is free it is left out.
    var fs = A.clamp(11 + (k - 5) * 0.25, 11, 15), placed = [];
    var order = L.deco.groups.slice().sort(function(a, b) { return b.n - a.n; });
    function clearOfGlyphs(bx) {
      for (var i = 0; i < st.n; i++) {
        var r = Math.max(S[i], 1.5) + 3, dx = Math.max(bx[0] - X[i], 0, X[i] - bx[2]), dy = Math.max(bx[1] - Y[i], 0, Y[i] - bx[3]);
        if (dx * dx + dy * dy < r * r) return false;
      }
      for (var q = 0; q < placed.length; q++) {
        var b2 = placed[q];
        if (bx[0] < b2[2] && bx[2] > b2[0] && bx[1] < b2[3] && bx[3] > b2[1]) return false;
      }
      return true;
    }
    ctx.textBaseline = 'middle';
    order.forEach(function(g) {
      ctx.font = '600 ' + fs + 'px ' + FONT;
      var tw = Math.max(ctx.measureText(g.key).width, (ctx.font = (fs - 2) + 'px ' + FONT, ctx.measureText(g.n + ' receptors').width));
      var am = (g.a0 + g.a1) / 2, half = (g.a1 - g.a0) / 2, spot = null;
      var r0 = L.R0 - 3.6, rMin = L.R0 * 0.3, offs = [0, 0.35, -0.35, 0.7, -0.7];
      for (var rw = r0; rw >= rMin && !spot; rw -= 0.7) {
        for (var o = 0; o < offs.length && !spot; o++) {
          var a = am + offs[o] * half, rr = rw * k;
          var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr, ca = Math.cos(a);
          var align = ca > 0.35 ? 'right' : ca < -0.35 ? 'left' : 'center';
          var x0 = align === 'right' ? x - tw : align === 'left' ? x : x - tw / 2;
          var box = [x0 - 3, y - fs * 1.1, x0 + tw + 3, y + fs * 1.3];
          if (clearOfGlyphs(box)) spot = { x: x, y: y, align: align, box: box };
        }
      }
      if (!spot || spot.x < -200 || spot.x > W + 200 || spot.y < -40 || spot.y > H + 40) return;
      placed.push(spot.box);
      ctx.textAlign = spot.align;
      ctx.font = '600 ' + fs + 'px ' + FONT;
      ctx.globalAlpha = alpha;
      A.haloText(ctx, g.key, spot.x, spot.y - fs * 0.45, P, groupText(g.group));
      ctx.font = fs - 2 + 'px ' + FONT;
      ctx.globalAlpha = alpha * 0.9;
      A.haloText(ctx, g.n + ' receptors', spot.x, spot.y + fs * 0.7, P, P.mutedCss);
    });
    st.glBoxes = placed; st.capBox = null;
    // center caption
    var R0px = L.R0 * k;
    if (R0px > 170 && cx > -R0px && cx < W + R0px && cy > -R0px && cy < H + R0px) {
      ctx.globalAlpha = alpha * A.clamp((R0px - 170) / 60, 0, 1);
      ctx.textAlign = 'center';
      ctx.font = '600 ' + A.clamp(R0px * 0.11, 22, 40) + 'px ' + SERIF;
      ctx.fillStyle = P.fgCss;
      ctx.fillText(String(st.n), cx, cy - 12);
      ctx.font = '12px ' + FONT;
      ctx.fillStyle = P.mutedCss;
      ctx.fillText('human Class A GPCRs', cx, cy + 16);
      ctx.fillText('GPCRdb families, by ligand type', cx, cy + 33);
      st.capBox = [cx - 105, cy - 40, cx + 105, cy + 40];
    }
    // family names, radial, once there is room
    var fa = alpha * A.clamp((k - 8) / 3, 0, 1);
    if (fa > 0.01) {
      ctx.font = '11.5px ' + FONT;
      var rr0 = (L.Rout + 2.6) * k;
      L.deco.fams.forEach(function(f) {
        var span = (f.a1 - f.a0) * (L.Rout + 2.6) * k;
        var la = fa * A.clamp((span - 11) / 6, 0, 1);
        if (la < 0.02) return;
        var a = (f.a0 + f.a1) / 2, x = cx + Math.cos(a) * rr0, y = cy + Math.sin(a) * rr0;
        if (x < -260 || x > W + 260 || y < -260 || y > H + 260) return;
        ctx.save();
        ctx.translate(x, y);
        var flip = Math.cos(a) < 0;
        ctx.rotate(flip ? a + Math.PI : a);
        ctx.textAlign = flip ? 'right' : 'left';
        ctx.globalAlpha = la;
        A.haloText(ctx, f.family + ' (' + f.n + ')', 0, 0, P, P.mutedCss);
        ctx.restore();
      });
    }
    ctx.restore();
  }

  // Soft ligand-group halos behind the similarity map: rendered once per theme into a low
  // resolution image of the whole layout, then drawn as one scaled image per frame.
  function haloField() {
    if (st.haloField && st.haloField.field === st.layouts.similarity.field) return st.haloField;
    var L = st.layouts.similarity, b = L.bounds, pad = 6, R = st.data.receptors;
    var x0 = b[0] - pad, y0 = b[1] - pad, w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
    var res = 6, c = document.createElement('canvas');   // pixels per world unit
    c.width = Math.ceil(w * res); c.height = Math.ceil(h * res);
    var x = c.getContext('2d');
    for (var i = 0; i < st.n; i++) {
      var hr = 3.6 * res, px = (L.xy[2 * i] - x0) * res, py = (L.xy[2 * i + 1] - y0) * res;
      x.drawImage(st.halos[R[i].group], px - hr, py - hr, 2 * hr, 2 * hr);
    }
    st.haloField = { canvas: c, x0: x0, y0: y0, w: w, h: h, field: L.field };
    return st.haloField;
  }

  function drawHalos(alpha) {
    var k = st.cam.k;
    var fade = A.clamp((34 - st.meanS) / 22, 0, 1) * (st.color === 'activation' && lens() < 0 ? 1 : 0.45);
    if (alpha * fade < 0.02) return;
    var f = haloField();
    ctx.save();
    ctx.globalAlpha = alpha * fade;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(f.canvas, sx(f.x0), sy(f.y0), f.w * k, f.h * k);
    ctx.restore();
  }

  function rowsVisible(L) {
    var k = st.cam.k, y0 = wy(-10), y1 = wy(st.H + 10);
    return { y0: y0, y1: y1, k: k };
  }

  function drawHeat(alpha) {
    var L = st.layouts.fingerprints, k = st.cam.k, P = st.P, m = L.m, CW = L.cw, heat = heatFor(heatLayer());
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    var x = sx(0), w = m * CW * k;
    var vr = rowsVisible(L);
    L.deco.blocks.forEach(function(b) {
      if (b.y1 < vr.y0 || b.y0 > vr.y1) return;
      ctx.drawImage(heat, 0, b.r0, m, b.rows.length, x, sy(b.y0), w, b.rows.length * k);
    });
    // helix boundaries
    ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.22)' : 'rgba(31,35,40,0.22)';
    var top = sy(0), bot = sy(L.height);
    st.data.segRuns.forEach(function(run, i) {
      if (!i) return;
      ctx.fillRect(Math.round(sx(run.start * CW)) - 0.5, top, 1, bot - top);
    });
    ctx.restore();
  }

  function drawHeatOverlay(alpha) {
    var L = st.layouts.fingerprints, k = st.cam.k, P = st.P, m = L.m, CW = L.cw, W = st.W, H = st.H, R = st.data.receptors;
    var tnow = performance.now();
    if (!st.insCache || tnow - st.insT > 300) { st.insCache = insets(); st.insT = tnow; }
    var ins = st.insCache;
    ctx.save();
    ctx.globalAlpha = alpha;
    var top = sy(0), bot = sy(L.height);
    var j = lens();
    if (j >= 0) {
      ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.10)' : 'rgba(31,35,40,0.08)';
      ctx.fillRect(sx(j * CW), top, CW * k, bot - top);
      ctx.strokeStyle = P.fgCss; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(sx(j * CW)) - 0.5, top, Math.max(1, CW * k) + 1, bot - top);
    }
    var hc = st.hoverCell;
    if (hc) {
      ctx.strokeStyle = P.fgCss; ctx.lineWidth = 1.5;
      var ry = sy(L.rowY[hc.i]);
      ctx.globalAlpha = alpha * 0.35;
      ctx.strokeRect(sx(0), ry, m * CW * k, k);
      ctx.globalAlpha = alpha;
      ctx.strokeRect(sx(hc.j * CW) - 1, ry - 1, CW * k + 2, k + 2);
    }
    // header: helix names (sticky under the controls), generic numbers when there is room
    var hy = Math.max(top - 10, ins.t + 6);
    var showGn0 = CW * k >= 13, headH = showGn0 ? 62 : 20;
    if (top - 10 < hy) {
      // the header is pinned: a band behind it so the rows scroll underneath
      var grd = ctx.createLinearGradient(0, hy - headH - 8, 0, hy + 10);
      var bgc = P.dark ? [10, 15, 24] : [246, 246, 243];
      grd.addColorStop(0, 'rgba(' + bgc + ',0.94)');
      grd.addColorStop(0.85, 'rgba(' + bgc + ',0.94)');
      grd.addColorStop(1, 'rgba(' + bgc + ',0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, hy + 10);
    }
    ctx.font = '600 11px ' + FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    var showGn = CW * k >= 13;
    st.data.segRuns.forEach(function(run) {
      var x0 = sx(run.start * CW), x1 = sx((run.end + 1) * CW);
      if (x1 < 0 || x0 > W) return;
      var label = run.seg;
      if (x1 - x0 < ctx.measureText(label).width + 4) {
        if (/^TM/.test(label) && x1 - x0 > 10) label = label.slice(2); else return;
      }
      var cxm = A.clamp((x0 + x1) / 2, Math.max(x0, 0) + 20, Math.min(x1, W) - 20);
      if (x1 - x0 < 40) cxm = (x0 + x1) / 2;
      A.haloText(ctx, label, cxm, showGn ? hy - 44 : hy, P, P.mutedCss);
    });
    if (showGn) {
      ctx.font = '10px ' + FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (var c = 0; c < m; c++) {
        var xc = sx((c + 0.5) * CW);
        if (xc < -10 || xc > W + 10) continue;
        ctx.save(); ctx.translate(xc, hy - 2); ctx.rotate(-Math.PI / 2);
        A.haloText(ctx, st.data.positions[c].gn, 0, 0, P, c === j ? P.fgCss : P.mutedCss, 2.5);
        ctx.restore();
      }
    } else if (j >= 0) {
      ctx.font = '600 11px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      A.haloText(ctx, st.data.positions[j].gn, sx((j + 0.5) * CW), hy - 16, P, P.fgCss);
    }
    // row labels, group bars and family names
    var showSym = k >= 8.5, lx = sx(-2.1);
    if (showSym) {
      ctx.font = '600 ' + A.clamp(k * 0.8, 9, 13) + 'px ' + FONT;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (var i = 0; i < st.n; i++) {
        var yy = sy(L.rowY[i] + 0.5);
        if (yy < -10 || yy > H + 10) continue;
        A.haloText(ctx, R[i].symbol, lx, yy, P, i === st.sel ? P.accentCss : P.fgCss, 2.5);
      }
    }
    var barX = lx - (showSym ? 62 : 6);
    ctx.textBaseline = 'bottom';
    L.deco.groups.forEach(function(g) {
      var y0 = sy(g.y0), y1 = sy(g.y1);
      if (y1 < 0 || y0 > H) return;
      ctx.fillStyle = st.data.groups[g.group].color;
      ctx.fillRect(barX - 3, y0, 3, y1 - y0);
      ctx.font = '600 11px ' + FONT;
      var name = st.data.groups[g.group].key, tw = ctx.measureText(name).width;
      if (y1 - y0 > tw + 10) {
        ctx.save();
        var ym = A.clamp((y0 + y1) / 2, Math.max(y0, ins.t) + tw / 2 + 4, Math.min(y1, H - ins.b) - tw / 2 - 4);
        if (y1 - y0 < tw + 40) ym = (y0 + y1) / 2;
        ctx.translate(barX - 8, ym); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        A.haloText(ctx, name, 0, 0, P, groupText(g.group));
        ctx.restore();
      }
    });
    var fx0 = sx(m * CW + 0.8);
    if (fx0 < W) {
      ctx.font = '11px ' + FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      L.deco.blocks.forEach(function(b) {
        var y0 = sy(b.y0), y1 = sy(b.y1);
        if (y1 < 0 || y0 > H || y1 - y0 < 10) return;
        if (fx0 + 6 + ctx.measureText(b.family).width > W - 4) return;
        ctx.fillStyle = P.mutedCss;
        ctx.fillRect(fx0, y0 + 1, 1.5, y1 - y0 - 2);
        A.haloText(ctx, b.family, fx0 + 6, (y0 + y1) / 2, P, P.mutedCss);
      });
    }
    ctx.restore();
  }

  // the soft glow under a hovered receptor
  function drawHoverUnder(h, a) {
    if (h !== st.hover) return;
    var P = st.P;
    ctx.save();
    var rad = Math.max(S[h] * 2.3, 16);
    var g = ctx.createRadialGradient(X[h], Y[h], 0, X[h], Y[h], rad);
    var ac = P.accent;
    g.addColorStop(0, A.css(ac, (P.dark ? 0.38 : 0.26) * a));
    g.addColorStop(0.55, A.css(ac, (P.dark ? 0.12 : 0.08) * a));
    g.addColorStop(1, A.css(ac, 0));
    ctx.fillStyle = g;
    ctx.fillRect(X[h] - rad, Y[h] - rad, 2 * rad, 2 * rad);
    ctx.restore();
  }

  function simT(v) { return A.clamp((v - 0.1) / 0.55, 0, 1); }

  // edges from the focused receptor to its 8 most similar contact patterns, wider and stronger
  // for higher similarity; the neighbor hovered in the panel is drawn in the accent color
  function drawFocusEdges(h, a) {
    var P = st.P, fp = st.view === 'fingerprints';
    ctx.save();
    ctx.lineCap = 'round';
    neighbors(h).slice().reverse().forEach(function(o) {
      var j = o.j, t = simT(o.sim), hot = j === st.rowHover;
      var dx = X[j] - X[h], dy = Y[j] - Y[h], d = Math.sqrt(dx * dx + dy * dy) || 1;
      var bend = fp ? -Math.min(80, d * 0.35) : d * 0.16;
      var mx = (X[h] + X[j]) / 2 + (fp ? bend : -dy / d * bend);
      var my = (Y[h] + Y[j]) / 2 + (fp ? 0 : dx / d * bend);
      ctx.strokeStyle = hot ? A.css(P.accent, a) : A.css(P.fg, (0.22 + 0.55 * t) * a);
      ctx.lineWidth = hot ? 3 : 0.8 + 2.4 * t;
      ctx.beginPath(); ctx.moveTo(X[h], Y[h]); ctx.quadraticCurveTo(mx, my, X[j], Y[j]); ctx.stroke();
    });
    ctx.restore();
  }

  function drawHoverOver(h, a) {
    var P = st.P, placed = [], R = st.data.receptors;
    ctx.save();
    neighbors(h).forEach(function(nb) {
      var j = nb.j, o = R[j], hot = j === st.rowHover;
      ctx.strokeStyle = hot ? A.css(P.accent, a) : A.css(P.fg, (0.4 + 0.45 * simT(nb.sim)) * a);
      ctx.lineWidth = hot ? 2.5 : 1.5;
      ctx.beginPath(); ctx.arc(X[j], Y[j], Math.max(S[j] * 1.12 + 1.5, 5), 0, Math.PI * 2); ctx.stroke();
      if (S[j] < 20 && st.view !== 'fingerprints' && vis[j]) {
        ctx.font = '600 11px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        var tw = ctx.measureText(o.symbol).width / 2 + 2, ty = Y[j] - Math.max(S[j] * 1.2, 6) - 2;
        var clash = false;
        for (var q = 0; q < placed.length; q += 4) {
          if (X[j] - tw < placed[q + 2] && X[j] + tw > placed[q] && ty - 12 < placed[q + 3] && ty > placed[q + 1]) clash = true;
        }
        if (!clash || hot) {
          placed.push(X[j] - tw, ty - 12, X[j] + tw, ty);
          ctx.globalAlpha = a;
          A.haloText(ctx, o.symbol, X[j], ty, P, hot ? P.accentCss : P.fgCss);
          ctx.globalAlpha = 1;
        }
      }
    });
    ctx.strokeStyle = A.css(P.accent, a);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X[h], Y[h], Math.max(S[h] * 1.12 + 2, 6), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ similarity map: links, groups

  // the current rule's mutual-nearest links, thin and calm, one path per opacity step
  function drawLinks(alpha) {
    var P = st.P, links = rule().links, steps = [0.4, 0.55, 2], alphas = [0.14, 0.24, 0.36];
    if (!links || !links.length || st.layouts.similarity.rule !== st.rule) return;
    ctx.save();
    ctx.strokeStyle = P.fgCss;
    ctx.lineWidth = A.clamp(st.meanS / 8, 0.8, 1.6);
    var lo = -1;
    for (var b = 0; b < steps.length; b++) {
      ctx.globalAlpha = alpha * alphas[b];
      ctx.beginPath();
      for (var q = 0; q < links.length; q++) {
        var l = links[q], v = l[2];
        if (v < lo || v >= steps[b]) continue;
        var i = l[0], j = l[1];
        if (!vis[i] && !vis[j]) continue;
        ctx.moveTo(X[i], Y[i]); ctx.lineTo(X[j], Y[j]);
      }
      ctx.stroke();
      lo = steps[b];
    }
    ctx.restore();
  }

  // soft halos in each group's color, rendered once per rule, cut and theme into a low-resolution
  // image of the whole map and drawn as one scaled image per frame
  function groupHaloSprites() {
    if (st.grpSprites && st.grpSprites.dark === st.P.dark) return st.grpSprites;
    var list = [];
    for (var hh = 0; hh < st.P.nGroupHues; hh++) list.push({ color: A.css(st.P.colors[st.P.grpBase + hh]) });
    st.grpSprites = A.buildHalos(list, st.P, st.P.dark ? 1.3 : 1.9);
    st.grpSprites.dark = st.P.dark;
    return st.grpSprites;
  }
  function groupField() {
    var L = st.layouts.similarity, key = st.rule + ':' + st.k + ':' + st.P.dark;
    if (st.groupField && st.groupField.key === key) return st.groupField;
    var b = L.bounds, pad = 6, res = 6, sprites = groupHaloSprites();
    var x0 = b[0] - pad, y0 = b[1] - pad, w = b[2] - b[0] + 2 * pad, h = b[3] - b[1] + 2 * pad;
    var c = st.groupFieldCanvas || (st.groupFieldCanvas = document.createElement('canvas'));
    var cw = Math.ceil(w * res), chh = Math.ceil(h * res);
    if (c.width !== cw || c.height !== chh) { c.width = cw; c.height = chh; }
    var x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    st.cut.groups.forEach(function(g) {
      if (g.members.length < 2) return;
      var spr = sprites[g.hue % sprites.length];
      g.members.forEach(function(i) {
        var hr = 3.4 * res, px = (L.xy[2 * i] - x0) * res, py = (L.xy[2 * i + 1] - y0) * res;
        x.drawImage(spr, px - hr, py - hr, 2 * hr, 2 * hr);
      });
    });
    st.groupField = { canvas: c, x0: x0, y0: y0, w: w, h: h, key: key };
    return st.groupField;
  }
  function drawGroupHalos(alpha) {
    var fade = A.clamp((40 - st.meanS) / 26, 0.25, 1);
    var f = groupField(), k = st.cam.k;
    ctx.save();
    ctx.globalAlpha = alpha * fade * 1.6;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(f.canvas, sx(f.x0), sy(f.y0), f.w * k, f.h * k);
    ctx.restore();
  }

  // a group's name next to its densest member, clear of glyphs and of other names
  function drawGroupLabels(alpha, placed) {
    var P = st.P, L = st.layouts.similarity, groups = st.cut.groups;
    ctx.save();
    ctx.font = '600 11px ' + FONT;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    groups.map(function(g, gi) { return gi; }).sort(function(a, b) { return groups[b].members.length - groups[a].members.length; })
      .forEach(function(gi) {
        var g = groups[gi];
        if (!g.label) return;
        var mkey = L.rule + ':' + g.node, cache = st.medoids || (st.medoids = {});
        if (cache[mkey] != null) { g.medoid = cache[mkey]; g.medoidKey = L.rule; }
        if (g.medoid == null || g.medoidKey !== L.rule) {
          var best = -1, bd = Infinity;
          g.members.forEach(function(i) {
            var d = 0;
            g.members.forEach(function(j) { var dx = L.xy[2 * i] - L.xy[2 * j], dy = L.xy[2 * i + 1] - L.xy[2 * j + 1]; d += Math.sqrt(dx * dx + dy * dy); });
            if (d < bd) { bd = d; best = i; }
          });
          g.medoid = best; g.medoidKey = L.rule; cache[mkey] = best;
        }
        var mx = X[g.medoid], my = Y[g.medoid], off = Math.max(S[g.medoid] * 1.3, 8) + 6;
        if (!vis[g.medoid]) return;
        var tw = ctx.measureText(g.label).width / 2 + 3;
        // outward from the middle of the map, so names settle at the cloud's edge
        var ccx = sx((L.bounds[0] + L.bounds[2]) / 2), ccy = sy((L.bounds[1] + L.bounds[3]) / 2);
        var dx = mx - ccx, dy = my - ccy, dl = Math.sqrt(dx * dx + dy * dy);
        if (dl < 1) { dx = 0; dy = -1; dl = 1; }
        dx /= dl; dy /= dl;
        var ins = st.insCache || insets(), col = st.grpText[g.hue % st.grpText.length];
        for (var t = off, tMax = off + (st.W < 700 ? 90 : 150); t < tMax; t += 6) {
          var x = mx + dx * (t + tw * Math.abs(dx)), y = my + dy * (t + 8 * Math.abs(dy));
          if (x < ins.l + tw || x > st.W - ins.r - tw || y < ins.t + 8 || y > st.H - ins.b - 8) break;
          if (boxHits(-1, x - tw, y - 8, x + tw, y + 8, placed)) continue;
          placed.push(x - tw, y - 8, x + tw, y + 8);
          ctx.globalAlpha = alpha * 0.55;
          if (t > off + 10) {
            ctx.strokeStyle = col; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(mx + dx * (S[g.medoid] + 2), my + dy * (S[g.medoid] + 2));
            ctx.lineTo(x - dx * tw * Math.abs(dx), y - dy * 8 * Math.abs(dy)); ctx.stroke();
          }
          ctx.globalAlpha = alpha;
          A.haloText(ctx, g.label, x, y, P, col);
          break;
        }
      });
    ctx.restore();
  }

  // ------------------------------------------------------------------ tree layout

  // radial dendrogram of the current rule's tree: elbow branches (radial line, then an arc), colored
  // by the current cut; above the cut in a neutral gray; a faint ring marks the cut
  function drawTree(alpha) {
    var L = st.layouts.tree, T = rule().tree;
    if (!T || L.rule !== st.rule) return;
    var k = st.cam.k, E = L.R + 1, dpr = st.dpr;
    // the whole tree is rendered once per rule, cut and theme into an image at twice the overview
    // scale; vectors take over only when zoomed in past that
    var c = st.treeCache, key = st.rule + ':' + st.k + ':' + st.P.dark;
    if (!c || c.key !== key) {
      var fitK = fitView(L).k, scale = Math.min(fitK * 2.2 * dpr, 4096 / (2 * E));
      var cv = (c && c.canvas) || document.createElement('canvas');
      cv.width = cv.height = Math.ceil(2 * E * scale);
      var c2 = cv.getContext('2d');
      c2.clearRect(0, 0, cv.width, cv.height);
      paintTree(c2, cv.width / 2, cv.height / 2, scale, 1, Math.max(1, dpr));
      c = st.treeCache = { canvas: cv, key: key, scale: scale };
    }
    if (k * dpr <= c.scale * 1.15) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(c.canvas, sx(-E), sy(-E), 2 * E * k, 2 * E * k);
      ctx.restore();
    } else paintTree(ctx, sx(0), sy(0), k, alpha, 1);
  }

  // radial dendrogram of the current rule's tree: elbow branches (radial line, then an arc), colored
  // by the current cut; above the cut in a neutral gray; a faint dashed ring marks the cut
  function paintTree(c2, cx, cy, k, alpha, px) {
    var L = st.layouts.tree, T = rule().tree, P = st.P, n = T.n, M = T.merges, cut = st.cut;
    var Rt = L.Rtree, keep = n - st.k;
    function rad(node) { return node < n ? Rt * k : Rt * (1 - 0.94 * T.f[node]) * k; }
    var paths = [], neutral = [];
    c2.save();
    c2.lineCap = 'round';
    if (cut) {
      c2.globalAlpha = alpha * 0.5;
      c2.strokeStyle = P.mutedCss; c2.lineWidth = px;
      c2.setLineDash([3 * px, 4 * px]);
      c2.beginPath(); c2.arc(cx, cy, Rt * (1 - 0.94 * cut.fCut) * k, 0, Math.PI * 2); c2.stroke();
      c2.setLineDash([]);
    }
    for (var r = 0; r < n - 1; r++) {
      var list = neutral;
      if (cut && r < keep) {
        var hu = T.hue[cut.root[n + r]] % P.nGroupHues;
        list = paths[hu] || (paths[hu] = []);
      }
      list.push(r);
    }
    function stroke(list, color, width, a) {
      if (!list || !list.length) return;
      c2.strokeStyle = color; c2.lineWidth = width * px; c2.globalAlpha = alpha * a;
      c2.beginPath();
      for (var q = 0; q < list.length; q++) {
        var row = list[q], ca = M[row][0], cb = M[row][1], rp = rad(n + row);
        var ra = rad(ca), rb = rad(cb), aa = T.ang[ca], ab = T.ang[cb], a0 = Math.min(aa, ab), a1 = Math.max(aa, ab);
        c2.moveTo(cx + Math.cos(aa) * ra, cy + Math.sin(aa) * ra); c2.lineTo(cx + Math.cos(aa) * rp, cy + Math.sin(aa) * rp);
        c2.moveTo(cx + Math.cos(ab) * rb, cy + Math.sin(ab) * rb); c2.lineTo(cx + Math.cos(ab) * rp, cy + Math.sin(ab) * rp);
        c2.moveTo(cx + Math.cos(a0) * rp, cy + Math.sin(a0) * rp);
        c2.arc(cx, cy, rp, a0, a1);
      }
      c2.stroke();
    }
    stroke(neutral, P.mutedCss, 1.1, 0.6);
    for (var h2 = 0; h2 < paths.length; h2++) stroke(paths[h2], P.fill[P.grpBase + h2], 1.6, 0.9);
    c2.restore();
  }

  // the floating cards and the lens bar as rectangles in stage coordinates (cached briefly)
  function uiRects() {
    var now = performance.now();
    if (st.uiRects && now - st.uiRectsT < 300) return st.uiRects;
    var r = stage.getBoundingClientRect(), out = [];
    Array.prototype.forEach.call(root.querySelectorAll('.atlas-top > .atlas-card, .atlas-legend, .atlas-zoom, .atlas-lens, .atlas-panel, .atlas-hint'), function(el) {
      if (el.hidden || !el.offsetWidth) return;
      var b = el.getBoundingClientRect();
      out.push([b.left - r.left, b.top - r.top, b.right - r.left, b.bottom - r.top]);
    });
    st.uiRects = out; st.uiRectsT = now;
    return out;
  }
  function underUI(x, y) {
    if (x < 2 || y < 2 || x > st.W - 2 || y > st.H - 2) return true;
    var rs = uiRects();
    for (var q = 0; q < rs.length; q++) if (x >= rs[q][0] && x <= rs[q][2] && y >= rs[q][1] && y <= rs[q][3]) return true;
    return false;
  }

  // group names outside the rim, radial, where a group's arc has room
  function drawTreeLabels(alpha) {
    var L = st.layouts.tree, T = rule().tree;
    if (!T || L.rule !== st.rule) return;
    var P = st.P, k = st.cam.k, cx = sx(0), cy = sy(0), n = T.n;
    if (2 * Math.PI * L.R / n * k >= 11) return;          // receptor names take the rim when zoomed in
    var rr = (L.R + 2) * k, W = st.W, H = st.H;
    ctx.save();
    ctx.font = '600 11px ' + FONT;
    ctx.textBaseline = 'middle';
    st.cut.groups.forEach(function(g) {
      if (!g.label) return;
      var p0 = T.pos[g.members[0]], p1 = T.pos[g.members[g.members.length - 1]];
      var span = (p1 - p0 + 1) / n * Math.PI * 2 * rr;
      if (span < 13) return;
      var a = -Math.PI / 2 + ((p0 + p1 + 1) / 2) / n * Math.PI * 2;
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      var tl = ctx.measureText(g.label).width;
      // skip a name that would run under a card or off the stage
      for (var u = 0; u <= 4; u++) {
        var d = tl * u / 4;
        if (underUI(x + Math.cos(a) * d, y + Math.sin(a) * d)) return;
      }
      ctx.save();
      ctx.translate(x, y);
      var flip = Math.cos(a) < 0;
      ctx.rotate(flip ? a + Math.PI : a);
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.globalAlpha = alpha;
      A.haloText(ctx, g.label, 0, 0, P, st.grpText[g.hue % st.grpText.length]);
      ctx.restore();
    });
    ctx.restore();
  }

  // true when the box [x0,y0,x1,y1] touches the disc of any visible glyph other than i, or a label
  // box already placed
  function boxHits(i, x0, y0, x1, y1, placed) {
    for (var q = 0; q < st.n; q++) {
      if (q === i || !vis[q]) continue;
      var r = S[q] * 1.02 + 1, dx = Math.max(x0 - X[q], 0, X[q] - x1), dy = Math.max(y0 - Y[q], 0, Y[q] - y1);
      if (dx * dx + dy * dy < r * r) return true;
    }
    for (var b = 0; b < placed.length; b += 4) {
      if (x0 < placed[b + 2] && x1 > placed[b] && y0 < placed[b + 3] && y1 > placed[b + 1]) return true;
    }
    return false;
  }

  function drawGlyphLabels(placed) {
    var P = st.P, R = st.data.receptors, D = st.data, j = lens(), Ly = D.layers;
    placed = placed || [];
    var fpa = st.decoA.fingerprints, other = 1 - fpa;
    var ranked = st.view === 'ranked' && st.layouts.ranked;
    var heat = null;
    ctx.save();
    ctx.textAlign = 'center';
    for (var i = 0; i < st.n; i++) {
      if (!vis[i]) continue;
      var s = S[i], x = X[i], y = Y[i];
      if (s < 12 || other < 0.05) continue;
      var la = A.clamp((s - 19) / 7, 0, 1) * other;
      var yy = y + s * 1.02 + 2, labelled = false;
      if (la > 0.02) {
        var f = A.clamp(10.5 + (s - 20) * 0.06, 10.5, 14);
        ctx.font = '600 ' + f + 'px ' + FONT;
        var tw = ctx.measureText(R[i].symbol).width / 2 + 2;
        if (i === st.sel || i === st.hover || !boxHits(i, x - tw, yy, x + tw, yy + f + 1, placed)) {
          placed.push(x - tw, yy, x + tw, yy + f + 1);
          ctx.globalAlpha = la;
          ctx.textBaseline = 'top';
          A.haloText(ctx, R[i].symbol, x, yy, P, i === st.sel ? P.accentCss : P.fgCss);
          yy += f + 3;
          labelled = true;
        }
      }
      var noMore = !labelled && s >= 19;
      if (ranked && st.decoA.ranked > 0.05 && !noMore) {
        var room = st.layouts.ranked.deco.sx * st.cam.k - 6;
        var va = A.clamp((room - 56) / 12, 0, 1) * st.decoA.ranked;
        if (va > 0.02 && !boxHits(i, x - 30, yy, x + 30, yy + 13, placed)) {
          placed.push(x - 30, yy, x + 30, yy + 13);
          ctx.globalAlpha = va;
          ctx.font = '10.5px ' + FONT;
          ctx.textBaseline = 'top';
          var rk = st.layouts.ranked.rank[i], txt = A.METRICS[st.metric].fmt(R[i][st.metric]);
          if (room > 80) txt = '#' + rk + '  ' + txt;
          A.haloText(ctx, txt, x, yy, P, P.mutedCss, 2.5);
          yy += 14;
        }
      }
      // fingerprint strip
      var fa = noMore ? 0 : A.clamp((s - 42) / 10, 0, 1) * other;
      var w = Math.min(s * 1.9, 230), hh = A.clamp(s * 0.085, 4, 9), x0 = x - w / 2;
      if (fa > 0.02 && boxHits(i, x0, yy - 1, x0 + w, yy + hh + 3, placed)) {
        // a shorter strip when the full one would touch a neighbor
        w = Math.min(w, s * 1.3); x0 = x - w / 2;
        if (boxHits(i, x0, yy - 1, x0 + w, yy + hh + 3, placed)) fa = 0;
      }
      if (fa > 0.02) {
        placed.push(x0, yy - 1, x0 + w, yy + hh + 3);
        heat = heat || heatByIndex();
        ctx.globalAlpha = fa;
        ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.05)' : 'rgba(31,35,40,0.05)';
        ctx.fillRect(x0, yy + 1, w, hh);
        ctx.imageSmoothingEnabled = w < Ly.m;
        ctx.drawImage(heat, 0, i, Ly.m, 1, x0, yy + 1, w, hh);
        if (j >= 0) {
          ctx.fillStyle = P.fgCss;
          ctx.fillRect(x0 + (j + 0.5) / Ly.m * w - 0.75, yy - 1, 1.5, hh + 4);
        }
      }
      // residue at the lens position
      if (j >= 0 && s >= 15 && Ly.aa[i * Ly.m + j] !== 45) {
        var k = i * Ly.m + j;
        ctx.globalAlpha = A.clamp((s - 15) / 6, 0, 1) * other;
        ctx.font = '700 ' + A.clamp(10 + s * 0.05, 10.5, 14) + 'px ' + FONT;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        var col = colors[i].scalar >= 0 ? P.fill[colors[i].scalar] : P.fgCss;
        if (st.color === 'activation') {
          var v = Ly.net[k];
          col = v > 0 ? P.fill[P.divBase + 2 * A.DIV] : v < 0 ? P.fill[P.divBase] : P.mutedCss;
        }
        var lh = colors[i].lensHelix, lx2, ly2;
        if (lh >= 0) {
          var hp = A.HELIX_XY[lh], dr = lh === 7 ? 0.12 : R[i]._dr[lh];
          lx2 = x + hp[0] * s * 0.9 + dr * s * 0.9 + 3; ly2 = y - hp[1] * s * 0.9 - dr * s * 0.6 - 2;
        } else { lx2 = x + s * 0.7; ly2 = y - s * 0.72; }
        A.haloText(ctx, String.fromCharCode(Ly.aa[k]) + Ly.pos[k], lx2, ly2, P, col);
        ctx.textAlign = 'center';
      }
    }
    ctx.restore();
  }

  // ================================================================== picking

  function pick(px, py) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < st.n; i++) {
      if (!vis[i]) continue;
      var dx = X[i] - px, dy = Y[i] - py, d2 = dx * dx + dy * dy, r = Math.max(S[i] * 1.05, 7);
      if (d2 < r * r && d2 < bd) { bd = d2; best = i; }
    }
    return best;
  }

  function pickCell(px, py) {
    if (st.view !== 'fingerprints' || st.trans || st.decoA.fingerprints < 0.5) return null;
    var L = st.layouts.fingerprints, x = wx(px), y = wy(py);
    var j = Math.floor(x / L.cw);
    if (j < 0 || j >= L.m) return null;
    var rows = L.rows, lo = 0, hi = rows.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, ry = L.rowY[rows[mid]];
      if (y < ry) hi = mid - 1; else if (y >= ry + 1) lo = mid + 1; else return { i: rows[mid], j: j };
    }
    return null;
  }

  // ================================================================== tooltip

  function fmtNum(v, d) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function signClass(v) { return v > 0 ? 'is-act' : v < 0 ? 'is-ina' : ''; }

  function lensLine(i, j) {
    var c = A.cell(st.data, i, j), gn = st.data.positions[j].gn;
    if (!c.present) return '<strong>' + gn + '</strong>: not present in this receptor';
    var v = (c.clipped ? (c.net > 0 ? '≥ ' : '≤ ') : '') + fmtNum(c.net);
    var s = '<strong>' + gn + '</strong>: ' + c.aa + c.resnum + ', net ΔRRCS <span class="' + signClass(c.net) + '">' + v + '</span>';
    s += ', ' + (c.hit ? c.hit + ' above-threshold contact' + (c.hit > 1 ? 's' : '') : 'no above-threshold contact');
    if (st.color === 'cons') s += ', conservation ' + (c.cons == null ? 'n/a' : c.cons.toFixed(2));
    if (st.color === 'am') s += ', AlphaMissense ' + (c.am == null ? 'n/a' : c.am.toFixed(2));
    return s;
  }

  function receptorTip(i) {
    var r = st.data.receptors[i], g = st.data.groups[r.group];
    var h = '<div class="tp-head"><span class="tp-sym">' + esc(r.symbol) + '</span><span class="tp-name">' + esc(r.fullName || r.name) + '</span></div>';
    h += '<div class="tp-meta">' + esc(r.family) + ' · <span style="color:' + groupText(r.group) + '">' + esc(g.key) + '</span></div>';
    h += '<dl class="tp-grid">';
    h += '<dt>Contacts above threshold</dt><dd>' + r.n_above + '</dd>';
    h += '<dt>Stronger in active</dt><dd>' + Math.round(r.share_active * 100) + '%</dd>';
    h += '<dt>TM6 displacement</dt><dd>' + r.tm6_shift.toFixed(1) + ' Å</dd>';
    if (st.view === 'ranked' && st.metric === 'sum_abs_above') h += '<dt>Total change</dt><dd>' + Math.round(r.sum_abs_above) + '</dd>';
    h += '</dl>';
    var j = lens();
    if (j >= 0) h += '<div class="tp-lens">' + lensLine(i, j) + '</div>';
    h += '<div class="tp-hint">Click for details</div>';
    return h;
  }

  function cellTip(c) {
    var r = st.data.receptors[c.i];
    var h = '<div class="tp-head"><span class="tp-sym">' + esc(r.symbol) + '</span><span class="tp-name">' + esc(r.family) + '</span></div>';
    var cell = A.cell(st.data, c.i, c.j), p = st.data.positions[c.j];
    h += '<div class="tp-meta">' + p.gn + ' · ' + p.segment + '</div>';
    if (!cell.present) return h + '<div>The receptor has no residue at this position.</div>';
    h += '<dl class="tp-grid">';
    h += '<dt>Residue</dt><dd>' + cell.aa + cell.resnum + '</dd>';
    h += '<dt>Net ΔRRCS</dt><dd class="' + signClass(cell.net) + '">' + (cell.clipped ? (cell.net > 0 ? '≥ ' : '≤ ') : '') + fmtNum(cell.net) + '</dd>';
    h += '<dt>Above-threshold contacts</dt><dd>' + cell.hit + '</dd>';
    h += '<dt>Conservation</dt><dd>' + (cell.cons == null ? 'n/a' : cell.cons.toFixed(2)) + '</dd>';
    h += '<dt>AlphaMissense (mean)</dt><dd>' + (cell.am == null ? 'n/a' : cell.am.toFixed(2)) + '</dd>';
    h += '</dl><div class="tp-hint">Click to open ' + esc(r.symbol) + ' at this position</div>';
    return h;
  }

  function showTip(html, px, py, key) {
    if (key !== st.tipKey) { tip.innerHTML = html; st.tipKey = key; }
    tip.hidden = false;
    var tw = tip.offsetWidth, th = tip.offsetHeight, W = st.W, H = st.H;
    var x = px + 16, y = py + 16;
    if (x + tw > W - 8) x = px - tw - 16;
    if (y + th > H - 8) y = py - th - 16;
    x = A.clamp(x, 8, W - tw - 8); y = A.clamp(y, 8, H - th - 8);
    tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    if (!tip.classList.contains('is-on')) requestAnimationFrame(function() { tip.classList.add('is-on'); });
  }
  function hideTip() { tip.classList.remove('is-on'); tip.hidden = true; st.tipKey = ''; }

  function setHover(i, px, py) {
    if (i !== st.hover) { st.hover = i; invalidate(); }
    canvas.classList.toggle('is-pointing', i >= 0 || !!st.hoverCell);
    if (i >= 0) showTip(receptorTip(i), px, py, 'r' + i + ':' + lens() + ':' + st.color);
    else if (st.hoverCell) showTip(cellTip(st.hoverCell), px, py, 'c' + st.hoverCell.i + ':' + st.hoverCell.j);
    else hideTip();
  }

  // ================================================================== legend

  function bar(stops) {
    return '<div class="lg-bar" style="background:linear-gradient(90deg,' + stops.map(function(c) { return A.css(c); }).join(',') + ')"></div>';
  }
  function divBar() { var P = st.P; return bar([P.ina, P.neutral, P.act]); }

  function maybeLegend() {
    var lod = st.meanS < 5.2 ? 'dots' : 'bundle';
    var key = [st.view, st.color, st.rule, st.cut ? st.cut.k : 0, lens() >= 0 ? st.data.positions[lens()].gn : '', lod, st.P.dark].join('|');
    if (key !== st.legendKey) { st.legendKey = key; buildLegend(lod); }
  }
  function updateLegend() { st.legendKey = ''; invalidate(); }

  function buildLegend(lod) {
    var P = st.P, j = lens(), gn = j >= 0 ? st.data.positions[j].gn : null, h = '';
    var groupsHtml = '<ul class="lg-groups">' + st.data.groups.map(function(g) {
      return '<li><span class="lg-dot" style="background:' + g.color + '"></span>' + esc(g.key.replace(' receptors', '')) + '</li>';
    }).join('') + '</ul>';
    if (st.view === 'fingerprints') {
      var layer = heatLayer();
      if (layer === 'net') {
        h += '<p class="lg-title">Net ΔRRCS per residue</p>' + divBar();
        h += '<div class="lg-ends"><span>stronger inactive</span><span>stronger active</span></div>';
        h += '<p class="lg-note">Pale: no above-threshold contact at that residue. Blank: the receptor lacks the position.</p>';
      } else if (layer === 'cons') {
        h += '<p class="lg-title">Conservation per residue</p>' + bar(P.consStops) + '<div class="lg-ends"><span>0</span><span>1</span></div>';
      } else {
        h += '<p class="lg-title">Mean AlphaMissense per residue</p>' + bar(P.amStops) + '<div class="lg-ends"><span>0</span><span>1</span></div>';
      }
    } else if (st.color === 'group') {
      var rr = rule();
      h += '<p class="lg-title">Group: ' + esc(rr ? rr.label.toLowerCase() : '') + (st.cut ? ', ' + st.cut.groups.length + ' groups' : '') + '</p>';
      h += '<div class="lg-hues">' + (st.P.colors.slice(st.P.grpBase, st.P.grpBase + st.P.nGroupHues).map(function(c) {
        return '<span class="lg-dot" style="background:' + A.css(c) + '"></span>'; }).join('')) + '</div>';
      h += '<p class="lg-note">Groups are cut from the similarity tree of the chosen rule; colors repeat. A browsing aid, not a classification.</p>';
    } else if (st.color === 'ligand') {
      h += '<p class="lg-title">Ligand group</p>' + groupsHtml;
    } else if (st.color === 'share') {
      h += '<p class="lg-title">Share of above-threshold contacts stronger in active</p>' + divBar();
      h += '<div class="lg-ends"><span>25% or less</span><span>50%</span><span>75% or more</span></div>';
    } else if (st.color === 'cons' || st.color === 'am') {
      var isC = st.color === 'cons';
      h += '<p class="lg-title">' + (isC ? 'Conservation' : 'Mean AlphaMissense') + ' at ' + (gn || 'the lens position') + '</p>';
      h += bar(isC ? P.consStops : P.amStops) + '<div class="lg-ends"><span>0</span><span>1</span></div>';
      h += '<p class="lg-note">Faded: the receptor lacks this position. Gray: no value.</p>';
    } else if (gn) {
      h += '<p class="lg-title">Net ΔRRCS at ' + gn + '</p>' + divBar();
      h += '<div class="lg-ends"><span>stronger inactive</span><span>stronger active</span></div>';
      h += '<p class="lg-note">Paler: no above-threshold contact at that residue. Faded: the receptor lacks the position. The outlined disc is the helix that holds it.</p>';
    } else if (lod === 'dots') {
      h += '<p class="lg-title">Dots: ligand group</p>' + groupsHtml;
      h += '<div class="lg-sizes"><span class="lg-sz" style="width:7px;height:7px"></span><span class="lg-sz" style="width:15px;height:15px"></span>';
      h += '<span class="lg-long">Dot area: total change, the sum of <span class="nw">|ΔRRCS|</span> over above-threshold contacts</span><span class="lg-short">Dot area: total change</span></div>';
      h += '<p class="lg-note">Zoom in to see each receptor’s helix bundle.</p>';
    } else {
      h += '<div class="lg-row"><canvas class="lg-key" id="atlas-lg-key" aria-hidden="true"></canvas><div>';
      h += '<p class="lg-title">Helix bundle, top view</p>';
      h += '<span class="lg-desc">Disc size: summed |ΔRRCS| on the helix. Color: net. Lines: contacts between helices.</span></div></div>';
      h += divBar() + '<div class="lg-ends"><span>stronger inactive</span><span>stronger active</span></div>';
      h += '<p class="lg-note">One scale for every receptor.</p>';
    }
    if (st.view === 'similarity' || st.view === 'tree') {
      h += '<p class="lg-note lg-viewnote">' + (st.view === 'similarity'
        ? 'Lines: each receptor is among the other\u2019s nearest under the rule. Colored halos: the current groups.'
        : 'Branches: the ' + (st.rule === 'sequence' ? 'sequence tree' : 'similarity tree') + ', colored by the current groups; the dashed ring is the cut.') + '</p>';
    }
    if (lod === 'dots' && st.view !== 'fingerprints' && h.indexOf('lg-sizes') < 0) {
      h += '<p class="lg-note lg-dotnote">Zoomed out, dot area shows total change (sum of |ΔRRCS| above threshold).</p>';
    }
    legendEl.innerHTML = h;
    var kc = $('atlas-lg-key');
    if (kc) A.drawKeyGlyph(kc, P);
  }

  // ================================================================== lens + ruler

  var rulerGeo = null;
  function drawRuler() { rulerGeo = A.drawRuler(rulerCv, st.data, st.P, st.lensPin, st.lensHover); }

  function lensReadout(j) {
    var p = st.data.positions[j];
    return '<strong>' + p.gn + '</strong> ' + p.segment + ' · present in ' + p.n + ' · above-threshold change in ' + p.n_hit +
      ': <span class="is-act">' + p.n_up + ' stronger active</span>, <span class="is-ina">' + p.n_down + ' stronger inactive</span>';
  }

  // A soft fade on the chip row's clipped side(s), so a phone user can tell the row scrolls.
  function chipCue() {
    var el = root.querySelector('.atlas-chips');
    if (!el) return;
    var more = el.scrollWidth - el.clientWidth > 2;
    el.classList.toggle('has-more-right', more && el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    el.classList.toggle('has-more-left', more && el.scrollLeft > 2);
  }

  function lensChanged() {
    var j = lens(), out = $('atlas-lens-readout');
    out.innerHTML = j >= 0 ? lensReadout(j) : (st.color === 'cons' || st.color === 'am' ? 'Choose a position' : 'Hover the bars, or type a generic number');
    out.title = out.textContent;
    $('atlas-lens').classList.toggle('has-lens', j >= 0);
    $('atlas-lens-clear').hidden = st.lensPin < 0;
    rulerCv.setAttribute('aria-valuenow', String((st.lensPin >= 0 ? st.lensPin : 0) + 1));
    rulerCv.setAttribute('aria-valuetext', st.lensPin >= 0 ? st.data.positions[st.lensPin].gn : 'none');
    Array.prototype.forEach.call(root.querySelectorAll('.atlas-chip'), function(b) {
      b.setAttribute('aria-pressed', st.lensPin >= 0 && b.getAttribute('data-gn') === st.data.positions[st.lensPin].gn ? 'true' : 'false');
    });
    chipCue();
    drawRuler();
    if (st.hover >= 0) st.tipKey = '';
    st.legendKey = '';
    refreshPanelLens();
    invalidate();
  }

  function pinLens(j) {
    st.lensPin = j;
    var inp = $('atlas-pos-input');
    if (document.activeElement !== inp) inp.value = j >= 0 ? st.data.positions[j].gn : '';
    lensChanged();
    writeHash();
  }

  function rulerCol(px) {
    if (!rulerGeo) return -1;
    var xs = rulerGeo.xs, best = -1, bd = Infinity;
    for (var j = 0; j < xs.length; j++) { var d = Math.abs(xs[j] - px); if (d < bd) { bd = d; best = j; } }
    return bd <= rulerGeo.cw / 2 + rulerGeo.gap ? best : -1;
  }

  function initRuler() {
    var down = false;
    function px(e) { return e.clientX - rulerCv.getBoundingClientRect().left; }
    rulerCv.addEventListener('pointerdown', function(e) {
      down = true;
      dismissHint();
      try { rulerCv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var j = rulerCol(px(e));
      st.lensHover = j; lensChanged();
      e.preventDefault();
    });
    rulerCv.addEventListener('pointermove', function(e) {
      var j = rulerCol(px(e));
      if (j < 0 && down) j = st.lensHover;
      if (j !== st.lensHover) { st.lensHover = j; lensChanged(); }
    });
    rulerCv.addEventListener('pointerup', function(e) {
      if (!down) return;
      down = false;
      var j = rulerCol(px(e));
      if (j < 0) j = st.lensHover;
      if (j >= 0) pinLens(j);
      if (e.pointerType !== 'mouse') { st.lensHover = -1; lensChanged(); }
    });
    rulerCv.addEventListener('pointercancel', function() { down = false; st.lensHover = -1; lensChanged(); });
    rulerCv.addEventListener('pointerleave', function() { if (!down && st.lensHover >= 0) { st.lensHover = -1; lensChanged(); } });
    rulerCv.addEventListener('keydown', function(e) {
      var j = st.lensPin, m = st.m;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') j = j < 0 ? 0 : Math.min(m - 1, j + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') j = j < 0 ? m - 1 : Math.max(0, j - 1);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = m - 1;
      else if (e.key === 'Escape') j = -1;
      else return;
      e.preventDefault(); e.stopPropagation();
      dismissHint();
      pinLens(j);
    });
    var inp = $('atlas-pos-input');
    function apply() {
      dismissHint();
      var t = inp.value.trim();
      if (!t) { pinLens(-1); return; }
      var j = A.parseGn(st.data, t);
      if (j >= 0) { pinLens(j); inp.value = st.data.positions[j].gn; }
      else $('atlas-lens-readout').textContent = t + ' is not on the shared position axis (generic positions present in at least a quarter of receptors).';
    }
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      if (e.key === 'Escape') { inp.value = ''; pinLens(-1); }
    });
    inp.addEventListener('change', apply);
    Array.prototype.forEach.call(root.querySelectorAll('.atlas-chip'), function(b) {
      b.addEventListener('click', function() {
        var j = A.parseGn(st.data, b.getAttribute('data-gn'));
        dismissHint();
        pinLens(st.lensPin === j ? -1 : j);
      });
    });
    $('atlas-lens-clear').addEventListener('click', function() { pinLens(-1); });
    var chipRow = root.querySelector('.atlas-chips');
    if (chipRow) chipRow.addEventListener('scroll', chipCue, { passive: true });
    chipCue();
  }

  // ================================================================== canvas interaction

  function initPointer() {
    var pts = {}, npts = 0, drag = null, pinch = null, lastTap = 0, lastTapXY = null;
    function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    canvas.addEventListener('pointerdown', function(e) {
      if (!st.data) return;
      var p = local(e);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pts[e.pointerId] = p; npts++;
      st.fly = null; st.inertia = null;
      if (st.zoom) st.zoom = null;
      if (npts === 1) drag = { x: p.x, y: p.y, x0: p.x, y0: p.y, t: e.timeStamp, moved: false, vx: 0, vy: 0, type: e.pointerType };
      else if (npts === 2) {
        var ids = Object.keys(pts), a = pts[ids[0]], b = pts[ids[1]];
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: st.cam.k, wx: wx(mx), wy: wy(my) };
        if (drag) drag.moved = true;
      }
      setHover(-1);
    });

    canvas.addEventListener('pointermove', function(e) {
      if (!st.data) return;
      var p = local(e);
      if (pts[e.pointerId]) {
        pts[e.pointerId] = p;
        if (npts >= 2 && pinch) {
          var ids = Object.keys(pts), a = pts[ids[0]], b = pts[ids[1]];
          var d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          var lim = limits(), k = A.clamp(pinch.k0 * d / pinch.d0, lim.min, lim.max);
          st.cam.k = k; st.cam.x = pinch.wx - (mx - st.W / 2) / k; st.cam.y = pinch.wy - (my - st.H / 2) / k;
          userMoved();
          invalidate();
        } else if (drag) {
          var dx = p.x - drag.x, dy = p.y - drag.y;
          if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) > (drag.type === 'mouse' ? 3 : 8)) {
            drag.moved = true; canvas.classList.add('is-dragging');
          }
          if (drag.moved) {
            st.cam.x -= dx / st.cam.k; st.cam.y -= dy / st.cam.k;
            var dt = Math.max(1, e.timeStamp - drag.t);
            drag.vx = drag.vx * 0.6 + (dx / dt) * 0.4; drag.vy = drag.vy * 0.6 + (dy / dt) * 0.4;
            userMoved();
            invalidate();
          }
          drag.x = p.x; drag.y = p.y; drag.t = e.timeStamp;
        }
        return;
      }
      if (e.pointerType === 'mouse') hoverAt(p.x, p.y);
    });

    function end(e) {
      if (!pts[e.pointerId]) return;
      var p = local(e);
      delete pts[e.pointerId]; npts = Math.max(0, npts - 1);
      if (npts === 1) {
        pinch = null;
        var id = Object.keys(pts)[0];
        drag = { x: pts[id].x, y: pts[id].y, x0: pts[id].x, y0: pts[id].y, t: e.timeStamp, moved: true, vx: 0, vy: 0, type: e.pointerType };
        return;
      }
      if (npts > 0) return;
      canvas.classList.remove('is-dragging');
      if (drag && drag.moved) {
        if (!reduced && e.type !== 'pointercancel' && e.timeStamp - drag.t < 80 && Math.hypot(drag.vx, drag.vy) > 0.08) {
          st.inertia = { vx: drag.vx, vy: drag.vy }; invalidate();
        }
      } else if (drag && e.type !== 'pointercancel') {
        // a tap or click
        var now = e.timeStamp;
        if (e.pointerType !== 'mouse' && lastTapXY && now - lastTap < 320 && Math.hypot(p.x - lastTapXY.x, p.y - lastTapXY.y) < 30) {
          zoomAt(p.x, p.y, 2.2, true); lastTap = 0;
        } else {
          lastTap = now; lastTapXY = p;
          clickAt(p.x, p.y);
        }
      }
      drag = null; pinch = null;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', function(e) { if (e.pointerType === 'mouse' && !npts) { st.hoverCell = null; setHover(-1); invalidate(); } });

    canvas.addEventListener('wheel', function(e) {
      if (!st.data) return;
      e.preventDefault();
      var p = local(e);
      var d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? st.H : 1);
      if (e.ctrlKey) d *= 3;
      d = A.clamp(d, -240, 240);
      zoomAt(p.x, p.y, Math.exp(-d * 0.0019), true);
      setHover(-1);
    }, { passive: false });

    canvas.addEventListener('dblclick', function(e) {
      var p = local(e);
      if (pick(p.x, p.y) >= 0) return;
      e.preventDefault();
      var lim = limits(), k = A.clamp(st.cam.k * 2.2, lim.min, lim.max), w0x = wx(p.x), w0y = wy(p.y);
      flyTo({ k: k, x: w0x - (p.x - st.W / 2) / k, y: w0y - (p.y - st.H / 2) / k }, 650);
      userMoved();
    });

    canvas.addEventListener('keydown', function(e) {
      var step = 120 / st.cam.k, c = st.cam, t = null;
      switch (e.key) {
        case 'ArrowLeft': t = { x: c.x - step, y: c.y, k: c.k }; break;
        case 'ArrowRight': t = { x: c.x + step, y: c.y, k: c.k }; break;
        case 'ArrowUp': t = { x: c.x, y: c.y - step, k: c.k }; break;
        case 'ArrowDown': t = { x: c.x, y: c.y + step, k: c.k }; break;
        case '+': case '=': zoomBy(1.6); break;
        case '-': case '_': zoomBy(1 / 1.6); break;
        case '0': case 'f': fit(); break;
        default: return;
      }
      e.preventDefault();
      if (t) { userMoved(); flyTo(t, 320); }
    });
  }

  function hoverAt(px, py) {
    var i = pick(px, py);
    var hc = i < 0 ? pickCell(px, py) : null;
    var changed = (hc ? hc.i + ':' + hc.j : '') !== (st.hoverCell ? st.hoverCell.i + ':' + st.hoverCell.j : '');
    st.hoverCell = hc;
    if (changed) invalidate();
    setHover(i, px, py);
  }

  function clickAt(px, py) {
    var i = pick(px, py);
    if (i >= 0) { select(i, { fly: true }); return; }
    var c = pickCell(px, py);
    if (c) { pinLens(c.j); select(c.i, { fly: false }); return; }
  }

  // ================================================================== selection + panel

  // The panel and the help card sit below the color card on wide screens, so that control stays usable.
  function positionOverlays() {
    var help = $('atlas-help');
    if (st.W < 700) { panel.style.top = ''; help.style.top = ''; return; }
    var cc = root.querySelector('.atlas-colorcard').getBoundingClientRect(), r = stage.getBoundingClientRect();
    var topPx = Math.round(cc.bottom - r.top + 10), top = topPx + 'px';
    panel.style.top = top; help.style.top = top;
    var lensTop = $('atlas-lens').getBoundingClientRect().top - r.top;
    help.style.maxHeight = Math.max(160, Math.round(lensTop - topPx - 12)) + 'px';
  }

  function panelOpen() { return !panel.hidden && !panel.classList.contains('is-closed'); }

  function flyToReceptor(i) {
    var ins = insets(), L = st.layouts[st.view];
    var x = L.xy[2 * i], y = L.xy[2 * i + 1];
    var k, tx0, ty0;
    if (st.view === 'fingerprints') {
      k = Math.max(st.cam.k, 14);
      tx0 = ins.l + 130; ty0 = ins.t + (st.H - ins.t - ins.b) / 2;
    } else {
      k = Math.max(st.cam.k, 62 / L.s);
      k = Math.min(k, 120 / L.s);
      tx0 = ins.l + (st.W - ins.l - ins.r) / 2; ty0 = ins.t + (st.H - ins.t - ins.b) / 2;
    }
    flyTo({ k: k, x: x - (tx0 - st.W / 2) / k, y: y - (ty0 - st.H / 2) / k });
  }

  function userMoved() { st.userMoved = true; dismissHint(); }

  function dismissHint() {
    var hint = $('atlas-hint');
    if (hint.hidden || hint.classList.contains('is-leaving')) return;
    try { localStorage.setItem('gpcrsynth-atlas-hint', '1'); } catch (e) { /* ignore */ }
    hint.classList.add('is-leaving');
    var docked = hint.classList.contains('is-docked');
    setTimeout(function() {
      hint.hidden = true;
      if (docked && !st.userMoved && st.sel < 0 && st.view === 'families') fit(800);
    }, reduced ? 0 : 400);
  }

  function select(i, opts) {
    opts = opts || {};
    st.sel = i;
    if (i >= 0) dismissHint();
    if (i < 0) { closePanel(); writeHash(); invalidate(); return; }
    openPanel(i);
    // let the panel take its place before the camera computes the free area
    requestAnimationFrame(function() { if (opts.fly !== false) flyToReceptor(i); });
    writeHash();
    invalidate();
  }

  function openPanel(i) {
    var r = st.data.receptors[i], g = st.data.groups[r.group];
    $('atlas-panel-title').textContent = r.symbol;
    var sIn = $('atlas-search-input');
    if (document.activeElement !== sIn) sIn.value = r.symbol;
    if (st.panelGid !== r.gid) { $('atlas-panel-body').scrollTop = 0; panel.classList.remove('is-scrolled'); st.panelGid = r.gid; }
    $('atlas-panel-name').textContent = r.fullName || r.name;
    $('atlas-panel-meta').innerHTML = '<span><span class="pm-dot" style="background:' + g.color + '"></span>' + esc(g.key) + '</span><span>·</span><span>' + esc(r.family) + '</span>';
    $('atlas-panel-report').href = r.report;
    $('atlas-panel-search').href = root.getAttribute('data-search') + '?q=' + encodeURIComponent(r.symbol);
    var dl = '';
    function row(label, value, title) { dl += '<div' + (title ? ' title="' + esc(title) + '"' : '') + '><dt>' + label + '</dt><dd>' + value + '</dd></div>'; }
    row('Contacts above threshold', r.n_above + ' <small>of ' + r.n_pairs + '</small>', 'Contact pairs whose |ΔRRCS| is at or above this receptor’s threshold');
    row('Threshold', '|ΔRRCS| ≥ ' + r.threshold.toFixed(2), 'Mean plus one standard deviation of |ΔRRCS| over all contact pairs, at least 0.2');
    row('Stronger in active', Math.round(r.share_active * 100) + '%', 'Share of above-threshold contacts that are stronger in the active model');
    row('Total change', r.sum_abs_above.toFixed(0) + ' <small>sum |ΔRRCS|</small>', 'Sum of |ΔRRCS| over the above-threshold contacts');
    row('TM6 displacement', r.tm6_shift.toFixed(1) + ' Å', 'Mean C-alpha distance of TM6 between the two models after superposition');
    row('Length', r.length + ' <small>residues</small>');
    $('atlas-panel-stats').innerHTML = dl;
    fillNeighbors(i);
    positionOverlays();
    if (panel.hidden) {
      panel.hidden = false;
      panel.classList.add('is-closed');
      void panel.offsetWidth;
    }
    panel.classList.remove('is-closed');
    requestAnimationFrame(function() { refreshPanelDrawings(); });
    open3D(r.gid);
  }

  // the panel's neighbor list follows the current grouping rule
  function fillNeighbors(i) {
    var r = st.data.receptors[i], R = st.data.receptors, ru = rule(), seqRule = st.rule === 'sequence';
    var sim = $('atlas-panel-similar');
    $('atlas-sim-h').textContent = seqRule ? 'Most similar sequences' : 'Most similar contact patterns';
    $('atlas-sim-rule').textContent = 'Rule: ' + (ru ? ru.label : 'Contact pattern') + (st.rulesState === 'ready' ? '' : '') + '.';
    $('atlas-sim-note').innerHTML = seqRule
      ? 'Bar: sequence identity. Pattern: whole-receptor contact-pattern similarity.'
      : 'Bar: similarity under this rule (0 to 1). Seq.: sequence identity. Chips: the contacts that weigh most in the match, <span class="is-act">red</span> stronger in the active model, <span class="is-ina">blue</span> in the inactive model.';
    sim.innerHTML = '';
    neighbors(i).forEach(function(nb) {
      var o = R[nb.j], pat = nb.sim, comp = nb.comp;
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      var chips = (nb.pairs || []).map(function(pp) {
        return '<span class="sm-chip ' + (pp[2] > 0 ? 'is-act' : 'is-ina') + '" title="Contact ' + pp[0] + ' to ' + pp[1] + ': stronger in the ' +
          (pp[2] > 0 ? 'active' : 'inactive') + ' model of ' + esc(r.symbol) + '">' + pp[0] + '\u2013' + pp[1] + '</span>';
      }).join('');
      var compTxt = seqRule ? 'pattern ' + comp.toFixed(2) : 'seq. ' + Math.round(comp * 100) + '%';
      var contrast = !seqRule && pat >= 0.3 && comp <= 0.22;
      b.innerHTML = '<span class="sm-top"><span class="sm-dot" style="background:' + st.data.groups[o.group].color + '"></span>' +
        '<span class="sm-sym">' + esc(o.symbol) + '</span><span class="sm-fam">' + esc(o.family) + '</span>' +
        '<span class="sm-bar" aria-hidden="true"><span style="width:' + Math.round(A.clamp(pat, 0, 1) * 100) + '%"></span></span>' +
        '<span class="sm-val">' + pat.toFixed(2) + '</span></span>' +
        '<span class="sm-sub"><span class="sm-seq">' + compTxt + '</span>' +
        (contrast ? '<span class="sm-flag">similar pattern, low sequence identity</span>' : '') + chips + '</span>';
      b.setAttribute('aria-label', o.symbol + ', ' + o.family + ': ' + (seqRule ? 'sequence identity ' : 'similarity ') + pat.toFixed(2) + ', ' + compTxt);
      b.addEventListener('click', function() { st.rowHover = -1; select(o.index, { fly: true }); });
      b.addEventListener('mouseenter', function() { st.rowHover = o.index; invalidate(); });
      b.addEventListener('mouseleave', function() { st.rowHover = -1; invalidate(); });
      b.addEventListener('focus', function() { st.rowHover = o.index; invalidate(); });
      b.addEventListener('blur', function() { st.rowHover = -1; invalidate(); });
      li.appendChild(b); sim.appendChild(li);
    });
  }

  function closePanel() {
    if (panel.hidden) return;
    $('atlas-search-input').value = '';
    st.panelGid = null;
    panel.classList.add('is-closed');
    setTimeout(function() { if (panel.classList.contains('is-closed')) panel.hidden = true; }, reduced ? 0 : 420);
    if (st.three && st.three.handle) { try { st.three.handle.play(false); } catch (e) { /* ignore */ } setPlay(false); }
  }

  function refreshPanelDrawings() {
    if (st.sel < 0 || panel.hidden) return;
    var r = st.data.receptors[st.sel], j = st.lensPin >= 0 ? st.lensPin : lens();
    var lh = j >= 0 && HELIX_OF[st.data.positions[j].segment] != null && A.cell(st.data, st.sel, j).present ? HELIX_OF[st.data.positions[j].segment] : -1;
    A.drawBigGlyph($('atlas-panel-glyph'), r, st.P, lh);
    A.drawStrip($('atlas-panel-strip'), st.data, heatByIndex(), st.sel, st.P, j, st.stripHover == null ? -1 : st.stripHover);
  }

  function refreshPanelLens() {
    if (st.sel < 0 || panel.hidden) return;
    var j = lens(), el = $('atlas-panel-lens');
    if (j >= 0) { el.hidden = false; el.innerHTML = lensLine(st.sel, j); }
    else el.hidden = true;
    refreshPanelDrawings();
    if (st.three && st.three.handle) {
      var c = j >= 0 ? A.cell(st.data, st.sel, j) : null;
      try { st.three.handle.setHighlight(c && c.present ? c.resnum : null); } catch (e) { /* ignore */ }
    }
  }

  // The 3D view zooms on the wheel. In the panel that would steal scrolling, so it receives wheel
  // events only after a click inside it, until the pointer leaves.
  function init3DWheelGuard() {
    var c = $('atlas-3d'), engaged = false;
    c.addEventListener('pointerdown', function() { engaged = true; c.classList.add('is-engaged'); }, true);
    c.addEventListener('pointerleave', function() { engaged = false; c.classList.remove('is-engaged'); });
    c.addEventListener('wheel', function(e) { if (!engaged) e.stopPropagation(); }, true);
  }

  function initPanel() {
    init3DWheelGuard();
    var body = $('atlas-panel-body');
    body.addEventListener('scroll', function() { panel.classList.toggle('is-scrolled', body.scrollTop > 2); }, { passive: true });
    $('atlas-panel-close').addEventListener('click', function() { select(-1); canvas.focus({ preventScroll: true }); });
    var strip = $('atlas-panel-strip');
    function col(e) {
      var r = strip.getBoundingClientRect();
      return A.clamp(Math.floor((e.clientX - r.left) / r.width * st.m), 0, st.m - 1);
    }
    strip.addEventListener('pointermove', function(e) {
      if (st.sel < 0) return;
      var j = col(e);
      st.stripHover = j;
      var c = A.cell(st.data, st.sel, j), p = st.data.positions[j];
      $('atlas-strip-readout').innerHTML = !c.present ? p.gn + ': not present'
        : '<strong>' + p.gn + '</strong> ' + c.aa + c.resnum + ' · net ΔRRCS <span class="' + signClass(c.net) + '">' + fmtNum(c.net) + '</span> · ' + c.hit + ' above-threshold';
      refreshPanelDrawings();
    });
    strip.addEventListener('pointerleave', function() {
      st.stripHover = null;
      $('atlas-strip-readout').textContent = 'Net ΔRRCS at each generic position. Hover to read a position; click to set the lens.';
      refreshPanelDrawings();
    });
    strip.addEventListener('click', function(e) { pinLens(col(e)); });
  }

  // ------------------------------------------------------------------ 3D

  function setPlay(on) {
    var b = $('atlas-3d-play');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? 'Pause' : 'Play';
  }

  function load3D() {
    if (st.three) return st.three.promise;
    st.three = {};
    st.three.promise = new Promise(function(resolve, reject) {
      if (window.GPCAtlas3D && window.GPCAtlas3D.mount) { resolve(window.GPCAtlas3D); return; }
      var s = document.createElement('script');
      s.src = root.getAttribute('data-static') + 'js/atlas/atlas-3d.js';
      s.async = true;
      s.onload = function() {
        if (window.GPCAtlas3D && window.GPCAtlas3D.mount) resolve(window.GPCAtlas3D);
        else reject(new Error('no GPCAtlas3D'));
      };
      s.onerror = function() { reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
    return st.three.promise;
  }

  function unavailable3D() {
    $('atlas-3d').innerHTML = '';
    $('atlas-3d-controls').hidden = true;
    $('atlas-3d-status').textContent = '3D view unavailable.';
  }

  function residueColumn(i, resnum) {
    var Ly = st.data.layers, m = Ly.m;
    for (var j = 0; j < m; j++) if (Ly.pos[i * m + j] === resnum) return j;
    return -1;
  }

  function open3D(gid) {
    var status = $('atlas-3d-status');
    var T0 = st.three;
    if (T0 && T0.failed) return;
    status.textContent = 'Loading 3D models';
    load3D().then(function(lib) {
      var T = st.three, cont = $('atlas-3d');
      if (!T.handle) {
        T.handle = lib.mount(cont, {
          dataUrl: root.getAttribute('data-detail'),
          gid: gid,
          labelFor: function(g) { var r = st.data.byGid[g]; return r ? r.symbol : g; },
          onMorph: function(t) { $('atlas-3d-morph').value = String(Math.round(t * 1000)); },
          onResidueHover: function(res) {
            if (st.sel < 0) return;
            if (res == null) { status.textContent = T.baseStatus || ''; return; }
            var j = residueColumn(st.sel, res), aa = '';
            if (j >= 0) aa = A.cell(st.data, st.sel, j).aa;
            status.textContent = 'Residue ' + aa + res + (j >= 0 ? ' (' + st.data.positions[j].gn + '), click to set the lens' : '');
          },
          onResidueClick: function(res) {
            if (st.sel < 0) return;
            var j = residueColumn(st.sel, res);
            if (j >= 0) pinLens(j);
          }
        });
        if (!T.handle) throw new Error('mount returned nothing');
        T.gid = gid;
        bind3DControls();
        $('atlas-3d-controls').hidden = false;
        after3D();
        return;
      }
      if (T.gid === gid) { after3D(); return; }
      T.gid = gid;
      $('atlas-3d-morph').value = '0';
      setPlay(false);
      try { T.handle.play(false); } catch (e) { /* ignore */ }
      Promise.resolve(T.handle.setReceptor(gid)).then(after3D, function() { status.textContent = ''; });
    }).catch(function() {
      if (st.three) st.three.failed = true;
      unavailable3D();
    });
  }

  function after3D() {
    var T = st.three;
    if (!T || !T.handle) return;
    try {
      T.handle.resize();
      T.handle.setMorph(+$('atlas-3d-morph').value / 1000);
      T.handle.setContactsVisible($('atlas-3d-contacts').checked);
    } catch (e) { /* ignore */ }
    T.baseStatus = 'Drag to rotate; click in the view to zoom with the wheel. The slider morphs the inactive model (left) into the active model (right).';
    $('atlas-3d-status').textContent = T.baseStatus;
    refreshPanelLens();
  }

  function bind3DControls() {
    var T = st.three, morph = $('atlas-3d-morph');
    $('atlas-3d-play').addEventListener('click', function() {
      var on = this.getAttribute('aria-pressed') !== 'true';
      try { T.handle.play(on); } catch (e) { /* ignore */ }
      setPlay(on);
    });
    morph.addEventListener('input', function() {
      try { T.handle.setMorph(+morph.value / 1000); } catch (e) { /* ignore */ }
      setPlay(false);
    });
    $('atlas-3d-contacts').addEventListener('change', function() {
      try { T.handle.setContactsVisible(this.checked); } catch (e) { /* ignore */ }
    });
  }

  // ================================================================== search

  function initSearch() {
    var inp = $('atlas-search-input'), list = $('atlas-suggest'), items = [], active = -1;
    function norm(s) { return String(s || '').toLowerCase().replace(/[\s\-_]+/g, ''); }
    // Several words: every word must hit the symbol, an accession, a name or the family, in any order.
    // Short words (1 to 2 characters, such as "d2" or "mu") must start a word, so they do not match inside others.
    function hayFrom(str) {
      var parts = String(str || '').toLowerCase();
      return { text: norm(parts), words: parts.split(/[^a-z0-9]+/).filter(Boolean) };
    }
    function hayOf(r) { return hayFrom([r.symbol, r.gid, r.name, r.fullName, r.family, r.uniprot, r.entry].join(' ')); }
    function hasWord(h, t) {
      if (t.length > 2 && h.text.indexOf(t) >= 0) return true;
      for (var i = 0; i < h.words.length; i++) if (h.words[i].indexOf(t) === 0) return true;
      return false;
    }
    function findWords(q) {
      var toks = String(q || '').toLowerCase().split(/\s+/).map(norm).filter(Boolean);
      if (toks.length < 2) return [];
      var out = [];
      st.data.receptors.forEach(function(r) {
        var h = r._hay || (r._hay = hayOf(r)), ok = true, alt = false;
        for (var i = 0; i < toks.length && ok; i++) {
          if (hasWord(h, toks[i])) continue;
          var x = r._alias ? (r._aliasHay || (r._aliasHay = hayFrom(r._alias))) : null;
          if (x && hasWord(x, toks[i])) alt = true; else ok = false;
        }
        if (ok) out.push([alt ? 7 : 6, r]);
      });
      return out;
    }
    function find(q) {
      var k = norm(q);
      if (!k) return [];
      var out = [];
      st.data.receptors.forEach(function(r) {
        var s = norm(r.symbol), sc = -1;
        if (s === k) sc = 0;
        else if (s.indexOf(k) === 0) sc = 1;
        else if (norm(r.gid).indexOf(k) === 0 || norm(r.name).indexOf(k) === 0) sc = 2;
        else if (s.indexOf(k) > 0) sc = 3;
        else if (k.length > 2 && norm(r.fullName).indexOf(k) >= 0) sc = 4;
        else if (k.length > 2 && norm(r.family).indexOf(k) >= 0) sc = 5;
        else if (k.length > 2 && (norm(r.uniprot).indexOf(k) === 0 || norm(r.entry).indexOf(k) === 0)) sc = 2;
        else if (k.length > 2 && r._alias && norm(r._alias).indexOf(k) >= 0) sc = 7;
        if (sc >= 0) out.push([sc, r]);
      });
      var seen = {};
      out.forEach(function(x) { seen[x[1].gid] = 1; });
      findWords(q).forEach(function(x) { if (!seen[x[1].gid]) out.push(x); });
      out.sort(function(a, b) { return a[0] - b[0] || (a[1].symbol < b[1].symbol ? -1 : 1); });
      return out.slice(0, 8).map(function(x) { return x[1]; });
    }
    function render() {
      list.innerHTML = '';
      items.forEach(function(r, k) {
        var li = document.createElement('li');
        li.id = 'atlas-sg-' + k;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', k === active ? 'true' : 'false');
        li.innerHTML = '<span class="sg-dot" style="background:' + st.data.groups[r.group].color + '"></span><span class="sg-sym">' + esc(r.symbol) + '</span><span class="sg-name">' + esc(r.fullName || r.family) + '</span>';
        li.addEventListener('mousedown', function(e) { e.preventDefault(); choose(r); });
        list.appendChild(li);
      });
      if (!items.length && inp.value.trim()) {
        var li = document.createElement('li');
        li.className = 'sg-empty'; li.textContent = 'No receptor matches';
        list.appendChild(li);
      }
      var show = !!inp.value.trim();
      list.hidden = !show;
      inp.setAttribute('aria-expanded', show && items.length ? 'true' : 'false');
      if (active >= 0) inp.setAttribute('aria-activedescendant', 'atlas-sg-' + active);
      else inp.removeAttribute('aria-activedescendant');
    }
    function choose(r) {
      inp.value = r.symbol;
      items = []; active = -1; list.hidden = true;
      inp.setAttribute('aria-expanded', 'false');
      select(r.index, { fly: true });
    }
    inp.addEventListener('input', function() { if (!st.data) return; items = find(inp.value); active = items.length ? 0 : -1; render(); });
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active]); }
      else if (e.key === 'Escape') { inp.value = ''; items = []; render(); }
    });
    inp.addEventListener('blur', function() { setTimeout(function() { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); }, 120); });
    inp.addEventListener('focus', function() { if (inp.value.trim() && st.data) { items = find(inp.value); render(); } });
  }

  // ================================================================== view + color controls

  var CAPTIONS = {
    families: 'GPCRdb family classification, grouped by ligand type. Not a phylogeny.',
    similarity: 'Receptors whose residue contacts change alike sit close. A browsing aid, not a classification.',
    ranked: 'One number per receptor, highest first, read left to right.',
    fingerprints: 'One row per receptor, one column per generic position.'
  };

  function caption() {
    var r = rule(), lbl = r ? r.label.toLowerCase() : 'contact pattern';
    if (st.view === 'similarity') {
      return (st.rule === 'sequence' ? 'Placed by sequence identity at the shared generic positions.' :
              'Placed by ' + lbl + ' similarity.') + ' Lines join mutual nearest neighbors; colors mark groups. A browsing aid, not a classification.';
    }
    if (st.view === 'tree') {
      return st.rule === 'sequence'
        ? 'Phylogenetic tree of the sequences (maximum likelihood, GPCRdb generic residue positions). Colors: the current groups, a browsing aid, not a classification.'
        : 'Similarity tree (hierarchical clustering) of the ' + lbl + ' measure, not a phylogeny. Colors: the current groups, a browsing aid, not a classification.';
    }
    return CAPTIONS[st.view];
  }

  function syncViewUI() {
    Array.prototype.forEach.call(root.querySelectorAll('.atlas-seg-btn'), function(b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-view') === st.view ? 'true' : 'false');
    });
    $('atlas-caption').textContent = caption();
    syncRuleUI();
    $('atlas-metric-wrap').hidden = st.view !== 'ranked';
    $('atlas-metric').value = st.metric;
    $('atlas-color').value = st.color;
    st.legendKey = '';
  }

  function setColor(c) {
    if (COLORS.indexOf(c) < 0) c = 'activation';
    st.color = c;
    if (c === 'group' && st.rulesState !== 'ready') loadRules().then(function() { st.legendKey = ''; invalidate(); });
    if ((c === 'cons' || c === 'am') && st.lensPin < 0) {
      pinLens(st.data.gnIndex['3.50x50'] != null ? st.data.gnIndex['3.50x50'] : 0);
    }
    syncViewUI();
    lensChanged();
    writeHash();
  }

  function initControls() {
    Array.prototype.forEach.call(root.querySelectorAll('.atlas-seg-btn'), function(b) {
      b.addEventListener('click', function() {
        var v = b.getAttribute('data-view');
        if (v !== st.view) setView(v);
        else fit();
      });
    });
    $('atlas-metric').addEventListener('change', function() { st.metric = this.value; setView('ranked'); });
    $('atlas-color').addEventListener('change', function() { setColor(this.value); });
    $('atlas-rule').addEventListener('change', function() { var v = this.value; loadRules().then(function() { setRule(v); }); });
    $('atlas-k').addEventListener('input', function() { setK(+this.value); });
    $('atlas-zoom-in').addEventListener('click', function() { zoomBy(1.8); });
    $('atlas-zoom-out').addEventListener('click', function() { zoomBy(1 / 1.8); });
    $('atlas-fit').addEventListener('click', function() { fit(); });
    var helpBtn = $('atlas-help-btn'), help = $('atlas-help');
    function toggleHelp(on) {
      positionOverlays();
      help.hidden = !on;
      helpBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    helpBtn.addEventListener('click', function() { toggleHelp(help.hidden); });
    help.querySelector('[data-close-help]').addEventListener('click', function() { toggleHelp(false); helpBtn.focus(); });
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (!help.hidden) { toggleHelp(false); return; }
      if (st.lensPin >= 0) { pinLens(-1); return; }
      if (st.sel >= 0) select(-1);
    });
    var hint = $('atlas-hint'), seen = false;
    try { seen = localStorage.getItem('gpcrsynth-atlas-hint') === '1'; } catch (e) { seen = false; }
    if (!seen) {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
        hint.querySelector('span').textContent = 'Pinch to zoom, drag to move. Touch the bars at the bottom to light up one position. Tap a receptor for details.';
      }
      hint.hidden = false;
    }
    $('atlas-hint-close').addEventListener('click', dismissHint);
  }

  // ================================================================== hash

  var hashTimer = 0, applyingHash = false;
  function writeHash() {
    if (applyingHash || !st.data) return;
    clearTimeout(hashTimer);
    hashTimer = setTimeout(function() {
      var parts = ['view=' + st.view];
      if (st.view === 'ranked') parts.push('metric=' + st.metric);
      if (st.rule !== 'pattern') parts.push('rule=' + st.rule);
      if (st.k !== K_DEFAULT && (st.view === 'similarity' || st.view === 'tree' || st.color === 'group')) parts.push('k=' + st.k);
      if (st.color !== 'activation') parts.push('color=' + st.color);
      if (st.lensPin >= 0) parts.push('pos=' + st.data.positions[st.lensPin].gn);
      if (st.sel >= 0) parts.push('receptor=' + st.data.receptors[st.sel].gid);
      var h = '#' + parts.join('&');
      if (location.hash !== h) {
        try { history.replaceState(null, '', h); } catch (e) { /* ignore */ }
      }
    }, 200);
  }
  function readHash() {
    var out = {};
    location.hash.replace(/^#/, '').split('&').forEach(function(kv) {
      var p = kv.split('=');
      if (p[0]) out[decodeURIComponent(p[0])] = decodeURIComponent(p.slice(1).join('=') || '');
    });
    return out;
  }
  function applyHash(intro) {
    var h = readHash();
    applyingHash = true;
    if (h.metric && A.METRICS[h.metric]) st.metric = h.metric;
    if (st.rulesState === 'ready') {
      if (h.k) { st.k = A.clamp(parseInt(h.k, 10) || K_DEFAULT, K_MIN, K_MAX); }
      var wantRule = st.rules[h.rule] ? h.rule : 'pattern';
      if (wantRule !== st.rule || h.k) setRule(wantRule, { quiet: true });
    }
    var view = VIEWS.indexOf(h.view) >= 0 ? h.view : 'families';
    if (view === 'tree' && !st.layouts.tree) view = 'similarity';
    var j = h.pos ? A.parseGn(st.data, h.pos) : -1;
    st.lensPin = j;
    if (COLORS.indexOf(h.color) >= 0) st.color = h.color;
    if ((st.color === 'cons' || st.color === 'am') && st.lensPin < 0) st.lensPin = st.data.gnIndex['3.50x50'] || 0;
    $('atlas-pos-input').value = st.lensPin >= 0 ? st.data.positions[st.lensPin].gn : '';
    var rec = h.receptor || h.r;
    var ri = rec && st.data.byGid[rec] ? st.data.byGid[rec].index : -1;
    if (intro || view !== st.view) setView(view, { intro: intro, camera: true });
    syncViewUI();
    lensChanged();
    applyingHash = false;
    if (ri >= 0) {
      setTimeout(function() { select(ri, { fly: true }); }, intro && !reduced ? 1300 : 0);
    } else if (st.sel >= 0) select(-1);
    writeHash();
  }

  // ================================================================== theme + size

  function rebuildPalette() {
    st.P = A.buildPalette(stage, st.data.groups);
    A.prepareColors(st.data, st.P);
    st.heat = {}; st.heatIdx = null;
    st.halos = A.buildHalos(st.data.groups, st.P);
    st.haloField = null;
    st.groupText = st.data.groups.map(function(g) {
      var c = A.parseColor(g.color);
      return A.css(st.P.dark ? A.mix(c, [255, 255, 255, 1], 0.38) : A.mix(c, [0, 0, 0, 1], 0.12));
    });
    st.grpText = [];
    for (var gh = 0; gh < st.P.nGroupHues; gh++) {
      var gc = st.P.colors[st.P.grpBase + gh];
      st.grpText.push(A.css(st.P.dark ? A.mix(gc, [255, 255, 255, 1], 0.2) : A.mix(gc, [0, 0, 0, 1], 0.15)));
    }
    st.groupField = null; st.grpSprites = null; st.treeCache = null;
    st.legendKey = ''; st.tipKey = '';
    drawRuler();
    refreshPanelDrawings();
    invalidate();
  }

  function resize() {
    var r = stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    var oldW = st.W, oldH = st.H;
    st.W = W; st.H = H; st.dpr = dpr;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    st.insCache = null; st.treeCache = null;
    positionOverlays();
    chipCue();
    if (st.data && st.P) {
      if (oldW && !st.userMoved && !st.fly && st.sel < 0) {
        var f = fitView(st.layouts[st.view]); st.cam.x = f.x; st.cam.y = f.y; st.cam.k = f.k;
      }
      drawRuler();
      refreshPanelDrawings();
      if (st.three && st.three.handle) { try { st.three.handle.resize(); } catch (e) { /* ignore */ } }
      st.legendKey = '';
      draw(performance.now());
    }
  }

  function measureTop() {
    var tb = document.querySelector('.topbar');
    if (tb) root.style.setProperty('--atlas-top', tb.getBoundingClientRect().height + 'px');
  }

  // ================================================================== boot

  function boot(index) {
    var D = A.decode(index);
    st.data = D; st.n = D.receptors.length; st.m = D.layers.m;
    var n = st.n;
    X = new Float32Array(n); Y = new Float32Array(n); S = new Float32Array(n); vis = new Uint8Array(n);
    gx = new Float32Array(n); gy = new Float32Array(n); gs = new Float32Array(n);
    fx = new Float32Array(n); fy = new Float32Array(n); fs = new Float32Array(n);
    tx = new Float32Array(n); ty = new Float32Array(n); ts = new Float32Array(n); delay = new Float32Array(n);
    colors = []; for (var i = 0; i < n; i++) colors.push({ scalar: -1, dot: 0, dim: false, lensHelix: -1 });
    st.layouts.families = A.layoutFamilies(D);
    // the default rule (contact pattern) ships in index.json; the other rules and every tree load later
    st.rules.pattern = A.prepareRule(D, { id: 'pattern', label: 'Contact pattern', xy: D.receptors.map(function(r) { return r.sim_xy; }),
                                          links: index.links || [], similar: D.receptors.map(function(r) { return r.similar || []; }) });
    st.rules.pattern.description = 'Which contacts change between the two models, and in which direction, over the whole receptor.';
    st.layouts.similarity = ruleSimilarity('pattern');
    st.layouts.ranked = A.layoutRanked(D, st.metric);
    var fp = A.layoutFingerprints(D);
    // heat map rows in display order, and each block's first row in that order
    var rows = [], r0 = 0;
    fp.deco.blocks.forEach(function(b) { b.r0 = r0; r0 += b.rows.length; rows.push.apply(rows, b.rows); });
    fp.rows = rows;
    st.layouts.fingerprints = fp;
    // every glyph starts at the center, small, for the opening
    for (i = 0; i < n; i++) { gx[i] = 0; gy[i] = 0; gs[i] = 0.15; }
    $('atlas-help-sign').textContent = 'Each value is a ΔRRCS: the contact score in the active model minus the inactive model.';
    $('atlas-help-threshold').textContent = index.threshold_rule || '';
    $('atlas-help-npos').textContent = String(st.m);
    rulerCv.setAttribute('aria-valuemax', String(st.m));
    measureTop();
    rebuildPalette();
    resize();
    var f = fitView(st.layouts.families);
    st.cam.x = f.x; st.cam.y = f.y; st.cam.k = f.k;
    initControls(); initRuler(); initPointer(); initPanel(); initSearch();
    st.meanS = 0; maybeLegend();
    var hintEl = $('atlas-hint');
    if (!hintEl.hidden) {
      var fc = fitCircle(st.layouts.families);
      if ((st.layouts.families.R0 - 2.4) * fc.k < 215 || VIEWS.indexOf(readHash().view) > 0) dockHint();
    }
    var hh = readHash();
    var needRules = hh.view === 'tree' || (hh.rule && hh.rule !== 'pattern') || hh.color === 'group' || hh.k;
    if (needRules) loadRules().then(function() { applyHash(true); });
    else {
      applyHash(true);
      // after the opening, quietly
      setTimeout(function() { loadRules(); }, reduced ? 200 : 1600);
    }
    var ld = $('atlas-loading');
    ld.classList.add('is-done');
    setTimeout(function() { ld.hidden = true; }, 500);
    window.addEventListener('hashchange', function() { applyHash(false); });
    new MutationObserver(function() { rebuildPalette(); if (st.three && st.three.handle) { /* the 3D view re-reads colors itself */ } })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode'] });
    if (window.ResizeObserver) new ResizeObserver(function() { measureTop(); resize(); }).observe(stage);
    else window.addEventListener('resize', function() { measureTop(); resize(); });
    // full protein names for the tooltip, the panel and search (optional)
    var metaUrl = root.getAttribute('data-meta');
    if (metaUrl && window.fetch) {
      fetch(metaUrl).then(function(r) { return r.ok ? r.json() : null; }).then(function(meta) {
        if (!meta || !meta.receptors) return;
        var fi = (meta.receptorFields || []).indexOf('name');
        if (fi < 0) return;
        var ui = meta.receptorFields.indexOf('uniprot'), ei = meta.receptorFields.indexOf('entry');
        meta.receptors.forEach(function(row) {
          var r = D.byGid[row[0]];
          if (!r) return;
          if (row[fi]) r.fullName = row[fi];
          if (ui >= 0 && row[ui]) r.uniprot = row[ui];
          if (ei >= 0 && row[ei]) r.entry = row[ei];
          r._hay = null;
        });
        // curated common names and synonyms (for example "serotonin"), searched after the primary fields
        var ai = (meta.aliasFields || []).indexOf('display'), ri = (meta.aliasFields || []).indexOf('receptor'), ci = (meta.aliasFields || []).indexOf('collision'); var ti = (meta.aliasFields || []).indexOf('tier');
        if (ai >= 0 && ri >= 0 && meta.aliases) {
          var acc = {};
          meta.aliases.forEach(function(a) {
            if (ci >= 0 && a[ci]) return;
            if (ti >= 0 && a[ti] === 0) return;             // tier 0 is identifiers (accessions, gene and Ensembl ids)
            var row = meta.receptors[a[ri]];
            if (row) (acc[row[0]] = acc[row[0]] || []).push(a[ai]);
          });
          Object.keys(acc).forEach(function(g) { var r = D.byGid[g]; if (r) { r._alias = acc[g].join(' '); r._aliasHay = null; } });
        }
        if (st.sel >= 0) $('atlas-panel-name').textContent = D.receptors[st.sel].fullName;
        st.tipKey = '';
      }).catch(function() { /* names stay as the entry names */ });
    }
    window.__atlas = st; // for debugging and tests (st.rule, st.k, st.groupCount, st.rulesState)
  }

  measureTop();
  fetch(root.getAttribute('data-index'))
    .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(boot)
    .catch(function(err) {
      var ld = $('atlas-loading');
      ld.textContent = 'The atlas data could not be loaded.';
      ld.classList.add('is-error');
      if (window.console) console.error(err);
    });
})();
