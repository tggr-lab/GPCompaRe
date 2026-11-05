/* report-select.js: one selection for the whole report page.

   A residue or a contact pair chosen anywhere (snake plot, the tables, a chart point, the
   summary block, the residue drawer, the 3D view) is marked everywhere else, and a compact
   selection bar at the bottom of the screen says what is selected, which way its dRRCS goes
   (red: stronger in the active model, blue: stronger in the inactive model) and offers the
   next steps: partners, 3D, this position in all receptors, show on the plot or in the
   table, copy a link. Hover is a lighter, transient mark. Escape, or the bar's close
   button, hides the bar and keeps the selection (the plot, tables and 3D view stay
   marked); "Clear" or a second Escape clears the selection everywhere. While the open 3D
   view would sit under the bar, the bar docks at the top of the screen instead.

   Events (plain CustomEvents on document, the shared contract):
     listens  gpc:select-residue {gid, res, source}     gpc:select-pair {gid, a, b, delta, source}
              gpc:hover-residue  {gid, res, source}     gpc:hover-pair  {gid, a, b, source}
     fires    the same four, with the source that made the choice ('snake', 'table', 'clinvar',
              'chart', 'summary', 'drawer', 'selbar', 'hash'); events this module fires are
              ignored by it, and events from another receptor's gid are ignored.
   The residue drawer (residue-drawer.js) hands its selections to window.GPCSelect, so the
   snake plot, the tables and the ClinVar rows arrive through it. The 3D view (viewer3d.js)
   speaks the events directly. Deep links: #res=<n> (existing) and #pair=<a>-<b>.
   Nothing here loads anything, and nothing runs until the page is parsed. */
