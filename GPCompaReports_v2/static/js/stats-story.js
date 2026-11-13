/* stats-story.js: the Statistics page (templates/statistics.html, static/css/stats.css).

   The page answers four questions top to bottom, then places the reader's receptor. Every card is drawn
   here from the class payloads in data/stats/ (fetched when the card comes within 600 px of the viewport;
   statistics_page.py and analysis/class_results.py write them), as in-house SVG or canvas; the receptor
   explorer's scatter is the only Plotly chart, loaded only for that card.

   Shared selection (StatsSel): { rec: gid | null, pos: generic number | null, pair: [i, j] | null }. pos and
   pair are exclusive. It lives in the URL (?sel=rec:<gid>,pos:<gn> or pair:TM3-TM6, history.replaceState),
   starts empty, and every change dispatches 'gpc:stats-select' on document; each card redraws from the
   payloads it already holds. Card footers: Table, Method, Export (PNG 2x, SVG with light-theme colors
   resolved, CSV, Copy caption). Charts read the CSS tokens of .stats at draw time and redraw on
   'gpcrsynth-theme-change' (hidden ones when next shown).

   Colors, one job each: red = stronger in the active model, blue = stronger in the inactive model (signed
   ΔRRCS only); neutral ink = unsigned magnitude; sequential teal = counts and recurrence; the clinical tint
   (crimson predicted pathogenic, gray ambiguous, green predicted benign) only in section 4 and the profile;
   ligand hues only in section 5. Motion only on first reveal, never under prefers-reduced-motion. */
(function () {
  'use strict';

  var ROOT = document.documentElement;
  var STATS = document.querySelector('.stats');
  var CFG_EL = document.getElementById('stats-config');
  if (!STATS || !CFG_EL) return;
  var CFG = JSON.parse(CFG_EL.textContent);
  var TOP = CFG.top_n, NREC = CFG.n_receptors;
  var NS = 'http://www.w3.org/2000/svg';
  var PHONE = window.matchMedia('(max-width: 720px)');
  var WIDE = window.matchMedia('(min-width: 1100px)');
  var REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)');
  var SCROLL = function () { return REDUCE.matches ? 'auto' : 'smooth'; };
  var REPORT = function (gid) { return 'reports/' + gid + '.html'; };
  var SEARCH = function (q) { return 'search/index.html?q=' + encodeURIComponent(q); };
  var HELIX = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'];
  var MOTIF_ORDER = ['D2.50', 'DRY', 'PIF', 'CWxP', 'NPxxY'];
  var LIGAND_DARK = {
    'Peptide receptors': '#5EEAD4', 'Orphan receptors': '#FCD34D', 'Aminergic receptors': '#C4B5FD',
    'Lipid receptors': '#F0ABFC', 'Protein receptors': '#4ADE80', 'Nucleotide receptors': '#BEF264',
    'Sensory receptors': '#D4A373', 'Other': '#9CA3AF'
  };
  var NF = new Intl.NumberFormat('en-US');

  // ------------------------------------------------------------------ tokens
  var TOKENS = { bg: 'st-bg', surface: 'st-surface', surface2: 'st-surface-2', plate: 'st-plate', fg: 'st-fg',
    muted: 'st-muted', faint: 'st-faint', line: 'st-line', lineSoft: 'st-line-soft', brand: 'st-brand',
    brandSoft: 'st-brand-soft', rule: 'st-rule', active: 'st-active', inactive: 'st-inactive',
    neutral: 'st-neutral-div', path: 'path', amb: 'amb', ben: 'ben', pathSoft: 'path-soft', ink: 'st-ink-bar',
    cellEmpty: 'st-cell-empty', onDark: 'st-on-dark', b0: 'b0', b1: 'b1', b2: 'b2', b3: 'b3', b4: 'b4', b5: 'b5' };
  function readTokens(node) {
    var s = getComputedStyle(node), out = {};
    Object.keys(TOKENS).forEach(function (k) { out[k] = s.getPropertyValue('--' + TOKENS[k]).trim(); });
    out.dark = node === STATS && ROOT.getAttribute('data-color-mode') === 'dark';
    return out;
  }
  var C = {};
  function refreshTokens() { C = readTokens(STATS); }
  var LIGHT = null;
  function lightTokens() {
    if (!LIGHT) {
      var probe = document.createElement('div');
      probe.className = 'stats-probe';
      document.body.appendChild(probe);
      LIGHT = readTokens(probe);
      LIGHT.dark = false;
      document.body.removeChild(probe);
    }
    return LIGHT;
  }

  // ------------------------------------------------------------------ small helpers
  function fmt(n) { return n === null || n === undefined ? '' : NF.format(n); }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function signed(x, d) {
    if (x === null || x === undefined) return '';
    var s = Math.abs(x).toFixed(d === undefined ? 2 : d);
    return (x > 0 ? '+' : x < 0 ? '−' : '') + s;
  }
  function pct(x, d) { return (100 * x).toFixed(d || 0) + '%'; }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function quant(a, q) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(q * (s.length - 1))]; }
  function maxOf(a) { return a.reduce(function (m, v) { return v > m ? v : m; }, -Infinity); }
  function minOf(a) { return a.reduce(function (m, v) { return v < m ? v : m; }, Infinity); }
  function isPhone() { return PHONE.matches; }
  function rows(cols, list) { return list.map(function (r) { var o = {}; cols.forEach(function (c, i) { o[c] = r[i]; }); return o; }); }
  function el(tag, attrs, parent, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function svgIn(node, w, hgt, label) {
    var s = el('svg', { viewBox: '0 0 ' + w + ' ' + hgt, width: w, height: hgt, role: 'img', 'aria-label': label || null,
      style: 'max-width:100%;height:auto' }, node);
    return s;
  }
  // text width at a font size (the page's sans stack), to fit captions and clamp labels
  var MEASURE = document.createElement('canvas').getContext('2d');
  function textW(str, size, weight) {
    MEASURE.font = (weight || 400) + ' ' + (size || 11) + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    return MEASURE.measureText(String(str)).width;
  }
  function fit(list, maxW, size, weight) {   // the first text of the list that fits, else the last
    for (var i = 0; i < list.length; i++) if (textW(list[i], size, weight) <= maxW) return list[i];
    return list[list.length - 1];
  }
  function clampX(cx, str, size, weight, lo, hi) {   // a middle-anchored label kept inside [lo, hi]
    var half = textW(str, size, weight) / 2 + 2;
    return Math.max(lo + half, Math.min(hi - half, cx));
  }
  function width(node) { return Math.max(260, Math.floor(node.clientWidth || node.getBoundingClientRect().width || 600)); }
  function hexRGB(c) {
    if (!c) return [128, 128, 128];
    if (c.charAt(0) === '#') { c = c.slice(1); if (c.length === 3) c = c.replace(/./g, '$&$&'); return [0, 2, 4].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
    var m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }
  function mix(a, b, t) {
    var A = hexRGB(a), B = hexRGB(b);
    return 'rgb(' + A.map(function (v, i) { return Math.round(v + (B[i] - v) * t); }).join(',') + ')';
  }
  function divColor(v, cap) {   // signed ΔRRCS: blue (inactive) .. neutral .. red (active)
    var t = Math.max(-1, Math.min(1, v / cap));
    return t >= 0 ? mix(C.neutral, C.active, Math.sqrt(t)) : mix(C.neutral, C.inactive, Math.sqrt(-t));
  }
  function bandOf(n, bands) {
    for (var i = 0; i < bands.length; i++) if (n >= bands[i].lo && (bands[i].hi === null || n <= bands[i].hi)) return i;
    return 0;
  }
  function band(i) { return C['b' + Math.max(0, Math.min(5, i))]; }
  function anim(o) { return o && o.first && !o.exporting && !REDUCE.matches; }
  function pairName(p) { return HELIX[p[0]] + '-' + HELIX[p[1]]; }
  function samePair(a, b) { return !!a && !!b && a[0] === b[0] && a[1] === b[1]; }
  function segRank(seg) { return window.GPCSegOrder ? window.GPCSegOrder.rank(seg) : (HELIX.indexOf(seg) < 0 ? 99 : HELIX.indexOf(seg)); }
  function segMode() { return window.GPCSegOrder ? window.GPCSegOrder.mode() : 'helices'; }

  // ------------------------------------------------------------------ data
  var cache = {};
  function load(name) {
    var url = CFG.urls[name] || name;
    if (!cache[url]) {
      cache[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.json();
      });
      cache[url].catch(function () { delete cache[url]; });
    }
    return cache[url];
  }
  function loadAll(names) {
    return Promise.all(names.map(load)).then(function (list) {
      var D = {}; names.forEach(function (n, i) { D[n] = list[i]; }); return D;
    });
  }
  var csvCache = {};
  function loadCSV(url) {
    if (!csvCache[url]) {
      csvCache[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.text();
      }).then(parseCSV);
    }
    return csvCache[url];
  }
  function parseCSV(text) {
    var out = [], row = [], f = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; out.push(row); row = []; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); out.push(row); }
    out = out.filter(function (r) { return !(r.length === 1 && r[0] === '') && !(r[0] && r[0].charAt(0) === '#'); });
    return { header: out[0] || [], rows: out.slice(1) };
  }

  // indexes over the payloads, built once
  var IDX = {};
  function receptorIndex(rj) {
    if (IDX.rec) return IDX.rec;
    var list = rows(rj.columns, rj.rows), by = {};
    list.forEach(function (r) { by[r.gid] = r; });
    IDX.rec = { list: list, by: by };
    return IDX.rec;
  }
  function positionIndex(cp) {
    if (IDX.pos) return IDX.pos;
    var rk = rows(cp.ranking_columns, cp.ranking), by = {};
    rk.forEach(function (r) { by[r.gn] = r; });
    var partners = {}; rows(cp.partner_columns, cp.partners).forEach(function (r) { partners[r.gn] = r; });
    var cons = {}; rows(cp.conservation.columns, cp.conservation.rows).forEach(function (r) { cons[r.gn] = r; });
    var motif = {}; cp.motifs.forEach(function (m) { m.positions.forEach(function (g) { motif[g] = m.name; }); });
    var rec = {}; rows(cp.recovery.columns, cp.recovery.rows).forEach(function (r) { rec[r.gn] = r; });
    IDX.pos = { ranking: rk, by: by, partners: partners, cons: cons, motif: motif, recovery: rec };
    return IDX.pos;
  }
  function ligandColors(rj, tok) {
    var m = {};
    rj.ligand_groups.forEach(function (g) { m[g.key] = (tok || C).dark ? (LIGAND_DARK[g.key] || g.color) : g.color; });
    return m;
  }

  // ------------------------------------------------------------------ tooltip
  var TIP = h('div', 'st-tip', document.body); TIP.hidden = true; TIP.setAttribute('role', 'tooltip');
  function showTip(x, y, text) {
    TIP.textContent = text; TIP.hidden = false;
    var r = TIP.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    var left = Math.min(vw - r.width - 8, Math.max(8, x + 12)), top = y + 16;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 12;
    TIP.style.left = left + 'px'; TIP.style.top = top + 'px';
  }
  function hideTip() { TIP.hidden = true; }
  document.addEventListener('pointermove', function (e) {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-own-tip')) return;   // the matrix canvas
    var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t && STATS.contains(t)) showTip(e.clientX, e.clientY, t.getAttribute('data-tip')); else if (!TIP.hidden) hideTip();
  }, { passive: true });
  document.addEventListener('scroll', hideTip, { passive: true });
  // keyboard: SVG marks that act take tabindex and role=button; dense marks (one dot per receptor or residue)
  // stay out of the Tab order, the selection box reaches the same receptors and positions
  function hit(node, tip, fn, label, dense) {
    if (tip) node.setAttribute('data-tip', tip);
    if (fn) {
      node.setAttribute('data-hit', '1');
      if (!dense) {
        node.setAttribute('tabindex', '0');
        node.setAttribute('role', 'button');
        if (label || tip) { node.setAttribute('aria-label', label || tip); node.setAttribute('data-key', label || tip); }
      }
      node.addEventListener('click', function (e) { e.stopPropagation(); hideTip(); fn(e, node); });
      node.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e, node); } });
    }
    return node;
  }
  // one Tab stop per chart: the marks of an SVG share a roving tabindex, arrow keys move between them
  function roving(svg, prefer) {
    var marks = Array.prototype.slice.call(svg.querySelectorAll('[role="button"][data-key]'));
    if (marks.length < 2) return;
    var cur = (prefer && marks.filter(function (m) { return m.getAttribute('data-key') === prefer; })[0]) || marks[0];
    marks.forEach(function (m) { m.setAttribute('tabindex', m === cur ? '0' : '-1'); });
    if (svg.__roving) return;
    svg.__roving = true;
    svg.addEventListener('keydown', function (e) {
      var keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 'first', End: 'last' };
      if (!(e.key in keys)) return;
      var all = Array.prototype.slice.call(svg.querySelectorAll('[role="button"][data-key]')), i = all.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      var k = keys[e.key], j = k === 'first' ? 0 : k === 'last' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + k));
      all.forEach(function (m, n) { m.setAttribute('tabindex', n === j ? '0' : '-1'); });
      all[j].focus();
    });
  }
  // the focused mark of a card, by key, so a redraw can give focus back to its successor
  function focusKey(root) {
    var a = document.activeElement;
    if (!a || !root || !root.contains(a)) return null;
    return a.getAttribute('data-key') || null;
  }
  function refocus(root, key) {
    if (!key || !root) return;
    var n = root.querySelector('[data-key="' + key.replace(/["\\]/g, '\\$&') + '"]');
    if (!n || document.activeElement === n) return;
    var sv = n.closest && n.closest('svg');
    if (sv && sv.__roving) sv.querySelectorAll('[role="button"][data-key]').forEach(function (m) { m.setAttribute('tabindex', '-1'); });
    if (n.getAttribute('role') === 'button') n.setAttribute('tabindex', '0');
    n.focus({ preventScroll: true });
  }
  // hovering a position marks it in every chart that draws it (data-gn)
  function hoverGn(gn, on) {
    document.querySelectorAll('[data-gn="' + gn + '"]').forEach(function (n) { n.classList.toggle('is-hover', !!on); });
  }
  document.addEventListener('pointerover', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-gn]') : null;
    if (t) hoverGn(t.getAttribute('data-gn'), true);
  });
  document.addEventListener('pointerout', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-gn]') : null;
    if (t) hoverGn(t.getAttribute('data-gn'), false);
  });

  // ------------------------------------------------------------------ StatsSel: the shared selection
  var StatsSel = (function () {
    var state = { rec: null, pos: null, pair: null };
    function parsePair(s) {
      var m = String(s || '').trim().toUpperCase().match(/^(TM[1-7]|H8)\s*(?:-|–|\s+AND\s+|\s+)\s*(TM[1-7]|H8)$/);
      if (!m) return null;
      var a = HELIX.indexOf(m[1]), b = HELIX.indexOf(m[2]);
      if (a < 0 || b < 0 || a === b) return null;
      return a < b ? [a, b] : [b, a];
    }
    function get() { return { rec: state.rec, pos: state.pos, pair: state.pair ? state.pair.slice() : null }; }
    function writeURL() {
      var params = new URLSearchParams(location.search), parts = [];
      if (state.rec) parts.push('rec:' + state.rec);
      if (state.pos) parts.push('pos:' + state.pos);
      if (state.pair) parts.push('pair:' + pairName(state.pair));
      if (parts.length) params.set('sel', parts.join(',')); else params.delete('sel');
      var q = params.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',');
      try { history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* file URLs */ }
    }
    function set(patch, opts) {
      var next = get();
      if ('rec' in patch) next.rec = patch.rec || null;
      if ('pos' in patch) { next.pos = patch.pos || null; if (next.pos) next.pair = null; }
      if ('pair' in patch) { next.pair = patch.pair || null; if (next.pair) next.pos = null; }
      var samePairs = (!next.pair && !state.pair) || samePair(next.pair, state.pair);
      if (next.rec === state.rec && next.pos === state.pos && samePairs && !(opts && opts.force)) return;
      state = next;
      writeURL();
      document.dispatchEvent(new CustomEvent('gpc:stats-select', { detail: Object.assign(get(), { noProfile: !!(opts && opts.noProfile) }) }));
    }
    function clear(kind) { var p = {}; p[kind] = null; set(p); }
    // ?sel= on load, validated against the payloads; unknown kinds or values are dropped silently
    function fromURL() {
      var raw = new URLSearchParams(location.search).get('sel');
      if (!raw) {
        if (state.rec || state.pos || state.pair) {
          state = { rec: null, pos: null, pair: null };
          document.dispatchEvent(new CustomEvent('gpc:stats-select', { detail: Object.assign(get(), { fromURL: true }) }));
        }
        return Promise.resolve();
      }
      var want = {};
      raw.split(',').forEach(function (part) {
        var i = part.indexOf(':'); if (i < 0) return;
        var k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
        if (k === 'rec' || k === 'pos' || k === 'pair') want[k] = v;
      });
      var jobs = [];
      if (want.rec) jobs.push(load('receptors').then(function (rj) { return receptorIndex(rj).by[want.rec] ? { rec: want.rec } : {}; }, function () { return {}; }));
      if (want.pos) jobs.push(load('class_positions').then(function (cp) { return positionIndex(cp).by[want.pos] ? { pos: want.pos } : {}; }, function () { return {}; }));
      else if (want.pair) { var p = parsePair(want.pair); if (p) jobs.push(Promise.resolve({ pair: p })); }
      return Promise.all(jobs).then(function (list) {
        var patch = {}; list.forEach(function (o) { for (var k in o) patch[k] = o[k]; });
        state = { rec: patch.rec || null, pos: patch.pos || null, pair: patch.pair || null };
        writeURL();
        document.dispatchEvent(new CustomEvent('gpc:stats-select', { detail: Object.assign(get(), { fromURL: true }) }));
      });
    }
    return { get: get, set: set, clear: clear, fromURL: fromURL, parsePair: parsePair };
  })();
  window.StatsSel = StatsSel;
  // Back and Forward: the page follows the ?sel of the history entry
  window.addEventListener('popstate', function () { StatsSel.fromURL(); });
  function urlParam(k) { return new URLSearchParams(location.search).get(k); }
  function setUrlParam(k, v) {
    var params = new URLSearchParams(location.search);
    if (v) params.set(k, v); else params.delete(k);
    var q = params.toString().replace(/%3A/gi, ':').replace(/%2C/gi, ',');
    try { history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ the selection box
  var SelBox = (function () {
    var box = document.getElementById('stats-sel');
    if (!box) return { summary: function () {} };
    var input = box.querySelector('#sel-input'), list = box.querySelector('#sel-list');
    var chips = box.querySelector('[data-sel-chips]'), summary = box.querySelector('[data-sel-summary]');
    var shown = [], active = -1, ready = null;
    box.hidden = false;
    function place() {
      var slot = document.querySelector('[data-sel-slot="' + (WIDE.matches ? 'rail' : 'main') + '"]');
      if (slot && box.parentNode !== slot) slot.appendChild(box);
    }
    place();
    WIDE.addEventListener('change', place);
    function data() {
      if (!ready) ready = Promise.all([load('receptors'), load('class_positions'), load('helix_pairs')]);
      return ready;
    }
    input.addEventListener('focus', function () { data().then(function () { if (input.value.trim()) suggest(); }, function () {}); });
    function suggest() {
      data().then(function (arr) {
        var R = receptorIndex(arr[0]), P = positionIndex(arr[1]);
        var q = input.value.trim().toLowerCase(), out = [];
        clear(list); shown = []; active = -1;
        if (!q) { close(); return; }
        var pair = StatsSel.parsePair(q);
        var recs = R.list.filter(function (r) {
          return [r.symbol, r.gid, r.name, r.protein_name, r.family].some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
        }).sort(function (a, b) {
          var as = a.symbol.toLowerCase().indexOf(q) === 0 ? 0 : 1, bs = b.symbol.toLowerCase().indexOf(q) === 0 ? 0 : 1;
          return as - bs || a.symbol.localeCompare(b.symbol);
        });
        var poss = /^\d/.test(q) ? P.ranking.filter(function (r) { return r.gn.toLowerCase().indexOf(q) === 0; }) : [];
        var nP = pair ? 1 : 0, nPos = Math.min(poss.length, pair ? 2 : 4), nR = Math.min(recs.length, 8 - nPos - nP);
        if (nR < 0) nR = 0;
        if (nR) out.push(['Receptors', recs.slice(0, nR).map(function (r) { return { kind: 'rec', value: r.gid, label: r.symbol, sub: (r.protein_name || r.name) + ', ' + r.family }; })]);
        if (nPos) out.push(['Positions', poss.slice(0, nPos).map(function (r) { return { kind: 'pos', value: r.gn, label: r.gn, sub: r.segment + ', rank ' + r.rank }; })]);
        if (nP) out.push(['Helix pairs', [{ kind: 'pair', value: pair, label: pairName(pair), sub: 'helix pair' }]]);
        out.forEach(function (g) {
          h('li', 'grp', list, g[0]).setAttribute('role', 'presentation');
          g[1].forEach(function (it) {
            var li = h('li', '', list); li.setAttribute('role', 'option'); li.id = 'sel-opt-' + shown.length;
            h('span', '', li, it.label); h('small', '', li, it.sub);
            li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(it); });
            shown.push(it);
          });
        });
        if (!shown.length) { var li = h('li', 'grp', list, 'No receptor, position or helix pair matches'); li.setAttribute('role', 'presentation'); }
        list.hidden = false; input.setAttribute('aria-expanded', 'true');
      }, function () {});
    }
    function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
    function pick(it) {
      input.value = ''; close();
      if (it.kind === 'rec') StatsSel.set({ rec: it.value });
      else if (it.kind === 'pos') StatsSel.set({ pos: it.value });
      else StatsSel.set({ pair: it.value });
    }
    function mark() {
      var opts = list.querySelectorAll('[role="option"]');
      opts.forEach(function (o, i) { o.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
      if (active >= 0 && opts[active]) { input.setAttribute('aria-activedescendant', opts[active].id); opts[active].scrollIntoView({ block: 'nearest' }); }
    }
    input.addEventListener('input', suggest);
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (!list.hidden) e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) suggest(); active = Math.min(active + 1, shown.length - 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); mark(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (shown.length) pick(shown[active < 0 ? 0 : active]);
        else { var p = StatsSel.parsePair(input.value); if (p) pick({ kind: 'pair', value: p }); }
      }
    });
    function chip(text, kind) {
      var c = h('span', 'sel-chip', chips, text);
      var x = h('button', '', c, '×'); x.type = 'button'; x.setAttribute('aria-label', 'Clear ' + text);
      x.addEventListener('click', function () { StatsSel.clear(kind); input.focus(); });
    }
    function render(st) {
      clear(chips);
      if (!st.rec && !st.pos && !st.pair) { summary.textContent = 'Nothing selected. Every chart shows all ' + NREC + ' receptors.'; return; }
      data().then(function (arr) {
        clear(chips);
        var R = receptorIndex(arr[0]), P = positionIndex(arr[1]), hp = arr[2], lines = [];
        if (st.rec && R.by[st.rec]) {
          var r = R.by[st.rec];
          chip(r.symbol, 'rec');
          lines.push(r.symbol + ': ' + r.ligand.replace(/ receptors$/, '').toLowerCase() + ' receptor, threshold ' + f2(r.threshold) + ', ' + f1(r.above_per_100) + ' of every 100 pairs above it');
        }
        if (st.pos && P.by[st.pos]) {
          var p = P.by[st.pos];
          chip(st.pos, 'pos');
          lines.push(st.pos + ': ' + p.segment + ', rank ' + p.rank + ', CFR in ' + p.n + ' of ' + NREC);
        }
        if (st.pair) {
          chip(pairName(st.pair), 'pair');
          var c = helixCell(hp, 'all', st.pair[0], st.pair[1]);
          if (c && c.n_present) lines.push(pairName(st.pair) + ': ' + (c.n_down >= c.n_up ? 'weaker in the active model in ' + c.n_down : 'stronger in the active model in ' + c.n_up) + ' of ' + c.n_present);
          else lines.push(pairName(st.pair) + ': no above-threshold contact in any receptor');
        }
        summary.textContent = lines.join('. ') + '.';
      }, function () { summary.textContent = ''; });
    }
    document.addEventListener('gpc:stats-select', function (e) { render(e.detail); });
    return { render: render };
  })();

  function helixCell(hp, groupKey, i, j) {
    var g = hp.groups.filter(function (x) { return x.key === groupKey; })[0] || hp.groups[0];
    var cols = hp.summary_columns, row = null;
    g.cells.forEach(function (c) { if (c[0] === Math.min(i, j) && c[1] === Math.max(i, j)) row = c; });
    if (!row) return null;
    var o = {}; cols.forEach(function (k, n) { o[k] = row[n]; }); return o;
  }

  // ------------------------------------------------------------------ cards
  var DEFS = {}, CARDS = {};
  function define(id, def) { DEFS[id] = def; }

  function makeCard(article) {
    var id = article.getAttribute('data-card'), def = DEFS[id];
    if (!def) return null;
    var card = {
      id: id, def: def, el: article, chart: article.querySelector('#' + id) || article.querySelector('[data-chart]'),
      table: article.querySelector('.scard-table'), side: article.querySelector('.chart-card-side'),
      body: article.querySelector('.scard-body'), legend: article.querySelector('[data-legend]'),
      guide: article.querySelector('[data-guide]'), scope: article.querySelector('[data-scope]'),
      meta: (CFG.cards || {})[id] || { title: id, export: id.replace('chart-', '') },
      state: {}, loaded: false, drawn: false, dirty: false, lastW: 0
    };
    card.serverTable = article.querySelector('[data-server-table]');
    CARDS[id] = card;
    wireFoot(card);
    return card;
  }
  function visible(node) { return !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length)); }

  function loadCard(card) {
    if (card.loaded) return card.ready;
    card.loaded = true;
    card.ready = loadAll(card.def.needs).then(function (D) {
      card.D = D;
      if (card.serverTable && !card.def.keepServerTable) card.serverTable.setAttribute('data-js-hidden', '');
      if (card.def.init) card.def.init(card, D);
      draw(card, { first: true });
    }).catch(function (err) {
      card.failed = true;
      if (card.chart) { clear(card.chart); h('p', 'load-note', card.chart, 'This chart could not load.'); card.chart.setAttribute('data-chart-error', String(err && err.message || err)); }
      if (card.serverTable) { card.serverTable.removeAttribute('data-js-hidden'); card.serverTable.hidden = false; }
    });
    return card.ready;
  }
  function draw(card, o) {
    if (!card.D || card.failed) return;
    o = o || {};
    var shown = card.def.visibleNode ? card.def.visibleNode(card) : card.chart;
    if (!visible(shown) && !o.force) { card.dirty = true; return; }
    card.dirty = false;
    card.lastW = width(card.chart);
    var key = focusKey(card.el);
    if (!o.keepNode && !card.def.keepNode) clear(card.chart);
    var res = card.def.draw(card, card.chart, card.lastW, o);
    var done = function () {
      card.drawn = true;
      card.chart.setAttribute('data-chart-rendered', '1');
      if (!o.first && !o.exporting && !REDUCE.matches && card.chart.firstElementChild && o.fade) {
        card.chart.firstElementChild.classList.add('fade-in');
      }
      [card.chart, card.strip].forEach(function (root) {
        if (root) root.querySelectorAll('svg').forEach(function (sv) { if (!sv.parentElement.closest('svg')) roving(sv, key); });
      });
      refocus(card.el, key);
    };
    if (res && res.then) res.then(done, function () {}); else done();
  }
  function redrawAll(onlyVisible) {
    Object.keys(CARDS).forEach(function (id) {
      var c = CARDS[id];
      if (!c.drawn) return;
      if (onlyVisible && !visible(c.chart)) { c.dirty = true; return; }
      draw(c, {});
    });
  }
  // a card made visible again (tab, details, Table off) redraws when it was marked dirty
  function revisit(card) { if (card && card.D && (card.dirty || !card.drawn)) draw(card, { first: !card.drawn }); }

  // ---- footer: Table, Method, Export
  function buildTools(card) {
    var slot = card.el.querySelector('[data-tools]');
    if (!slot || slot.childNodes.length) return;
    var hasTable = slot.hasAttribute('data-table'), id = card.id, csv = card.meta.csv;
    function btn(parent, cls, text, attrs) {
      var b = h('button', cls, parent, text); b.type = 'button';
      for (var k in attrs) b.setAttribute(k, attrs[k]);
      return b;
    }
    if (hasTable) btn(slot, 'cc-btn foot-wide', 'Table', { 'data-table-toggle': '', 'aria-pressed': 'false' });
    btn(slot, 'cc-btn foot-wide', 'Method', { 'data-method-toggle': '', 'aria-expanded': 'false', 'aria-controls': id + '-method' });
    var menu = h('span', 'xmenu', slot);
    var t = btn(menu, 'cc-btn', null, { 'data-export-toggle': '', 'aria-expanded': 'false', 'aria-haspopup': 'true' });
    h('span', 'foot-wide-text', t, 'Export'); h('span', 'foot-phone-text', t, 'Export and method');
    var list = h('span', 'xmenu-list', menu); list.setAttribute('role', 'menu'); list.hidden = true;
    btn(list, '', 'PNG 2x', { role: 'menuitem', 'data-export': 'png' });
    btn(list, '', 'SVG', { role: 'menuitem', 'data-export': 'svg' });
    if (csv) { var a = h('a', '', list, 'CSV'); a.href = csv; a.setAttribute('role', 'menuitem'); a.setAttribute('data-export', 'csv'); a.setAttribute('download', 'gpcompare_' + card.meta.export + '.csv'); }
    btn(list, '', 'Copy caption', { role: 'menuitem', 'data-copy-caption': '' });
    if (hasTable) btn(list, 'menu-phone', 'Table', { role: 'menuitem', 'data-menu-table': '' });
    btn(list, 'menu-phone', 'Method', { role: 'menuitem', 'data-menu-method': '' });
  }
  function wireFoot(card) {
    buildTools(card);
    var a = card.el;
    var tb = a.querySelector('[data-table-toggle]'), mt = a.querySelector('[data-method-toggle]');
    var xt = a.querySelector('[data-export-toggle]'), xl = a.querySelector('.xmenu-list');
    var method = a.querySelector('.scard-method');
    if (tb) tb.addEventListener('click', function () { toggleTable(card); });
    function toggleMethod() {
      var open = method.hidden;
      method.hidden = !open;
      if (mt) mt.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) method.scrollIntoView({ block: 'nearest', behavior: SCROLL() });
    }
    if (mt && method) mt.addEventListener('click', toggleMethod);
    function closeMenu() { if (xl) { xl.hidden = true; xt.setAttribute('aria-expanded', 'false'); } }
    if (xt && xl) {
      xt.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = xl.hidden; closeAllMenus(); xl.hidden = !open; xt.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) { var f = xl.querySelector('button, a'); if (f) f.focus(); }
      });
      xl.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); xt.focus(); return; }
        var items = Array.prototype.slice.call(xl.querySelectorAll('button, a')).filter(function (n) { return !n.hidden && n.offsetParent !== null; });
        var i = items.indexOf(document.activeElement), j = -1;
        if (e.key === 'ArrowDown') j = (i + 1) % items.length;
        else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = items.length - 1;
        if (j >= 0) { e.preventDefault(); items[j].focus(); }
      });
      xt.parentNode.addEventListener('focusout', function () {
        setTimeout(function () { if (!xt.parentNode.contains(document.activeElement)) closeMenu(); }, 0);
      });
      xl.querySelectorAll('[data-export]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          var kind = b.getAttribute('data-export');
          if (kind === 'csv') { var u = csvURL(card); if (u) { b.href = u; b.setAttribute('download', fileName(card, 'csv')); } closeMenu(); return; }
          e.preventDefault(); closeMenu();
          exportCard(card, kind);
        });
      });
      var cc = xl.querySelector('[data-copy-caption]');
      if (cc) cc.addEventListener('click', function () { copyCaption(card, cc); });
      var mtab = xl.querySelector('[data-menu-table]'); if (mtab) mtab.addEventListener('click', function () { closeMenu(); toggleTable(card); });
      var mm = xl.querySelector('[data-menu-method]'); if (mm && method) mm.addEventListener('click', function () { closeMenu(); toggleMethod(); });
    }
  }
  function closeAllMenus() {
    document.querySelectorAll('.stats .xmenu-list').forEach(function (l) { if (!l.hidden) { l.hidden = true; var t = l.parentNode.querySelector('[data-export-toggle]'); if (t) t.setAttribute('aria-expanded', 'false'); } });
  }
  document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.xmenu')) closeAllMenus(); });

  function csvURL(card) { return card.def.csv ? card.def.csv(card) : card.meta.csv; }
  function fileName(card, ext) {
    var parts = ['gpcompare', card.meta.export];
    var sfx = card.def.suffix ? card.def.suffix(card, ext) : '';
    if (sfx) parts.push(sfx);
    return parts.join('_').replace(/[^\w.-]+/g, '_').toLowerCase() + '.' + ext;
  }

  function toggleTable(card) {
    var btn = card.el.querySelector('[data-table-toggle]');
    var on = !card.tableOn;
    card.tableOn = on;
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    var server = card.def.serverTable ? card.def.serverTable(card) : null;
    if (!card.csvBox) {
      card.csvBox = card.table && !card.table.hasAttribute('data-server-table') ? card.table : h('div', 'scard-table');
      if (!card.csvBox.parentNode) card.chart.parentNode.insertBefore(card.csvBox, card.chart.nextSibling);
      card.csvBox.hidden = true;
    }
    var tbox = server || card.csvBox;
    if (!on) {
      if (card.tableBox) { card.tableBox.hidden = true; if (card.tableBox.hasAttribute('data-server-table')) card.tableBox.setAttribute('data-js-hidden', ''); }
      card.chart.hidden = false;
      if (card.extraHide) card.extraHide.forEach(function (n) { n.hidden = false; });
      revisit(card);
      return;
    }
    card.chart.hidden = true;
    card.tableBox = tbox;
    if (server) { server.removeAttribute('data-js-hidden'); server.hidden = false; return; }
    tbox.hidden = false;
    clear(tbox); h('p', 'table-note', tbox, 'Loading the table');
    var u = csvURL(card);
    if (!u) { clear(tbox); h('p', 'table-note', tbox, 'No table for this view.'); return; }
    loadCSV(u).then(function (t) { renderTable(tbox, t.header, t.rows); }, function (err) { clear(tbox); h('p', 'table-note', tbox, 'The table could not load.'); });
  }
  function isNum(rows, i) {
    var seen = 0;
    for (var k = 0; k < rows.length && k < 30; k++) { var v = rows[k][i]; if (v === '' || v === undefined) continue; if (isNaN(parseFloat(v)) || !isFinite(v)) return false; seen++; }
    return seen > 0;
  }
  function renderTable(box, header, list) {
    var MAX = 400;
    clear(box);
    var t = h('table', '', box), tr = h('tr', '', h('thead', '', t)), tb = h('tbody', '', t);
    var num = header.map(function (x, i) { return isNum(list, i); });
    header.forEach(function (x, i) { h('th', num[i] ? 'num' : '', tr, x); });
    list.slice(0, MAX).forEach(function (r) { var row = h('tr', '', tb); r.forEach(function (v, i) { h('td', num[i] ? 'num' : '', row, v); }); });
    h('p', 'table-note', box, list.length > MAX ? 'The first ' + fmt(MAX) + ' of ' + fmt(list.length) + ' rows; the CSV has all of them.' : fmt(list.length) + ' rows.');
  }

  function captionText(card) {
    var guide = card.guide ? card.guide.textContent.replace(/\s+/g, ' ').trim() : '';
    var scope = card.scope ? card.scope.textContent.replace(/\s+/g, ' ').trim().replace(/\.$/, '') : '';
    var title = card.el.querySelector('.scard-title').textContent.trim();
    return title + '. ' + guide + ' Scope: ' + scope + '. GPCompaRe database, ' + location.origin + location.pathname + '#card-' + card.id;
  }
  function copyCaption(card, btn) {
    var text = captionText(card);
    var done = function () { btn.classList.add('is-done'); btn.textContent = 'Copied'; setTimeout(function () { btn.classList.remove('is-done'); btn.textContent = 'Copy caption'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to do */ }
    document.body.removeChild(ta);
  }

  // ---- export: the chart redrawn off screen with light-theme colors, title and scope added
  function download(blob, name) {
    var a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function offscreen(card) {
    var saved = C, w = card.lastW || width(card.chart);
    C = lightTokens();
    var host = h('div', 'stats-offscreen');
    host.style.cssText = 'position:absolute;left:-20000px;top:0;width:' + w + 'px';
    STATS.appendChild(host);
    try { card.def.draw(card, host, w, { exporting: true }); }
    finally { C = saved; }
    return { host: host, w: w };
  }
  function exportSVGString(card) {
    var off = offscreen(card), host = off.host, w = off.w, L = lightTokens();
    var parts = [], y = 0;
    host.querySelectorAll('svg').forEach(function (s) {
      if (s.parentElement && s.parentElement.closest('svg')) return;
      var vb = (s.getAttribute('viewBox') || '0 0 ' + w + ' 100').split(/\s+/).map(Number);
      parts.push({ s: s, vb: vb, y: 0 });
    });
    if (card.def.vector) { var v = card.def.vector(card, w, L); if (v) parts = [{ s: v, vb: v.getAttribute('viewBox').split(/\s+/).map(Number) }]; }
    var title = card.el.querySelector('.scard-title').textContent.trim();
    var scope = card.scope ? card.scope.textContent.replace(/\s+/g, ' ').trim() : '';
    var top = 34, gap = 10;
    var out = el('svg', { xmlns: NS, 'font-family': 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' });
    var total = top;
    parts.forEach(function (p) { p.y = total; total += p.vb[3] + gap; });
    var W = Math.max(w, maxOf(parts.map(function (p) { return p.vb[2]; })) || w);
    var H = total + 24;
    out.setAttribute('viewBox', '0 0 ' + W + ' ' + H); out.setAttribute('width', W); out.setAttribute('height', H);
    el('rect', { width: W, height: H, fill: '#ffffff' }, out);
    el('text', { x: 0, y: 20, 'font-size': 15, 'font-weight': 600, fill: L.fg }, out, title);
    parts.forEach(function (p) {
      var g = p.s.cloneNode(true);
      g.setAttribute('x', 0); g.setAttribute('y', p.y);
      g.removeAttribute('style'); g.setAttribute('width', p.vb[2]); g.setAttribute('height', p.vb[3]);
      out.appendChild(g);
    });
    el('text', { x: 0, y: H - 8, 'font-size': 11, fill: L.muted }, out, scope + ' GPCompaRe database, statistics.html#card-' + card.id);
    host.remove();
    out.querySelectorAll('[data-tip]').forEach(function (n) { n.removeAttribute('data-tip'); n.removeAttribute('tabindex'); n.removeAttribute('role'); n.removeAttribute('data-hit'); n.removeAttribute('aria-label'); });
    return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out), w: W, h: H };
  }
  function exportCard(card, kind) {
    if (!card.D) return;
    if (card.def.exportCustom) { card.def.exportCustom(card, kind); return; }
    var cv = card.def.canvasExport && kind === 'png' ? card.def.canvasExport(card) : null;
    if (cv) { cv.toBlob(function (b) { download(b, fileName(card, 'png')); }); return; }   // null: the SVG route below
    var svg = exportSVGString(card);
    if (kind === 'svg') { download(new Blob([svg.text], { type: 'image/svg+xml' }), fileName(card, 'svg')); return; }
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement('canvas'); cv.width = svg.w * 2; cv.height = svg.h * 2;
      var g = cv.getContext('2d'); g.scale(2, 2); g.drawImage(img, 0, 0, svg.w, svg.h);
      cv.toBlob(function (b) { download(b, fileName(card, 'png')); });
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.text);
  }

  // ---- side panel (helix cell, receptor, per-position variants)
  function openSide(card, title, build) {
    var side = card.side; if (!side) return;
    var a = document.activeElement, inCard = a && card.el.contains(a) && !side.contains(a);
    if (inCard) card.sideReturn = a.getAttribute('data-key') || a.getAttribute('data-pair') || null;
    clear(side);
    var x = h('button', 'side-close', side, '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', function () { closeSide(card, true); });
    var head = h('h4', '', side, title); head.tabIndex = -1;
    build(side);
    side.hidden = false;
    card.body.classList.add('has-side');
    card.sideOpen = true;
    if (!side.__esc) {
      side.__esc = true;
      side.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSide(card, true); } });
    }
    if (card.lastW && width(card.chart) !== card.lastW) draw(card, {});
    if (inCard) head.focus({ preventScroll: !isPhone() });
    if (isPhone()) side.scrollIntoView({ block: 'nearest', behavior: SCROLL() });
  }
  function closeSide(card, back) {
    if (!card.side) return;
    card.side.hidden = true; clear(card.side); card.body.classList.remove('has-side'); card.sideOpen = false;
    card.sideKey = null;
    if (card.drawn && width(card.chart) !== card.lastW) draw(card, {});
    if (back && card.sideReturn) {
      var k = card.sideReturn.replace(/["\\]/g, '\\$&');
      var n = card.el.querySelector('[data-key="' + k + '"], [data-pair="' + k + '"]');
      if (n) n.focus({ preventScroll: true });
    }
    card.sideReturn = null;
  }
  function link(text, href, cls) { var a = h('a', cls || '', null, text); a.href = href; return a; }
  function sideTable(header, list) {
    var t = h('table'), tr = h('tr', '', h('thead', '', t)), tb = h('tbody', '', t);
    header.forEach(function (x) { h('th', x.num ? 'num' : '', tr, x.label); });
    list.forEach(function (r) {
      var row = h('tr', '', tb);
      r.forEach(function (v, i) {
        var td = h('td', header[i].num ? 'num' : '', row);
        if (v instanceof Node) td.appendChild(v); else td.textContent = v === null || v === undefined ? '' : String(v);
        if (header[i].sign && typeof v === 'number') td.classList.add(v > 0 ? 'up' : v < 0 ? 'down' : 'zero');
      });
    });
    return t;
  }
  function followButton(gid, symbol) {
    var b = h('button', 'cc-btn btn-follow', null, StatsSel.get().rec === gid ? 'Following ' + symbol : 'Follow this receptor');
    b.type = 'button';
    b.addEventListener('click', function () { StatsSel.set({ rec: gid }); b.textContent = 'Following ' + symbol; });
    return b;
  }

  // ================================================================== 1 scale
  // Wilkinson dot strip, the same layout as statistics_page.strip_layout (the server SVG)
  function stripLayout(vals, lo, hi, x0, x1, r) {
    var step = 2 * r + 0.6, order = vals.map(function (v, i) { return i; }).sort(function (a, b) { return vals[a] - vals[b] || a - b; });
    var cols = {}, pts = [];
    order.forEach(function (i) {
      var x = x0 + (vals[i] - lo) / (hi - lo) * (x1 - x0), k = Math.floor(x / step + 0.5), c = cols[k] || 0;
      cols[k] = c + 1;
      pts.push([k * step, c === 0 ? 0 : (c % 2 ? 1 : -1) * Math.ceil(c / 2), i]);
    });
    return { pts: pts, step: step };
  }
  define('chart-thresholds', {
    needs: ['class_scale'],
    csv: null,
    draw: function (card, node, w, o) {
      var sc = card.D.class_scale, cen = sc.census, R = rows(sc.receptor_columns, sc.receptors);
      var phone = isPhone() || w < 800, r = phone ? 2.4 : 3, gap = 40, pw = phone ? w : (w - gap) / 2;
      if (!o.exporting && card.guide) {
        if (!card.guideBase) card.guideBase = card.guide.innerHTML;
        card.guide.innerHTML = phone ? card.guideBase.replace('Left:', 'Top:').replace('Right:', 'Bottom:') : card.guideBase;
      }
      var rec = StatsSel.get().rec;
      var P = [
        { title: 'Threshold |ΔRRCS|', key: 'threshold', half: true, note: 'range ' + f2(cen.threshold_min) + ' to ' + f2(cen.threshold_max) + ', median ' + f2(cen.threshold_median), f: f2 },
        { title: 'Above-threshold pairs per 100 pairs', key: 'above_per_100', half: false, note: 'median ' + f2(cen.above_per_100_median) + ' per receptor', f: f2 }
      ];
      P.forEach(function (p) {
        p.vals = R.map(function (x) { return x[p.key]; });
        p.lo = p.half ? Math.floor(minOf(p.vals) * 2) / 2 : Math.floor(minOf(p.vals));
        p.hi = p.half ? Math.ceil(maxOf(p.vals) * 2) / 2 : Math.ceil(maxOf(p.vals));
        p.L = stripLayout(p.vals, p.lo, p.hi, 8, pw - 8, r);
      });
      var maxOff = maxOf(P.map(function (p) { return maxOf(p.L.pts.map(function (q) { return Math.abs(q[1]); })); }));
      var top = rec ? 44 : 30, half = (maxOff + 1) * P[0].L.step, cy = top + half, axisY = cy + half + 6, ph = axisY + 26;
      var H = phone ? ph * 2 + 16 : ph;
      var s = svgIn(node, w, H, 'Thresholds and above-threshold pairs per 100, one dot per receptor');
      if (anim(o)) s.classList.add('draw-in');
      P.forEach(function (p, k) {
        var g = el('g', { transform: phone ? 'translate(0 ' + (k * (ph + 16)) + ')' : 'translate(' + (k * (pw + gap)) + ' 0)' }, s);
        var xs = function (v) { return 8 + (v - p.lo) / (p.hi - p.lo) * (pw - 16); };
        el('text', { x: 0, y: 13, 'font-size': 12, 'font-weight': 600, fill: C.fg }, g, p.title);
        var nfs = phone ? 10.5 : 11, room = pw - textW(p.title, 12, 600) - 14;
        el('text', { x: pw, y: 13, 'text-anchor': 'end', 'font-size': nfs, fill: C.muted }, g, fit([p.note, p.note.replace(' per receptor', ''), ''], room, nfs));
        var med = median(p.vals), fi = null;
        p.L.pts.forEach(function (q) {
          var x = R[q[2]], f = x.gid === rec;
          if (f) fi = q;
          var c = el('circle', { cx: q[0], cy: cy + q[1] * p.L.step, r: r, fill: C.ink, 'fill-opacity': f ? 0 : 0.55 }, g);
          if (!o.exporting) hit(c, x.symbol + ': ' + p.f(x[p.key]), function () { StatsSel.set({ rec: x.gid }); }, null, true);
        });
        el('line', { x1: xs(med), x2: xs(med), y1: top - 4, y2: cy + half + 2, stroke: C.rule, 'stroke-width': 2 }, g);
        el('line', { x1: 8, x2: pw - 8, y1: axisY, y2: axisY, stroke: C.line }, g);
        for (var t = p.lo; t <= p.hi + 1e-9; t += p.half ? 0.5 : 1) {
          if (phone && p.half && Math.round(t * 2) % 2) continue;
          el('text', { x: xs(t), y: axisY + 15, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, g, String(Math.round(t * 10) / 10));
        }
        if (fi) {
          var fx = fi[0], fy = cy + fi[1] * p.L.step, x = R[fi[2]];
          el('circle', { cx: fx, cy: fy, r: r + 2.5, fill: C.fg }, g);
          el('circle', { cx: fx, cy: fy, r: r + 5, fill: 'none', stroke: C.fg, 'stroke-width': 1.5 }, g);
          var flab = x.symbol + ' ' + p.f(x[p.key]);
          el('text', { x: clampX(fx, flab, 12, 700, 0, pw), y: Math.min(fy, cy - half) - r - 9, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: C.fg, stroke: C.surface, 'stroke-width': 3, 'paint-order': 'stroke' }, g, flab);
        }
      });
    },
    onSelect: function (card) { draw(card, {}); }
  });

  define('chart-histogram', {
    needs: ['class_scale'],
    draw: function (card, node, w, o) {
      var sc = card.D.class_scale, rule = sc.histogram_rule, lo = rule.drawn_from, hi = rule.drawn_to;
      var bins = sc.histogram.filter(function (b) { return b[0] >= lo && b[0] < hi; });
      var hh = isPhone() ? 170 : 210, ml = 40, mr = 8, s = svgIn(node, w, hh + 34, 'Histogram of ΔRRCS over all contact pairs, log scale');
      if (anim(o)) s.classList.add('draw-in');
      var x = function (v) { return ml + (v - lo) / (hi - lo) * (w - ml - mr); };
      var lmax = Math.log10(maxOf(bins.map(function (b) { return b[1]; })) + 1);
      var y = function (n) { return hh - Math.log10(n + 1) / lmax * (hh - 8); };
      [1, 10, 100, 1000, 10000].forEach(function (t) {
        if (Math.log10(t + 1) > lmax) return;
        el('line', { x1: ml, x2: w - mr, y1: y(t), y2: y(t), stroke: C.lineSoft }, s);
        el('text', { x: ml - 6, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, s, t >= 1000 ? (t / 1000) + 'k' : String(t));
      });
      bins.forEach(function (b) {
        var r = el('rect', { x: x(b[0]) + 0.5, width: Math.max(1, x(b[0] + 1) - x(b[0]) - 1), y: y(b[1]), height: hh - y(b[1]), fill: b[0] < 0 ? C.inactive : C.active, 'fill-opacity': 0.85, class: 'grow-y' }, s);
        if (!o.exporting) r.setAttribute('data-tip', fmt(b[1]) + ' pairs with ΔRRCS from ' + b[0] + ' to ' + (b[0] + 1));
      });
      [lo, lo / 2, 0, hi / 2, hi].forEach(function (t) { el('text', { x: x(t), y: hh + 16, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, s, t < 0 ? '−' + Math.abs(t) : String(t)); });
      el('text', { x: ml, y: hh + 31, 'font-size': 11, fill: C.muted }, s, fit(['ΔRRCS (active minus inactive); pairs per bin, log scale', 'ΔRRCS; pairs per bin, log scale'], w - ml, 11));
      var rec = StatsSel.get().rec;
      if (rec) {
        var R = rows(sc.receptor_columns, sc.receptors).filter(function (r) { return r.gid === rec; })[0];
        if (R) [-R.threshold, R.threshold].forEach(function (t, i) {
          el('line', { x1: x(t), x2: x(t), y1: 6, y2: hh, stroke: C.fg, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, s);
          var hl = R.symbol + ' threshold ±' + f2(R.threshold), right = x(t) + 5 + textW(hl, 12, 600) <= w;
          if (i) el('text', { x: right ? x(t) + 5 : x(t) - 5, y: 16, 'text-anchor': right ? 'start' : 'end', 'font-size': 12, 'font-weight': 600, fill: C.fg, stroke: C.surface, 'stroke-width': 3, 'paint-order': 'stroke' }, s, hl);
        });
      }
    },
    onSelect: function (card) { draw(card, {}); }
  });

  // ================================================================== 2 helix bundle
  var HXY = (function () {
    function polar(d, r) { var a = d * Math.PI / 180; return [Math.cos(a) * r, Math.sin(a) * r]; }
    return [polar(152, 0.63), polar(207, 0.64), polar(262, 0.17), polar(258, 0.69), polar(313, 0.64), polar(10, 0.63), polar(70, 0.62), polar(112, 0.93)];
  })();   // static/js/atlas/atlas-core.js A.HELIX_XY: extracellular view, TM1..TM7 counterclockwise, H8 last
  var H8A = (112 + 90) * Math.PI / 180;

  function hpCells(hp, G) {
    var cols = hp.summary_columns;
    return G.cells.map(function (r) { var o = {}; cols.forEach(function (k, i) { o[k] = r[i]; }); return o; });
  }
  function chord(s, a, b, col, wdt, op) {
    var len = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    return el('path', { d: 'M' + a[0].toFixed(1) + ',' + a[1].toFixed(1) + 'L' + b[0].toFixed(1) + ',' + b[1].toFixed(1), stroke: col, 'stroke-width': wdt.toFixed(1), 'stroke-linecap': 'round', fill: 'none', 'stroke-opacity': op.toFixed(2), class: 'chord', style: '--len:' + len }, s);
  }
  define('chart-helix-pairs', {
    needs: ['helix_pairs'],
    init: function (card, D) {
      var hp = D.helix_pairs, st = card.state;
      st.mode = ({ magnitude: 1, grid: 1 })[urlParam('bm')] ? urlParam('bm') : 'direction';
      st.group = 'all'; st.segments = 'helices';
      var modeBox = card.el.querySelector('[data-ctl="mode"]'), segBox = card.el.querySelector('[data-ctl="segments"]');
      card.ledger = card.el.querySelector('[data-ledger]');
      var gbox = card.el.querySelector('[data-ctl="group"]');
      function pressed(box, v) { box.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-value') === v ? 'true' : 'false'); }); }
      pressed(modeBox, st.mode);
      modeBox.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          st.mode = b.getAttribute('data-value'); pressed(modeBox, st.mode);
          setUrlParam('bm', st.mode === 'direction' ? null : st.mode);
          if (st.mode === 'magnitude') closeSide(card); else if (card.sideKey) openCell(card, card.sideKey[0], card.sideKey[1]);
          draw(card, { fade: true });
        });
      });
      segBox.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { st.segments = b.getAttribute('data-value'); pressed(segBox, st.segments); draw(card, { fade: true }); });
      });
      function groupLabel(g) { return g.key === 'all' ? 'All receptors' : g.label.replace(/ receptors$/, ''); }
      function setGroup(v) {
        st.group = v;
        gbox.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-value') === v ? 'true' : 'false'); });
        var sel = gbox.querySelector('select'); if (sel) sel.value = v;
        if (card.sideKey) openCell(card, card.sideKey[0], card.sideKey[1]);
        draw(card, { fade: true });
      }
      card.setGroup = setGroup;
      function buildGroups() {
        clear(gbox);
        if (isPhone()) {
          var lab = h('label', 'sr-only', gbox, 'Receptor group'); lab.setAttribute('for', 'helix-group-select');
          var sel = h('select', '', gbox); sel.id = 'helix-group-select';
          hp.groups.forEach(function (g) { var op = h('option', '', sel, groupLabel(g) + ' (' + g.n + ')'); op.value = g.key; });
          sel.value = st.group;
          sel.addEventListener('change', function () { setGroup(sel.value); });
          return;
        }
        hp.groups.forEach(function (g) {
          var b = h('button', g.n < hp.min_receptors ? 'small' : '', gbox, groupLabel(g)); b.type = 'button';
          h('span', 'n', b, String(g.n));
          b.setAttribute('data-value', g.key); b.setAttribute('aria-pressed', g.key === st.group ? 'true' : 'false');
          if (g.n < hp.min_receptors) b.title = 'Fewer than ' + hp.min_receptors + ' receptors: no class direction';
          b.addEventListener('click', function () { setGroup(g.key); });
        });
      }
      buildGroups();
      PHONE.addEventListener('change', buildGroups);
    },
    suffix: function (card) { var st = card.state; return st.mode + (st.mode === 'magnitude' ? '' : '_' + st.group.replace(/ receptors$/, '')); },
    csv: function (card) { return card.state.mode === 'magnitude' ? CFG.csv_extra.helix_interfaces : card.meta.csv; },
    draw: function (card, node, w, o) {
      var hp = card.D.helix_pairs, st = card.state;
      var G = hp.groups.filter(function (g) { return g.key === st.group; })[0] || hp.groups[0];
      var small = G.n < hp.min_receptors;
      var gbox = card.el.querySelector('[data-ctl="group"]'), segBox = card.el.querySelector('[data-ctl="segments"]');
      if (!o.exporting) {
        gbox.hidden = st.mode === 'magnitude';
        segBox.hidden = st.mode !== 'grid';
        var scope = (st.group === 'all' || st.mode === 'magnitude') ? NREC + ' receptors.' : G.n + ' receptors (' + G.label.replace(/ receptors$/, '').toLowerCase() + ').';
        card.scope.querySelector('b').textContent = scope;
        var rest = card.scope.querySelector('[data-scope-rest]');
        if (!rest) {   // the text after the bold count, kept in one span so the mode can change it
          rest = h('span', ''); rest.setAttribute('data-scope-rest', '');
          var b0 = card.scope.querySelector('b'), nx = b0.nextSibling;
          while (nx) { var nn = nx.nextSibling; rest.appendChild(nx); nx = nn; }
          card.scope.appendChild(rest);
          card.scopeRest = rest.textContent;
        }
        rest.textContent = st.mode === 'magnitude' && CFG.labels.scope_maps ? ' ' + CFG.labels.scope_maps : card.scopeRest;
        card.guide.innerHTML = guideFor(hp, G, st, small);
        ledger(card, hp, G, small);
        legendFor(card, st, small);
      }
      if (st.mode === 'grid') return gridView(card, node, w, hp, G, o);
      return bundle(card, node, w, hp, G, small, o);
    },
    onSelect: function (card) { draw(card, {}); }
  });
  function guideFor(hp, G, st, small) {
    if (st.mode === 'magnitude') return 'Line width and label: mean |ΔRRCS| per contact over all contacts between two of TM1 to TM7, for pairs with at least ' + hp.magnitude_rule.min_contacts + ' contacts; H8 pairs are not included. Disc size, and the width of the H8 bar: mean |ΔRRCS| per contact endpoint on the helix. Unsigned, over all ' + NREC + ' receptors.';
    if (st.mode === 'grid' && small) return esc(G.label.replace(/ receptors$/, '')) + ': ' + G.n + ' receptors, fewer than the ' + hp.min_receptors + ' a class direction needs. Each cell: how many of them carry the pair, without a direction. Within-helix pairs are not shown.';
    if (st.mode === 'grid') return 'Each cell: the mean net ΔRRCS of the pair over all receptors in the group (receptors without the pair count as 0), and the share of receptors with the pair whose net has that sign. Within-helix pairs are not shown. Loops and termini appear under All segments.';
    if (small) return esc(G.label.replace(/ receptors$/, '')) + ': ' + G.n + ' receptors, fewer than the ' + hp.min_receptors + ' a class direction needs. Lines join the helices these receptors pair, width by how many carry the pair. Each receptor’s own bundle is on its report.';
    return 'Each line joins two helices that share above-threshold contacts. Color: mean net ΔRRCS per receptor, <span class="t-up">red</span> stronger in the active model, <span class="t-down">blue</span> stronger in the inactive model. Width: receptors that change in the majority direction. Pairs carried by fewer than ' + hp.min_receptors + ' receptors are not drawn.';
  }
  function legendFor(card, st, small) {
    var L = card.legend; if (!L) return;
    if (st.mode === 'magnitude') { L.innerHTML = '<span><span class="sw" style="background:var(--st-ink-bar)"></span>mean |ΔRRCS| per contact (unsigned)</span>'; return; }
    if (small && st.mode === 'direction') { L.innerHTML = '<span><span class="sw" style="background:var(--st-faint)"></span>line width: receptors carrying the pair (no direction)</span>'; return; }
    if (small) { L.innerHTML = '<span><span class="sw" style="background:var(--st-faint)"></span>cell: receptors of the group carrying the pair (no direction)</span>'; return; }
    L.innerHTML = '<span>stronger in the inactive model</span><span class="ramp" style="background:linear-gradient(90deg,' + C.inactive + ',' + C.neutral + ',' + C.active + ')"></span><span>stronger in the active model</span><span>scale ±6 |ΔRRCS| per receptor</span>';
  }
  function bundle(card, node, w, hp, G, small, o) {
    var st = card.state, S = Math.min(520, w), s = svgIn(node, S, S, 'Helix bundle seen from the extracellular side');
    if (anim(o)) s.classList.add('draw-in');
    var X = S / 2, Y = S / 2, R = S / 2 - 6, sc = R * 0.86, sel = StatsSel.get().pair;
    function P(k) { return [X + HXY[k][0] * sc, Y - HXY[k][1] * sc]; }
    el('circle', { cx: X, cy: Y, r: R, fill: C.plate, stroke: C.lineSoft }, s);
    var discR = [], labels = [], hits = [];
    var lines = el('g', {}, s);
    if (st.mode === 'magnitude') {
      var segs = hp.segments_magnitude.filter(function (x) { return x.block === 'Helices'; });
      var mx = maxOf(segs.map(function (x) { return x.mean_abs_delta; }));
      HELIX.forEach(function (n, k) { var m = segs.filter(function (x) { return x.segment === n; })[0]; discR[k] = sc * (0.07 + 0.09 * Math.pow((m ? m.mean_abs_delta : 0) / mx, 2)); });
      var IF = hp.interfaces.filter(function (i) { return i.supported && HELIX.indexOf(i.seg_i) >= 0 && HELIX.indexOf(i.seg_j) >= 0; }).sort(function (a, b) { return a.mean_abs_delta - b.mean_abs_delta; });
      var imax = IF.length ? IF[IF.length - 1].mean_abs_delta : 1;
      IF.forEach(function (i, n) {
        var a = P(HELIX.indexOf(i.seg_i)), b = P(HELIX.indexOf(i.seg_j)), t = Math.pow(i.mean_abs_delta / imax, 3);
        chord(lines, a, b, C.ink, 2 + 22 * t, 0.25 + 0.7 * t);
        if (n >= IF.length - 3) labels.push([a, b, f2(i.mean_abs_delta), C.ink]);
        hits.push([a, b, i.seg_i + '-' + i.seg_j + ': mean |ΔRRCS| ' + f2(i.mean_abs_delta) + ' per contact over ' + fmt(i.n_contacts) + ' contacts', null]);
      });
    } else {
      HELIX.forEach(function (n, k) { discR[k] = sc * 0.105; });
      var cells = hpCells(hp, G).filter(function (c) { return c.i < 8 && c.j < 8 && c.i !== c.j && (small ? c.n_present > 0 : c.n_present >= hp.min_receptors); })
        .sort(function (a, b) { return Math.abs(a.mean_net) - Math.abs(b.mean_net); });
      cells.forEach(function (c, n) {
        var a = P(c.i), b = P(c.j), on = samePair(sel, [c.i, c.j]), dim = sel && !on;
        var tip = HELIX[c.i] + '-' + HELIX[c.j] + ': ';
        if (small) {
          chord(lines, a, b, on ? C.fg : C.faint, 1.5 + 6 * c.n_present / G.n, dim ? 0.25 : 0.7);
          tip += 'carried by ' + c.n_present + ' of ' + G.n;
        } else {
          var maj = Math.max(c.n_up, c.n_down), col = divColor(c.mean_net, 6);
          chord(lines, a, b, col, 1.5 + 20 * maj / G.n, dim ? 0.12 : 0.35 + 0.65 * Math.min(1, Math.abs(c.mean_net) / 3));
          if (on) chord(lines, a, b, 'none', 1, 0).setAttribute('stroke', C.fg);
          if (n >= cells.length - 4) labels.push([a, b, signed(c.mean_net), col]);
          tip += 'mean net ' + signed(c.mean_net) + ' per receptor; ' + (c.n_down >= c.n_up ? 'weaker in the active model in ' + c.n_down : 'stronger in ' + c.n_up) + ' of ' + c.n_present;
        }
        hits.push([a, b, tip, [c.i, c.j], on]);
      });
      if (small) el('text', { x: X, y: Y + R * 0.9, 'text-anchor': 'middle', 'font-size': 12, fill: C.muted, stroke: C.plate, 'stroke-width': 4, 'paint-order': 'stroke' }, s, 'Width: receptors carrying each pair');
    }
    // selected pair outline
    hits.forEach(function (x) { if (x[4]) { var o2 = chord(lines, x[0], x[1], C.fg, 3, 1); o2.setAttribute('stroke-dasharray', '6 4'); o2.removeAttribute('class'); } });
    var c8 = P(7), Lh = sc * 0.2, dx = Math.cos(H8A) * Lh, dy = -Math.sin(H8A) * Lh;
    el('line', { x1: c8[0] - dx, y1: c8[1] - dy, x2: c8[0] + dx, y2: c8[1] + dy, stroke: C.fg, 'stroke-width': st.mode === 'magnitude' ? Math.min(18, discR[7] * 0.8) : 11, 'stroke-linecap': 'round', opacity: 0.85 }, s);
    el('text', { x: c8[0] + Math.abs(dx) + 10, y: c8[1] - Math.abs(dy) + 4, 'font-size': 12, 'font-weight': 600, fill: C.muted }, s, 'H8');   // past the bar's end
    for (var k = 0; k < 7; k++) {
      var p = P(k), mag = st.mode === 'magnitude';
      el('circle', { cx: p[0], cy: p[1], r: discR[k], fill: mag ? C.fg : C.surface, stroke: C.fg, 'stroke-width': 1.6, 'fill-opacity': mag ? 0.85 : 1 }, s);
      el('text', { x: p[0], y: p[1] + 5, 'text-anchor': 'middle', 'font-size': 14, 'font-family': "'Source Serif 4', Georgia, serif", 'font-weight': 600, fill: mag ? C.surface : C.fg }, s, String(k + 1));
    }
    labels.forEach(function (l) {
      var mx2 = (l[0][0] + l[1][0]) / 2, my = (l[0][1] + l[1][1]) / 2, tw = l[2].length * 7 + 12;
      el('rect', { x: mx2 - tw / 2, y: my - 10, width: tw, height: 20, rx: 10, fill: C.surface, stroke: l[3], 'stroke-width': 1.5 }, s);
      el('text', { x: mx2, y: my + 4.5, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600, fill: C.fg }, s, l[2]);
    });
    if (!o.exporting) {
      var hg = el('g', {}, s);
      hits.forEach(function (x) {
        var hp2 = el('path', { d: 'M' + x[0].join(',') + 'L' + x[1].join(','), stroke: 'transparent', 'stroke-width': 14, fill: 'none', 'stroke-linecap': 'round' }, hg);
        hit(hp2, x[2], x[3] ? function () { StatsSel.set({ pair: x[3] }); openCell(card, x[3][0], x[3][1]); } : null);
      });
    }
    el('text', { x: 10, y: S - 8, 'font-size': 11, fill: C.muted }, s, 'extracellular view; numbers: TM1 to TM7');
    // the followed receptor's own bundle (Direction mode)
    var rec = StatsSel.get().rec;
    if (rec && st.mode === 'direction' && !o.exporting) {
      var box = h('div', 'focus-mini', node);
      Promise.all([load('helix_receptor_cells'), load('receptors')]).then(function (arr) {
        var hc = arr[0], RI = receptorIndex(arr[1]), ri = hc.receptors.indexOf(rec), r = RI.by[rec];
        if (ri < 0 || !r) { box.remove(); return; }
        var mini = svgIn(box, 120, 120, r.symbol + ' helix bundle');
        el('circle', { cx: 60, cy: 60, r: 57, fill: C.plate }, mini);
        var q = function (k) { return [60 + HXY[k][0] * 48, 60 - HXY[k][1] * 48]; };
        hc.pairs.forEach(function (pp, n) {
          var v = hc.net[ri][n]; if (v === null || pp[0] === pp[1]) return;
          var a = q(pp[0]), b = q(pp[1]);
          el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: divColor(v, 6), 'stroke-width': 1 + Math.min(6, Math.abs(v) / 2), 'stroke-linecap': 'round' }, mini);
        });
        for (var j = 0; j < 7; j++) { var pj = q(j); el('circle', { cx: pj[0], cy: pj[1], r: 6, fill: C.surface, stroke: C.fg }, mini); }
        var t = h('div', '', box); h('b', '', t, r.symbol);
        t.appendChild(document.createTextNode(' on its own: net ΔRRCS of its above-threshold contacts between helices, same colors. '));
        t.appendChild(link('Open the ' + r.symbol + ' report', r.report || REPORT(rec)));
      }, function () { box.remove(); });
    }
  }
  function gridView(card, node, w, hp, G, o) {
    var small = G.n < hp.min_receptors;
    var st = card.state, segs = st.segments === 'helices' ? hp.segments.slice(0, hp.n_helices) : hp.segments.slice();
    var order = segs.map(function (s, i) { return i; }).sort(function (a, b) { return segRank(segs[a]) - segRank(segs[b]); });
    var n = segs.length, lab = isPhone() ? 40 : 52, cell = Math.min(st.segments === 'helices' ? 62 : 40, Math.floor((Math.min(w, 620) - lab) / n));
    var s = svgIn(node, lab + n * cell + 2, lab + n * cell + 2, 'Helix pair grid');
    var cells = {}; hpCells(hp, G).forEach(function (c) { cells[c.i + ',' + c.j] = c; });
    var sel = StatsSel.get().pair;
    order.forEach(function (si, r) {
      el('text', { x: lab - 6, y: lab + r * cell + cell / 2 + 4, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 600, fill: C.muted }, s, segs[si]);
      el('text', { x: lab + r * cell + cell / 2, y: lab - 8, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: C.muted, transform: n > 8 ? 'rotate(-50 ' + (lab + r * cell + cell / 2) + ' ' + (lab - 8) + ')' : null }, s, segs[si]);
      order.forEach(function (sj, c) {
        if (c > r) return;
        var a = Math.min(si, sj), b = Math.max(si, sj), x = lab + c * cell, y = lab + r * cell, d = cells[a + ',' + b];
        var ok = d && a !== b && (small ? d.n_present > 0 : d.n_present >= hp.min_receptors);
        var fill = !ok ? C.surface2 : small ? mix(C.surface2, C.faint, 0.35 + 0.65 * d.n_present / G.n) : divColor(d.mean_net, 6);
        var rect = el('rect', { x: x + 1.5, y: y + 1.5, width: cell - 3, height: cell - 3, rx: 4, fill: fill }, s);
        if (!ok) return;
        if (small) {
          if (cell >= 30) el('text', { x: x + cell / 2, y: y + cell / 2 + 4, 'text-anchor': 'middle', 'font-size': cell >= 50 ? 12 : 10, 'font-weight': 700, fill: C.fg }, s, d.n_present + '/' + G.n);
          if (!o.exporting) hit(rect, segs[a] + '-' + segs[b] + ': carried by ' + d.n_present + ' of ' + G.n, function () { if (a < 8 && b < 8) StatsSel.set({ pair: [a, b] }); openCell(card, a, b); });
          return;
        }
        var dark = Math.abs(d.mean_net) > 2.5, txt = dark ? C.onDark : C.fg;
        if (cell >= 34) {
          el('text', { x: x + cell / 2, y: y + cell / 2 + (cell >= 50 ? -1 : 4), 'text-anchor': 'middle', 'font-size': cell >= 50 ? 12 : 10, 'font-weight': 700, fill: txt }, s, signed(d.mean_net));
          if (cell >= 50) el('text', { x: x + cell / 2, y: y + cell / 2 + 13, 'text-anchor': 'middle', 'font-size': 10.5, fill: txt }, s, Math.round(100 * d.agree) + '%');
        }
        var isSel = sel && a < 8 && b < 8 && samePair(sel, [a, b]);
        if (isSel) el('rect', { x: x + 1, y: y + 1, width: cell - 2, height: cell - 2, rx: 4, fill: 'none', stroke: C.fg, 'stroke-width': 2.5 }, s);
        if (!o.exporting) hit(rect, segs[a] + '-' + segs[b] + ': mean net ' + signed(d.mean_net) + ', ' + Math.round(100 * d.agree) + '% of ' + d.n_present + ' receptors agree',
          function () { if (a < 8 && b < 8) StatsSel.set({ pair: [a, b] }); openCell(card, a, b); });
      });
    });
  }
  function ledger(card, hp, G, small) {
    var st = card.state, L = card.ledger;
    if (!L) return;
    if (!G) { G = hp.groups.filter(function (g) { return g.key === st.group; })[0] || hp.groups[0]; small = G.n < hp.min_receptors; }
    clear(L);
    var sel = StatsSel.get().pair;
    if (st.mode === 'magnitude') {
      h('h4', '', L, 'Pairs of TM helices by change per contact');
      var IF = hp.interfaces.filter(function (i) { return i.supported; }).sort(function (a, b) { return b.mean_abs_delta - a.mean_abs_delta; });
      var mx = IF[0].mean_abs_delta;
      IF.slice(0, isPhone() ? 6 : IF.length).forEach(function (i) {
        var r = h('div', 'lrow', L);
        h('span', 'lab', r, i.seg_i + '-' + i.seg_j);
        var bar = h('span', 'lbar', r); var b = h('i', '', bar); b.style.width = (100 * i.mean_abs_delta / mx) + '%'; b.style.background = C.ink;
        var t = h('span', 'txt', r); h('b', '', t, f2(i.mean_abs_delta)); t.appendChild(document.createTextNode(' over ' + fmt(i.n_contacts) + ' contacts'));
      });
      return;
    }
    if (st.mode === 'grid' && !small) {
      h('h4', '', L, 'How to read the grid');
      h('p', 'small-note', L, 'Each cell: mean net ΔRRCS per receptor (bold) and the share of receptors carrying the pair whose net has that sign. Blank: fewer than ' + hp.min_receptors + ' receptors carry the pair, and within-helix pairs (not shown). Click a cell for the receptors behind it.');
      return;
    }
    if (st.mode === 'grid') {
      h('h4', '', L, 'Receptors carrying each helix pair');
      h('p', 'small-note', L, 'With fewer than ' + hp.min_receptors + ' receptors the grid shows how many of them carry each pair, not a class direction. Click a cell for the receptors behind it, or follow one of them:');
      smallChips(L, hp, G);
      return;
    }
    h('h4', '', L, small ? 'Receptors carrying each helix pair' : 'How consistent is each helix pair?');
    var cells = hpCells(hp, G).filter(function (c) { return c.i < 8 && c.j < 8 && c.i !== c.j && c.n_present >= Math.min(hp.min_receptors, G.n) && c.coverage >= 0.25; })
      .sort(function (a, b) { return small ? b.n_present - a.n_present : Math.abs(b.mean_net) - Math.abs(a.mean_net); }).slice(0, isPhone() ? 5 : 8);
    if (sel && !cells.some(function (c) { return samePair(sel, [c.i, c.j]); })) {
      var extra = hpCells(hp, G).filter(function (c) { return samePair(sel, [c.i, c.j]); })[0];
      if (extra && extra.n_present) cells.push(extra);
    }
    cells.forEach(function (c) {
      var r = h('button', 'lrow', L); r.type = 'button'; r.setAttribute('data-pair', HELIX[c.i] + '-' + HELIX[c.j]); r.setAttribute('data-key', 'ledger ' + HELIX[c.i] + '-' + HELIX[c.j]);
      if (samePair(sel, [c.i, c.j])) r.classList.add('is-sel');
      h('span', 'lab', r, HELIX[c.i] + '-' + HELIX[c.j]);
      var bar = h('span', 'lbar', r), t = h('span', 'txt', r);
      if (small) {
        var bb = h('i', '', bar); bb.style.width = (100 * c.n_present / G.n) + '%'; bb.style.background = C.faint;
        t.appendChild(document.createTextNode('carried by ')); h('b', '', t, c.n_present + ' of ' + G.n);
      } else {
        var dn = h('i', '', bar), up = h('i', '', bar);
        dn.style.width = (100 * c.n_down / c.n_present) + '%'; dn.style.background = C.inactive;
        up.style.width = (100 * c.n_up / c.n_present) + '%'; up.style.background = C.active;
        var weaker = c.n_down >= c.n_up;
        t.appendChild(document.createTextNode((weaker ? 'weaker' : 'stronger') + ' in '));
        h('b', '', t, (weaker ? c.n_down : c.n_up) + ' of ' + c.n_present);
        t.appendChild(document.createTextNode(' (' + Math.round(100 * Math.max(c.n_up, c.n_down) / c.n_present) + '%)'));
      }
      r.addEventListener('click', function () { StatsSel.set({ pair: [c.i, c.j] }); openCell(card, c.i, c.j); });
    });
    if (small) {
      h('p', 'small-note', L, 'With fewer than ' + hp.min_receptors + ' receptors the page shows which helix pairs they carry, not a class direction. Follow one of them:');
      smallChips(L, hp, G);
    } else {
      h('p', 'small-note', L, 'Bars: receptors carrying the pair, split by the sign of their net change (blue weaker, red stronger in the active model). Click a line or a row for the receptors behind it.');
    }
  }
  function smallChips(L, hp, G) {
    var list = h('div', 'group-chips-list chips', L);
    hp.receptors.filter(function (r) { return r.ligand === G.key; }).forEach(function (r) {
      var b = h('button', '', list, r.symbol); b.type = 'button'; b.setAttribute('aria-pressed', StatsSel.get().rec === r.gid ? 'true' : 'false');
      b.setAttribute('data-key', 'follow ' + r.gid);
      b.addEventListener('click', function () { StatsSel.set({ rec: r.gid }); });
    });
  }
  function openCell(card, a, b) {
    var hp = card.D.helix_pairs, st = card.state;
    if (st.mode === 'magnitude') return;
    card.sideKey = [a, b];
    var G = hp.groups.filter(function (g) { return g.key === st.group; })[0] || hp.groups[0];
    var name = hp.segments[a] + '-' + hp.segments[b];
    load('helix_pair_cells').then(function (hc) {
      var cell = hc.cells.filter(function (c) { return c.i === a && c.j === b; })[0];
      var list = cell ? cell.receptors.filter(function (r) { return G.key === 'all' || hp.receptors[r[0]].ligand === G.key; }) : [];
      openSide(card, name + ': the receptors behind it' + (G.key === 'all' ? '' : ' (' + G.label.replace(/ receptors$/, '').toLowerCase() + ')'), function (side) {
        if (!list.length) { h('p', 'side-note', side, 'No receptor in this group has an above-threshold pair here.'); return; }
        var pick = list.length > 16 ? list.slice(0, 8).concat(list.slice(-8)) : list;
        var mx = maxOf(pick.map(function (r) { return Math.abs(r[1]); })) || 1, bars = h('div', 'side-bars', side);
        pick.forEach(function (r) {
          var rec = hp.receptors[r[0]], row = h('div', 'sb', bars);
          h('span', '', row, rec.symbol);
          var track = h('span', '', row), i = h('i', '', track);
          i.style.width = (100 * Math.abs(r[1]) / mx) + '%'; i.style.background = r[1] >= 0 ? C.active : C.inactive;
          h('span', '', row, signed(r[1], 1));
        });
        h('p', 'side-note', side, fmt(list.length) + ' receptors with an above-threshold pair here' + (list.length > 16 ? '; the bars show the eight at each end' : '') + '. Red: stronger in the active model. Blue: stronger in the inactive model.');
        side.appendChild(sideTable([{ label: 'Receptor' }, { label: 'Net', num: true, sign: true }, { label: 'Gain', num: true }, { label: 'Loss', num: true }, { label: 'Pairs', num: true }, { label: '' }],
          list.map(function (r) {
            var rec = hp.receptors[r[0]], fb = h('button', 'cc-btn', null, 'Follow'); fb.type = 'button';
            fb.addEventListener('click', function () { StatsSel.set({ rec: rec.gid }); });
            return [link(rec.symbol, REPORT(rec.gid)), r[1], r[2], r[3], r[4], fb];
          })));
      });
    }, function () { openSide(card, name, function (side) { h('p', 'side-note', side, 'The receptor list could not load.'); }); });
  }

  define('chart-segments', {
    needs: ['helix_pairs', 'class_positions'],
    draw: function (card, node, w, o) {
      var S = card.D.helix_pairs.segments_magnitude, mode = segMode(), sel = StatsSel.get();
      var mark = {};
      if (sel.pos) { var p = positionIndex(card.D.class_positions).by[sel.pos]; if (p) mark[p.segment] = true; }
      if (sel.pair) { mark[HELIX[sel.pair[0]]] = true; mark[HELIX[sel.pair[1]]] = true; }
      var blocks;
      if (mode === 'sequence') blocks = [['', S.slice().sort(function (a, b) { return segRank(a.segment) - segRank(b.segment); })]];
      else blocks = [['Helices', S.filter(function (x) { return x.block === 'Helices'; }).sort(function (a, b) { return segRank(a.segment) - segRank(b.segment); })],
                     ['Loops and termini', S.filter(function (x) { return x.block !== 'Helices'; }).sort(function (a, b) { return segRank(a.segment) - segRank(b.segment); })]];
      var hel = S.filter(function (x) { return x.block === 'Helices'; }).sort(function (a, b) { return b.mean_abs_delta - a.mean_abs_delta; });
      var lead = { }; lead[hel[0].segment] = 1; lead[hel[1].segment] = 1;
      var rh = 22, lab = isPhone() ? 62 : 72, n = S.length, hh = n * rh + blocks.filter(function (b) { return b[0]; }).length * 26 + 30;
      var s = svgIn(node, w, hh, 'Mean |ΔRRCS| per contact endpoint by segment');
      if (anim(o)) s.classList.add('draw-in');
      var mx = maxOf(S.map(function (q) { return q.mean_abs_delta; })), x = function (v) { return lab + v / (mx * 1.12) * (w - lab - 50); };
      var y = 0;
      blocks.forEach(function (blk) {
        if (blk[0]) { el('text', { x: 0, y: y + 16, 'font-size': 11.5, 'font-weight': 700, fill: C.muted }, s, blk[0]); y += 24; }
        blk[1].forEach(function (q) {
          var isH = q.block === 'Helices', hi = !!lead[q.segment];
          el('text', { x: lab - 8, y: y + 14, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: C.fg }, s, q.segment);
          var r = el('rect', { x: lab, y: y + 4, width: Math.max(1, x(q.mean_abs_delta) - lab), height: 13, rx: 2, fill: C.ink, 'fill-opacity': isH ? (hi ? 1 : 0.6) : 0.32, class: 'grow' }, s);
          if (!o.exporting) r.setAttribute('data-tip', q.segment + ': mean |ΔRRCS| ' + f2(q.mean_abs_delta) + ' per contact endpoint, median ' + f2(q.median_abs_delta) + ', ' + fmt(q.endpoints) + ' endpoints');
          if (mark[q.segment]) el('rect', { x: lab - 2, y: y + 2, width: x(q.mean_abs_delta) - lab + 4, height: 17, rx: 3, fill: 'none', stroke: C.fg, 'stroke-width': 2 }, s);
          el('text', { x: x(q.mean_abs_delta) + 6, y: y + 15, 'font-size': 11.5, 'font-weight': hi ? 700 : 400, fill: C.fg }, s, f2(q.mean_abs_delta));
          y += rh;
        });
        y += 4;
      });
      el('text', { x: lab, y: hh - 4, 'font-size': 11, fill: C.muted }, s, 'mean |ΔRRCS| per contact endpoint');
    },
    onSelect: function (card) { draw(card, {}); }
  });

  // ================================================================== 3 positions
  // a position picked on a chart: the profile opens beside the mark (anchor) and takes the focus
  function selectPos(gn, card, anchor) { Profile.open(gn, card, anchor, { focus: true }); StatsSel.set({ pos: gn }); }

  define('chart-scaffold', {
    needs: ['class_positions'],
    draw: function (card, node, w, o) {
      var cp = card.D.class_positions, PI = positionIndex(cp), sc = cp.scaffold;
      var res = rows(sc.columns, sc.residues), sel = StatsSel.get().pos;
      if (!o.exporting) legend(card, cp);
      if (isPhone() || w < 560) return ladder(card, node, w, res, PI, cp, o);
      var xs = res.map(function (r) { return r.x; }), ys = res.map(function (r) { return r.y; });
      var x0 = minOf(xs) - 30, x1 = maxOf(xs) + 30, y0 = minOf(ys) - 40, y1 = maxOf(ys) + 34, vw = x1 - x0, vh = y1 - y0;
      var scale = w / vw, s = el('svg', { viewBox: [x0, y0, vw, vh].join(' '), width: w, height: Math.round(vh * scale), role: 'img', 'aria-label': 'ADRB2 snake plot colored by recurrence', style: 'max-width:100%;height:auto' }, node);
      var tm = res.filter(function (r) { return /^TM/.test(r.segment); }).map(function (r) { return r.y; });
      var my0 = quant(tm, 0.06), my1 = quant(tm, 0.94);
      el('rect', { x: x0, y: my0, width: vw, height: my1 - my0, fill: C.plate }, s);
      el('text', { x: x1 - 6, y: my0 - 8, 'text-anchor': 'end', 'font-size': 12, fill: C.muted }, s, 'extracellular');
      el('text', { x: x1 - 6, y: y1 - 6, 'text-anchor': 'end', 'font-size': 12, fill: C.muted }, s, 'intracellular');
      var path = '';
      res.forEach(function (r, i) { path += (i ? 'L' : 'M') + r.x + ',' + r.y; });
      el('path', { d: path, fill: 'none', stroke: C.line, 'stroke-width': 1.2 }, s);
      var leaders = el('g', {}, s), groups = {}, selP = null;
      res.forEach(function (r) {
        var x = r.gn && PI.by[r.gn], n = r.gn ? (r.n === undefined ? (x ? x.n : 0) : r.n) : 0, bi = r.gn ? bandOf(n, cp.bands) : -1;
        var g = el('g', { 'data-gn': r.gn || null }, s);
        el('circle', { cx: r.x, cy: r.y, r: 8.4, fill: bi < 0 ? C.surface : band(bi), stroke: bi < 0 || bi < 3 ? C.line : 'none', 'stroke-width': 1 }, g);
        el('text', { x: r.x, y: r.y + 3.5, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 600, fill: bi >= 3 ? (C.dark && bi >= 4 ? '#0d1117' : '#ffffff') : C.muted, 'pointer-events': 'none' }, g, r.aa);
        var tip = r.aa + r.num + (r.gn ? ' · ' + r.gn + ' · CFR in ' + n + ' of ' + NREC + ' receptors' + (x ? ' · CFR score rank ' + x.rank : '') : ' · no generic number');
        if (!o.exporting) hit(g, tip, r.gn && x ? function (e, nd) { selectPos(r.gn, card, nd); } : null, null, true);
        var m = r.gn && PI.motif[r.gn];
        if (m) { (groups[m + '|' + r.segment] = groups[m + '|' + r.segment] || []).push([r.x, r.y]); el('circle', { cx: r.x, cy: r.y, r: 11, fill: 'none', stroke: C.fg, 'stroke-width': 1.8, 'pointer-events': 'none' }, s); }
        if (sel && r.gn === sel) selP = r;
      });
      if (selP) {
        el('circle', { cx: selP.x, cy: selP.y, r: 14, fill: 'none', stroke: C.fg, 'stroke-width': 3 }, s);
        el('circle', { cx: selP.x, cy: selP.y, r: 17.5, fill: 'none', stroke: C.surface, 'stroke-width': 2 }, s);
      }
      // motif labels: rings of growing radius around each group's centroid, horizontal spots first,
      // skipping spots that overlap a residue or a placed label; a dashed leader under the residues
      var occ = res.map(function (r) { return [r.x - 10, r.y - 10, r.x + 10, r.y + 10]; });
      var clash = function (b) { return b[0] < x0 || b[2] > x1 || occ.some(function (q) { return b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]; }); };
      Object.keys(groups).forEach(function (k) {
        var P = groups[k], name = k.split('|')[0], tw = name.length * 8 + 6, th = 15;
        var mx = P.reduce(function (a, p) { return a + p[0]; }, 0) / P.length, my = P.reduce(function (a, p) { return a + p[1]; }, 0) / P.length, best = null;
        for (var d = 18; d <= 120 && !best; d += 6) {
          for (var ai = 0; ai < 16 && !best; ai++) {
            var ang = Math.PI * [0, 8, 1, 15, 7, 9, 2, 14, 6, 10, 3, 13, 5, 11, 4, 12][ai] / 8, lx = mx + d * Math.cos(ang), ly = my + d * Math.sin(ang);
            var b = [lx - tw / 2, ly - th / 2, lx + tw / 2, ly + th / 2];
            if (!clash(b)) best = [lx, ly, b];
          }
        }
        if (!best) best = [mx, my - 26, [mx - tw / 2, my - 34, mx + tw / 2, my - 19]];
        occ.push(best[2]);
        var near = P.reduce(function (q, p) { return Math.hypot(p[0] - best[0], p[1] - best[1]) < Math.hypot(q[0] - best[0], q[1] - best[1]) ? p : q; });
        var dx = best[0] - near[0], dy = best[1] - near[1], L = Math.hypot(dx, dy) || 1;
        el('line', { x1: near[0] + 11 * dx / L, y1: near[1] + 11 * dy / L, x2: best[0] - (tw / 2) * dx / L * 0.9, y2: best[1] - (th / 2) * dy / L * 0.9, stroke: C.fg, 'stroke-width': 1, 'stroke-dasharray': '3 2' }, leaders);
        el('text', { x: best[0], y: best[1] + 4.5, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 700, fill: C.fg, stroke: C.surface, 'stroke-width': 4, 'paint-order': 'stroke' }, s, name);
      });
    },
    onSelect: function (card) { draw(card, {}); }
  });
  function legend(card, cp) {
    if (!card.legend) return;
    var html = '<span><b>Receptors with a CFR at the position:</b></span>' + cp.bands.map(function (b, i) {
      return '<span><span class="sw" style="background:' + band(i) + ';border:1px solid var(--st-line)"></span>' + esc(b.label) + (b.positions ? ' (' + b.positions + ')' : '') + '</span>';
    }).join('') + '<span><span class="sw hollow"></span>no generic number</span><span><span class="sw ring"></span>activation motif</span>';
    card.legend.innerHTML = html;
  }
  function ladder(card, node, w, res, PI, cp, o) {
    var lab = 34, rh = 32, seg = HELIX.map(function (s) { return res.filter(function (r) { return r.segment === s; }); });
    var mx = maxOf(seg.map(function (r) { return r.length; })), cw = Math.min(12, (w - lab) / mx), sel = StatsSel.get().pos;
    var s = svgIn(node, w, seg.length * rh + 6, 'Recurrence along each helix of ADRB2');
    seg.forEach(function (row, i) {
      var y = i * rh + 4, marks = {};
      el('text', { x: 0, y: y + 11, 'font-size': 12, 'font-weight': 600, fill: C.muted }, s, HELIX[i]);
      row.forEach(function (r, j) {
        var x = r.gn && PI.by[r.gn], n = r.gn ? (r.n === undefined ? (x ? x.n : 0) : r.n) : 0, bi = r.gn ? bandOf(n, cp.bands) : -1, xx = lab + j * cw;
        var rect = el('rect', { x: xx, y: y, width: cw - 1, height: 14, rx: 2, fill: bi < 0 ? C.surface : band(bi), stroke: bi < 0 ? C.line : 'none', 'data-gn': r.gn || null }, s);
        if (!o.exporting) hit(rect, r.aa + r.num + (r.gn ? ' · ' + r.gn + ' · CFR in ' + n + ' of ' + NREC : ''), x ? function (e, nd) { selectPos(r.gn, card, nd); } : null, null, true);
        var m = r.gn && PI.motif[r.gn];
        if (m) { el('rect', { x: xx - 0.5, y: y - 1.5, width: cw, height: 17, rx: 2.5, fill: 'none', stroke: C.fg, 'stroke-width': 1.4 }, s); (marks[m] = marks[m] || []).push(xx); }
        if (sel && r.gn === sel) el('rect', { x: xx - 2, y: y - 3, width: cw + 3, height: 20, rx: 3, fill: 'none', stroke: C.fg, 'stroke-width': 2.4 }, s);
      });
      Object.keys(marks).forEach(function (k) { el('text', { x: Math.min(w - 40, marks[k][0]), y: y + 27, 'font-size': 10.5, 'font-weight': 700, fill: C.fg }, s, k); });
    });
  }

  // ---- ranking: two columns of 25 rows (desktop) or 20 plus "Show all" (phone), then the 368 strip
  define('chart-ranking', {
    needs: ['class_positions'],
    init: function (card) {
      card.state.sort = 'score';
      card.strip = card.el.querySelector('[data-strip368]');
      var box = card.el.querySelector('[data-ctl="sort"]');
      box.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          card.state.sort = b.getAttribute('data-value');
          box.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          draw(card, { fade: true });
        });
      });
      document.addEventListener('gpc:segment-order', function () { if (card.state.sort === 'segment') draw(card, {}); });
    },
    serverTable: function (card) { return card.serverTable; },
    suffix: function (card) { return card.state.sort === 'score' ? '' : card.state.sort; },
    draw: function (card, node, w, o) {
      var cp = card.D.class_positions, PI = positionIndex(cp), sel = StatsSel.get().pos;
      var top = PI.ranking.slice(0, cp.top_n), st = card.state;
      if (st.sort === 'receptors') top = top.slice().sort(function (a, b) { return b.n - a.n || a.rank - b.rank; });
      else if (st.sort === 'segment') top = top.slice().sort(function (a, b) { return segRank(a.segment) - segRank(b.segment) || a.rank - b.rank; });
      var phone = isPhone() || w < 640, showAll = card.showAll || o.exporting;
      var outlier = top.reduce(function (m, x) { return x.mean_abs_delta > m.mean_abs_delta ? x : m; }, top[0]);
      var list = phone ? (showAll ? top : top.slice(0, 20)) : top;
      var ncol = phone ? 1 : 2, per = Math.ceil(list.length / ncol), gap = 28, cw = (w - gap * (ncol - 1)) / ncol, rh = 24, head = 20;
      var s = svgIn(node, w, head + per * rh + 4, 'The top-ranked positions by CFR score');
      if (anim(o)) s.classList.add('draw-in');
      for (var c = 0; c < ncol; c++) {
        var ox = c * (cw + gap), col = list.slice(c * per, (c + 1) * per);
        var bx = ox + 24 + 8 + 74 + 8 + 38 + 8, bw = cw - (bx - ox) - 48;
        var bs = Math.min(0.72, Math.max(0.3, (bw - 86) / bw));   // room for the count and a motif tag
        var rlab = fit(['receptors, of ' + NREC, 'receptors'], ox + cw - 28 - bx, 11);
        [['#', ox + 24, 'end'], ['position', ox + 32, 'start'], ['seg.', ox + 114, 'start'], [rlab, bx, 'start'], ['|Δ|', ox + cw, 'end']].forEach(function (t) {
          el('text', { x: t[1], y: 13, 'text-anchor': t[2], 'font-size': 11, fill: C.muted }, s, t[0]);
        });
        el('line', { x1: ox, x2: ox + cw, y1: head - 1, y2: head - 1, stroke: C.line }, s);
        col.forEach(function (x, i) {
          var y = head + i * rh, g = el('g', { 'data-gn': x.gn }, s), isSel = x.gn === sel;
          el('rect', { x: ox, y: y, width: cw, height: rh, fill: isSel ? C.brandSoft : 'transparent' }, g);
          if (isSel) el('rect', { x: ox + 0.75, y: y + 0.75, width: cw - 1.5, height: rh - 1.5, fill: 'none', stroke: C.fg, 'stroke-width': 1.5, rx: 3 }, g);
          el('line', { x1: ox, x2: ox + cw, y1: y + rh, y2: y + rh, stroke: C.lineSoft }, g);
          el('text', { x: ox + 24, y: y + 16, 'text-anchor': 'end', 'font-size': 12, fill: C.muted }, g, String(x.rank));
          var a = o.exporting ? g : el('a', { href: SEARCH(x.gn), tabindex: '-1' }, g);
          el('text', { x: ox + 32, y: y + 16, 'font-size': 12, 'font-family': 'ui-monospace, Menlo, Consolas, monospace', fill: C.brand }, a, x.gn);
          el('text', { x: ox + 114, y: y + 16, 'font-size': 11.5, fill: C.muted, class: 'rk-seg' }, g, x.segment);
          var bl = Math.max(2, bw * bs * x.n / NREC);
          el('rect', { x: bx, y: y + 8, width: bl, height: 8, rx: 2, fill: C.b3, class: 'grow' }, g);
          var tx = bx + bl + 5;
          el('text', { x: tx, y: y + 16, 'font-size': 11.5, fill: C.muted }, g, String(x.n));
          tx += String(x.n).length * 7 + 6;
          var tags = [];
          if (x.motif) tags.push([x.motif, false]);
          if (x === outlier) tags.push(['ranked on |Δ|', true]);
          tags.forEach(function (t) {
            var tw = t[0].length * 6.6 + 8;
            if (tx + tw > ox + cw - 44) return;
            el('rect', { x: tx, y: y + 5, width: tw, height: 15, rx: 3, fill: 'none', stroke: t[1] ? C.muted : C.fg, 'stroke-dasharray': t[1] ? '3 2' : null }, g);
            el('text', { x: tx + tw / 2, y: y + 16, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': t[1] ? 500 : 700, fill: t[1] ? C.muted : C.fg }, g, t[0]);
            tx += tw + 4;
          });
          el('text', { x: ox + cw, y: y + 16, 'text-anchor': 'end', 'font-size': 11.5, fill: C.muted }, g, f2(x.mean_abs_delta));
          if (!o.exporting) {
            var hitR = el('rect', { x: ox + 112, y: y, width: cw - 112, height: rh, fill: 'transparent' }, g);
            hit(hitR, x.gn + ': CFR in ' + x.n + ' of ' + NREC + ' receptors, mean |ΔRRCS| ' + f2(x.mean_abs_delta) + ', CFR score ' + x.cfr_score.toFixed(3), function (e, nd) { selectPos(x.gn, card, nd); }, 'Open the profile of ' + x.gn);
          }
        });
      }
      if (!o.exporting && phone) {
        var more = h('button', 'cc-btn show-all', node, showAll ? 'Show 20 positions' : 'Show all ' + top.length + ' positions'); more.type = 'button';
        more.addEventListener('click', function () { card.showAll = !card.showAll; draw(card, {}); });
      }
      strip(card, o.exporting ? node : card.strip, w, cp, PI, o);
    },
    onSelect: function (card) { draw(card, {}); }
  });
  function strip(card, node, w, cp, PI, o) {
    if (!node) return;
    if (!o.exporting) clear(node);
    var A = PI.ranking, sel = StatsSel.get().pos, lanes = MOTIF_ORDER.filter(function (m) { return cp.motifs.some(function (x) { return x.name === m; }); });
    var laneH = 12, lab = isPhone() ? 46 : 52, hh = 74, top = lanes.length * laneH + 8, bw = (w - lab) / A.length;
    var s = svgIn(node, w, top + hh + 24, 'All recurrent positions in CFR score order, with activation motif lanes');
    s.classList.add('export-part');
    var x = function (i) { return lab + i * bw; };
    lanes.forEach(function (m, k) {
      var y = k * laneH + 6, mo = cp.motifs.filter(function (q) { return q.name === m; })[0];
      el('text', { x: lab - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10.5, 'font-weight': 600, fill: C.fg }, s, m);
      el('line', { x1: lab, x2: w, y1: y, y2: y, stroke: C.lineSoft }, s);
      mo.positions.forEach(function (g) { var p = PI.by[g]; if (p) el('circle', { cx: x(p.rank - 0.5), cy: y, r: 3.2, fill: p.rank <= cp.top_n ? C.fg : C.surface, stroke: C.fg, 'stroke-width': 1.2 }, s); });
    });
    A.forEach(function (p, i) {
      var y = top + hh - p.n / NREC * hh;
      var r = el('rect', { x: x(i), y: y, width: Math.max(0.6, bw - 0.4), height: top + hh - y, fill: i < cp.top_n ? C.b4 : C.b2, 'data-gn': p.gn }, s);
      if (!o.exporting) hit(r, p.gn + ' · rank ' + p.rank + ' · CFR in ' + p.n + ' of ' + NREC, function (e, nd) { selectPos(p.gn, card, nd); }, null, true);
    });
    if (sel && PI.by[sel]) {
      var i = PI.by[sel].rank - 1, xx = x(i) + bw / 2;
      el('line', { x1: xx, x2: xx, y1: top - 2, y2: top + hh, stroke: C.fg, 'stroke-width': 1.5 }, s);
      el('text', { x: Math.min(w - 4, Math.max(lab, xx + 4)), y: top + 10, 'text-anchor': xx > w - 80 ? 'end' : 'start', 'font-size': 11, 'font-weight': 700, fill: C.fg, stroke: C.surface, 'stroke-width': 3, 'paint-order': 'stroke' }, s, sel);
    }
    var cut = x(cp.top_n);
    el('line', { x1: cut, x2: cut, y1: top - 4, y2: top + hh + 4, stroke: C.fg, 'stroke-dasharray': '3 3' }, s);
    el('text', { x: cut + 5, y: top + 22, 'font-size': 11, fill: C.fg }, s, 'top ' + cp.top_n);
    el('text', { x: isPhone() ? lab : w, y: top + hh + 18, 'text-anchor': isPhone() ? 'start' : 'end', 'font-size': 11, fill: C.muted }, s,
      fit(['bar height: receptors with a CFR at the position; lanes: activation motif positions by rank (filled: top ' + cp.top_n + ')',
           'height: receptors; lanes: motif positions by rank', 'height: receptors; lanes: motifs'], isPhone() ? w - lab : w, 11));
  }

  // ---- position profile: one shared drawer
  var Profile = (function () {
    var panel = null, hostCard = null, current = null, back = null;
    function close(clearSel, refocusTrigger) {
      if (panel) { panel.remove(); panel = null; }
      current = null;
      if (clearSel && StatsSel.get().pos) StatsSel.set({ pos: null });
      if (refocusTrigger && back) { var k = back; back = null; refocus(STATS, k); }
    }
    // Escape closes the profile, unless another control used it (the selection box, an export menu, a side panel)
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !panel || e.defaultPrevented) return;
      var t = e.target;
      if (t && t.closest && t.closest('.sel, .xmenu, .chart-card-side, input, select, textarea')) return;
      close(true, true);
    });
    // a click outside closes it, but not a click on a chart, a control or a panel: those select or act
    document.addEventListener('click', function (e) {
      if (!panel || panel.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-hit], [data-chart], [data-strip368], .ledger, .chart-card-side, .controls, .chips, .tabs, .legend, .scard-foot, .sel, .lrow, button, a, canvas, .js-plotly-plot')) return;
      close(true);
    });
    function open(gn, card, anchor, opts) {
      card = card || CARDS['chart-ranking'];
      if (!card) return;
      opts = opts || {};
      // where the mark sits in the card now: the selection redraws the card before the profile is built
      if (anchor && anchor.getBoundingClientRect && !isPhone()) {
        var ar = anchor.getBoundingClientRect();
        if (ar.height || ar.width) opts.anchorTop = ar.top - card.el.getBoundingClientRect().top;
      }
      if (opts.focus) back = focusKey(STATS) || (anchor && anchor.getAttribute && anchor.getAttribute('data-key')) || null;
      current = gn; hostCard = card;
      Promise.all([load('class_positions'), load('cfr_atlas').catch(function () { return null; }), load('cfr_variants').catch(function () { return null; })]).then(function (arr) {
        if (current !== gn) return;
        build(gn, card, arr[0], arr[1], arr[2], anchor, opts);
      });
    }
    // desktop: beside the mark that opened it (or near the top of the card), kept inside the card
    function place(card, anchorTop) {
      if (isPhone() || !panel) return;
      var top = anchorTop === undefined ? 104 : anchorTop - 24;
      var ph = panel.offsetHeight || 420;
      top = Math.max(8, Math.min(top, card.el.offsetHeight - ph - 8));
      panel.style.top = Math.round(top) + 'px';
    }
    function build(gn, card, cp, atlas, cv, anchor, opts) {
      var PI = positionIndex(cp), x = PI.by[gn];
      if (!x) return;
      opts = opts || {};
      if (panel) panel.remove();
      panel = h('aside', 'pos-profile', card.el);
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Position ' + gn); panel.tabIndex = -1;
      h('span', 'handle', panel);
      var xb = h('button', 'x', panel, '×'); xb.type = 'button'; xb.setAttribute('aria-label', 'Close');
      xb.addEventListener('click', function (e) { e.stopPropagation(); close(true, true); });
      var head = h('div', 'pgn', panel, gn);
      if (x.motif) h('span', 'tag', head, x.motif);
      h('div', 'psub', panel, x.segment + (x.adrb2 ? ' · ' + cp.scaffold.gene + ' ' + x.adrb2 : '') + ' · rank ' + x.rank + ' by CFR score');
      h('div', 'pbig', panel, x.n + ' of ' + NREC + ' receptors have a CFR here (' + f1(x.pct) + '%)');
      var k = atlas ? atlas.positions.map(function (p) { return p.gn; }).indexOf(gn) : -1;
      if (k >= 0) {
        var col = atlas.columns[k];
        h('div', 'plab', panel, 'Net change of those contacts');
        var bar = h('div', 'pbar', panel), dn = h('i', '', bar), up = h('i', '', bar);
        dn.style.width = (100 * col.n_down / col.n_hit) + '%'; dn.style.background = C.inactive;
        up.style.width = (100 * col.n_up / col.n_hit) + '%'; up.style.background = C.active;
        h('div', 'pnote', panel, 'stronger in the inactive model in ' + col.n_down + ', in the active model in ' + col.n_up);
        var rec = StatsSel.get().rec;
        if (rec) {
          var rr = atlas.receptors.filter(function (r) { return r.gid === rec; })[0];
          if (rr) {
            var stc = rr.state.charAt(k), v = rr.net[k];
            h('div', 'pnote', panel, rr.symbol + ': ' + (stc === '2' ? 'a CFR here, net ' + signed(v, 1) + (v > 0 ? ', stronger in the active model' : v < 0 ? ', stronger in the inactive model' : '') : stc === '1' ? 'numbered, no above-threshold contact' : 'not numbered'));
          }
        }
      }
      var dl = h('dl', '', panel);
      function row(a, b) { h('dt', '', dl, a); h('dd', '', dl, b); }
      row('Mean |ΔRRCS|', f2(x.mean_abs_delta));
      var pa = PI.partners[gn];
      if (pa && pa.top_partner) { row('Most frequent partner', pa.top_partner + ', in ' + pa.top_partner_n + ' receptors'); row('Distinct partners', String(pa.distinct_partners)); }
      var co = PI.cons[gn];
      row('Conservation (mean)', co ? f2(co.mean) + ' over ' + co.n_residues + ' residues' : 'fewer than ' + cp.conservation.min_residues + ' scored residues');
      var vp = cv ? cv.positions.filter(function (p) { return p.generic === gn; })[0] : null;
      if (vp) {
        var a = vp.am_substitutions, sc = a.pathogenic + a.ambiguous + a.benign;
        h('div', 'plab', panel, CFG.labels.site_gnomad + ' substitutions here: ' + fmt(vp.substitutions));
        var vb = h('div', 'pbar', panel);
        [['pathogenic', 'c-path'], ['ambiguous', 'c-amb'], ['benign', 'c-ben']].forEach(function (q) { var i = h('i', q[1], vb); i.style.width = (sc ? 100 * a[q[0]] / sc : 0) + '%'; });
        h('div', 'pnote', panel, 'AlphaMissense: ' + fmt(a.pathogenic) + ' predicted pathogenic, ' + fmt(a.ambiguous) + ' ambiguous, ' + fmt(a.benign) + ' predicted benign');
        var rec2 = StatsSel.get().rec;
        if (rec2 && (CFG.labels.variants_none_gids || []).indexOf(rec2) >= 0) h('div', 'pnote', panel, 'No ' + CFG.labels.site_gnomad + ' missense records for this receptor.');
      }
      var links = h('div', 'plinks', panel);
      if (vp) {
        var b = h('button', 'cc-btn', links, 'Receptors numbered here, with their variants'); b.type = 'button';
        b.addEventListener('click', function (e) { e.stopPropagation(); var vc = CARDS['chart-cfr-variants']; if (vc) { loadCard(vc).then(function () { showVariantPosition(vc, vp, true); vc.el.scrollIntoView({ block: 'start', behavior: SCROLL() }); }); } });
      }
      links.appendChild(link('Search ' + gn, SEARCH(gn), 'cc-btn'));
      place(card, opts.anchorTop);
      if (opts.focus) panel.focus({ preventScroll: isPhone() });
      if ((opts.focus || opts.scroll) && !isPhone()) {
        var me = panel;
        me.scrollIntoView({ block: 'nearest', behavior: SCROLL() });
        // cards that load on the way can move it: look again once the scroll has settled
        setTimeout(function () {
          if (panel !== me) return;
          var r = me.getBoundingClientRect();
          if (r.bottom < 60 || r.top > window.innerHeight - 40) me.scrollIntoView({ block: 'nearest' });
        }, 900);
      }
    }
    document.addEventListener('gpc:stats-select', function (e) {
      var p = e.detail.pos, o = { scroll: !e.detail.fromURL };
      if (!p) { if (panel) close(false); return; }
      if (e.detail.noProfile) { if (panel) close(false); return; }   // a view that shows the position itself
      if (p !== current) open(p, hostCard && hostCard.el.isConnected ? hostCard : null, null, o);
      else if (panel) open(p, hostCard, null, {});
    });
    return { open: open, close: close };
  })();

  define('chart-recovery', {
    needs: ['class_positions'],
    draw: function (card, node, w, o) {
      var cp = card.D.class_positions, Rv = cp.recovery, list = rows(Rv.columns, Rv.rows), M = Rv.universe, K = Rv.known;
      var hh = isPhone() ? 220 : 250, ml = 34, mb = 42, s = svgIn(node, w, hh + mb, 'Known activation positions found down the ranking');
      if (anim(o)) s.classList.add('draw-in');
      var x = function (n) { return ml + n / M * (w - ml - 8); }, y = function (k) { return hh - k / K * (hh - 10); };
      [0, 10, 20, 30, K].forEach(function (t) {
        el('line', { x1: ml, x2: w - 8, y1: y(t), y2: y(t), stroke: C.lineSoft }, s);
        el('text', { x: ml - 6, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, s, String(t));
      });
      el('line', { x1: x(0), y1: y(0), x2: x(M), y2: y(K), stroke: C.muted, 'stroke-dasharray': '5 4', 'stroke-width': 1.4 }, s);
      var d = 'M' + x(0) + ',' + y(0), len = 0, px = x(0), py = y(0);
      list.forEach(function (r) { var nx = x(r.rank_in_universe), ny = y(r.known_found); len += Math.abs(nx - px) + Math.abs(ny - py); px = nx; py = ny; d += 'H' + nx.toFixed(1) + 'V' + ny.toFixed(1); });
      el('path', { d: d, fill: 'none', stroke: C.brand, 'stroke-width': 2.4, class: 'trace', style: '--len:' + Math.ceil(len) }, s);
      var rankText = function (r) { return 'rank ' + r.rank_in_universe + ' of ' + M + (r.cfr_score_rank !== r.rank_in_universe ? '; CFR score rank ' + r.cfr_score_rank : ''); };
      list.forEach(function (r) { if (r.known) { var t = el('rect', { x: x(r.rank_in_universe) - 0.8, y: hh + 4, width: 1.6, height: 7, fill: C.fg }, s); if (!o.exporting) t.setAttribute('data-tip', r.gn + (r.motif ? ' (' + r.motif + ')' : '') + ', ' + rankText(r)); } });
      Object.keys(Rv.cuts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n, i) {
        var cut = Rv.cuts[n], kf = cut.known_found, px2 = x(n), py2 = y(kf);
        el('circle', { cx: px2, cy: py2, r: 4.5, fill: C.brand, stroke: C.surface, 'stroke-width': 2 }, s);
        var tx = Math.min(px2 + (i ? 34 : 26), w - 150), ty = py2 + (i ? 36 : 24);
        el('line', { x1: px2 + 4, y1: py2 + 3, x2: tx - 3, y2: ty - 11, stroke: C.muted }, s);
        el('text', { x: tx, y: ty, 'font-size': 12, 'font-weight': 600, fill: C.fg, stroke: C.surface, 'stroke-width': 4, 'paint-order': 'stroke' }, s, kf + ' of the first ' + n);
        el('text', { x: tx, y: ty + 15, 'font-size': 11, fill: C.muted, stroke: C.surface, 'stroke-width': 4, 'paint-order': 'stroke' }, s, f1(cut.expected) + ' expected by chance');
      });
      [1, 50, 100, 150, 200, M].forEach(function (t) { el('text', { x: x(t), y: hh + 25, 'text-anchor': t === M ? 'end' : 'middle', 'font-size': 11, fill: C.muted }, s, String(t)); });
      el('text', { x: ml, y: hh + 40, 'font-size': 11, fill: C.muted }, s, fit(['rank among the ' + M + ' positions, in CFR score order; ticks: known activation positions',
        'rank among the ' + M + ' positions; ticks: known positions', 'rank among the ' + M + ' positions'], w - ml, 11));
      var sel = StatsSel.get().pos, note = card.el.querySelector('[data-rec-note]');
      if (!o.exporting) { if (!note) { note = h('p', 'small-note', null); note.setAttribute('data-rec-note', ''); card.chart.parentNode.insertBefore(note, card.chart.nextSibling); } note.textContent = ''; }
      if (sel) {
        var r = positionIndex(cp).recovery[sel];
        if (r) {
          var rx = x(r.rank_in_universe);
          el('line', { x1: rx, x2: rx, y1: 4, y2: hh, stroke: C.fg, 'stroke-width': 1.5 }, s);
          var sl = sel + ': ' + r.rank_in_universe + ' of ' + M + (r.known ? ', a known position' : ''), right = rx + 5 + textW(sl, 12, 700) <= w;
          el('text', { x: right ? rx + 5 : rx - 5, y: 16, 'text-anchor': right ? 'start' : 'end', 'font-size': 12, 'font-weight': 700, fill: C.fg, stroke: C.surface, 'stroke-width': 3, 'paint-order': 'stroke' }, s, sl);
          if (note) note.textContent = sel + ' is at ' + r.rank_in_universe + ' of the ' + M + ' positions of this curve' + (r.cfr_score_rank !== r.rank_in_universe ? ' (rank ' + r.cfr_score_rank + ' by CFR score among all ' + positionIndex(cp).ranking.length + ' recurrent positions).' : '.');
        } else if (note) note.textContent = sel + ': numbered in fewer than half of the receptors, so it is not among the ' + M + ' positions of this ranking.';
      }
    },
    onSelect: function (card) { draw(card, {}); }
  });

  define('chart-partners', {
    needs: ['class_positions'],
    keepServerTable: false,
    init: function (card) {
      card.state.tab = 'partners';
      card.pairsGuide = card.el.querySelector('[data-tab-guide="pairs"]');
      var tabs = card.el.querySelector('[data-ctl="tab"]');
      tabs.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          card.state.tab = b.getAttribute('data-value');
          tabs.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          var pairs = card.state.tab === 'pairs';
          card.guide.hidden = pairs; card.pairsGuide.hidden = !pairs;
          if (card.tableOn) toggleTable(card);
          draw(card, { fade: true });
        });
      });
    },
    serverTable: function (card) { return card.state.tab === 'pairs' ? card.serverTable : null; },
    csv: function (card) { return card.state.tab === 'pairs' ? CFG.csv_extra.pairs : card.meta.csv; },
    suffix: function (card) { return card.state.tab; },
    draw: function (card, node, w, o) {
      var cp = card.D.class_positions, PI = positionIndex(cp), phone = isPhone() || w < 480;
      if (card.state.tab === 'pairs') {
        var P = rows(cp.pairs.columns, cp.pairs.top), lab = phone ? 128 : 150, rh = 22;
        var s = svgIn(node, w, P.length * rh + 8, 'The most recurrent exact contact pairs');
        if (anim(o)) s.classList.add('draw-in');
        P.forEach(function (p, i) {
          var y = i * rh + 4, bw = (w - lab - 80) * p.n / NREC;
          el('text', { x: lab - 8, y: y + 12, 'text-anchor': 'end', 'font-size': 11.5, 'font-family': 'ui-monospace, Menlo, Consolas, monospace', fill: C.fg }, s, p.cfr_1 + ' · ' + p.cfr_2);
          el('rect', { x: lab, y: y + 3, width: bw, height: 11, rx: 2, fill: C.b3, class: 'grow' }, s);
          el('text', { x: lab + bw + 6, y: y + 12, 'font-size': 11, fill: C.muted }, s, p.n + ' (' + Math.round(p.pct) + '%)');
        });
        if (!o.exporting && card.legend) card.legend.innerHTML = '';
        return;
      }
      var T = rows(cp.partner_columns, cp.partners.slice(0, 15)), sel = StatsSel.get().pos;
      var extra = sel && !T.some(function (p) { return p.gn === sel; }) && PI.partners[sel] ? PI.partners[sel] : null;
      var lab = phone ? 70 : 80, right = phone ? 70 : 92, rh = 26, n = T.length + (extra ? 1 : 0), gapY = extra ? 12 : 0;
      var s2 = svgIn(node, w, n * rh + gapY + 30, 'Recurrence of each position against its most frequent exact partner');
      if (anim(o)) s2.classList.add('draw-in');
      var x = function (v) { return lab + v / NREC * (w - lab - right); };
      [0, 25, 50, 75, 100].forEach(function (t) {
        var xx = lab + t / 100 * (w - lab - right);
        el('line', { x1: xx, x2: xx, y1: 0, y2: n * rh + gapY, stroke: C.lineSoft }, s2);
        el('text', { x: xx, y: n * rh + gapY + 14, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, s2, t + '%');
      });
      T.concat(extra ? [extra] : []).forEach(function (p, i) {
        var y = i * rh + rh / 2 + (extra && i === T.length ? gapY : 0), g = el('g', { 'data-gn': p.gn }, s2), on = p.gn === sel;
        if (on) el('rect', { x: 0, y: y - rh / 2 + 1, width: w, height: rh - 2, rx: 4, fill: C.brandSoft, stroke: C.fg, 'stroke-width': 1.2 }, g);
        el('text', { x: lab - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11.5, 'font-family': 'ui-monospace, Menlo, Consolas, monospace', fill: C.fg }, g, p.gn);
        el('line', { x1: x(p.top_partner_n), x2: x(p.n), y1: y, y2: y, stroke: C.line, 'stroke-width': 3 }, g);
        el('circle', { cx: x(p.top_partner_n), cy: y, r: 4.5, fill: C.surface, stroke: C.fg, 'stroke-width': 1.6 }, g);
        el('circle', { cx: x(p.n), cy: y, r: 5.5, fill: C.b4 }, g);
        if (!phone && p.top_partner) el('text', { x: x(p.top_partner_n) - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 10.5, fill: C.muted }, g, p.top_partner);
        el('text', { x: w - right + 10, y: y + 4, 'font-size': 11, fill: C.muted }, g, phone ? String(p.distinct_partners) : p.distinct_partners + ' partners');
        if (!o.exporting) {
          var hr = el('rect', { x: 0, y: y - rh / 2, width: w, height: rh, fill: 'transparent' }, g);
          hit(hr, p.gn + ': CFR in ' + p.n + ' receptors; with ' + (p.top_partner || 'no partner') + ' in ' + p.top_partner_n + '; ' + p.distinct_partners + ' distinct partners', function (e, nd) { selectPos(p.gn, card, nd); });
        }
      });
      el('text', { x: lab, y: n * rh + gapY + 28, 'font-size': 11, fill: C.muted }, s2, fit(['share of ' + NREC + ' receptors' + (phone ? '; right: partners' : ''), 'share of ' + NREC + ' receptors'], w - lab, 11));
      if (!o.exporting && card.legend) {
        card.legend.innerHTML = '<span><span class="sw" style="background:' + C.b4 + ';border-radius:50%"></span>receptors with a CFR at the position</span><span><span class="sw ring"></span>receptors with its most frequent partner</span>';
      }
    },
    onSelect: function (card) { draw(card, {}); }
  });

  // ---- the matrix: a canvas (or an SVG for export) through one painter interface
  function canvasPainter(cv, W, H, scale) {
    var bw = Math.round(W * scale), bh = Math.round(H * scale);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }   // a new backing store only on a size change
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bw, bh); g.setTransform(scale, 0, 0, scale, 0, 0);
    return {
      rect: function (x, y, w, h, fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); },
      stroke: function (x, y, w, h, col, lw) { g.strokeStyle = col; g.lineWidth = lw; g.strokeRect(x, y, w, h); },
      text: function (x, y, s, o) {
        g.save(); g.font = (o.weight || 400) + ' ' + (o.size || 11) + 'px ' + (o.mono ? 'ui-monospace, Menlo, monospace' : 'system-ui, sans-serif');
        g.fillStyle = o.fill; g.textAlign = o.align || 'left';
        if (o.rotate) { g.translate(x, y); g.rotate(o.rotate * Math.PI / 180); g.fillText(s, 0, 0); } else g.fillText(s, x, y);
        g.restore();
      }
    };
  }
  function svgPainter(svg) {
    return {
      rect: function (x, y, w, h, fill) { el('rect', { x: x, y: y, width: w, height: h, fill: fill }, svg); },
      stroke: function (x, y, w, h, col, lw) { el('rect', { x: x, y: y, width: w, height: h, fill: 'none', stroke: col, 'stroke-width': lw }, svg); },
      text: function (x, y, s, o) {
        el('text', { x: x, y: y, 'font-size': o.size || 11, 'font-weight': o.weight || 400, fill: o.fill, 'text-anchor': o.align === 'right' ? 'end' : o.align === 'center' ? 'middle' : 'start',
          'font-family': o.mono ? 'ui-monospace, Menlo, monospace' : null, transform: o.rotate ? 'rotate(' + o.rotate + ' ' + x + ' ' + y + ')' : null }, svg, s);
      }
    };
  }
  function matrixModel(card) {
    if (card.model) return card.model;
    var A = card.D.cfr_atlas, groups = A.groups.ligand.map(function (g) { return g.key; });
    var cols = A.rank_order.slice();   // column indexes in rank order
    var hits = function (r) { var n = 0; for (var i = 0; i < r.state.length; i++) if (r.state.charAt(i) === '2') n++; return n; };
    var list = A.receptors.slice().sort(function (a, b) { return groups.indexOf(a.ligand) - groups.indexOf(b.ligand) || hits(b) - hits(a) || (a.symbol < b.symbol ? -1 : 1); });
    card.model = { A: A, groups: groups, cols: cols, list: list };
    return card.model;
  }
  function paintMatrix(card, P, W, tok, layout) {
    var M = matrixModel(card), A = M.A, view = card.state.view, st = StatsSel.get(), L = layout;
    var empty = tok.cellEmpty;
    P.rect(0, 0, W, L.H, tok.surface);
    M.cols.forEach(function (ci, j) {   // narrow columns: every L.every-th label, and always the selected one
      var isSel = A.positions[ci].gn === st.pos;
      if (j % L.every && !isSel) return;
      P.text(L.lw + j * L.cw + L.cw / 2 + 3, L.top - 6, A.positions[ci].gn, { size: 10, fill: isSel ? tok.fg : tok.muted, weight: isSel ? 700 : 400, rotate: -60, mono: true });
    });
    var y = L.top, cur = null, rowY = {}, start = 0;
    M.list.forEach(function (r) {
      if (r.ligand !== cur) {
        if (cur !== null) y = Math.max(y, start + L.minGroup) + L.gap;   // small groups keep room for their label
        cur = r.ligand; start = y;
        var n = M.list.filter(function (q) { return q.ligand === cur; }).length;
        P.text(L.lw - 10, y + Math.min(Math.max(n * L.rh, L.minGroup), 30) / 2 + 4, cur.replace(/ receptors$/, '') + ' (' + n + ')', { size: 11, weight: 600, fill: tok.fg, align: 'right' });
      }
      rowY[r.gid] = y;
      M.cols.forEach(function (ci, j) {
        var s = r.state.charAt(ci), v = r.net[ci];
        if (s === '0') return;
        P.rect(L.lw + j * L.cw, y, L.cw - 1, L.rh + 0.35, s === '1' ? empty : view === 'cfr' ? tok.b4 : (v > 0 ? tok.active : v < 0 ? tok.inactive : tok.muted));
      });
      y += L.rh;
    });
    if (st.rec && rowY[st.rec] !== undefined) {
      var fy = rowY[st.rec], fr = M.list.filter(function (r) { return r.gid === st.rec; })[0];
      P.stroke(L.lw - 2, fy - 2, L.cw * M.cols.length + 3, L.rh + 4, tok.fg, 1.5);
      P.text(W - 2, fy + 5, '◂ ' + fr.symbol, { size: 11, weight: 700, fill: tok.fg, align: 'right' });
    }
    if (st.pos) {
      var j = M.cols.map(function (ci) { return A.positions[ci].gn; }).indexOf(st.pos);
      if (j >= 0) {
        var col = A.columns[M.cols[j]];
        P.stroke(L.lw + j * L.cw - 1, L.top - 2, L.cw + 1, y - L.top + 4, tok.fg, 1.5);
        P.text(L.lw + j * L.cw + L.cw / 2, y + 16, col.n_hit + ' of ' + NREC, { size: 11, weight: 700, fill: tok.fg, align: 'center' });
      }
    }
    return rowY;
  }
  function matrixLayout(card, w) {
    var M = matrixModel(card), cw = Math.max(6, Math.min(17, Math.floor((w - 150 - 56) / M.cols.length)));
    var rh = 2.4, top = 74, lw = 150, gap = 6, minGroup = 13;
    var extra = M.groups.reduce(function (t, g) { var n = M.list.filter(function (r) { return r.ligand === g; }).length; return t + (n ? Math.max(0, minGroup - n * rh) : 0); }, 0);
    var W = lw + cw * M.cols.length + 56, H = top + M.list.length * rh + extra + M.groups.length * gap + 26;
    return { cw: cw, rh: rh, top: top, lw: lw, gap: gap, W: W, H: H, minGroup: minGroup, every: cw >= 12 ? 1 : cw >= 8 ? 2 : 5 };
  }
  define('chart-cfr-atlas', {
    needs: ['cfr_atlas'],
    init: function (card) {
      card.state.view = 'cfr';
      var box = card.el.querySelector('[data-ctl="view"]');
      box.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          card.state.view = b.getAttribute('data-value');
          box.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          draw(card, { fade: true });
        });
      });
    },
    suffix: function (card, ext) { return ext === 'csv' ? '' : isPhone() ? 'groups' : card.state.view; },   // the CSV is the full grid
    draw: function (card, node, w, o) {
      var M = matrixModel(card), A = M.A, phone = isPhone() || w < 560, view = card.state.view;
      var ctl = card.el.querySelector('[data-ctl="view"]');
      if (!o.exporting) ctl.hidden = phone;
      if (phone) {
        if (!o.exporting) {
          card.guide.textContent = 'Share of receptors in each ligand type with a CFR at each top-ranked position (columns in rank order). The full receptor-by-position grid is in the Table view.';
          card.legend.innerHTML = '<span>0%</span><span class="ramp" style="background:linear-gradient(90deg,' + C.b0 + ',' + C.b5 + ')"></span><span>100% of the group</span>';
        }
        var G = A.groups.ligand, lw = 112, cw = Math.max(4, Math.floor((w - lw) / M.cols.length)), rh = 22, H = 70 + G.length * rh + 22;
        var s = svgIn(node, lw + cw * M.cols.length + 24, H, 'Share of each ligand type with a CFR at each position');   // room for the last rotated label
        var sel = StatsSel.get(), selJ = M.cols.map(function (ci) { return A.positions[ci].gn; }).indexOf(sel.pos);
        var fr = sel.rec ? M.list.filter(function (r) { return r.gid === sel.rec; })[0] : null;
        var selI = fr ? G.map(function (g) { return g.key; }).indexOf(fr.ligand) : -1;
        M.cols.forEach(function (ci, j) { if (j % 5 === 0 || j === selJ) el('text', { x: lw + j * cw + cw / 2, y: 62, 'font-size': 10, 'font-weight': j === selJ ? 700 : 400, fill: j === selJ ? C.fg : C.muted, transform: 'rotate(-60 ' + (lw + j * cw + cw / 2) + ' 62)', 'font-family': 'ui-monospace, Menlo, monospace' }, s, A.positions[ci].gn); });
        G.forEach(function (g, i) {
          el('text', { x: lw - 6, y: 70 + i * rh + 14, 'text-anchor': 'end', 'font-size': 11, 'font-weight': i === selI ? 700 : 400, fill: C.fg }, s, g.key.replace(/ receptors$/, '') + ' (' + g.n + ')');
          M.cols.forEach(function (ci, j) {
            var c = el('rect', { x: lw + j * cw, y: 70 + i * rh, width: cw - 1, height: rh - 2, fill: mix(C.b0, C.b5, g.hit[ci]) }, s);
            if (!o.exporting) hit(c, g.key.replace(/ receptors$/, '') + ' at ' + A.positions[ci].gn + ': ' + Math.round(100 * g.hit[ci]) + '% with a CFR', function (e, nd) { selectPos(A.positions[ci].gn, card, nd); }, null, true);
          });
        });
        if (selI >= 0) el('rect', { x: lw - 2, y: 70 + selI * rh - 2, width: cw * M.cols.length + 3, height: rh + 2, rx: 3, fill: 'none', stroke: C.fg, 'stroke-width': 1.6 }, s);
        if (selJ >= 0) el('rect', { x: lw + selJ * cw - 1.5, y: 68, width: cw + 2, height: G.length * rh + 2, rx: 2, fill: 'none', stroke: C.fg, 'stroke-width': 1.6 }, s);
        if (fr || selJ >= 0) el('text', { x: lw, y: H - 4, 'font-size': 11, 'font-weight': 600, fill: C.fg }, s,
          [fr ? fr.symbol + ': ' + fr.ligand.replace(/ receptors$/, '').toLowerCase() + ' row' : '', selJ >= 0 ? sel.pos + ': CFR in ' + A.columns[M.cols[selJ]].n_hit + ' of ' + NREC : ''].filter(Boolean).join('; '));
        return;
      }
      if (!o.exporting) {
        card.guide.textContent = view === 'direction'
          ? 'One row per receptor, one column per top-ranked position. Rows grouped by ligand type and sorted by how many of the ' + TOP + ' are CFRs. Red: the net change of the CFR contacts is stronger in the active model; blue: stronger in the inactive model.'
          : 'One row per receptor, one column per top-ranked position. Rows grouped by ligand type and sorted by how many of the ' + TOP + ' are CFRs.';
        var sw = function (bg, lab, cls) { return '<span><span class="sw' + (cls ? ' ' + cls : '') + '"' + (bg ? ' style="background:' + bg + '"' : '') + '></span>' + lab + '</span>'; };
        card.legend.innerHTML = (view === 'cfr' ? sw(C.b4, 'CFR at the position') : sw(C.active, 'CFR, net stronger in the active model') + sw(C.inactive, 'CFR, net stronger in the inactive model'))
          + sw(C.cellEmpty, 'numbered, no above-threshold contact') + sw('', 'no residue numbered here', 'hollow');
      }
      var L = matrixLayout(card, w);
      if (o.exporting) {
        var sv = svgIn(node, L.W, L.H, 'Receptors by top-ranked positions');
        paintMatrix(card, svgPainter(sv), L.W, C, L);
        return;
      }
      var cv = card.cv;
      if (!cv) {
        cv = card.cv = h('canvas', '');
        cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Every receptor at the top-ranked positions');
        cv.setAttribute('data-own-tip', '');   // the document tooltip handler leaves this canvas alone
        var cellAt = function (e) {
          var L2 = card.mL, b = cv.getBoundingClientRect(), x = (e.clientX - b.left) * L2.W / b.width, y = (e.clientY - b.top) * L2.H / b.height;
          var j = Math.floor((x - L2.lw) / L2.cw);
          if (j < 0 || j >= M.cols.length) return null;
          if (y < L2.top) return { head: true, j: j };
          var gid = null; Object.keys(card.mRowY).forEach(function (g) { if (y >= card.mRowY[g] && y < card.mRowY[g] + L2.rh) gid = g; });
          return gid ? { gid: gid, j: j } : null;
        };
        cv.addEventListener('pointermove', function (e) {
          var c = cellAt(e);
          if (!c) { hideTip(); cv.style.cursor = ''; return; }
          var ci = M.cols[c.j], p = A.positions[ci];
          cv.style.cursor = 'pointer';
          if (c.head) { showTip(e.clientX, e.clientY, p.gn + ': CFR in ' + A.columns[ci].n_hit + ' of ' + NREC + ' receptors. Click to select.'); return; }
          var r = M.list.filter(function (q) { return q.gid === c.gid; })[0], st2 = r.state.charAt(ci);
          showTip(e.clientX, e.clientY, r.symbol + ' at ' + p.gn + ': ' + (st2 === '2' ? 'CFR, net ' + signed(r.net[ci], 1) : st2 === '1' ? 'numbered, no above-threshold contact' : 'not numbered'));
        });
        cv.addEventListener('pointerleave', hideTip);
        cv.addEventListener('click', function (e) {
          var c = cellAt(e); if (!c) return;
          e.stopPropagation();
          var ci = M.cols[c.j];
          if (c.head) { selectPos(A.positions[ci].gn, card, cv); return; }
          var r = M.list.filter(function (q) { return q.gid === c.gid; })[0];
          receptorPanel(card, r.gid);
        });
      }
      node.appendChild(cv);
      card.mL = L;
      card.mRowY = paintMatrix(card, canvasPainter(cv, L.W, L.H, Math.min(2, window.devicePixelRatio || 1)), L.W, C, L);
    },
    canvasExport: function (card) {   // null on phones: the export takes the SVG route of the group view
      if (isPhone()) return null;
      var w = card.lastW || width(card.chart), L = matrixLayout(card, w), cv = document.createElement('canvas');
      paintMatrix(card, canvasPainter(cv, L.W, L.H, 2), L.W, lightTokens(), L);
      return cv;
    },
    onSelect: function (card) { draw(card, {}); }
  });
  // the receptor side panel (matrix cell, explorer point)
  function receptorPanel(card, gid) {
    Promise.all([load('receptors'), load('cfr_atlas')]).then(function (arr) {
      var RI = receptorIndex(arr[0]), r = RI.by[gid], A = arr[1];
      if (!r) return;
      openSide(card, r.symbol + ': ' + (r.protein_name || r.name), function (side) {
        side.appendChild(followButton(gid, r.symbol));
        side.appendChild(link('Open the report', r.report || REPORT(gid), 'cc-btn'));
        h('p', '', side, r.family + ', ' + r.ligand.replace(/ receptors$/, '').toLowerCase() + '. Threshold ' + f2(r.threshold) + '; ' + fmt(r.n_pairs) + ' contact pairs, ' + fmt(r.n_above) + ' above threshold (' + f1(r.above_per_100) + ' per 100); ' + pct(r.share_active) + ' of them stronger in the active model; ' + r.cfr_hits + ' of the ' + TOP + ' top-ranked positions are CFRs.');
        var sim = arr[0].similar[gid];
        if (!sim || !sim.length) { h('p', 'side-note', side, 'No similarity list: too few numbered top-ranked positions.'); return; }
        h('h4', '', side, 'Most similar patterns at the top-ranked positions');
        side.appendChild(sideTable([{ label: 'Receptor' }, { label: 'Similarity', num: true }], sim.map(function (s) { var o = RI.by[s[0]]; return [link(o ? o.symbol : s[0], REPORT(s[0])), s[1].toFixed(2)]; })));
        h('p', 'side-note', side, 'Cosine similarity of the signed pattern over the ' + TOP + ' top-ranked positions. A browsing aid, not a classification.');
      });
    });
  }

  // ================================================================== 4 variants (clinical tint, always labeled)
  function selGroup(cp, gn) {
    var p = gn && positionIndex(cp).by[gn];
    return p ? (p.rank <= cp.top_n ? 0 : 1) : -1;
  }
  define('chart-pathogenicity', {
    needs: ['class_variants', 'class_positions'],
    init: function (card) { var d = card.el.querySelector('#am-classes'); if (d && !isPhone()) d.open = true; },
    draw: function (card, node, w, o) {
      var G = card.D.class_variants.groups, ph = isPhone() || w < 560, lab = ph ? 0 : 230, right = ph ? 0 : 110, rh = ph ? 86 : 64;
      var s = svgIn(node, w, rh * 2 + (ph ? 12 : 8), 'Predicted pathogenic share of decisive AlphaMissense calls'), sg = selGroup(card.D.class_positions, StatsSel.get().pos);
      if (anim(o)) s.classList.add('draw-in');
      G.forEach(function (g, i) {
        var y = i * rh + (ph ? 24 : 10), bw = w - lab - right, p = bw * g.predicted_pathogenic / g.decisive, by = ph ? y + 2 : y;
        el('text', { x: ph ? 0 : lab - 12, y: ph ? y - 5 : y + 17, 'text-anchor': ph ? 'start' : 'end', 'font-size': 12.5, 'font-weight': 600, fill: C.fg }, s, g.label);
        el('rect', { x: lab, y: by, width: p, height: 26, fill: C.path, rx: 3, class: 'grow' }, s);
        el('rect', { x: lab + p, y: by, width: bw - p, height: 26, fill: C.ben, rx: 3, class: 'grow' }, s);
        var tc = C.dark ? '#0d1117' : '#ffffff';
        el('text', { x: lab + 8, y: by + 17.5, 'font-size': 12, 'font-weight': 600, fill: tc }, s, fmt(g.predicted_pathogenic) + (ph ? '' : ' predicted pathogenic'));
        el('text', { x: lab + bw - 8, y: by + 17.5, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: tc }, s, fmt(g.predicted_benign) + (ph ? '' : ' predicted benign'));
        el('text', { x: lab, y: by + 42, 'font-size': 11, fill: C.muted }, s, fit([fmt(g.decisive) + ' decisive calls; ' + fmt(g.ambiguous) + ' ambiguous; ' + fmt(g.scored) + ' scored',
          fmt(g.decisive) + ' decisive; ' + fmt(g.ambiguous) + ' ambiguous', fmt(g.decisive) + ' decisive calls'], w - lab - (ph ? 0 : right), 11));
        var share = f1(g.pct_predicted_pathogenic_of_decisive) + '%';
        if (!ph) el('text', { x: w - right + 14, y: by + 21, 'font-family': "'Source Serif 4', Georgia, serif", 'font-size': 26, 'font-weight': 600, fill: C.fg }, s, share);
        else el('text', { x: w, y: y - 5, 'text-anchor': 'end', 'font-family': "'Source Serif 4', Georgia, serif", 'font-size': 18, 'font-weight': 600, fill: C.fg }, s, share);
        if (sg === i) el('rect', { x: lab - 3, y: by - 3, width: bw + 6, height: 32, rx: 5, fill: 'none', stroke: C.fg, 'stroke-width': 2 }, s);
      });
      if (!o.exporting && card.legend) card.legend.innerHTML = '<span><span class="sw c-path"></span>predicted pathogenic</span><span><span class="sw c-ben"></span>predicted benign</span><span><span class="sw c-amb"></span>ambiguous (counted, not in the share)</span><span>Large number: predicted pathogenic share of decisive calls</span>';
    },
    onSelect: function (card) { draw(card, {}); }
  });
  define('chart-am-bands', {
    needs: ['class_variants', 'class_positions'],
    draw: function (card, node, w, o) {
      var B = card.D.class_variants.bands, pos = StatsSel.get().pos, P = pos && positionIndex(card.D.class_positions).by[pos];
      var sb = P ? bandOf(P.n, B) : -1, n = B.length;
      if (isPhone() || w < 420) {
        var lab = 84, rh = 40, sp = svgIn(node, w, n * rh + 22, 'Predicted pathogenic share by recurrence group');
        if (anim(o)) sp.classList.add('draw-in');
        B.forEach(function (b, i) {
          var y = i * rh + 4, bw = (w - lab - 50) * b.pct_predicted_pathogenic_of_decisive / 100;
          el('text', { x: lab - 8, y: y + 13, 'text-anchor': 'end', 'font-size': 11.5, 'font-weight': 600, fill: C.fg }, sp, b.label);
          el('text', { x: lab - 8, y: y + 27, 'text-anchor': 'end', 'font-size': 10.5, fill: C.muted }, sp, b.positions + ' positions');
          el('rect', { x: lab, y: y + 3, width: bw, height: 16, rx: 3, fill: C.path, 'fill-opacity': 0.35 + 0.65 * i / (n - 1), class: 'grow' }, sp);
          if (i === sb) el('rect', { x: lab - 2, y: y + 1, width: bw + 4, height: 20, rx: 4, fill: 'none', stroke: C.fg, 'stroke-width': 2 }, sp);
          el('text', { x: lab + bw + 6, y: y + 16, 'font-size': 12, 'font-weight': 600, fill: C.fg }, sp, f1(b.pct_predicted_pathogenic_of_decisive) + '%');
          el('text', { x: lab, y: y + 32, 'font-size': 10.5, fill: C.muted }, sp, fmt(b.predicted_pathogenic) + ' of ' + fmt(b.decisive) + ' decisive calls');
        });
        el('text', { x: 0, y: n * rh + 18, 'font-size': 11, fill: C.muted }, sp, 'receptors in which the position is a CFR');
        return;
      }
      var hh = 200, mb = 62, ml = 34, s = svgIn(node, w, hh + mb, 'Predicted pathogenic share by recurrence group');
      if (anim(o)) s.classList.add('draw-in');
      var bw = (w - ml) / n, y = function (p) { return hh - p / 100 * (hh - 16); };
      [0, 25, 50, 75, 100].forEach(function (t) { el('line', { x1: ml, x2: w, y1: y(t), y2: y(t), stroke: C.lineSoft }, s); el('text', { x: ml - 6, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, s, t + '%'); });
      B.forEach(function (b, i) {
        var x = ml + i * bw + bw * 0.16, ww = bw * 0.68, v = b.pct_predicted_pathogenic_of_decisive;
        var r = el('rect', { x: x, y: y(v), width: ww, height: hh - y(v), fill: C.path, 'fill-opacity': 0.35 + 0.65 * i / (n - 1), rx: 3, class: 'grow-y' }, s);
        if (!o.exporting) r.setAttribute('data-tip', b.label + ': ' + fmt(b.predicted_pathogenic) + ' predicted pathogenic of ' + fmt(b.decisive) + ' decisive calls (' + fmt(b.ambiguous) + ' ambiguous), ' + b.positions + ' positions');
        if (i === sb) el('rect', { x: x - 3, y: y(v) - 3, width: ww + 6, height: hh - y(v) + 3, rx: 4, fill: 'none', stroke: C.fg, 'stroke-width': 2 }, s);
        el('text', { x: x + ww / 2, y: y(v) - 6, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 600, fill: C.fg }, s, f1(v) + '%');
        el('text', { x: x + ww / 2, y: hh + 16, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: C.fg }, s, b.label.replace('fewer than 3', 'under 3'));
        el('text', { x: x + ww / 2, y: hh + 31, 'text-anchor': 'middle', 'font-size': 10.5, fill: C.muted }, s, b.positions + ' pos.');
        el('text', { x: x + ww / 2, y: hh + 44, 'text-anchor': 'middle', 'font-size': 10.5, fill: C.muted }, s, fmt(b.decisive) + ' calls');
      });
      el('text', { x: ml, y: hh + 60, 'font-size': 11, fill: C.muted }, s, fit(['receptors in which the position is a CFR; bar: predicted pathogenic, % of decisive calls',
        'receptors with a CFR there; bar: predicted pathogenic, % of decisive', 'receptors with a CFR there'], w - ml, 11));
    },
    onSelect: function (card) { draw(card, {}); }
  });
  define('chart-position-conservation', {
    needs: ['class_positions'],
    draw: function (card, node, w, o) {
      var cp = card.D.class_positions, PI = positionIndex(cp), list = rows(cp.conservation.columns, cp.conservation.rows);
      var phone = isPhone() || w < 420, r = phone ? 2.3 : 3.2, ml = phone ? 8 : 92, top = phone ? 22 : 12;
      var lo = Math.floor(minOf(list.map(function (p) { return p.mean; })) * 10) / 10, hi = 1;
      var x = function (v) { return ml + (v - lo) / (hi - lo) * (w - ml - 10); };
      var G = [['Top ' + cp.top_n, list.filter(function (p) { return p.top50; }), cp.conservation.median_top], ['Other', list.filter(function (p) { return !p.top50; }), cp.conservation.median_other]];
      var lay = G.map(function (g) { var L = stripLayout(g[1].map(function (p) { return p.mean; }), lo, hi, ml, w - 10, r); return { L: L, half: (maxOf(L.pts.map(function (q) { return Math.abs(q[1]); })) + 1) * L.step }; });
      var sel = StatsSel.get().pos, selP = sel ? PI.cons[sel] : null;
      var hh = top + lay[0].half * 2 + lay[1].half * 2 + (phone ? 64 : 40) + 30, s = svgIn(node, w, hh, 'Conservation per generic position, top-ranked and other'), y0 = top;
      if (anim(o)) s.classList.add('draw-in');
      lay.forEach(function (L, i) {
        var g = G[i], cy = y0 + L.half;
        if (phone) el('text', { x: 0, y: y0 - 6, 'font-size': 11.5, 'font-weight': 600, fill: C.fg }, s, g[0] + ', ' + g[1].length + ' positions');
        L.L.pts.forEach(function (q) {
          var p = g[1][q[2]], m = PI.motif[p.gn], on = p.gn === sel;
          var c = el('circle', { cx: q[0], cy: cy + q[1] * L.L.step, r: on ? r + 3 : r, fill: m ? 'none' : (i ? C.ink : C.b4), stroke: m || on ? C.fg : 'none', 'stroke-width': on ? 2 : 1.3, 'fill-opacity': i ? 0.55 : 0.9, 'data-gn': p.gn }, s);
          if (!o.exporting) hit(c, p.gn + ': mean conservation ' + f2(p.mean) + ' over ' + p.n_residues + ' residues' + (m ? ' (' + m + ')' : ''), PI.by[p.gn] ? function () { selectPos(p.gn, card); } : null, null, true);
          if (on) el('text', { x: q[0], y: cy + q[1] * L.L.step - r - 8, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: C.fg, stroke: C.surface, 'stroke-width': 3, 'paint-order': 'stroke' }, s, p.gn + ' ' + f2(p.mean));
        });
        el('line', { x1: x(g[2]), x2: x(g[2]), y1: cy - L.half, y2: cy + L.half, stroke: C.fg, 'stroke-width': 2 }, s);
        if (!phone) {
          el('text', { x: ml - 10, y: cy - 2, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: C.fg }, s, g[0]);
          el('text', { x: ml - 10, y: cy + 13, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, s, g[1].length + ' positions');
        }
        el('text', { x: x(g[2]) + 5, y: cy - L.half + 2, 'font-size': 11, 'font-weight': 600, fill: C.fg }, s, 'median ' + f2(g[2]));
        y0 += L.half * 2 + (phone ? 32 : 20);
      });
      for (var t = lo; t <= 1.0001; t += 0.1) el('text', { x: x(t), y: hh - 16, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, s, t.toFixed(1));
      el('text', { x: ml, y: hh - 2, 'font-size': 11, fill: C.muted }, s, fit(['mean conservation of the residues at the position; rings: activation motifs', 'mean conservation per position'], w - ml, 11));
      if (sel && !selP) el('text', { x: w, y: 12, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 600, fill: C.fg }, s, sel + ': fewer than ' + cp.conservation.min_residues + ' scored residues');
      if (!o.exporting && card.legend) card.legend.innerHTML = '<span><span class="sw" style="background:' + C.b4 + ';border-radius:50%"></span>top ' + cp.top_n + ' positions</span><span><span class="sw" style="background:' + C.ink + ';opacity:.6;border-radius:50%"></span>other positions</span><span><span class="sw ring"></span>activation motif position</span><span>Bar: median</span>';
    },
    onSelect: function (card) { draw(card, {}); }
  });
  define('chart-am-quintiles', {
    needs: ['class_variants'],
    draw: function (card, node, w, o) {
      var Q = card.D.class_variants.fifths, phone = isPhone() || w < 560, hh = 210, mb = phone ? 56 : 58, ml = 34;
      var s = svgIn(node, w, hh + mb, 'Predicted pathogenic share within conservation groups');
      if (anim(o)) s.classList.add('draw-in');
      var gw = (w - ml) / Q.length, y = function (p) { return hh - p / 100 * (hh - 16); };
      [0, 25, 50, 75, 100].forEach(function (t) { el('line', { x1: ml, x2: w, y1: y(t), y2: y(t), stroke: C.lineSoft }, s); el('text', { x: ml - 6, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: C.muted }, s, t + '%'); });
      Q.forEach(function (q, i) {
        var x0 = ml + i * gw + gw * 0.12, bw = gw * 0.36;
        [[q.top50_pct, 1, q.top50_predicted_pathogenic, q.top50_decisive], [q.other_pct, 0, q.other_predicted_pathogenic, q.other_decisive]].forEach(function (b, k) {
          var x = x0 + k * (bw + 4);
          var r = el('rect', { x: x, y: y(b[0]), width: bw, height: hh - y(b[0]), rx: 3, fill: b[1] ? C.path : C.pathSoft, stroke: C.path, 'stroke-width': b[1] ? 0 : 1, class: 'grow-y' }, s);
          if (!o.exporting) r.setAttribute('data-tip', 'Q' + q.fifth + ', ' + (b[1] ? 'top ' + TOP + ' positions' : 'other positions') + ': ' + fmt(b[2]) + ' predicted pathogenic of ' + fmt(b[3]) + ' decisive calls');
          el('text', { x: x + bw / 2, y: y(b[0]) - 5, 'text-anchor': 'middle', 'font-size': phone ? 10 : 11, 'font-weight': 600, fill: C.fg }, s, phone ? Math.round(b[0]) + '%' : f1(b[0]) + '%');
        });
        el('text', { x: x0 + bw + 2, y: hh + 16, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: C.fg }, s, 'Q' + q.fifth);
        var rng = f2(q.conservation_from) + ' to ' + f2(q.conservation_to);
        if (!phone || textW(rng, 9.5) <= gw - 2) el('text', { x: x0 + bw + 2, y: hh + 30, 'text-anchor': 'middle', 'font-size': phone ? 9.5 : 10.5, fill: C.muted }, s, rng);
        else {   // narrow: the range on two lines
          el('text', { x: x0 + bw + 2, y: hh + 30, 'text-anchor': 'middle', 'font-size': 9.5, fill: C.muted }, s, f2(q.conservation_from));
          el('text', { x: x0 + bw + 2, y: hh + 42, 'text-anchor': 'middle', 'font-size': 9.5, fill: C.muted }, s, 'to ' + f2(q.conservation_to));
        }
        if (!phone) el('text', { x: x0 + bw + 2, y: hh + 44, 'text-anchor': 'middle', 'font-size': 10.5, fill: C.muted }, s, fmt(q.top50_decisive) + ' / ' + fmt(q.other_decisive) + ' calls');
      });
      if (!o.exporting && card.legend) card.legend.innerHTML = '<span><span class="sw c-path"></span>top ' + TOP + ' positions: predicted pathogenic, % of decisive calls</span><span><span class="sw" style="background:var(--path-soft);border:1px solid var(--path)"></span>other generic-numbered positions</span>';
    }
  });

  // ---- variants at each top-ranked position: rows with a composition bar; a row opens the profile and the
  //      per-position side table
  define('chart-cfr-variants', {
    needs: ['cfr_variants'],
    init: function (card) {
      card.state.order = 'rank'; card.state.dir = 1;
      var box = card.el.querySelector('[data-ctl="order"]');
      function mark() {
        box.querySelectorAll('button').forEach(function (b) {
          var on = b.getAttribute('data-value') === card.state.order;
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          b.querySelector('[data-dir]').textContent = on ? (card.state.dir > 0 ? (card.state.order === 'rank' ? '↑' : '↓') : (card.state.order === 'rank' ? '↓' : '↑')) : '';
        });
      }
      box.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = b.getAttribute('data-value');
          if (card.state.order === v) card.state.dir = -card.state.dir; else { card.state.order = v; card.state.dir = 1; }
          mark(); draw(card, { fade: true });
        });
      });
      mark();
    },
    suffix: function (card) { return card.state.order === 'rank' && card.state.dir > 0 ? '' : card.state.order; },
    draw: function (card, node, w, o) {
      var V = card.D.cfr_variants, st = card.state, sel = StatsSel.get().pos;
      var P = V.positions.slice().sort(function (a, b) {
        if (st.order === 'share') return st.dir * ((b.pathogenic_pct_decisive || 0) - (a.pathogenic_pct_decisive || 0)) || a.cfr_rank - b.cfr_rank;
        return st.dir * (a.cfr_rank - b.cfr_rank);
      });
      var phone = isPhone() || w < 640, list = phone && !card.showAll && !o.exporting ? P.slice(0, 15) : P;
      var ncol = phone ? 1 : 2, per = Math.ceil(list.length / ncol), gap = 28, cw = (w - gap * (ncol - 1)) / ncol, rh = 24;
      var s = svgIn(node, w, per * rh + 4, 'AlphaMissense classes of the substitutions at each top-ranked position');
      if (anim(o)) s.classList.add('draw-in');
      for (var c = 0; c < ncol; c++) {
        var ox = c * (cw + gap);
        list.slice(c * per, (c + 1) * per).forEach(function (p, i) {
          var y = i * rh, a = p.am_substitutions, sc = a.pathogenic + a.ambiguous + a.benign, g = el('g', { 'data-gn': p.generic }, s), on = p.generic === sel;
          if (on) el('rect', { x: ox, y: y + 1, width: cw, height: rh - 2, rx: 3, fill: C.brandSoft, stroke: C.fg, 'stroke-width': 1.5 }, g);
          el('line', { x1: ox, x2: ox + cw, y1: y + rh, y2: y + rh, stroke: C.lineSoft }, g);
          el('text', { x: ox + 22, y: y + 16, 'text-anchor': 'end', 'font-size': 12, fill: C.muted }, g, String(p.cfr_rank));
          el('text', { x: ox + 30, y: y + 16, 'font-size': 12, 'font-family': 'ui-monospace, Menlo, Consolas, monospace', fill: C.fg }, g, p.generic);
          var right = phone ? 112 : 136, bx = ox + 110, bw = cw - 110 - right, xx = bx, dec = a.pathogenic + a.benign;
          [['pathogenic', C.path], ['ambiguous', C.amb], ['benign', C.ben]].forEach(function (k) {
            var ww = sc ? bw * a[k[0]] / sc : 0;
            if (ww > 0) el('rect', { x: xx, y: y + 7, width: ww, height: 11, fill: k[1], class: 'grow' }, g);
            xx += ww;
          });
          var t = el('text', { x: ox + cw, y: y + 16, 'text-anchor': 'end', 'font-size': 11.5, fill: C.muted }, g);
          el('tspan', { 'font-weight': 700, fill: C.fg }, t, p.pathogenic_pct_decisive === null ? '' : Math.round(p.pathogenic_pct_decisive) + '%');
          el('tspan', {}, t, ' of ' + fmt(dec) + ' decisive');
          if (!o.exporting) {
            var hr = el('rect', { x: ox, y: y, width: cw, height: rh, fill: 'transparent' }, g);
            hit(hr, p.generic + ': ' + fmt(p.substitutions) + ' substitutions; ' + fmt(a.pathogenic) + ' predicted pathogenic, ' + fmt(a.ambiguous) + ' ambiguous, ' + fmt(a.benign) + ' predicted benign; ' + (p.pathogenic_pct_decisive === null ? '' : Math.round(p.pathogenic_pct_decisive) + '% of ' + fmt(dec) + ' decisive calls predicted pathogenic'), function (e, nd) {
              StatsSel.set({ pos: p.generic }, { noProfile: true }); showVariantPosition(card, p);
            });
          }
        });
      }
      if (!o.exporting && phone) {
        var more = h('button', 'cc-btn show-all', node, card.showAll ? 'Show 15 positions' : 'Show all ' + P.length + ' positions'); more.type = 'button';
        more.addEventListener('click', function () { card.showAll = !card.showAll; draw(card, {}); });
      }
      if (!o.exporting && card.legend) card.legend.innerHTML = '<span><span class="sw c-path"></span>predicted pathogenic</span><span><span class="sw c-amb"></span>ambiguous</span><span><span class="sw c-ben"></span>predicted benign</span><span>Click a position for the receptors behind it</span>';
    },
    onSelect: function (card) { draw(card, {}); }
  });
  function showVariantPosition(card, pos) {
    var V = card.D.cfr_variants, url = (pos.links && pos.links.detail) || (CFG.stats_dir + '/cfr_variants/' + pos.generic + '.json');
    Promise.all([load(url), load('cfr_atlas').catch(function () { return null; })]).then(function (arr) {
      var d = arr[0], A = arr[1];
      var F = {}; d.fields.forEach(function (f, i) { F[f] = i; });
      var recs = V.receptors.rows, RF = {}; V.receptors.fields.forEach(function (f, i) { RF[f] = i; });
      // which receptors have a CFR at the position (cfr_atlas state '2'), from each receptor's own numbering
      var k = A ? A.positions.map(function (q) { return q.gn; }).indexOf(pos.generic) : -1, cfr = {};
      if (k >= 0) A.receptors.forEach(function (r) { if (r.state.charAt(k) === '2') cfr[r.gid] = true; });
      var nCfr = Object.keys(cfr).length;
      openSide(card, pos.generic + ' (' + pos.segment + ', rank ' + pos.cfr_rank + '): the receptors numbered here', function (side) {
        var a = pos.am_substitutions;
        h('p', '', side, fmt(pos.substitutions) + ' unique substitutions (' + fmt(pos.alleles) + ' alleles) in ' + pos.receptors_with_alleles + ' of ' + pos.receptors_numbered + ' receptors numbered here' + (k >= 0 ? '; ' + nCfr + ' of the ' + pos.receptors_numbered + ' have a CFR here' : '') + '. AlphaMissense: ' + fmt(a.pathogenic) + ' predicted pathogenic, ' + fmt(a.ambiguous) + ' ambiguous, ' + fmt(a.benign) + ' predicted benign.');
        side.appendChild(link('Search ' + pos.generic, SEARCH(pos.generic), 'cc-btn'));
        var list = d.rows.slice().sort(function (x, y) { return y[F.pathogenic] - x[F.pathogenic] || y[F.substitutions] - x[F.substitutions]; });
        var head = [{ label: 'Receptor' }, { label: 'Residue' }];
        if (k >= 0) head.push({ label: 'CFR' });
        side.appendChild(sideTable(
          head.concat([{ label: 'Subst.', num: true }, { label: 'Path.', num: true }, { label: 'Amb.', num: true }, { label: 'Ben.', num: true }, { label: 'AC', num: true }, { label: 'ClinVar P/LP', num: true }]),
          list.map(function (r) {
            var rec = recs[r[F.receptor]], row = [link(rec[RF.gene], rec[RF.report_url] || REPORT(rec[RF.gid])), (r[F.aa] || '') + r[F.residue]];
            if (k >= 0) row.push(cfr[rec[RF.gid]] ? 'yes' : '');
            return row.concat([r[F.substitutions], r[F.pathogenic], r[F.ambiguous], r[F.benign], r[F.allele_count], r[F.clinvar_plp_db] || '']);
          })));
        h('p', 'side-note', side, (k >= 0 ? 'CFR: yes when the residue is in an above-threshold contact of its receptor. ' : '') + 'Path., Amb., Ben.: AlphaMissense predicted classes of the unique substitutions. AC: gnomAD allele count. ClinVar P/LP: pathogenic or likely pathogenic missense records, per receptor.');
      });
    }, function () { openSide(card, pos.generic, function (side) { h('p', 'side-note', side, 'The receptor list could not load.'); }); });
  }

  // ================================================================== 5 receptors
  define('chart-receptors', {
    needs: ['receptors'],
    keepNode: true,
    init: function (card, D) {
      var st = card.state, rj = D.receptors;
      st.tab = ({ table: 1, families: 1 })[urlParam('rx')] ? urlParam('rx') : 'scatter';
      st.x = 'above_per_100'; st.y = 'share_active'; st.sort = null; st.dir = 1;
      card.tableBox = null;
      card.explorer = card.el.querySelector('.explorer-table');
      card.families = card.el.querySelector('[data-families-text]');
      card.view = card.el.querySelector('[data-view-text]');
      card.axes = card.el.querySelector('[data-ctl="axes"]');
      var tabs = card.el.querySelector('[data-ctl="tab"]');
      function showTab() {
        tabs.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-value') === st.tab ? 'true' : 'false'); });
        card.axes.hidden = st.tab !== 'scatter';
        card.chart.hidden = st.tab === 'table';
        card.explorer.hidden = st.tab !== 'table';
        card.families.hidden = st.tab !== 'families';
        // the Table tab exports as CSV only (an image of a 283-row table is not useful)
        card.el.querySelectorAll('.xmenu-list [data-export="png"], .xmenu-list [data-export="svg"]').forEach(function (b) { b.hidden = st.tab === 'table'; });
        setUrlParam('rx', st.tab === 'scatter' ? null : st.tab);
      }
      tabs.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { st.tab = b.getAttribute('data-value'); showTab(); draw(card, { fade: true, force: true }); });
      });
      card.showTab = showTab;
      buildAxes(card, rj);
      PHONE.addEventListener('change', function () { buildAxes(card, rj); });
      showTab();
    },
    csv: function (card) { return card.meta.csv; },
    visibleNode: function (card) { return card.state.tab === 'table' ? card.explorer : card.chart; },
    suffix: function (card) { return card.state.tab === 'scatter' ? card.state.x + '_' + card.state.y : card.state.tab; },
    draw: function (card, node, w, o) {
      var st = card.state;
      if (st.tab === 'table') { explorerTable(card); return; }
      if (st.tab === 'families') return families(card, node, w, o);
      if (o.exporting) return;
      return scatter(card, node, w, o);
    },
    onSelect: function (card) { draw(card, { force: true }); },
    exportCustom: function (card, kind) {
      if (card.state.tab !== 'scatter') {
        var svg = exportSVGString(card);
        if (kind === 'svg') { download(new Blob([svg.text], { type: 'image/svg+xml' }), fileName(card, 'svg')); return; }
        var img = new Image();
        img.onload = function () { var cv = document.createElement('canvas'); cv.width = svg.w * 2; cv.height = svg.h * 2; var g = cv.getContext('2d'); g.scale(2, 2); g.drawImage(img, 0, 0); cv.toBlob(function (b) { download(b, fileName(card, 'png')); }); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.text);
        return;
      }
      if (!window.Plotly || !card.plotDiv) return;
      var saved = C; C = lightTokens();
      var fig = scatterFigure(card, card.lastW, true);
      C = saved;
      var tmp = h('div', '', STATS); tmp.style.cssText = 'position:absolute;left:-20000px;top:0;width:' + card.lastW + 'px;height:480px';
      window.Plotly.newPlot(tmp, fig.data, fig.layout, { staticPlot: true }).then(function () {
        return window.Plotly.downloadImage(tmp, { format: kind, scale: kind === 'png' ? 2 : 1, width: card.lastW, height: 520, filename: fileName(card, kind).replace(/\.\w+$/, '') });
      }).then(function () { window.Plotly.purge(tmp); tmp.remove(); }, function () { tmp.remove(); });
    }
  });
  function buildAxes(card, rj) {
    var st = card.state, box = card.axes;
    clear(box);
    if (isPhone()) {
      ['x', 'y'].forEach(function (ax) {
        var lab = h('label', 'ctl-note', box, ax + ' '), sel = h('select', '', lab);
        rj.metrics.forEach(function (m) { var op = h('option', '', sel, m.label); op.value = m.key; });
        sel.value = st[ax];
        sel.addEventListener('change', function () { st[ax] = sel.value; draw(card, { force: true }); });
      });
      return;
    }
    ['x', 'y'].forEach(function (ax) {
      var grp = h('span', 'chips', box); grp.setAttribute('role', 'group'); grp.setAttribute('aria-label', ax + ' axis');
      h('span', 'ctl-note', grp, ax);
      rj.metrics.forEach(function (m) {
        var b = h('button', '', grp, m.label); b.type = 'button'; b.title = m.description;
        b.setAttribute('data-value', m.key); b.setAttribute('aria-pressed', st[ax] === m.key ? 'true' : 'false');
        b.addEventListener('click', function () { st[ax] = m.key; grp.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); draw(card, { force: true }); });
      });
    });
  }
  function recolorModel(card) {
    var st = StatsSel.get(), out = null;
    if (st.pos && card.atlas) {
      var k = card.atlas.positions.map(function (p) { return p.gn; }).indexOf(st.pos);
      if (k < 0) return { note: st.pos + ': coloring by position is available for the ' + TOP + ' top-ranked positions.' };
      var m = {}, c = { up: 0, down: 0, none: 0, out: 0 };
      card.atlas.receptors.forEach(function (r) {
        var s = r.state.charAt(k), v = r.net[k], cls = s === '2' ? (v > 0 ? 'up' : v < 0 ? 'down' : 'none') : s === '1' ? 'none' : 'out';
        m[r.gid] = cls; c[cls]++;
      });
      out = { by: m, text: st.pos + ': stronger in the active model in ' + c.up + ', in the inactive model in ' + c.down + ', no above-threshold contact in ' + c.none + ', not numbered in ' + c.out + '.' };
    } else if (st.pair && card.cells) {
      var pi = card.cells.pairs.map(function (p) { return p.join(','); }).indexOf(st.pair.join(','));
      var m2 = {}, c2 = { up: 0, down: 0, none: 0 };
      card.cells.receptors.forEach(function (gid, i) { var v = pi < 0 ? null : card.cells.net[i][pi], cls = v === null ? 'none' : v > 0 ? 'up' : v < 0 ? 'down' : 'none'; m2[gid] = cls; c2[cls]++; });
      out = { by: m2, text: pairName(st.pair) + ': stronger in the active model in ' + c2.up + ', in the inactive model in ' + c2.down + ', no above-threshold contact in ' + c2.none + '.' };
    }
    return out;
  }
  function scatterFigure(card, w, light) {
    var rj = card.D.receptors, RI = receptorIndex(rj), st = card.state, sel = StatsSel.get(), lc = ligandColors(rj, light ? lightTokens() : C);
    var lab = {}; rj.metrics.forEach(function (m) { lab[m.key] = m.label; });
    var list = RI.list.filter(function (r) { return r[st.x] !== null && r[st.y] !== null; });
    function range(k) {
      var v = list.map(function (r) { return r[k]; }), lo = minOf(v), hi = maxOf(v), pad = (hi - lo) * 0.04 || 1;
      return [lo - pad, hi + pad];
    }
    var rc = recolorModel(card), data = [];
    var size = function (r) { return (isPhone() ? 4 : 5) + 0.22 * (r.cfr_hits || 0); };
    var hover = '%{text}<br>' + lab[st.x] + ': %{x}<br>' + lab[st.y] + ': %{y}<extra></extra>';
    if (rc && rc.by) {
      [['up', C.active, 'stronger in the active model'], ['down', C.inactive, 'stronger in the inactive model'], ['none', C.faint, 'no above-threshold contact'], ['out', null, 'not numbered']].forEach(function (k) {
        var sub = list.filter(function (r) { return rc.by[r.gid] === k[0]; }); if (!sub.length) return;
        data.push({ type: 'scatter', mode: 'markers', name: k[2] + ' (' + sub.length + ')', x: sub.map(function (r) { return r[st.x]; }), y: sub.map(function (r) { return r[st.y]; }),
          text: sub.map(function (r) { return r.symbol; }), customdata: sub.map(function (r) { return r.gid; }), hovertemplate: hover,
          marker: { size: sub.map(size), color: k[1] || 'rgba(0,0,0,0)', line: { width: 1, color: k[1] ? C.surface : C.muted }, opacity: 0.9 } });
      });
    } else {
      rj.ligand_groups.forEach(function (g) {
        var sub = list.filter(function (r) { return r.ligand_group === g.key; }); if (!sub.length) return;
        data.push({ type: 'scatter', mode: 'markers', name: g.key.replace(/ receptors$/, '') + ' (' + sub.length + ')', x: sub.map(function (r) { return r[st.x]; }), y: sub.map(function (r) { return r[st.y]; }),
          text: sub.map(function (r) { return r.symbol; }), customdata: sub.map(function (r) { return r.gid; }), hovertemplate: hover,
          marker: { size: sub.map(size), color: lc[g.key], opacity: 0.85, line: { width: 0.5, color: C.surface } } });
      });
    }
    var f = sel.rec && RI.by[sel.rec], shapes = [];
    if (f && f[st.x] !== null) {
      (rj.similar[f.gid] || []).forEach(function (s) {
        var o = RI.by[s[0]]; if (!o || o[st.x] === null) return;
        data.push({ type: 'scatter', mode: 'lines', x: [f[st.x], o[st.x]], y: [f[st.y], o[st.y]], line: { color: C.fg, width: 1 }, opacity: 0.5, hoverinfo: 'skip', showlegend: false });
      });
      data.push({ type: 'scatter', mode: 'markers+text', x: [f[st.x]], y: [f[st.y]], text: [f.symbol], textposition: 'top center', textfont: { color: C.fg, size: 12 }, showlegend: false, hoverinfo: 'skip',
        marker: { size: 18, color: 'rgba(0,0,0,0)', line: { width: 2, color: C.fg } } });
    }
    var narrow = w < 400;
    var axis = function (k) { return { title: { text: lab[k], font: { size: narrow ? 10.5 : 12 }, standoff: 6 }, range: range(k), tickformat: k === 'share_active' ? '.0%' : undefined, gridcolor: C.lineSoft, zeroline: false, linecolor: C.line, tickfont: { size: narrow ? 10 : 11 }, automargin: true }; };
    var layout = { paper_bgcolor: light ? '#ffffff' : C.surface, plot_bgcolor: light ? '#ffffff' : C.surface, font: { family: 'system-ui, sans-serif', color: C.fg, size: 12 },
      xaxis: axis(st.x), yaxis: axis(st.y), margin: { l: narrow ? 50 : 56, r: 12, t: narrow ? 16 : 10, b: isPhone() ? 130 : 80 }, showlegend: true,
      legend: { orientation: 'h', yanchor: 'top', y: isPhone() ? -0.3 : -0.2, x: 0, font: { size: isPhone() ? 10 : 11.5 } }, hoverlabel: { font: { size: 12 } } };
    return { data: data, layout: layout, rc: rc };
  }
  function scatter(card, node, w, o) {
    var st = card.state, rj = card.D.receptors, need = [];
    var sel = StatsSel.get();
    if (sel.pos && !card.atlas) need.push(load('cfr_atlas').then(function (a) { card.atlas = a; }));
    if (sel.pair && !card.cells) need.push(load('helix_receptor_cells').then(function (c) { card.cells = c; }));
    return Promise.all(need).then(function () {
      var fig = scatterFigure(card, w, false);
      var lab = {}; rj.metrics.forEach(function (m) { lab[m.key] = m.label; });
      card.view.textContent = fig.rc ? fig.rc.text || fig.rc.note : 'Scatter: x ' + lab[st.x].toLowerCase() + ', y ' + lab[st.y].toLowerCase() + '; color by ligand group; dot size by top-ranked positions with a CFR.';
      var back = card.el.querySelector('[data-back]');
      var recolored = !!(fig.rc && fig.rc.by);   // a note alone (a position outside the top 50) changes no color
      if (recolored && !back) {
        back = h('button', 'cc-btn', null, 'Back to ligand colors'); back.type = 'button'; back.setAttribute('data-back', '');
        back.addEventListener('click', function () { StatsSel.set({ pos: null, pair: null }); });
        card.view.parentNode.insertBefore(back, card.view.nextSibling);
      } else if (!recolored && back) back.remove();
      node.classList.add('plotly-host');
      if (!card.plotDiv || !node.contains(card.plotDiv)) { clear(node); card.plotDiv = h('div', 'plot', node); card.plotDiv.style.height = '100%'; card.plotDiv.id = 'chart-receptors-plot'; card.plotDiv.setAttribute('role', 'img'); card.plotDiv.setAttribute('aria-label', 'Receptor explorer scatter'); }
      if (!window.Plotly) { clear(node); h('p', 'load-note', node, 'This chart could not load.'); return; }
      var fn = card.plotted ? window.Plotly.react : window.Plotly.newPlot;
      return fn(card.plotDiv, fig.data, fig.layout, { responsive: true, displayModeBar: false, displaylogo: false, scrollZoom: false }).then(function () {
        if (!card.plotted) {
          card.plotted = true;
          card.plotDiv.on('plotly_click', function (ev) { var p = ev.points && ev.points[0]; if (p && p.customdata) receptorPanel(card, p.customdata); });
        }
      });
    });
  }
  function families(card, node, w, o) {
    var rj = card.D.receptors, RI = receptorIndex(rj), rec = StatsSel.get().rec, by = {};
    if (!o.exporting) { if (card.plotDiv && window.Plotly && window.Plotly.purge) window.Plotly.purge(card.plotDiv); clear(node); node.classList.remove('plotly-host'); card.plotDiv = null; card.plotted = false; }
    if (!o.exporting) card.view.textContent = 'Families: total |ΔRRCS| per receptor, one row per ligand type, ordered by median. Tick: median.';
    RI.list.forEach(function (r) { (by[r.ligand] = by[r.ligand] || []).push(r); });
    var L = Object.keys(by).map(function (k) { return { k: k, rs: by[k], m: median(by[k].map(function (r) { return r.sum_abs; })) }; }).sort(function (a, b) { return b.m - a.m; });
    var phone = isPhone() || w < 560, lab = phone ? 0 : 210, rh = phone ? 42 : 28, s = svgIn(node, w, L.length * rh + 30, 'Total |ΔRRCS| per receptor by ligand type');
    var mx = maxOf(RI.list.map(function (r) { return r.sum_abs; })), x = function (v) { return lab + 6 + v / mx * (w - lab - 16); };
    L.forEach(function (l, i) {
      var y = i * rh + (phone ? 28 : 14);
      el('text', { x: phone ? 0 : lab - 8, y: phone ? y - 12 : y + 4, 'text-anchor': phone ? 'start' : 'end', 'font-size': 11.5, fill: C.fg }, s, l.k + ' (' + l.rs.length + ')');
      el('line', { x1: lab + 6, x2: w - 10, y1: y, y2: y, stroke: C.lineSoft }, s);
      l.rs.forEach(function (r) {
        var f = r.gid === rec, c = el('circle', { cx: x(r.sum_abs), cy: y, r: f ? 6 : 3.4, fill: f ? C.fg : C.ink, 'fill-opacity': f ? 1 : 0.5, stroke: f ? C.surface : 'none', 'stroke-width': 1.5 }, s);
        if (!o.exporting) hit(c, r.symbol + ': ' + fmt(Math.round(r.sum_abs)), function () { receptorPanel(card, r.gid); }, null, true);
        if (f) el('text', { x: x(r.sum_abs), y: y - 9, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: C.fg }, s, r.symbol);
      });
      el('line', { x1: x(l.m), x2: x(l.m), y1: y - 8, y2: y + 8, stroke: C.fg, 'stroke-width': 2.4 }, s);
    });
    var step = mx > 2000 ? 500 : 250;
    for (var t = 0; t <= mx; t += step) el('text', { x: x(t), y: L.length * rh + 24, 'text-anchor': 'middle', 'font-size': 11, fill: C.muted }, s, fmt(t));
  }
  var TCOLS = [
    { key: 'symbol', label: 'Receptor' }, { key: 'name', label: 'UniProt name' }, { key: 'family', label: 'Family' }, { key: 'ligand', label: 'Ligand type' },
    { key: 'n_pairs', label: 'Contact pairs', num: true }, { key: 'n_above', label: 'Above threshold', num: true }, { key: 'above_per_100', label: 'Above threshold per 100 pairs', num: true },
    { key: 'sum_abs', label: 'Sum |ΔRRCS|', num: true }, { key: 'share_active', label: 'Share stronger in the active model', num: true, pct: true }, { key: 'cfr_hits', label: 'Top-ranked positions with a CFR', num: true },
    { key: 'threshold', label: 'Threshold', num: true }
  ];
  function explorerTable(card) {
    var rj = card.D.receptors, RI = receptorIndex(rj), st = card.state, box = card.explorer, rec = StatsSel.get().rec, lc = ligandColors(rj);
    card.view.textContent = 'Table: all ' + RI.list.length + ' receptors; sort by any column.';
    var list = RI.list.slice();
    if (st.sort) list.sort(function (a, b) { var va = a[st.sort], vb = b[st.sort]; if (typeof va === 'string') return st.dir * va.localeCompare(vb); return st.dir * ((va === null ? -Infinity : va) - (vb === null ? -Infinity : vb)); });
    clear(box);
    var t = h('table', '', box), tr = h('tr', '', h('thead', '', t)), tb = h('tbody', '', t);
    TCOLS.forEach(function (c) {
      var th = h('th', c.num ? 'num' : '', tr), b = h('button', '', th, c.label); b.type = 'button';
      th.setAttribute('aria-sort', st.sort === c.key ? (st.dir > 0 ? 'ascending' : 'descending') : 'none');
      b.addEventListener('click', function () { if (st.sort === c.key) st.dir = -st.dir; else { st.sort = c.key; st.dir = c.num ? -1 : 1; } explorerTable(card); box.querySelector('th[aria-sort]:not([aria-sort="none"]) button').focus(); });
    });
    list.forEach(function (r) {
      var row = h('tr', r.gid === rec ? 'is-found' : '', tb);
      TCOLS.forEach(function (c) {
        var td = h('td', c.num ? 'num' : '', row), v = r[c.key];
        if (c.key === 'symbol') { var sw = h('span', 'swatch', td); sw.style.background = lc[r.ligand_group]; td.appendChild(link(r.symbol, r.report || REPORT(r.gid))); }
        else td.textContent = v === null || v === undefined ? '' : c.pct ? pct(v, 1) : (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));
      });
    });
  }

  // ---- the GPCRome Atlas teaser
  function teaser() {
    var node = document.getElementById('atlas-teaser-map');
    if (!node) return null;
    var T = { node: node, drawn: false };
    T.draw = function () {
      Promise.all([load('atlas_map'), load('receptors')]).then(function (arr) {
        var m = arr[0], RI = receptorIndex(arr[1]), P = rows(m.columns, m.rows), rec = StatsSel.get().rec;
        clear(node);
        var w = Math.min(520, width(node)), hh = Math.round(w * 0.72), cv = h('canvas', '', node);
        cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'Receptors placed by the similarity of their contact changes');
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = w * dpr; cv.height = hh * dpr; cv.style.width = w + 'px'; cv.style.height = hh + 'px';
        var g = cv.getContext('2d'); g.scale(dpr, dpr);
        var xs = P.map(function (p) { return p.x; }), ys = P.map(function (p) { return p.y; });
        var x0 = minOf(xs), x1 = maxOf(xs), y0 = minOf(ys), y1 = maxOf(ys);
        var colors = m.ligand_groups.map(function (gg) { return C.dark ? (LIGAND_DARK[gg.key] || gg.color) : gg.color; });
        g.fillStyle = C.plate; g.beginPath(); if (g.roundRect) g.roundRect(0, 0, w, hh, 14); else g.rect(0, 0, w, hh); g.fill();
        var px = function (p) { return [14 + (p.x - x0) / (x1 - x0) * (w - 28), 14 + (1 - (p.y - y0) / (y1 - y0)) * (hh - 28)]; };
        P.forEach(function (p) { var q = px(p); g.fillStyle = colors[p.group] || C.muted; g.globalAlpha = 0.85; g.beginPath(); g.arc(q[0], q[1], 3.4, 0, 7); g.fill(); g.globalAlpha = 1; });
        var f = rec && P.filter(function (p) { return p.gid === rec; })[0];
        if (f) {
          var q = px(f), r = RI.by[rec];
          g.strokeStyle = C.fg; g.lineWidth = 2; g.beginPath(); g.arc(q[0], q[1], 9, 0, 7); g.stroke();
          g.font = '700 12px system-ui, sans-serif'; g.fillStyle = C.fg; g.textAlign = q[0] > w - 80 ? 'right' : 'left';
          g.fillText(r ? r.symbol : rec, q[0] + (q[0] > w - 80 ? -12 : 12), q[1] + 4);
        }
        var lg = h('div', 'legend', node);
        lg.innerHTML = m.ligand_groups.map(function (gg, i) { return '<span><span class="sw" style="background:' + colors[i] + ';border-radius:50%"></span>' + esc(gg.key.replace(/ receptors$/, '')) + '</span>'; }).join('');
        node.setAttribute('data-chart-rendered', '1');
        T.drawn = true;
      }, function () { clear(node); h('p', 'load-note', node, 'This chart could not load.'); });
    };
    return T;
  }

  // ================================================================== start
  function init() {
    refreshTokens();
    STATS.classList.add('is-live');
    var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        var c = CARDS[en.target.getAttribute('data-card')];
        if (c) loadCard(c);
        if (en.target.id === 'card-atlas-teaser' && T && !T.drawn) T.draw();
      });
    }, { rootMargin: '600px 0px' }) : null;
    document.querySelectorAll('.stats .scard[data-card]').forEach(function (a) {
      var c = makeCard(a);
      if (!c) return;
      var det = a.closest('details');
      if (det) {
        det.addEventListener('toggle', function () { if (det.open) { if (!c.loaded) loadCard(c); else revisit(c); } });
        if (!det.open) return;
      }
      if (io) io.observe(a); else loadCard(c);
    });
    var T = teaser(), tEl = document.getElementById('card-atlas-teaser');
    if (T && tEl) { if (io) io.observe(tEl); else T.draw(); }

    // the selection: every loaded card follows it
    document.addEventListener('gpc:stats-select', function () {
      Object.keys(CARDS).forEach(function (id) {
        var c = CARDS[id];
        if (!c.D || c.failed) return;
        if (c.def.onSelect) { if (visible(c.chart) || id === 'chart-receptors') c.def.onSelect(c); else c.dirty = true; }
      });
      if (T && T.drawn) T.draw();
    });

    // theme: tokens are read again; visible charts redraw now, hidden ones when next shown
    document.addEventListener('gpcrsynth-theme-change', function () {
      requestAnimationFrame(function () { refreshTokens(); redrawAll(true); if (T && T.drawn) T.draw(); });
    });
    var rT = null;
    window.addEventListener('resize', function () {
      clearTimeout(rT);
      rT = setTimeout(function () {
        Object.keys(CARDS).forEach(function (id) {
          var c = CARDS[id];
          if (!c.drawn || !visible(c.chart)) { if (c.drawn) c.dirty = true; return; }
          if (width(c.chart) !== c.lastW) draw(c, {});
        });
        if (T && T.drawn && Math.min(520, width(T.node)) !== (T.node.querySelector('canvas') || {}).clientWidth) T.draw();
      }, 150);
    });
    document.addEventListener('gpc:segment-order', function () {
      ['chart-segments', 'chart-helix-pairs'].forEach(function (id) { var c = CARDS[id]; if (c && c.drawn) draw(c, {}); });
    });

    // the rail marks the section in view
    var links = {};
    document.querySelectorAll('.rail-list a[data-rail]').forEach(function (a) { links[a.getAttribute('data-rail')] = a; });
    if ('IntersectionObserver' in window) {
      var current = null, seen = {};
      var ro = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { seen[en.target.id] = en.isIntersecting ? en.boundingClientRect.top : null; });
        var best = null;
        Object.keys(seen).forEach(function (id) { if (seen[id] !== null && (best === null || Math.abs(seen[id]) < Math.abs(seen[best]))) best = id; });
        if (best && best !== current) {
          current = best;
          Object.keys(links).forEach(function (k) { links[k].classList.toggle('is-current', k === best); if (k === best) links[k].setAttribute('aria-current', 'location'); else links[k].removeAttribute('aria-current'); });
        }
      }, { rootMargin: '-20% 0px -55% 0px' });
      document.querySelectorAll('.stats section.story[id]').forEach(function (s) { ro.observe(s); });
    }
    // a link to a card inside a closed disclosure opens it
    function openHash() {
      var t = location.hash && document.getElementById(location.hash.slice(1));
      var d = t && t.closest('details'); if (d) d.open = true;
    }
    openHash();
    window.addEventListener('hashchange', openHash);
    StatsSel.fromURL();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