(function () {
  'use strict';

  function readJSON(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var cfg = readJSON('rx-config') || {};
  var GID = cfg.gid || '';
  var ann = cfg.annotation || {};
  var byPos = {};
  (readJSON('residue-summary-data') || []).forEach(function (r) { byPos[r.position] = r; });
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var THREE = {
    A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile',
    L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val'
  };
  function aa3(name) {
    var n = String(name || '').trim();
    if (/^[A-Za-z]{3}$/.test(n)) return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
    return THREE[n.toUpperCase()] || n;
  }
  function label(pos) {
    var r = byPos[pos];
    return (r && r.amino_acid && THREE[r.amino_acid] ? THREE[r.amino_acid] : '') + pos;
  }
  function gnOf(pos) { var a = ann[String(pos)]; return (a && a[1]) || (byPos[pos] && (byPos[pos].display_number || byPos[pos].generic_number)) || ''; }
  function segOf(pos) { var a = ann[String(pos)]; return (a && a[0]) || (byPos[pos] && byPos[pos].protein_segment) || ''; }
  function fmtSigned(v) { return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2); }

  var state = { res: null, pair: null };   // pair: {a, b, delta}
  var dismissed = false;                   // the bar was hidden by the reader; the selection stays
  var pairEcho = null;                     // {pos, until}: the plot's echo of a pair's first residue
  var applying = false;                    // set while this module changes things, so its own echoes are ignored
  var marked = [];                         // elements carrying a selection class

  function fire(name, detail, source) {
    detail.gid = GID;
    detail.source = source;
    var was = applying;
    applying = true;
    try { document.dispatchEvent(new CustomEvent(name, { detail: detail })); } finally { applying = was; }
  }

  // ------------------------------------------------------------------ marks
  function unmark() {
    marked.forEach(function (n) { n.classList.remove('gpc-sel', 'gpc-sel-pair', 'gpc-sel-b'); n.removeAttribute('aria-current'); });
    marked = [];
  }
  function mark(nodes, cls) {
    Array.prototype.forEach.call(nodes, function (n) { n.classList.add(cls); marked.push(n); });
  }
  function qsa(sel) { return document.querySelectorAll(sel); }

  function paintTables() {
    unmark();
    var res = state.res, pair = state.pair;
    if (res === null) return;
    mark(qsa('[data-gpc-res="' + res + '"], [data-gpc-a="' + res + '"], [data-gpc-b="' + res + '"]'), 'gpc-sel');
    if (pair) {
      mark(qsa('[data-gpc-res="' + pair.b + '"], [data-gpc-a="' + pair.b + '"], [data-gpc-b="' + pair.b + '"]'), 'gpc-sel-b');
      mark(qsa('[data-gpc-a="' + pair.a + '"][data-gpc-b="' + pair.b + '"], [data-gpc-a="' + pair.b + '"][data-gpc-b="' + pair.a + '"]'), 'gpc-sel-pair');
      Array.prototype.forEach.call(qsa('.gpc-pair.gpc-sel-pair'), function (a) { a.setAttribute('aria-current', 'true'); });
    }
  }

  // The snake plot draws its own marks from the bus events (snake-plus.js); this module only
  // keeps the plot's existing selected residue in step, through SnakeAPI.
  function snakeCircle(pos) {
    var c = document.getElementById('snake-plot-container');
    return c ? c.querySelector('circle[id="' + pos + '"]') : null;
  }

  // ------------------------------------------------------------------ charts
  // The scatter (one point per contact pair) and the residue chart (one point per residue,
  // two panels) are drawn when they near the screen; the hooks attach then.
  var pairIdx = null;
  function scatterIndex(a, b) {
    var payload = (window.CHART_DATA || {})['scatter-chart'];
    if (!payload || !payload.data || !payload.data[0]) return -1;
    if (!pairIdx) {
      pairIdx = {};
      (payload.data[0].text || []).forEach(function (t, i) {
        var m = /^[A-Za-z]{3}(\d+) - [A-Za-z]{3}(\d+)/.exec(t || '');
        if (m) pairIdx[m[1] + '-' + m[2]] = i;
      });
    }
    var i = pairIdx[a + '-' + b];
    if (i === undefined) i = pairIdx[b + '-' + a];
    return i === undefined ? -1 : i;
  }
  function residueIndex(pos) {
    var payload = (window.CHART_DATA || {})['residue-chart'];
    if (!payload || !payload.data || !payload.data[0]) return -1;
    return (payload.data[0].x || []).indexOf(pos);
  }
  function rendered(id) {
    var e = document.getElementById(id);
    return e && e.dataset.chartRendered && typeof Plotly !== 'undefined' && Plotly.restyle ? e : null;
  }
  function paintCharts() {
    var sc = rendered('scatter-chart');
    if (sc) {
      var i = state.pair ? scatterIndex(state.pair.a, state.pair.b) : -1;
      Plotly.restyle(sc, i >= 0
        ? { selectedpoints: [[i]], 'selected.marker.size': 14, 'selected.marker.opacity': 1, 'unselected.marker.opacity': 0.25 }
        : { selectedpoints: [null] }, [0]);
    }
    var rc = rendered('residue-chart');
    if (rc) {
      var idx = [];
      if (state.res !== null) { var k = residueIndex(state.res); if (k >= 0) idx.push(k); }
      if (state.pair) { var k2 = residueIndex(state.pair.b); if (k2 >= 0) idx.push(k2); }
      var traces = [];
      for (var t = 0; t < (rc.data || []).length; t++) traces.push(t);
      Plotly.restyle(rc, idx.length
        ? { selectedpoints: [idx], 'selected.marker.size': 16, 'selected.marker.opacity': 1, 'unselected.marker.opacity': 0.3 }
        : { selectedpoints: [null] }, traces);
    }
  }
  function whenRendered(id, fn) {
    var e = document.getElementById(id);
    if (!e) return;
    if (e.dataset.chartRendered) return fn(e);
    if (!('MutationObserver' in window)) return;
    var mo = new MutationObserver(function () {
      if (e.dataset.chartRendered) { mo.disconnect(); fn(e); }
    });
    mo.observe(e, { attributes: true, attributeFilter: ['data-chart-rendered'] });
  }
  function hookCharts() {
    whenRendered('scatter-chart', function (e) {
      if (!e.on) return;
      e.on('plotly_click', function (ev) {
        var p = ev.points && ev.points[0];
        var m = p && /^[A-Za-z]{3}(\d+) - [A-Za-z]{3}(\d+)[\s\S]*ΔRRCS: ([+-]?[\d.]+)/.exec(p.text || '');
        if (m) selectPair(parseInt(m[1], 10), parseInt(m[2], 10), parseFloat(m[3]), 'chart');
      });
      e.on('plotly_hover', function (ev) {
        var p = ev.points && ev.points[0];
        var m = p && /^[A-Za-z]{3}(\d+) - [A-Za-z]{3}(\d+)/.exec(p.text || '');
        if (m) hoverPair(parseInt(m[1], 10), parseInt(m[2], 10), 'chart');
      });
      e.on('plotly_unhover', function () { hoverPair(null, null, 'chart'); });
      if (state.pair) paintCharts();
    });
    whenRendered('residue-chart', function (e) {
      if (!e.on) return;
      e.on('plotly_click', function (ev) {
        var p = ev.points && ev.points[0];
        if (p && typeof p.x === 'number') selectResidue(p.x, 'chart');
      });
      e.on('plotly_hover', function (ev) {
        var p = ev.points && ev.points[0];
        if (p && typeof p.x === 'number') hoverResidue(p.x, 'chart');
      });
      e.on('plotly_unhover', function () { hoverResidue(null, 'chart'); });
      if (state.res !== null) paintCharts();
    });
  }

  // ------------------------------------------------------------------ table rows
  // Rows of the report tables are tagged with the residues they name so marks are a query.
  // Attributes only: the approved text is untouched.
  function tagPairTable(id, ca, cb, re) {
    var t = document.getElementById(id);
    if (!t || !t.tBodies[0]) return;
    Array.prototype.forEach.call(t.tBodies[0].rows, function (tr) {
      var c = tr.cells;
      if (c.length <= Math.max(ca, cb)) return;
      var a = re.exec(c[ca].textContent.trim()), b = re.exec(c[cb].textContent.trim());
      if (a && b) { tr.setAttribute('data-gpc-a', a[1]); tr.setAttribute('data-gpc-b', b[1]); }
    });
  }
  function tagResTable(id, col, re) {
    var t = document.getElementById(id);
    if (!t || !t.tBodies[0]) return;
    Array.prototype.forEach.call(t.tBodies[0].rows, function (tr) {
      var c = tr.cells;
      if (c.length <= col) return;
      var m = re.exec(c[col].textContent.trim());
      if (m) tr.setAttribute('data-gpc-res', m[1]);
    });
  }
  function tagRows() {
    tagPairTable('top-changes-table', 1, 2, /^[A-Za-z]+(\d+)/);
    tagPairTable('rrcs-table', 0, 2, /^(\d+)/);
    tagResTable('variants-table', 0, /^(\d+)/);
    Array.prototype.forEach.call(qsa('#clinvar-table tbody tr'), function (tr) {
      var b = tr.querySelector('[data-rx-res]');
      if (b) tr.setAttribute('data-gpc-res', b.getAttribute('data-rx-res'));
    });
    Array.prototype.forEach.call(qsa('#tm-summary-table .tm-res'), function (s) {
      var m = /^(\d+)/.exec(s.textContent.trim());
      if (m) s.setAttribute('data-gpc-res', m[1]);
    });
  }

  // ------------------------------------------------------------------ hash
  function hashParts() {
    var raw = (window.location.hash || '').replace(/^#/, '');
    return raw ? raw.split('&').filter(Boolean) : [];
  }
  function writeSelectionHash() {
    var parts = hashParts().filter(function (p) { return !/^(res|pair)=/.test(p); });
    if (state.pair) parts.push('pair=' + state.pair.a + '-' + state.pair.b);
    else if (state.res !== null) parts.push('res=' + state.res);
    var hash = parts.length ? '#' + parts.join('&') : '';
    if (hash !== window.location.hash) {
      try { history.replaceState(null, '', window.location.pathname + window.location.search + hash); } catch (e) {}
    }
  }
  function pairFromHash() {
    var m = /(?:^#|&)pair=(\d+)-(\d+)(?:&|$)/.exec(window.location.hash || '');
    return m ? { a: parseInt(m[1], 10), b: parseInt(m[2], 10) } : null;
  }
  function deltaOf(a, b) {
    var t = document.getElementById('rrcs-table');
    if (t && t.tBodies[0]) {
      var row = t.querySelector('tr[data-gpc-a="' + a + '"][data-gpc-b="' + b + '"], tr[data-gpc-a="' + b + '"][data-gpc-b="' + a + '"]');
      if (row) return parseFloat(row.cells[6].textContent);
    }
    var chip = document.querySelector('.gpc-pair[data-gpc-a="' + a + '"][data-gpc-b="' + b + '"], .gpc-pair[data-gpc-a="' + b + '"][data-gpc-b="' + a + '"]');
    return chip ? parseFloat(chip.getAttribute('data-gpc-delta')) : NaN;
  }

  // ------------------------------------------------------------------ the snake plot
  function snakeSelect(pos) {
    var api = window.SnakeAPI;
    if (!api || !api.selectResidue) return;
    var was = applying;
    applying = true;
    try { api.selectResidue(pos); } finally { applying = was; }
  }
  function snakeClear() {
    var api = window.SnakeAPI;
    if (!api || !api.getSelectedResidue) return;
    var cur = api.getSelectedResidue();
    if (cur === null || cur === undefined) return;
    var was = applying;
    applying = true;
    try { api.toggleResidue(cur, false); } finally { applying = was; }
  }
  function snakeShowLinks() {
    var api = window.SnakeAPI;
    if (!api || api.getState().links) return;
    api.setLinksVisible(true);
    var cb = document.getElementById('snake-links-cb');
    if (cb) cb.checked = true;
  }

  // ------------------------------------------------------------------ selection
  function same(res, pair) {
    if (res !== state.res) return false;
    if (!pair && !state.pair) return true;
    return !!(pair && state.pair && pair.a === state.pair.a && pair.b === state.pair.b);
  }

  function paintAll() {
    paintTables();
    paintCharts();
    paintBar();
    writeSelectionHash();
  }

  // source: who chose it. external: the event came from another module (the 3D view), so
  // it is applied here but not fired again.
  function selectResidue(pos, source, opts) {
    opts = opts || {};
    if (typeof pos !== 'number' || isNaN(pos)) return;
    // Selecting a pair marks its first residue on the plot, and the plot and the drawer
    // announce that residue back shortly after. That echo must leave the pair a pair (on the
    // page and in the hash). A deliberate pick of the same residue later selects it alone.
    if (state.pair && state.pair.a === pos && pairEcho && pairEcho.pos === pos &&
        Date.now() < pairEcho.until && (source === 'snake' || source === 'drawer')) { paintAll(); return; }
    if (state.res === pos && !state.pair) { paintAll(); return; }
    state.res = pos;
    state.pair = null;
    dismissed = false;
    if (source !== 'snake') snakeSelect(pos);
    if (window.ReportExtras && window.ReportExtras.refresh) window.ReportExtras.refresh(pos);
    if (window.ReportExtras && window.ReportExtras.markPair) window.ReportExtras.markPair(null);
    paintAll();
    if (!opts.external) fire('gpc:select-residue', { res: pos }, source);
  }

  function selectPair(a, b, delta, source, opts) {
    opts = opts || {};
    if ([a, b].some(function (x) { return typeof x !== 'number' || isNaN(x); })) return;
    if (typeof delta !== 'number' || isNaN(delta)) delta = deltaOf(a, b);
    if (same(a, { a: a, b: b })) { paintAll(); return; }
    state.res = a;
    state.pair = { a: a, b: b, delta: delta };
    pairEcho = { pos: a, until: Date.now() + 600 };
    dismissed = false;
    snakeShowLinks();
    snakeSelect(a);
    if (window.ReportExtras && window.ReportExtras.refresh) window.ReportExtras.refresh(a);
    if (window.ReportExtras && window.ReportExtras.markPair) window.ReportExtras.markPair(b);
    paintAll();
    if (!opts.external) fire('gpc:select-pair', { a: a, b: b, delta: delta }, source);
  }

  function clear(source, opts) {
    opts = opts || {};
    if (state.res === null && !state.pair) return;
    state.res = null;
    state.pair = null;
    snakeClear();
    if (window.ReportExtras && window.ReportExtras.markPair) window.ReportExtras.markPair(null);
    paintAll();
    if (!opts.external) fire('gpc:select-residue', { res: null }, source);
  }

  // ------------------------------------------------------------------ hover
  var hovered = { res: null, pair: null };
  var hoverMarks = [];
  function unhover() {
    hoverMarks.forEach(function (n) { n.classList.remove('gpc-hover'); });
    hoverMarks = [];
  }
  function paintHover() {
    unhover();
    var res = hovered.res, pair = hovered.pair;
    if (res === null && !pair) return;
    var sel = pair
      ? '[data-gpc-a="' + pair.a + '"][data-gpc-b="' + pair.b + '"], [data-gpc-a="' + pair.b + '"][data-gpc-b="' + pair.a + '"]'
      : '[data-gpc-res="' + res + '"], [data-gpc-a="' + res + '"], [data-gpc-b="' + res + '"]';
    Array.prototype.forEach.call(qsa(sel), function (n) { n.classList.add('gpc-hover'); hoverMarks.push(n); });
  }
  function hoverResidue(pos, source, opts) {
    pos = (typeof pos === 'number' && !isNaN(pos)) ? pos : null;
    if (hovered.res === pos && !hovered.pair) return;
    hovered = { res: pos, pair: null };
    paintHover();
    if (!(opts && opts.external)) fire('gpc:hover-residue', { res: pos }, source);
  }
  function hoverPair(a, b, source, opts) {
    var pair = (typeof a === 'number' && typeof b === 'number' && !isNaN(a) && !isNaN(b)) ? { a: a, b: b } : null;
    if (!pair && !hovered.pair && hovered.res === null) return;
    if (pair && hovered.pair && hovered.pair.a === a && hovered.pair.b === b) return;
    hovered = { res: null, pair: pair };
    paintHover();
    if (!(opts && opts.external)) fire('gpc:hover-pair', { a: pair ? a : null, b: pair ? b : null }, source);
  }

  // clears whichever kind is hovered, with the matching event
  function hoverClear(source) {
    if (hovered.pair) hoverPair(null, null, source);
    else if (hovered.res !== null) hoverResidue(null, source);
  }

  var hoverTarget = null;
  function hoverFrom(t) {
    if (!t || !t.closest) return null;
    var row = t.closest('[data-gpc-a][data-gpc-b]');
    if (row) return { pair: { a: parseInt(row.getAttribute('data-gpc-a'), 10), b: parseInt(row.getAttribute('data-gpc-b'), 10) }, source: row.classList.contains('gpc-pair') ? 'summary' : 'table' };
    var r = t.closest('[data-gpc-res]');
    if (r) return { res: parseInt(r.getAttribute('data-gpc-res'), 10), source: 'table' };
    var s = t.closest('#snake-plot-container');
    if (s) {
      var id = (t.id || '').replace(/t$/, '');
      if (/^\d+$/.test(id)) return { res: parseInt(id, 10), source: 'snake' };
    }
    return null;
  }
  document.addEventListener('mouseover', function (ev) {
    var h = hoverFrom(ev.target);
    if (!h) { if (hoverTarget) { hoverTarget = null; hoverClear('page'); } return; }
    hoverTarget = ev.target;
    if (h.pair) hoverPair(h.pair.a, h.pair.b, h.source); else hoverResidue(h.res, h.source);
  }, { passive: true });
  document.addEventListener('mouseleave', function () { hoverTarget = null; hoverClear('page'); }, true);

  // ------------------------------------------------------------------ the selection bar
  var bar, what, actions;
  function buildBar() {
    bar = el('div', 'gpc-selbar');
    bar.id = 'gpc-selbar';
    bar.hidden = true;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Current selection');
    what = el('div', 'gpc-selbar-what');
    what.setAttribute('aria-live', 'polite');
    actions = el('div', 'gpc-selbar-actions');
    bar.appendChild(what);
    bar.appendChild(actions);
    document.body.appendChild(bar);
  }
  function button(text, title, onClick, cls) {
    var b = el('button', 'gpc-selbar-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
  function scrollTo(node) {
    if (!node || !node.scrollIntoView) return;
    // on a phone the drawer is a bottom sheet over the page: close it so the target is seen
    if (window.innerWidth <= 720 && window.ReportExtras && window.ReportExtras.close) {
      var drawer = document.getElementById('rx-drawer');
      if (drawer && !drawer.hidden) window.ReportExtras.close();
    }
    node.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  function showInTable(pos) {
    var t = document.getElementById('top-changes-table');
    if (!t) return;
    var sel = state.pair
      ? 'tr[data-gpc-a="' + state.pair.a + '"][data-gpc-b="' + state.pair.b + '"], tr[data-gpc-a="' + state.pair.b + '"][data-gpc-b="' + state.pair.a + '"]'
      : 'tr[data-gpc-a="' + pos + '"], tr[data-gpc-b="' + pos + '"]';
    var row = t.querySelector(sel);
    if (!row || row.hidden) {
      // paged out or not among the largest changes: filter the table to the residue so it is on the page
      var input = document.querySelector('[data-table-search="top-changes-table"]');
      if (input) {
        input.value = String(pos);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      row = t.querySelector(sel);
    }
    if (row && !row.hidden) scrollTo(row); else scrollTo(document.getElementById('sec-changes'));
  }
  function copyLink() {
    var url = window.location.href;
    var done = function (ok) {
      var note = bar.querySelector('.gpc-selbar-note');
      if (!note) { note = el('span', 'gpc-selbar-note'); note.setAttribute('role', 'status'); actions.appendChild(note); }
      note.textContent = ok ? 'Link copied' : 'Copy failed: ' + url;
      setTimeout(function () { note.textContent = ''; }, 2500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    else done(false);
  }

  function hideBar() {
    bar.hidden = true;
    bar.classList.remove('gpc-selbar--top');
    document.documentElement.style.setProperty('--gpc-selbar-h', '0px');
    document.documentElement.classList.remove('gpc-has-selection');
  }
  function dismissBar() {
    dismissed = true;
    if (bar) hideBar();
  }
  // The open 3D view (its pane and legend) must stay readable: when it would sit under the
  // bar's place at the bottom of the screen, the bar docks under the sticky chrome instead.
  function threeDRect() {
    var panel = document.getElementById('rx-3d-panel');
    if (!panel || panel.hidden) return null;
    var r = panel.getBoundingClientRect();
    return r.height ? r : null;
  }
  function dock() {
    if (!bar || bar.hidden) return;
    var r = threeDRect();
    var h = bar.offsetHeight + 24;
    var top = !!r && r.bottom > window.innerHeight - h && r.top < window.innerHeight;
    bar.classList.toggle('gpc-selbar--top', top);
  }
  var docking = false;
  function scheduleDock() {
    if (docking) return;
    docking = true;
    window.requestAnimationFrame(function () { docking = false; dock(); });
  }
  window.addEventListener('scroll', scheduleDock, { passive: true });
  window.addEventListener('resize', scheduleDock);
  document.addEventListener('rx:3d-state', function () { setTimeout(scheduleDock, 50); });
  document.addEventListener('gpc:3d-ready', scheduleDock);

  function paintBar() {
    if (!bar) return;
    var res = state.res, pair = state.pair;
    if (res === null || dismissed) { hideBar(); return; }
    what.textContent = '';
    actions.textContent = '';
    var r = byPos[res];
    var gn = gnOf(res), seg = segOf(res);
    if (pair) {
      var up = pair.delta >= 0;
      what.appendChild(el('span', 'gpc-selbar-kind', 'Contact'));
      what.appendChild(el('b', null, label(pair.a)));
      what.appendChild(el('span', 'gpc-selbar-arrow', '↔'));
      what.appendChild(el('b', null, label(pair.b)));
      if (!isNaN(pair.delta)) {
        what.appendChild(el('span', 'gpc-selbar-delta ' + (up ? 'is-active' : 'is-inactive'), fmtSigned(pair.delta)));
        what.appendChild(el('span', 'gpc-selbar-dir', up ? 'stronger in active' : 'stronger in inactive'));
      }
      var meta = [segOf(pair.a) || null, segOf(pair.b) || null].filter(Boolean);
      if (meta.length) what.appendChild(el('span', 'gpc-selbar-meta', meta.join(' to ')));
    } else {
      what.appendChild(el('span', 'gpc-selbar-kind', 'Residue'));
      what.appendChild(el('b', null, label(res)));
      var meta2 = [gn || null, seg || null].filter(Boolean);
      if (meta2.length) what.appendChild(el('span', 'gpc-selbar-meta', meta2.join(' · ')));
      if (r) {
        var net = r.active_minus_inactive;
        what.appendChild(el('span', 'gpc-selbar-delta ' + (net >= 0 ? 'is-active' : 'is-inactive'), 'net ' + fmtSigned(net)));
        what.appendChild(el('span', 'gpc-selbar-dir', net >= 0 ? 'stronger in active' : 'stronger in inactive'));
      }
    }
    actions.appendChild(button(pair ? 'Details' : 'Partners', 'Open the residue details with its contact partners', function () {
      // the drawer hands the selection back; it is this one, so the echo is ignored
      var was = applying;
      applying = true;
      try {
        if (window.ReportExtras && window.ReportExtras.select) window.ReportExtras.select(res, { source: 'selbar', focus: true });
      } finally { applying = was; }
      if (pair && window.ReportExtras && window.ReportExtras.markPair) window.ReportExtras.markPair(pair.b);
    }));
    if (cfg.has3d) {
      actions.appendChild(button('3D', pair ? 'Frame this contact in the 3D view' : 'Frame this residue in the 3D view', function () {
        if (pair) document.dispatchEvent(new CustomEvent('rx:focus-pair', { detail: { a: pair.a, b: pair.b } }));
        else document.dispatchEvent(new CustomEvent('rx:show3d', { detail: { pos: res } }));
      }));
    }
    actions.appendChild(button('Plot', 'Show on the snake plot', function () { scrollTo(snakeCircle(res) || document.getElementById('sec-snake')); }));
    actions.appendChild(button('Table', 'Show in the largest-changes table', function () { showInTable(res); }));
    if (gn && !pair) {
      var a = el('a', 'gpc-selbar-btn', 'All receptors');
      a.href = (cfg.search || '../search/') + '?q=' + encodeURIComponent(gn);
      a.title = 'Residues at generic position ' + gn + ' in every receptor';
      actions.appendChild(a);
    }
    actions.appendChild(button('Copy link', 'Copy a link to this selection', copyLink));
    actions.appendChild(button('Clear', 'Clear the selection everywhere', function () { clear('selbar'); }, 'gpc-selbar-clear'));
    var x = button('', 'Hide this bar (the selection stays)', dismissBar, 'gpc-selbar-close');
    x.setAttribute('aria-label', 'Hide this bar, keep the selection');
    x.textContent = '×';
    actions.appendChild(x);
    bar.hidden = false;
    document.documentElement.classList.add('gpc-has-selection');
    document.documentElement.style.setProperty('--gpc-selbar-h', (bar.offsetHeight + 8) + 'px');
    dock();
  }
  window.addEventListener('resize', function () {
    if (bar && !bar.hidden) document.documentElement.style.setProperty('--gpc-selbar-h', (bar.offsetHeight + 8) + 'px');
  });

  // ------------------------------------------------------------------ inbound events
  function foreign(d) { return d.gid && GID && d.gid !== GID; }
  document.addEventListener('gpc:select-residue', function (ev) {
    if (applying) return;
    var d = ev.detail || {};
    if (foreign(d)) return;
    if (d.res === null || d.res === undefined) clear(d.source, { external: true });
    else selectResidue(d.res, d.source || 'bus', { external: true });
  });
  document.addEventListener('gpc:select-pair', function (ev) {
    if (applying) return;
    var d = ev.detail || {};
    if (foreign(d)) return;
    if (d.a === null || d.a === undefined) clear(d.source, { external: true });
    else selectPair(d.a, d.b, d.delta, d.source || 'bus', { external: true });
  });
  document.addEventListener('gpc:hover-residue', function (ev) {
    if (applying) return;
    var d = ev.detail || {};
    if (foreign(d)) return;
    hoverResidue(d.res === undefined ? null : d.res, d.source, { external: true });
  });
  document.addEventListener('gpc:hover-pair', function (ev) {
    if (applying) return;
    var d = ev.detail || {};
    if (foreign(d)) return;
    hoverPair(d.a === undefined ? null : d.a, d.b === undefined ? null : d.b, d.source, { external: true });
  });

  // ------------------------------------------------------------------ clicks
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var chip = t.closest('.gpc-pair');
    if (chip) {
      ev.preventDefault();
      var a = parseInt(chip.getAttribute('data-gpc-a'), 10), b = parseInt(chip.getAttribute('data-gpc-b'), 10);
      if (state.pair && state.pair.a === a && state.pair.b === b) clear('summary');
      else selectPair(a, b, parseFloat(chip.getAttribute('data-gpc-delta')), 'summary');
      return;
    }
    var pick = t.closest('[data-gpc-pick]');
    if (pick) {
      selectPair(parseInt(pick.getAttribute('data-gpc-a'), 10), parseInt(pick.getAttribute('data-gpc-b'), 10),
        parseFloat(pick.getAttribute('data-gpc-delta')), 'drawer');
    }
  });

  // Escape, once the drawer is closed (the drawer takes the first one): hides the bar and
  // keeps the selection; pressed again, clears the selection everywhere.
  // Capture phase, so the order holds wherever the focus is (the snake plot has its own
  // Escape, which clears): each step that is taken here stops the event.
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    var t = ev.target;
    if (t && t.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var drawer = document.getElementById('rx-drawer');
    if (drawer && !drawer.hidden) {
      if (window.ReportExtras && window.ReportExtras.close) { window.ReportExtras.close(); ev.stopPropagation(); }
      return;
    }
    if (state.res === null) return;
    // inside the plot its own keyboard model holds: Escape clears (snake-plus.js)
    if (t && t.closest && t.closest('#snake-plot-container')) return;
    if (!dismissed && bar && !bar.hidden) { dismissBar(); ev.stopPropagation(); return; }
    clear('keyboard');
  }, true);

  // "Include loops and termini" in the summary: which "Largest changes" list is shown.
  var tails = document.getElementById('gpc-include-tails');
  if (tails) {
    var paintSets = function () {
      var core = document.getElementById('gpc-pairs-core'), all = document.getElementById('gpc-pairs-all');
      var note = document.getElementById('gpc-scope-note');
      if (core) core.hidden = tails.checked;
      if (all) all.hidden = !tails.checked;
      if (note) note.textContent = tails.checked ? ' overall' : ' in the helices';
      paintTables();
    };
    tails.addEventListener('change', paintSets);
  }

  // ------------------------------------------------------------------ public
  // Calls that arrive while this module is applying a selection are its own echo (the
  // snake plot announces the residue it was told to select, the drawer passes it on).
  window.GPCSelect = {
    select: function (pos, source) { if (!applying) selectResidue(pos, source || 'drawer'); },
    selectPair: function (a, b, delta, source) { if (!applying) selectPair(a, b, delta, source || 'drawer'); },
    clear: function (source) { if (!applying) clear(source || 'drawer'); },
    current: function () { return { res: state.res, pair: state.pair ? { a: state.pair.a, b: state.pair.b, delta: state.pair.delta } : null, dismissed: dismissed }; },
    showBar: function () { dismissed = false; paintBar(); },
    hideBar: dismissBar,
    repaint: paintTables,
    hover: function (pos, source) { hoverResidue(pos, source || 'page'); }
  };

  // ------------------------------------------------------------------ start
  function applyHash(landing) {
    var p = pairFromHash();
    if (p) {
      selectPair(p.a, p.b, undefined, 'hash');
      if (landing) {
        window.addEventListener('load', function () {
          var c = snakeCircle(p.a);
          if (c && !/sec=/.test(window.location.hash)) c.scrollIntoView({ block: 'center' });
        });
      }
      return;
    }
    var m = /(?:^#|&)res=(\d+)(?:&|$)/.exec(window.location.hash || '');
    if (m) selectResidue(parseInt(m[1], 10), 'hash');
  }

  buildBar();
  tagRows();
  hookCharts();
  var api = window.SnakeAPI;
  var cur = api && api.getSelectedResidue ? api.getSelectedResidue() : null;
  if (cur !== null && cur !== undefined && !pairFromHash()) { state.res = cur; paintAll(); }
  applyHash(true);
  window.addEventListener('hashchange', function () { applyHash(false); });
})();
