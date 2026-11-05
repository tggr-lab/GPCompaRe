/* snake-plus.js: a run-time layer over the approved snake plot of a receptor report.

   The plot itself (the SVG inside #snake-plot-container, its view buttons, the contact-link
   checkbox and its filter panel) is PI-approved content and is not changed in the built HTML.
   This module only adds to it on screen, once the plot comes near the viewport:

     - contact arcs for every above-threshold pair on the page (the RRCS table), red when the
       contact is stronger in the active model, blue when stronger in the inactive model,
       width by |dRRCS|; a hovered residue fans out its partners, a click on an arc selects
       the pair (gpc:select-pair) and every other module follows;
     - an inactive -> active scrubber: the same arcs, width by the contact's RRCS in the state
       between the two models, with a play button;
     - helix labels (TM1 to TM7, H8) and the extracellular / intracellular sides, which the
       plot does not carry; the empty margins of the SVG are trimmed on screen;
     - a "rewiring between helices" grid: how many above-threshold contacts each pair of helices
       has, and the net direction; a cell filters the arcs to that pair of helices;
     - the conserved Class A motifs (DRY, CWxP, PIF, NPxxY, sodium pocket, ionic lock) looked
       up by generic number, with this receptor's own residues at each position, and the motifs
       of the database's registry (motifs.json, carried in #rx-config as `motifs`: xMY), shown
       only when this receptor has the required residues, with the motif's own contacts;
     - an optional second colour layer as a ring around each residue (conservation,
       AlphaMissense, core functional residues) over the chosen fill view;
     - stepping through the largest changes, keyboard navigation along the chain, zoom and
       pan with a minimap (pinch on phones), screen-reader text, and export of the current
       view as SVG or PNG.

   It speaks the shared event bus (plain CustomEvents on document):
     listens  gpc:select-residue {gid, res, source}   gpc:select-pair {gid, a, b, delta, source}
              gpc:hover-residue  {gid, res, source}   gpc:hover-pair  {gid, a, b, source}
     fires    gpc:select-pair and gpc:hover-pair with source 'snake' (through window.GPCSelect
              when it exists, so the selection bar, the tables and the charts follow), and
              gpc:hover-residue only when no selection hub is on the page.
   Residue clicks keep going through the plot's own handler and SnakeAPI, as before.

   Data: everything is read from the page. Contacts come from the complete RRCS table
   (#rrcs-table: res1, aa1, res2, aa2, active RRCS, inactive RRCS, dRRCS; a .significant-row
   is above the threshold), or from a #rx-contacts JSON block when a build provides one, or
   as a last resort from the plot's own contact_links. Positions and views come from
   #snake-plot-data, segments and generic numbers from #rx-config and the SVG titles.

   Nothing is loaded from the network. The controls and the trimmed plot are laid out as soon as
   the page is parsed, so the section has its final height before anyone jumps past it; the arcs
   and marks are drawn only when the plot comes near the viewport. Without JavaScript the approved
   static plot remains. */
(function () {
  'use strict';

  var container = document.getElementById('snake-plot-container');
  var section = document.getElementById('sec-snake');
  if (!container || !section || !window.SnakeAPI) return;
  var svg = container.querySelector('svg');
  var snakeG = svg && svg.querySelector('#snake');
  if (!svg || !snakeG) return;

  var NS = 'http://www.w3.org/2000/svg';
  var SRC = 'snake';
  var reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

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
  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function btn(text, cls, title) {
    var b = el('button', 'sp-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  }
  function num(v) { var n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; }
  function fmtSigned(v) { return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var THREE = { A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile',
    L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val' };
  var SEG_ORDER = ['N-term', 'TM1', 'ICL1', 'TM2', 'ECL1', 'TM3', 'ICL2', 'TM4', 'ECL2', 'TM5', 'ICL3', 'TM6', 'ECL3', 'TM7', 'H8', 'C-term'];
  var HELICES = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'];

  // Conserved Class A motifs by Ballesteros-Weinstein number (the part before the x in the
  // GPCRdb number). The letters are the canonical ones; the plot shows what this receptor has.
  var MOTIFS = [
    { id: 'dry', name: 'DRY', canon: 'DRY', bw: ['3.49', '3.50', '3.51'], note: 'TM3 end; R3.50 is the arginine of the ionic lock' },
    { id: 'cwxp', name: 'CWxP', canon: 'CWxP', bw: ['6.47', '6.48', '6.49', '6.50'], note: 'TM6 kink; W6.48 is the toggle switch' },
    { id: 'pif', name: 'PIF', canon: 'PIF', bw: ['5.50', '3.40', '6.44'], note: 'the connector between the ligand pocket and the TM3 to TM6 core' },
    { id: 'npxxy', name: 'NPxxY', canon: 'NPxxY', bw: ['7.49', '7.50', '7.51', '7.52', '7.53'], note: 'TM7 end; Y7.53 moves towards TM3 on activation' },
    { id: 'sodium', name: 'Na+ pocket', canon: 'DSNSN', bw: ['2.50', '3.39', '7.45', '7.46', '7.49'], note: 'the sodium site of inactive receptors' },
    { id: 'lock', name: 'Ionic lock', canon: 'R..E', bw: ['3.50', '6.30'], pair: true, note: 'R3.50 to E/D6.30, closed in many inactive models' }
  ];

  // ------------------------------------------------------------------ page data
  var snakeData = readJSON('snake-plot-data') || {};
  var positions = snakeData.positions || {};
  var views = snakeData.views || {};
  var cfg = readJSON('rx-config') || {};
  var GID = cfg.gid || '';
  var segRanges = cfg.segments || {};
  // Motifs of the registry (GPCompaReports_v2/motifs.json): a chip only for a receptor that has the
  // `requires` residues at those generic numbers; `contacts` are drawn when the page lists them.
  (cfg.motifs || []).forEach(function (m) {
    if (!m || !m.id || !m.positions || MOTIFS.some(function (x) { return x.id === m.id; })) return;
    MOTIFS.push({ id: m.id, name: m.name, canon: m.name, bw: m.positions.slice(), note: m.note || '',
      requires: m.requires || null, contacts: m.contacts || [], glossary: m.glossary || '', registry: true });
  });
  var annotation = cfg.annotation || {};
  var byPos = {};
  (readJSON('residue-summary-data') || []).forEach(function (r) { byPos[r.position] = r; });
  var threshold = (function () { var x = readJSON('rx-residue-extra'); return x && typeof x.sig === 'number' ? x.sig : null; })();

  var circles = {};      // pos -> circle element
  var titleOf = {};      // pos -> 'E62 12.48x48'
  Array.prototype.forEach.call(snakeG.querySelectorAll('circle'), function (c) {
    var id = c.getAttribute('id');
    if (!id || !/^\d+$/.test(id)) return;
    circles[parseInt(id, 10)] = c;
    var t = c.querySelector('title');
    titleOf[parseInt(id, 10)] = t ? t.textContent.trim() : (c.getAttribute('original_title') || '');
  });
  function aa1(pos) {
    var r = byPos[pos];
    if (r && r.amino_acid) return r.amino_acid;
    var m = /^([A-Z])\d+/.exec(titleOf[pos] || '');
    return m ? m[1] : '';
  }
  function label(pos) { var a = aa1(pos); return (THREE[a] || a) + pos; }
  function gnOf(pos) {
    var m = /\s(\S+)$/.exec(titleOf[pos] || '');
    if (m && /\d/.test(m[1])) return m[1];
    var a = annotation[String(pos)];
    if (a && a[1]) return a[1];
    var r = byPos[pos];
    return (r && (r.display_number || r.generic_number)) || '';
  }
  function bwOf(pos) { return String(gnOf(pos)).split('x')[0]; }
  function segOf(pos) {
    var c = circles[pos];
    if (c) {
      var s = (c.getAttribute('class') || '').replace(/\b(long|short|rcircle|sp-\S+)\b/g, '').replace(/\s+/g, ' ').trim();
      if (s) return s;
    }
    var a = annotation[String(pos)];
    if (a && a[0]) return a[0];
    for (var k in segRanges) { var r = segRanges[k]; if (r && pos >= r[0] && pos <= r[1]) return k; }
    var row = byPos[pos];
    return (row && row.protein_segment) || '';
  }
  function segIndex(s) { var i = SEG_ORDER.indexOf(s); return i < 0 ? 99 : i; }
  function visible(pos) {
    var c = circles[pos];
    if (!c) return false;
    if (!/\blong\b/.test(c.getAttribute('class') || '')) return true;
    return getComputedStyle(c).display !== 'none';
  }

  // Contacts: {a, b, delta, active, inactive, passes}. One row per pair, a < b.
  function readContacts() {
    var out = [], seen = {};
    function add(a, b, d, act, inact, passes) {
      if (a === null || b === null || d === null || a === b) return;
      var lo = Math.min(a, b), hi = Math.max(a, b), k = lo + '-' + hi;
      if (seen[k]) return;
      seen[k] = true;
      out.push({ a: lo, b: hi, delta: d, active: act, inactive: inact, passes: !!passes });
    }
    // the build's block first: the above-threshold pairs with unrounded endpoint scores (the
    // tables show three decimals, so a small positive score would read back as 0); then the
    // table for every other listed pair (motif contacts below the threshold)
    var block = readJSON('rx-contacts');
    if (block && Array.isArray(block.pairs)) {
      var sig = typeof block.sig === 'number' ? block.sig : threshold;
      block.pairs.forEach(function (p) {
        var a = num(p[0]), b = num(p[1]), act = num(p[2]), inact = num(p[3]), d = num(p[4]);
        if (d === null && act !== null && inact !== null) d = act - inact;
        add(a, b, d, act, inact, p.length > 5 ? !!p[5] : (sig !== null && Math.abs(d) >= sig - 1e-9));
      });
    }
    var table = document.getElementById('rrcs-table');
    if (table && table.tBodies[0]) {
      Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
        var c = row.cells;
        if (c.length < 7) return;
        add(num(parseInt(c[0].textContent, 10)), num(parseInt(c[2].textContent, 10)), num(c[6].textContent),
            num(c[4].textContent), num(c[5].textContent), row.classList.contains('significant-row'));
      });
    }
    if (out.length) return out;
    (snakeData.contact_links || []).forEach(function (l) { add(num(l.from_seq), num(l.to_seq), num(l.delta), null, null, true); });
    return out;
  }
  var contacts = readContacts();
  var passing = contacts.filter(function (c) { return c.passes; });
  var byRes = {};
  passing.forEach(function (c) { (byRes[c.a] = byRes[c.a] || []).push(c); (byRes[c.b] = byRes[c.b] || []).push(c); });
  var pairIndex = {};
  contacts.forEach(function (c) { pairIndex[c.a + '-' + c.b] = c; });
  function contactOf(a, b) { return pairIndex[Math.min(a, b) + '-' + Math.max(a, b)] || null; }

  var absMax = passing.reduce(function (m, c) { return Math.max(m, Math.abs(c.delta)); }, 0);
  var absMin = passing.reduce(function (m, c) { return Math.min(m, Math.abs(c.delta)); }, absMax);
  // the lower end of the |dRRCS| range is the page's threshold, the number the page states
  // ("|dRRCS| >= 1.97"), not the smallest change that happens to pass it
  if (threshold !== null && threshold > 0 && threshold <= absMin) absMin = threshold;
  var stateMax = passing.reduce(function (m, c) {
    return Math.max(m, c.active === null ? 0 : c.active, c.inactive === null ? 0 : c.inactive);
  }, 0);
  var hasStates = passing.some(function (c) { return c.active !== null && c.inactive !== null; });

  // ------------------------------------------------------------------ state
  var S = {
    inited: false,
    arcs: true,                 // the contact-link checkbox
    mode: 'delta',              // 'delta' | 'state'
    t: 0,                       // state scrubber, 0 = inactive model, 1 = active model
    magMin: absMin, magMax: absMax, dir: 'both',
    segFilter: null,            // ['TM3', 'TM6'] from the rewiring grid, or 'loops'
    top: 0,                     // 0 = all, else the n largest
    labels: true,
    ring: 'none',
    motifs: {},                 // id -> true
    sel: { res: null, pair: null },
    hover: { res: null, pair: null },
    kbd: null,
    zoom: 1, cx: 0, cy: 0,      // view centre in fitted-box coordinates
    tour: -1
  };
  var pendingBus = [];          // bus events that arrived before init

  // ------------------------------------------------------------------ geometry
  var ty = (function () { var m = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)/.exec(snakeG.getAttribute('transform') || ''); return m ? parseFloat(m[2]) : 0; })();
  var tx = (function () { var m = /translate\(\s*([-\d.]+)/.exec(snakeG.getAttribute('transform') || ''); return m ? parseFloat(m[1]) : 0; })();
  var originalViewBox = svg.getAttribute('viewBox');
  // The build fits the viewBox to the collapsed plot and bakes the helix labels in (2026-11-05):
  // the layer keeps that box as the floor of every refit and reuses the baked labels.
  var bakedLabels = snakeG.querySelector('g.snake-helix-labels');
  var builtBox = (function () {
    var v = (originalViewBox || '').trim().split(/[\s,]+/).map(parseFloat);
    if (v.length !== 4 || v.some(isNaN) || (v[0] === 0 && v[1] === 0)) return null;
    return { x: v[0], y: v[1], w: v[2], h: v[3] };
  })();
  var originalSize = { w: parseFloat(svg.getAttribute('width')) || 0, h: parseFloat(svg.getAttribute('height')) || 0 };
  var fitBox = null;            // {x, y, w, h} in SVG user units, after trimming the margins
  var helixBox = {};            // seg -> {minX, maxX, minY, maxY, cx}

  function pointOf(pos) {
    var p = positions[String(pos)];
    if (p) return { x: p[0], y: p[1] };
    var c = circles[pos];
    return c ? { x: parseFloat(c.getAttribute('cx')), y: parseFloat(c.getAttribute('cy')) } : null;
  }
  function helixBoxes() {
    helixBox = {};
    for (var pos in circles) {
      pos = parseInt(pos, 10);
      if (!visible(pos)) continue;
      var s = segOf(pos), p = pointOf(pos);
      if (!p) continue;
      var b = helixBox[s] || (helixBox[s] = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, n: 0 });
      b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
      b.minY = Math.min(b.minY, p.y); b.maxY = Math.max(b.maxY, p.y); b.n++;
    }
    for (var k in helixBox) helixBox[k].cx = (helixBox[k].minX + helixBox[k].maxX) / 2;
  }

  var under = svgEl('g', { id: 'sp-under', 'class': 'sp-under' });
  var over = svgEl('g', { id: 'sp-over', 'class': 'sp-over' });
  var arcsG = svgEl('g', { id: 'sp-arcs', 'class': 'sp-arcs' });
  var labelsG = svgEl('g', { id: 'sp-labels', 'class': 'sp-labels' });
  var ringsG = svgEl('g', { id: 'sp-rings', 'class': 'sp-rings' });
  var motifsG = svgEl('g', { id: 'sp-motifs', 'class': 'sp-motifs' });
  var marksG = svgEl('g', { id: 'sp-marks', 'class': 'sp-marks' });
  under.appendChild(arcsG);
  over.appendChild(ringsG); over.appendChild(motifsG); over.appendChild(labelsG); over.appendChild(marksG);

  function mount() {
    var firstCircle = snakeG.querySelector('circle');
    if (firstCircle) snakeG.insertBefore(under, firstCircle); else snakeG.appendChild(under);
    snakeG.appendChild(over);
  }

  // Trim the SVG's empty margins on screen: the viewBox follows the drawn content.
  function fit() {
    var b;
    try { b = snakeG.getBBox(); } catch (e) { b = null; }
    if ((!b || !b.width) && !builtBox) return;
    var pad = 16;
    var box = b && b.width ? { x: b.x + tx - pad, y: b.y + ty - pad, w: b.width + 2 * pad, h: b.height + 2 * pad } : builtBox;
    if (builtBox) {
      // never smaller than the built box (it already holds the collapsed plot and its labels)
      var x0 = Math.min(builtBox.x, box.x), y0 = Math.min(builtBox.y, box.y);
      var x1 = Math.max(builtBox.x + builtBox.w, box.x + box.w), y1 = Math.max(builtBox.y + builtBox.h, box.y + box.h);
      box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    fitBox = box;
    applyView();
  }
  function applyView() {
    if (!fitBox) return;
    var z = S.zoom, w = fitBox.w / z, h = fitBox.h / z;
    var cx = S.zoom > 1 ? clamp(S.cx, fitBox.x + w / 2, fitBox.x + fitBox.w - w / 2) : fitBox.x + fitBox.w / 2;
    var cy = S.zoom > 1 ? clamp(S.cy, fitBox.y + h / 2, fitBox.y + fitBox.h - h / 2) : fitBox.y + fitBox.h / 2;
    S.cx = cx; S.cy = cy;
    svg.setAttribute('viewBox', (cx - w / 2).toFixed(1) + ' ' + (cy - h / 2).toFixed(1) + ' ' + w.toFixed(1) + ' ' + h.toFixed(1));
    if (originalSize.w) svg.setAttribute('height', (originalSize.w * h / w).toFixed(1));
    container.classList.toggle('sp-zoomed', S.zoom > 1.001);
    updateMinimap();
  }

  // ------------------------------------------------------------------ arcs
  var arcEls = {};              // 'a-b' -> path
  function arcPath(c) {
    var p1 = pointOf(c.a), p2 = pointOf(c.b);
    if (!p1 || !p2) return null;
    var sa = segOf(c.a), sb = segOf(c.b);
    var dx = p2.x - p1.x, dy = p2.y - p1.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (sa === sb && Math.abs(c.b - c.a) <= 5 && helixBox[sa]) {
      // within one helix: a small bow outside the column, so it is not hidden under the circles
      var side = (p1.x + p2.x) / 2 >= helixBox[sa].cx ? 1 : -1;
      var mx = (p1.x + p2.x) / 2 + side * (22 + dist * 0.2), my = (p1.y + p2.y) / 2;
      return 'M' + p1.x + ',' + p1.y + ' Q' + mx.toFixed(1) + ',' + my.toFixed(1) + ' ' + p2.x + ',' + p2.y;
    }
    // between helices: a chord that sags away from the residue rows, towards the nearer membrane side
    var midY = (p1.y + p2.y) / 2;
    var bodyMid = fitBox ? fitBox.y - ty + fitBox.h / 2 : 200;
    var sign = midY > bodyMid ? 1 : -1;
    var sag = clamp(Math.abs(dx) * 0.22 + 24, 28, 150);
    var nx = -dy / (dist || 1), ny = dx / (dist || 1);
    if (ny * sign < 0) { nx = -nx; ny = -ny; }
    var cx1 = (p1.x + p2.x) / 2 + nx * sag, cy1 = midY + ny * sag;
    return 'M' + p1.x + ',' + p1.y + ' Q' + cx1.toFixed(1) + ',' + cy1.toFixed(1) + ' ' + p2.x + ',' + p2.y;
  }
  function widthDelta(c) {
    if (absMax <= absMin) return 2.2;
    return 1 + 3.6 * (Math.abs(c.delta) - absMin) / (absMax - absMin);
  }
  function strengthAt(c, t) {
    if (c.active === null || c.inactive === null) return null;
    return c.inactive + (c.active - c.inactive) * t;
  }
  function widthState(c) {
    var s = strengthAt(c, S.t);
    if (s === null) return widthDelta(c);
    return stateMax > 0 ? 0.6 + 4.4 * (Math.max(0, s) / stateMax) : 2;
  }
  // a contact is drawn whenever its score is positive, however small; only a score of zero (no
  // contact in that model) leaves the dashed trace
  function absentAt(c, t) { var s = strengthAt(c, t); return s !== null && s <= 0; }
  function filtered() {
    var list = passing.filter(function (c) {
      var ad = Math.abs(c.delta);
      if (ad < S.magMin - 1e-9 || ad > S.magMax + 1e-9) return false;
      if (S.dir === 'active' && c.delta < 0) return false;
      if (S.dir === 'inactive' && c.delta > 0) return false;
      if (S.segFilter) {
        var sa = segOf(c.a), sb = segOf(c.b);
        if (S.segFilter === 'loops') { if (HELICES.indexOf(sa) >= 0 && HELICES.indexOf(sb) >= 0) return false; }
        else if (!((sa === S.segFilter[0] && sb === S.segFilter[1]) || (sa === S.segFilter[1] && sb === S.segFilter[0]))) return false;
      }
      return visible(c.a) && visible(c.b);
    });
    list.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
    if (S.top > 0) list = list.slice(0, S.top);
    return list;
  }
  var shown = [];
  function drawArcs() {
    while (arcsG.firstChild) arcsG.removeChild(arcsG.firstChild);
    arcEls = {};
    shown = S.arcs ? filtered() : [];
    // thin arcs last so the wide ones do not bury them
    shown.slice().reverse().forEach(function (c) {
      var d = arcPath(c);
      if (!d) return;
      var p = svgEl('path', { d: d, 'class': 'sp-arc ' + (c.delta >= 0 ? 'is-active' : 'is-inactive'),
        'data-a': c.a, 'data-b': c.b, 'data-delta': c.delta, tabindex: '-1' });
      p.setAttribute('stroke-width', (S.mode === 'state' ? widthState(c) : widthDelta(c)).toFixed(2));
      if (S.mode === 'state' && absentAt(c, S.t)) p.classList.add('is-absent');
      var t = svgEl('title');
      t.textContent = label(c.a) + (gnOf(c.a) ? ' ' + gnOf(c.a) : '') + ' to ' + label(c.b) + (gnOf(c.b) ? ' ' + gnOf(c.b) : '') +
        ', dRRCS ' + fmtSigned(c.delta) + (c.delta >= 0 ? ', stronger in the active model' : ', stronger in the inactive model') +
        (c.active !== null ? ' (active ' + c.active.toFixed(2) + ', inactive ' + c.inactive.toFixed(2) + ')' : '');
      p.appendChild(t);
      arcsG.appendChild(p);
      arcEls[c.a + '-' + c.b] = p;
    });
    paintMarks();
    updateSummary();
  }
  function restyleArcs() {
    // scrubber moves: widths only, no re-layout
    shown.forEach(function (c) {
      var p = arcEls[c.a + '-' + c.b];
      if (!p) return;
      p.setAttribute('stroke-width', (S.mode === 'state' ? widthState(c) : widthDelta(c)).toFixed(2));
      p.classList.toggle('is-absent', S.mode === 'state' && absentAt(c, S.t));
    });
    updateSummary();
  }
  function updateSummary() {
    var sum = document.getElementById('snake-filter-summary');
    var n = shown.length, total = passing.length;
    var hidden = passing.filter(function (c) { return !(visible(c.a) && visible(c.b)); }).length;
    var text = n + ' of ' + total + ' above-threshold contact' + (total === 1 ? '' : 's') + ' shown' +
      (hidden && S.arcs ? ' (' + hidden + ' in collapsed loops or termini)' : '');
    if (sum) sum.textContent = S.arcs ? text : '';
    if (ui.count) {
      if (!S.arcs) ui.count.textContent = '';
      else if (S.mode === 'state') {
        var present = shown.filter(function (c) { return strengthAt(c, S.t) !== null && !absentAt(c, S.t); }).length;
        ui.count.textContent = present + ' of ' + n + ' present';
      } else ui.count.textContent = n + ' of ' + total;
    }
    if (ui.tourLabel) {
      var list = tourList();
      ui.tourLabel.textContent = (S.tour >= 0 && list.length ? (S.tour + 1) : 0) + ' of ' + list.length;
      ui.tourPrev.disabled = ui.tourNext.disabled = !list.length;
    }
  }

  // ------------------------------------------------------------------ helix labels and sides
  function drawLabels() {
    while (labelsG.firstChild) labelsG.removeChild(labelsG.firstChild);
    labelsG.style.display = S.labels ? '' : 'none';
    if (bakedLabels) {
      // the plot carries its own labels: the toggle shows or hides those, nothing is drawn twice
      bakedLabels.style.display = S.labels ? '' : 'none';
      return;
    }
    if (!S.labels) return;
    var topY = 1e9, botY = -1e9, maxX = -1e9;
    for (var k in helixBox) { topY = Math.min(topY, helixBox[k].minY); botY = Math.max(botY, helixBox[k].maxY); maxX = Math.max(maxX, helixBox[k].maxX); }
    HELICES.forEach(function (seg) {
      var b = helixBox[seg];
      if (!b) return;
      var r = segRanges[seg];
      var gnFirst = r ? bwOf(r[0]) : '', gnLast = r ? bwOf(r[1]) : '';
      var y = b.minY - 21, x = b.cx;
      var g = svgEl('g', { 'class': 'sp-helix-label', 'data-seg': seg, transform: 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')' });
      var w = seg.length * 7 + 10;
      g.appendChild(svgEl('rect', { x: -w / 2, y: -8, width: w, height: 15, rx: 3 }));
      var t = svgEl('text', { x: 0, y: 3.5, 'text-anchor': 'middle' });
      t.textContent = seg;
      g.appendChild(t);
      var tt = svgEl('title');
      tt.textContent = seg + (r ? ': residues ' + r[0] + ' to ' + r[1] : '') + (gnFirst && gnLast ? ' (' + gnFirst + ' to ' + gnLast + ')' : '');
      g.appendChild(tt);
      labelsG.appendChild(g);
    });
    // the membrane sides, written up the left margin beside TM1
    var left = (helixBox.TM1 ? helixBox.TM1.minX : 32) - 24;
    var ec = svgEl('text', { x: left, y: topY + 96, 'class': 'sp-side', 'text-anchor': 'start', transform: 'rotate(-90 ' + left + ' ' + (topY + 96) + ')' });
    ec.textContent = 'extracellular side';
    var icY = Math.max(botY - 96, topY + 110);
    var ic = svgEl('text', { x: left, y: icY, 'class': 'sp-side', 'text-anchor': 'end', transform: 'rotate(-90 ' + left + ' ' + icY + ')' });
    ic.textContent = 'intracellular side';
    labelsG.appendChild(ec); labelsG.appendChild(ic);
  }

  // ------------------------------------------------------------------ ring layer
  function drawRings() {
    while (ringsG.firstChild) ringsG.removeChild(ringsG.firstChild);
    var v = views[S.ring];
    if (!v || !v.colors) return;
    for (var pos in v.colors) {
      var p = pointOf(parseInt(pos, 10));
      if (!p || !visible(parseInt(pos, 10))) continue;
      ringsG.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 15, 'class': 'sp-ring', stroke: v.colors[pos], 'data-pos': pos }));
    }
  }
  function ringLegend() {
    if (!ui.ringLegend) return;
    ui.ringLegend.textContent = '';
    var v = views[S.ring];
    if (!v) return;
    if (v.legend_type === 'categorical') {
      (v.legend_items || []).forEach(function (it) {
        var s = el('span', 'sp-key');
        var dot = el('span', 'sp-key-ring'); dot.style.borderColor = it.color;
        s.appendChild(dot); s.appendChild(document.createTextNode(it.label));
        ui.ringLegend.appendChild(s);
      });
    } else if (v.legend_colors) {
      var g = el('span', 'sp-key-grad');
      g.style.background = 'linear-gradient(to right,' + v.legend_colors.join(',') + ')';
      ui.ringLegend.appendChild(el('span', 'sp-key-lab', (v.legend_labels || [])[0] || ''));
      ui.ringLegend.appendChild(g);
      ui.ringLegend.appendChild(el('span', 'sp-key-lab', (v.legend_labels || []).slice(-1)[0] || ''));
    }
  }

  // ------------------------------------------------------------------ motifs
  var bwIndex = null;
  function bwLookup(bw) {
    if (!bwIndex) {
      bwIndex = {};
      for (var pos in circles) { var k = bwOf(parseInt(pos, 10)); if (k && /^\d+\.\d+$/.test(k) && !bwIndex[k]) bwIndex[k] = parseInt(pos, 10); }
    }
    return bwIndex[bw] || null;
  }
  function motifResidues(m) { return m.bw.map(function (bw) { return { bw: bw, pos: bwLookup(bw) }; }); }
  // a registry motif: does this receptor have the required residue at each generic number?
  function motifCarried(m) {
    if (!m.requires) return true;
    for (var bw in m.requires) { var p = bwLookup(bw); if (!p || aa1(p) !== m.requires[bw]) return false; }
    return true;
  }
  // a registry motif's own contacts that the page lists: [{a, b, bwA, bwB, c}]
  function motifContacts(m) {
    var out = [];
    (m.contacts || []).forEach(function (pr) {
      var a = bwLookup(pr[0]), b = bwLookup(pr[1]);
      var c = a && b ? contactOf(a, b) : null;
      if (c) out.push({ a: a, b: b, bwA: pr[0], bwB: pr[1], c: c });
    });
    return out;
  }
  function drawMotifs() {
    while (motifsG.firstChild) motifsG.removeChild(motifsG.firstChild);
    var keep = {};
    var any = false;
    MOTIFS.forEach(function (m) {
      if (!S.motifs[m.id]) return;
      var res = motifResidues(m).filter(function (r) { return r.pos && visible(r.pos); });
      if (!res.length) return;
      any = true;
      if (m.pair && res.length === 2) {
        var p1 = pointOf(res[0].pos), p2 = pointOf(res[1].pos);
        var line = svgEl('path', { d: 'M' + p1.x + ',' + p1.y + ' L' + p2.x + ',' + p2.y, 'class': 'sp-motif-link' });
        motifsG.appendChild(line);
      }
      res.forEach(function (r) {
        keep[r.pos] = true;
        var p = pointOf(r.pos);
        var g = svgEl('g', { 'class': 'sp-motif', 'data-motif': m.id, 'data-pos': r.pos });
        g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 16 }));
        var below = res.indexOf(r) % 2 === 1;
        var tag = svgEl('text', { x: p.x + 13, y: below ? p.y + 20 : p.y - 12, 'class': 'sp-motif-tag' });
        tag.textContent = r.bw;
        g.appendChild(tag);
        motifsG.appendChild(g);
      });
      // the motif's own contacts, coloured by the sign of the change; the partner outside the motif is kept too
      motifContacts(m).forEach(function (k) {
        if (!visible(k.a) || !visible(k.b)) return;
        var p1 = pointOf(k.a), p2 = pointOf(k.b);
        motifsG.appendChild(svgEl('path', { d: 'M' + p1.x + ',' + p1.y + ' L' + p2.x + ',' + p2.y,
          'class': 'sp-motif-link sp-motif-contact ' + (k.c.delta >= 0 ? 'is-active' : 'is-inactive'),
          'data-motif': m.id, 'data-pair': k.bwA + '-' + k.bwB }));
        [k.a, k.b].forEach(function (pos) {
          if (keep[pos]) return;
          keep[pos] = true;
          var p = pointOf(pos);
          var g = svgEl('g', { 'class': 'sp-motif-partner', 'data-motif': m.id, 'data-pos': pos });
          g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 16 }));
          var tag = svgEl('text', { x: p.x + 13, y: p.y - 12, 'class': 'sp-motif-tag' });
          tag.textContent = bwOf(pos);
          g.appendChild(tag);
          motifsG.appendChild(g);
        });
      });
    });
    dimTo(any ? keep : null, 'sp-dim-motif');
  }
  function motifText(m) {
    var parts = motifResidues(m).map(function (r) { return r.pos ? aa1(r.pos) + r.pos : '(' + r.bw + ' absent)'; });
    return parts.join(' ');
  }

  // dim everything except `keep` (pos -> true); null restores. One class per reason.
  var dimClasses = {};
  function dimTo(keep, cls) {
    dimClasses[cls] = keep;
    var merged = null;
    for (var k in dimClasses) if (dimClasses[k]) { merged = merged || {}; for (var p in dimClasses[k]) merged[p] = true; }
    svg.classList.toggle('sp-dim', !!merged);
    for (var pos in circles) {
      var on = !!(merged && merged[pos]);
      circles[pos].classList.toggle('sp-keep', on);
      var t = document.getElementById(pos + 't');
      if (t) t.classList.toggle('sp-keep', on);
    }
  }

  // ------------------------------------------------------------------ selection and hover marks
  function ring(pos, cls) {
    var p = pointOf(pos);
    if (!p || !visible(pos)) return null;
    return svgEl('circle', { cx: p.x, cy: p.y, r: 16.5, 'class': 'sp-mark ' + cls, 'data-pos': pos });
  }
  function callout(pos, text, side) {
    var p = pointOf(pos);
    if (!p) return null;
    var g = svgEl('g', { 'class': 'sp-callout', transform: 'translate(' + (p.x + side * 20) + ',' + (p.y - 16) + ')' });
    var w = text.length * 5.6 + 8;
    g.appendChild(svgEl('rect', { x: side < 0 ? -w : 0, y: -7, width: w, height: 14, rx: 3 }));
    var t = svgEl('text', { x: side < 0 ? -4 : 4, y: 3.5, 'text-anchor': side < 0 ? 'end' : 'start' });
    t.textContent = text;
    g.appendChild(t);
    return g;
  }
  function paintMarks() {
    while (marksG.firstChild) marksG.removeChild(marksG.firstChild);
    var sel = S.sel, hov = S.hover;
    var hot = {}, keep = null;
    var focusRes = hov.res !== null ? hov.res : (sel.pair ? null : sel.res);
    var focusPair = hov.pair || sel.pair;
    if (focusPair) { hot[Math.min(focusPair.a, focusPair.b) + '-' + Math.max(focusPair.a, focusPair.b)] = true; }
    else if (focusRes !== null) (byRes[focusRes] || []).forEach(function (c) { hot[c.a + '-' + c.b] = true; });
    var anyHot = false;
    for (var k in arcEls) {
      var on = !!hot[k];
      arcEls[k].classList.toggle('is-hot', on);
      if (on) anyHot = true;
    }
    svg.classList.toggle('sp-focus', anyHot || !!focusPair || focusRes !== null);
    // rings
    if (sel.pair) {
      var ra = ring(sel.pair.a, 'sp-sel'), rb = ring(sel.pair.b, 'sp-sel sp-sel-b');
      if (ra) marksG.appendChild(ra);
      if (rb) marksG.appendChild(rb);
    } else if (sel.res !== null) {
      var r0 = ring(sel.res, 'sp-sel');
      if (r0) marksG.appendChild(r0);
      (byRes[sel.res] || []).forEach(function (c) {
        var other = c.a === sel.res ? c.b : c.a;
        if (!arcEls[c.a + '-' + c.b]) return;
        var rp = ring(other, 'sp-partner ' + (c.delta >= 0 ? 'is-active' : 'is-inactive'));
        if (rp) marksG.appendChild(rp);
      });
    }
    if (hov.pair && !(sel.pair && sel.pair.a === hov.pair.a && sel.pair.b === hov.pair.b)) {
      var ha = ring(hov.pair.a, 'sp-hov'), hb = ring(hov.pair.b, 'sp-hov');
      if (ha) marksG.appendChild(ha);
      if (hb) marksG.appendChild(hb);
    } else if (hov.res !== null && hov.res !== sel.res) {
      var hr = ring(hov.res, 'sp-hov');
      if (hr) marksG.appendChild(hr);
      (byRes[hov.res] || []).forEach(function (c) {
        if (!arcEls[c.a + '-' + c.b]) return;
        var rp2 = ring(c.a === hov.res ? c.b : c.a, 'sp-partner ' + (c.delta >= 0 ? 'is-active' : 'is-inactive'));
        if (rp2) marksG.appendChild(rp2);
      });
    }
    if (S.kbd !== null) { var rk = ring(S.kbd, 'sp-kbd'); if (rk) marksG.appendChild(rk); }
    // partner callouts for a selected residue: its partners above the threshold, with the change
    if (sel.res !== null && !sel.pair && hov.res === null && !hov.pair) {
      var list = (byRes[sel.res] || []).filter(function (c) { return arcEls[c.a + '-' + c.b]; });
      list.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
      var p0 = pointOf(sel.res);
      var placed = [];   // {side, y} of the callouts so far, to keep them from stacking on each other
      list.slice(0, 8).forEach(function (c) {
        var other = c.a === sel.res ? c.b : c.a, p = pointOf(other);
        if (!p || !p0) return;
        var side = p.x >= p0.x ? 1 : -1;
        var gn = gnOf(other);
        var co = callout(other, aa1(other) + other + (gn ? ' ' + gn : '') + ' ' + fmtSigned(c.delta), side);
        if (!co) return;
        var y = p.y - 16, guard = 0;
        while (guard++ < 12 && placed.some(function (q) { return q.side === side && Math.abs(q.y - y) < 15 && Math.abs(q.x - p.x) < 150; })) y += 15;
        placed.push({ side: side, y: y, x: p.x });
        co.setAttribute('transform', 'translate(' + (p.x + side * 20) + ',' + y + ')');
        co.classList.add(c.delta >= 0 ? 'is-active' : 'is-inactive');
        marksG.appendChild(co);
      });
    }
    // dim the rest while a residue or pair is in focus and arcs are on
    if (S.arcs && (focusPair || (focusRes !== null && anyHot))) {
      keep = {};
      if (focusPair) { keep[focusPair.a] = true; keep[focusPair.b] = true; }
      else { keep[focusRes] = true; (byRes[focusRes] || []).forEach(function (c) { keep[c.a] = true; keep[c.b] = true; }); }
    }
    dimTo(keep, 'sp-dim-focus');
  }

  // ------------------------------------------------------------------ the bus
  function foreign(d) { return d && d.gid && GID && d.gid !== GID; }
  function onBus(name, d) {
    if (!S.inited) { pendingBus.push([name, d]); return; }
    if (foreign(d)) return;
    if (name === 'gpc:select-residue') {
      S.sel = (d.res === null || d.res === undefined) ? { res: null, pair: null } : { res: num(d.res), pair: null };
      S.tour = -1;
    } else if (name === 'gpc:select-pair') {
      var a = num(d.a), b = num(d.b);
      S.sel = (a === null || b === null) ? { res: null, pair: null } : { res: a, pair: { a: a, b: b, delta: num(d.delta) } };
      if (S.sel.pair) { var i = tourIndexOf(a, b); S.tour = i; }
    } else if (name === 'gpc:hover-residue') {
      S.hover = { res: (d.res === null || d.res === undefined) ? null : num(d.res), pair: null };
    } else if (name === 'gpc:hover-pair') {
      var ha = num(d.a), hb = num(d.b);
      S.hover = (ha === null || hb === null) ? { res: null, pair: null } : { res: null, pair: { a: ha, b: hb } };
    }
    paintMarks();
    announce();
    if (name === 'gpc:select-pair' || name === 'gpc:select-residue') updateSummary();
  }
  ['gpc:select-residue', 'gpc:select-pair', 'gpc:hover-residue', 'gpc:hover-pair'].forEach(function (n) {
    document.addEventListener(n, function (ev) { onBus(n, ev.detail || {}); });
  });
  function fire(name, detail) {
    detail.gid = GID; detail.source = SRC;
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }
  function selectPair(a, b, delta) {
    var hub = window.GPCSelect;
    if (hub && hub.selectPair) hub.selectPair(a, b, delta, SRC);
    else { S.sel = { res: a, pair: { a: a, b: b, delta: delta } }; paintMarks(); fire('gpc:select-pair', { a: a, b: b, delta: delta }); }
  }
  function selectResidue(pos) {
    if (window.GPCSelect && window.GPCSelect.select) window.GPCSelect.select(pos, SRC);
    else if (window.SnakeAPI.selectResidue) { window.SnakeAPI.selectResidue(pos); S.sel = { res: pos, pair: null }; paintMarks(); fire('gpc:select-residue', { res: pos }); }
  }
  function clearSelection() {
    if (window.GPCSelect && window.GPCSelect.clear) window.GPCSelect.clear(SRC);
    else { S.sel = { res: null, pair: null }; paintMarks(); fire('gpc:select-residue', { res: null }); }
  }
  function hoverPair(a, b) {
    fire('gpc:hover-pair', { a: a, b: b });
    if (!window.GPCSelect) { S.hover = a === null ? { res: null, pair: null } : { res: null, pair: { a: a, b: b } }; paintMarks(); }
  }

  // arcs: hover and click
  arcsG.addEventListener('mouseover', function (ev) {
    var p = ev.target.closest ? ev.target.closest('.sp-arc') : null;
    if (!p) return;
    hoverPair(parseInt(p.getAttribute('data-a'), 10), parseInt(p.getAttribute('data-b'), 10));
  });
  arcsG.addEventListener('mouseout', function (ev) {
    var p = ev.target.closest ? ev.target.closest('.sp-arc') : null;
    if (!p) return;
    var to = ev.relatedTarget;
    if (to && to.closest && to.closest('.sp-arc') === p) return;
    hoverPair(null, null);
  });
  arcsG.addEventListener('click', function (ev) {
    var p = ev.target.closest ? ev.target.closest('.sp-arc') : null;
    if (!p) return;
    ev.stopPropagation();
    var a = parseInt(p.getAttribute('data-a'), 10), b = parseInt(p.getAttribute('data-b'), 10), d = parseFloat(p.getAttribute('data-delta'));
    if (S.sel.pair && S.sel.pair.a === a && S.sel.pair.b === b) clearSelection(); else selectPair(a, b, d);
  });
  // residue hover when no selection hub is on the page (otherwise report-select.js fires it)
  container.addEventListener('mouseover', function (ev) {
    if (window.GPCSelect) return;
    var id = (ev.target.id || '').replace(/t$/, '');
    if (!/^\d+$/.test(id)) return;
    S.hover = { res: parseInt(id, 10), pair: null }; paintMarks();
    fire('gpc:hover-residue', { res: parseInt(id, 10) });
  });
  container.addEventListener('mouseout', function (ev) {
    if (window.GPCSelect) return;
    var id = (ev.target.id || '').replace(/t$/, '');
    if (!/^\d+$/.test(id)) return;
    S.hover = { res: null, pair: null }; paintMarks();
    fire('gpc:hover-residue', { res: null });
  });

  // ------------------------------------------------------------------ legacy controls (the approved checkbox and filter panel)
  // the checkbox, the approved filter panel and the section class; the panel takes space, so this
  // runs in the eager phase too, before the arcs themselves are drawn
  function setArcsChrome(show) {
    S.arcs = !!show;
    var cb = document.getElementById('snake-links-cb');
    if (cb) cb.checked = S.arcs;
    var panel = document.getElementById('snake-filter-panel');
    if (panel) { if (S.arcs) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); }
    section.classList.toggle('sp-arcs-on', S.arcs);
  }
  function setArcs(show) {
    setArcsChrome(show);
    drawArcs();
  }
  function setDirection(dir) {
    S.dir = dir === 'active' || dir === 'inactive' ? dir : 'both';
    document.querySelectorAll('.snake-dir-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.dir === S.dir); });
    drawArcs();
  }
  function setMagRange(lo, hi) {
    var minS = document.getElementById('snake-mag-min'), maxS = document.getElementById('snake-mag-max');
    if (typeof lo === 'number' && !isNaN(lo)) S.magMin = clamp(lo, absMin, absMax);
    if (typeof hi === 'number' && !isNaN(hi)) S.magMax = clamp(hi, absMin, absMax);
    if (S.magMin > S.magMax) S.magMin = S.magMax;
    if (minS) minS.value = String(S.magMin);
    if (maxS) maxS.value = String(S.magMax);
    var a = document.getElementById('snake-mag-min-val'), b = document.getElementById('snake-mag-max-val');
    if (a) a.textContent = S.magMin.toFixed(2);
    if (b) b.textContent = S.magMax.toFixed(2);
    drawArcs();
  }
  function wireLegacy() {
    var api = window.SnakeAPI;
    var origState = api.getState;
    // A link (#min=, #max=, #dir=) is applied to the approved plot before this layer starts:
    // carry those filters over instead of starting from the defaults.
    try {
      var prev = origState ? origState() : null, lb = api.bounds ? api.bounds() : null;
      if (prev && lb) {
        if (typeof prev.min === 'number' && prev.min > lb.lo + 1e-9) S.magMin = clamp(prev.min, absMin, absMax);
        if (typeof prev.max === 'number' && prev.max < lb.hi - 1e-9) S.magMax = clamp(prev.max, absMin, absMax);
        if (S.magMin > S.magMax) S.magMin = S.magMax;
      }
      if (prev && (prev.dir === 'active' || prev.dir === 'inactive')) S.dir = prev.dir;
    } catch (e) { /* keep the defaults */ }
    window.toggleSnakeLinks = setArcs;
    api.setLinksVisible = setArcs;
    api.setDirection = setDirection;
    api.setMagRange = setMagRange;
    api.bounds = function () { return { lo: absMin, hi: absMax }; };
    api.getState = function () {
      var s = origState ? origState() : {};
      s.min = S.magMin; s.max = S.magMax; s.dir = S.dir; s.links = S.arcs;
      return s;
    };
    api.plus = PUBLIC;
    var minS = document.getElementById('snake-mag-min'), maxS = document.getElementById('snake-mag-max');
    [minS, maxS].forEach(function (sl) {
      if (!sl) return;
      sl.min = String(absMin); sl.max = String(absMax); sl.step = '0.01';
    });
    if (minS) { minS.value = String(S.magMin); minS.addEventListener('input', function () { setMagRange(parseFloat(minS.value), S.magMax < parseFloat(minS.value) ? parseFloat(minS.value) : undefined); }); }
    if (maxS) { maxS.value = String(S.magMax); maxS.addEventListener('input', function () { setMagRange(S.magMin > parseFloat(maxS.value) ? parseFloat(maxS.value) : undefined, parseFloat(maxS.value)); }); }
    document.querySelectorAll('.snake-dir-btn').forEach(function (b) { b.addEventListener('click', function () { setDirection(b.dataset.dir); }); });
    document.querySelectorAll('.snake-dir-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.dir === S.dir); });
    var reset = document.getElementById('snake-filter-reset');
    if (reset) reset.addEventListener('click', function () { S.segFilter = null; S.top = 0; if (ui.top) ui.top.value = '0'; setMagRange(absMin, absMax); setDirection('both'); paintGrid(); });
    var a = document.getElementById('snake-mag-min-val'), b = document.getElementById('snake-mag-max-val');
    if (a) a.textContent = S.magMin.toFixed(2);
    if (b) b.textContent = S.magMax.toFixed(2);
    // view switches recolour the circles; the ring layer stays, the legend of the fill view is the plot's own
    var origSwitch = window.switchSnakeView;
    if (typeof origSwitch === 'function') {
      window.switchSnakeView = function (name) { origSwitch(name); if (S.ring === name) { S.ring = 'none'; if (ui.ring) ui.ring.value = 'none'; drawRings(); ringLegend(); } };
      api.setView = window.switchSnakeView;
    }
    var origLoop = window.toggleLoop;
    if (typeof origLoop === 'function') {
      window.toggleLoop = function () { origLoop.apply(this, arguments); setTimeout(relayout, 0); };
    }
  }
  function relayout() { helixBoxes(); drawLabels(); drawRings(); drawMotifs(); drawArcs(); fit(); }

  // ------------------------------------------------------------------ the toolbar and panels
  var ui = {};
  function buildUI() {
    var bar = el('div', 'sp-bar');
    bar.id = 'sp-bar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Snake plot tools');

    // contacts: change (width by dRRCS) or state (scrubber)
    var g1 = el('div', 'sp-group');
    g1.appendChild(el('span', 'sp-lab', 'Contacts'));
    var seg = el('div', 'sp-seg');
    seg.setAttribute('role', 'group');
    ui.modeDelta = btn('Change', 'sp-mode is-on', 'Arc width by the size of the change (|dRRCS|)');
    ui.modeDelta.dataset.mode = 'delta';
    ui.modeDelta.setAttribute('aria-pressed', 'true');
    ui.modeState = btn('By state', 'sp-mode', 'Arc width by the contact strength (RRCS) in the inactive model, the active model, or between them');
    ui.modeState.dataset.mode = 'state';
    ui.modeState.setAttribute('aria-pressed', 'false');
    seg.appendChild(ui.modeDelta); seg.appendChild(ui.modeState);
    g1.appendChild(seg);
    var scrub = el('div', 'sp-scrub');
    scrub.id = 'sp-scrub';
    scrub.hidden = true;
    ui.play = btn('', 'sp-play', 'Play: inactive to active');
    ui.play.setAttribute('aria-label', 'Play from the inactive model to the active model');
    ui.play.textContent = '▶';
    var lab0 = el('span', 'sp-scrub-end is-inactive', 'inactive');
    ui.slider = el('input', 'sp-slider');
    ui.slider.type = 'range'; ui.slider.min = '0'; ui.slider.max = '100'; ui.slider.step = '1'; ui.slider.value = '0';
    ui.slider.id = 'sp-state';
    ui.slider.setAttribute('aria-label', 'State between the inactive model (0) and the active model (100)');
    var lab1 = el('span', 'sp-scrub-end is-active', 'active');
    ui.stateText = el('span', 'sp-scrub-text');
    ui.stateText.setAttribute('role', 'status');
    scrub.appendChild(ui.play); scrub.appendChild(lab0); scrub.appendChild(ui.slider); scrub.appendChild(lab1); scrub.appendChild(ui.stateText);
    g1.appendChild(scrub);
    ui.count = el('span', 'sp-count');
    g1.appendChild(ui.count);
    bar.appendChild(g1);

    // largest changes: step through
    var g2 = el('div', 'sp-group');
    g2.appendChild(el('span', 'sp-lab sp-tour-lab', 'Step through the largest changes'));
    ui.tourPrev = btn('‹', 'sp-step', 'Previous of the largest changes shown');
    ui.tourPrev.setAttribute('aria-label', 'Previous largest change');
    ui.tourLabel = el('span', 'sp-tour-n', '');
    ui.tourNext = btn('›', 'sp-step', 'Next of the largest changes shown');
    ui.tourNext.setAttribute('aria-label', 'Next largest change');
    g2.appendChild(ui.tourPrev); g2.appendChild(ui.tourLabel); g2.appendChild(ui.tourNext);
    var topLab = el('label', 'sp-lab sp-top-lab');
    topLab.htmlFor = 'sp-top';
    topLab.textContent = 'show';
    ui.top = el('select', 'sp-select');
    ui.top.id = 'sp-top';
    [['0', 'all'], ['10', 'top 10'], ['25', 'top 25'], ['50', 'top 50']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; ui.top.appendChild(op); });
    g2.appendChild(topLab); g2.appendChild(ui.top);
    bar.appendChild(g2);

    // layers
    var g3 = el('div', 'sp-group');
    var labelsBtn = btn('Helix labels', 'sp-toggle is-on', 'Show TM1 to TM7 and H8 labels and the membrane sides');
    labelsBtn.setAttribute('aria-pressed', 'true');
    labelsBtn.id = 'sp-labels-btn';
    labelsBtn.addEventListener('click', function () { S.labels = !S.labels; labelsBtn.classList.toggle('is-on', S.labels); labelsBtn.setAttribute('aria-pressed', String(S.labels)); drawLabels(); });
    g3.appendChild(labelsBtn);
    var ringLab = el('label', 'sp-lab');
    ringLab.htmlFor = 'sp-ring';
    ringLab.textContent = 'Ring';
    ui.ring = el('select', 'sp-select');
    ui.ring.id = 'sp-ring';
    ui.ring.title = 'A second data layer drawn as a ring around each residue, over the fill view';
    var none = el('option', null, 'none'); none.value = 'none'; ui.ring.appendChild(none);
    // only the sparse layers: a ring on every residue (conservation, properties) is clutter, not a layer
    [['cfr', 'Core functional'], ['alphamissense', 'AlphaMissense']].forEach(function (o) {
      if (!views[o[0]] || !views[o[0]].colors || !Object.keys(views[o[0]].colors).length) return;
      var op = el('option', null, o[1]); op.value = o[0]; ui.ring.appendChild(op);
    });
    ui.ring.addEventListener('change', function () { S.ring = ui.ring.value; drawRings(); ringLegend(); });
    ui.ringLegend = el('span', 'sp-ring-legend');
    g3.appendChild(ringLab); g3.appendChild(ui.ring); g3.appendChild(ui.ringLegend);
    bar.appendChild(g3);

    // export
    var g4 = el('div', 'sp-group sp-group-end');
    var exSvg = btn('SVG', 'sp-toggle', 'Download the plot as it is shown now, as SVG');
    var exPng = btn('PNG', 'sp-toggle', 'Download the plot as it is shown now, as PNG');
    exSvg.addEventListener('click', function () { exportPlot('svg'); });
    exPng.addEventListener('click', function () { exportPlot('png'); });
    g4.appendChild(el('span', 'sp-lab', 'Export'));
    g4.appendChild(exSvg); g4.appendChild(exPng);
    bar.appendChild(g4);

    container.parentNode.insertBefore(bar, container);

    // mode and scrubber
    function setMode(mode) {
      S.mode = mode;
      ui.modeDelta.classList.toggle('is-on', mode === 'delta'); ui.modeDelta.setAttribute('aria-pressed', String(mode === 'delta'));
      ui.modeState.classList.toggle('is-on', mode === 'state'); ui.modeState.setAttribute('aria-pressed', String(mode === 'state'));
      scrub.hidden = mode !== 'state';
      section.classList.toggle('sp-mode-state', mode === 'state');
      if (mode === 'state' && !S.arcs) setArcs(true);
      restyleArcs();
      stateText();
    }
    ui.setMode = setMode;
    ui.modeDelta.addEventListener('click', function () { stopPlay(); setMode('delta'); });
    ui.modeState.addEventListener('click', function () { setMode('state'); });
    if (!hasStates) { ui.modeState.disabled = true; ui.modeState.title = 'This page has no per-state RRCS values for the contacts'; }
    ui.slider.addEventListener('input', function () { stopPlay(); S.t = parseInt(ui.slider.value, 10) / 100; restyleArcs(); stateText(); });
    ui.play.addEventListener('click', function () { if (playing) stopPlay(); else play(); });
    ui.top.addEventListener('change', function () { S.top = parseInt(ui.top.value, 10) || 0; drawArcs(); });
    ui.tourPrev.addEventListener('click', function () { tourStep(-1); });
    ui.tourNext.addEventListener('click', function () { tourStep(1); });

    // zoom cluster inside the plate
    var zoom = el('div', 'sp-zoom');
    zoom.id = 'sp-zoom';
    var zi = btn('+', 'sp-zbtn', 'Zoom in'); zi.setAttribute('aria-label', 'Zoom in');
    var zo = btn('−', 'sp-zbtn', 'Zoom out'); zo.setAttribute('aria-label', 'Zoom out');
    var zr = btn('↺', 'sp-zbtn', 'Fit the whole plot'); zr.setAttribute('aria-label', 'Fit the whole plot');
    zi.addEventListener('click', function () { zoomBy(1.5); });
    zo.addEventListener('click', function () { zoomBy(1 / 1.5); });
    zr.addEventListener('click', function () { S.zoom = 1; applyView(); });
    zoom.appendChild(zi); zoom.appendChild(zo); zoom.appendChild(zr);
    container.appendChild(zoom);
    ui.zoomIn = zi; ui.zoomOut = zo; ui.zoomReset = zr;

    // minimap
    var mm = document.createElementNS(NS, 'svg');
    mm.setAttribute('class', 'sp-minimap');
    mm.setAttribute('id', 'sp-minimap');
    mm.setAttribute('aria-hidden', 'true');
    var use = svgEl('use'); use.setAttribute('href', '#snake'); use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#snake');
    mm.appendChild(use);
    ui.mmRect = svgEl('rect', { 'class': 'sp-minimap-view' });
    mm.appendChild(ui.mmRect);
    container.appendChild(mm);
    ui.minimap = mm;
    mm.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      mm.setPointerCapture(ev.pointerId);
      panToMinimap(ev);
    });
    mm.addEventListener('pointermove', function (ev) { if (ev.buttons) panToMinimap(ev); });

    // screen-reader text
    ui.live = el('div', 'sp-live');
    ui.live.id = 'sp-live';
    ui.live.setAttribute('role', 'status');
    ui.live.setAttribute('aria-live', 'polite');
    container.appendChild(ui.live);

    // panels under the plot: rewiring grid and motifs
    var panels = el('div', 'sp-panels');
    panels.id = 'sp-panels';
    var gridWrap = el('div', 'sp-panel');
    var gh = el('h3', 'sp-panel-title', 'Rewiring between helices');
    gridWrap.appendChild(gh);
    ui.grid = el('div', 'sp-grid');
    ui.grid.id = 'sp-grid';
    ui.grid.setAttribute('role', 'grid');
    ui.grid.setAttribute('aria-label', 'Above-threshold contacts between each pair of helices');
    gridWrap.appendChild(ui.grid);
    ui.gridNote = el('p', 'sp-panel-note');
    gridWrap.appendChild(ui.gridNote);
    panels.appendChild(gridWrap);

    var motifWrap = el('div', 'sp-panel');
    motifWrap.appendChild(el('h3', 'sp-panel-title', 'Conserved motifs'));
    ui.motifs = el('div', 'sp-motif-chips');
    ui.motifs.id = 'sp-motif-chips';
    var registryShown = [];
    MOTIFS.forEach(function (m) {
      var res = motifResidues(m);
      if (!res.some(function (r) { return r.pos; })) return;
      if (!motifCarried(m)) return;
      var chip = btn('', 'sp-chip', m.note);
      chip.dataset.motif = m.id;
      chip.setAttribute('aria-pressed', 'false');
      chip.appendChild(el('b', null, m.name));
      chip.appendChild(el('span', 'sp-chip-res', motifText(m)));
      if (m.pair && res[0].pos && res[1].pos) {
        var c = contactOf(res[0].pos, res[1].pos);
        if (c) chip.appendChild(el('span', 'sp-chip-delta ' + (c.delta >= 0 ? 'is-active' : 'is-inactive'), fmtSigned(c.delta) + (c.passes ? '' : ' (not above the threshold)')));
        else chip.appendChild(el('span', 'sp-chip-delta', 'no RRCS contact listed'));
      }
      if (m.registry) {
        registryShown.push(m);
        chip.classList.add('sp-chip-registry');
        motifContacts(m).forEach(function (k) {
          var d = el('span', 'sp-chip-delta ' + (k.c.delta >= 0 ? 'is-active' : 'is-inactive'),
            k.bwA + '-' + k.bwB + ' ' + fmtSigned(k.c.delta));
          d.title = aa1(k.a) + k.bwA + ' to ' + aa1(k.b) + k.bwB + ': ΔRRCS ' + fmtSigned(k.c.delta) +
            (k.c.delta >= 0 ? ', stronger in the active model' : ', stronger in the inactive model') + (k.c.passes ? '' : ' (not above the threshold)');
          chip.appendChild(d);
        });
      }
      chip.addEventListener('click', function () {
        S.motifs[m.id] = !S.motifs[m.id];
        chip.classList.toggle('is-on', !!S.motifs[m.id]);
        chip.setAttribute('aria-pressed', String(!!S.motifs[m.id]));
        drawMotifs();
      });
      ui.motifs.appendChild(chip);
    });
    motifWrap.appendChild(ui.motifs);
    var mn = el('p', 'sp-panel-note', 'Looked up by generic number (the part before the x). The letters are what this receptor has at each position; the motif names are the canonical ones. Choose a motif to mark it on the plot.');
    motifWrap.appendChild(mn);
    registryShown.forEach(function (m) {
      if (!m.glossary) return;
      var badge = document.querySelector('.motif-badge[data-motif="' + m.id + '"]');
      var more = el('p', 'sp-panel-note sp-motif-more');
      more.appendChild(document.createTextNode(m.name + ' is named in the GPCompaRe study: '));
      var a = el('a', null, 'what it is');
      a.href = badge ? badge.getAttribute('href') : '../' + m.glossary;
      more.appendChild(a);
      more.appendChild(document.createTextNode('.'));
      motifWrap.appendChild(more);
    });
    panels.appendChild(motifWrap);
    container.parentNode.insertBefore(panels, container.nextSibling);

    var fine = el('aside', 'fine-print sp-fine');
    fine.innerHTML = '<p>Arcs: the contact pairs on this page at or above the threshold' + (threshold !== null ? ' (|ΔRRCS| ≥ ' + threshold.toFixed(2) + ')' : '') +
      ', drawn between the two residues. Red: stronger in the active model. Blue: stronger in the inactive model. Width: the size of the change, or, in "By state", the contact’s RRCS. The endpoints show contact scores from the inactive and active models. Intermediate slider values are linear interpolations of those scores; no intermediate structures or dynamics were calculated. A contact is drawn whenever its score is above zero; a dashed trace marks a score of zero. ' +
      'Pairs with a residue inside a collapsed loop are drawn when the loop is opened. The grid counts the same pairs by helix. Hover a residue to see its partners; choose a contact to mark it in the tables, the charts and the 3D view. Keyboard: Tab to the plot, arrows along the chain, Enter to select, Escape to step back (the cursor first, then the details, the selection bar and the selection).</p>';
    panels.parentNode.insertBefore(fine, panels.nextSibling);
    ui.fine = fine;
  }

  // ------------------------------------------------------------------ the rewiring grid
  function paintGrid() {
    if (!ui.grid) return;
    ui.grid.textContent = '';
    var cells = {}, loops = { n: 0, sum: 0 }, maxN = 0;
    passing.forEach(function (c) {
      var sa = segOf(c.a), sb = segOf(c.b);
      if (HELICES.indexOf(sa) < 0 || HELICES.indexOf(sb) < 0) { loops.n++; loops.sum += c.delta; return; }
      var i = HELICES.indexOf(sa), j = HELICES.indexOf(sb), k = Math.min(i, j) + '-' + Math.max(i, j);
      var cell = cells[k] || (cells[k] = { n: 0, sum: 0, up: 0, down: 0 });
      cell.n++; cell.sum += c.delta; if (c.delta >= 0) cell.up++; else cell.down++;
      maxN = Math.max(maxN, cell.n);
    });
    var table = el('table', 'sp-grid-table');
    var thead = el('thead'), tr0 = el('tr');
    tr0.appendChild(el('th', null, ''));
    HELICES.forEach(function (h) { tr0.appendChild(el('th', null, h.replace('TM', ''))); });
    thead.appendChild(tr0); table.appendChild(thead);
    var tbody = el('tbody');
    HELICES.forEach(function (hi, i) {
      var tr = el('tr');
      tr.appendChild(el('th', null, hi));
      HELICES.forEach(function (hj, j) {
        var td = el('td');
        if (j < i) { td.className = 'sp-grid-empty'; tr.appendChild(td); return; }
        var cell = cells[i + '-' + j];
        if (!cell) { td.className = 'sp-grid-zero'; td.textContent = '·'; tr.appendChild(td); return; }
        var b = btn(String(cell.n), 'sp-cell ' + (cell.sum >= 0 ? 'is-active' : 'is-inactive'),
          hi + (i === j ? ' within itself' : ' to ' + hj) + ': ' + cell.n + ' contact' + (cell.n === 1 ? '' : 's') + ' above the threshold, ' +
          cell.up + ' stronger in the active model, ' + cell.down + ' stronger in the inactive model, net ΔRRCS ' + fmtSigned(cell.sum));
        b.style.setProperty('--sp-cell-a', (0.18 + 0.72 * cell.n / maxN).toFixed(2));
        b.dataset.pair = hi + '|' + hj;
        var on = S.segFilter && S.segFilter !== 'loops' && S.segFilter[0] === hi && S.segFilter[1] === hj;
        b.classList.toggle('is-on', !!on);
        b.setAttribute('aria-pressed', String(!!on));
        b.addEventListener('click', function () {
          S.segFilter = on ? null : [hi, hj];
          paintGrid(); drawArcs();
        });
        b.addEventListener('mouseenter', function () { hotSegments([hi, hj]); });
        b.addEventListener('mouseleave', function () { hotSegments(null); });
        td.appendChild(b);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    ui.grid.appendChild(table);
    var foot = el('div', 'sp-grid-foot');
    if (loops.n) {
      var lb = btn(loops.n + ' contact' + (loops.n === 1 ? '' : 's') + ' with a loop or terminus', 'sp-chip sp-chip-loops', 'Contacts above the threshold where at least one residue is in a loop or a terminus (net ' + fmtSigned(loops.sum) + ')');
      var lon = S.segFilter === 'loops';
      lb.classList.toggle('is-on', lon);
      lb.setAttribute('aria-pressed', String(lon));
      lb.addEventListener('click', function () { S.segFilter = lon ? null : 'loops'; paintGrid(); drawArcs(); });
      foot.appendChild(lb);
    }
    if (S.segFilter) {
      var clr = btn('Show all helices', 'sp-chip', 'Remove the helix filter');
      clr.addEventListener('click', function () { S.segFilter = null; paintGrid(); drawArcs(); });
      foot.appendChild(clr);
    }
    ui.grid.appendChild(foot);
    ui.gridNote.textContent = 'How many of the above-threshold contacts join each pair of helices (a cell on the diagonal: within one helix). Red: the sum of their ΔRRCS favours the active model; blue: the inactive model. Choose a cell to show only those arcs.';
  }
  function hotSegments(pair) {
    for (var k in arcEls) {
      var p = arcEls[k], a = parseInt(p.getAttribute('data-a'), 10), b = parseInt(p.getAttribute('data-b'), 10);
      var on = !!pair && ((segOf(a) === pair[0] && segOf(b) === pair[1]) || (segOf(a) === pair[1] && segOf(b) === pair[0]));
      p.classList.toggle('is-seg', on);
    }
    svg.classList.toggle('sp-seg-hot', !!pair);
  }

  // ------------------------------------------------------------------ tour of the largest changes
  function tourList() { return shown; }
  function tourIndexOf(a, b) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    for (var i = 0; i < shown.length; i++) if (shown[i].a === lo && shown[i].b === hi) return i;
    return -1;
  }
  function tourStep(dir) {
    var list = tourList();
    if (!list.length) return;
    var i = S.tour < 0 ? (dir > 0 ? 0 : list.length - 1) : (S.tour + dir + list.length) % list.length;
    var c = list[i];
    S.tour = i;
    selectPair(c.a, c.b, c.delta);
    if (S.zoom > 1) { var p = pointOf(c.a), q = pointOf(c.b); if (p && q) { S.cx = (p.x + q.x) / 2 + tx; S.cy = (p.y + q.y) / 2 + ty; applyView(); } }
    updateSummary();
  }

  // ------------------------------------------------------------------ scrubber playback
  var playing = null;
  function stateText() {
    if (!ui.stateText) return;
    if (S.mode !== 'state') { ui.stateText.textContent = ''; return; }
    var pct = Math.round(S.t * 100);
    ui.stateText.textContent = 'Showing: ' + (pct === 0 ? 'the inactive model' : pct === 100 ? 'the active model' : pct + '% of the way to the active model');
    ui.slider.setAttribute('aria-valuetext', ui.stateText.textContent);
  }
  function play() {
    if (S.mode !== 'state') ui.setMode('state');
    if (reduceMotion) { S.t = S.t >= 1 ? 0 : 1; ui.slider.value = String(Math.round(S.t * 100)); restyleArcs(); stateText(); return; }
    var from = S.t >= 0.999 ? 0 : S.t, start = null, dur = 2400 * (1 - from);
    ui.play.textContent = '■';
    ui.play.setAttribute('aria-label', 'Stop');
    function frame(ts) {
      if (start === null) start = ts;
      var k = Math.min(1, (ts - start) / dur);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      S.t = from + (1 - from) * e;
      ui.slider.value = String(Math.round(S.t * 100));
      restyleArcs(); stateText();
      if (k < 1) playing = requestAnimationFrame(frame); else stopPlay();
    }
    playing = requestAnimationFrame(frame);
  }
  function stopPlay() {
    if (playing) cancelAnimationFrame(playing);
    playing = null;
    if (ui.play) { ui.play.textContent = '▶'; ui.play.setAttribute('aria-label', 'Play from the inactive model to the active model'); }
  }

  // ------------------------------------------------------------------ zoom and pan
  function clientToSvg(x, y) {
    var r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return { x: vb.x + (x - r.left) / r.width * vb.width, y: vb.y + (y - r.top) / r.height * vb.height };
  }
  function zoomBy(f, at) {
    if (!fitBox) return;
    var z0 = S.zoom, z1 = clamp(z0 * f, 1, 8);
    if (at) {
      // keep the point under the cursor where it is
      var p = clientToSvg(at.x, at.y);
      S.cx = p.x + (S.cx - p.x) * (z0 / z1);
      S.cy = p.y + (S.cy - p.y) * (z0 / z1);
    }
    S.zoom = z1;
    applyView();
  }
  function updateMinimap() {
    if (!ui.minimap || !fitBox) return;
    ui.minimap.setAttribute('viewBox', fitBox.x + ' ' + fitBox.y + ' ' + fitBox.w + ' ' + fitBox.h);
    var vb = svg.viewBox.baseVal;
    ui.mmRect.setAttribute('x', vb.x); ui.mmRect.setAttribute('y', vb.y);
    ui.mmRect.setAttribute('width', vb.width); ui.mmRect.setAttribute('height', vb.height);
  }
  function panToMinimap(ev) {
    var r = ui.minimap.getBoundingClientRect();
    S.cx = fitBox.x + (ev.clientX - r.left) / r.width * fitBox.w;
    S.cy = fitBox.y + (ev.clientY - r.top) / r.height * fitBox.h;
    applyView();
  }
  function wireZoom() {
    var pointers = {}, drag = null, pinch = null, lastTap = 0;
    svg.addEventListener('wheel', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey) && S.zoom <= 1) return;   // a plain wheel scrolls the page until the plot is zoomed
      ev.preventDefault();
      zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, { x: ev.clientX, y: ev.clientY });
    }, { passive: false });
    svg.addEventListener('pointerdown', function (ev) {
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        drag = null;
      } else if (ids.length === 1 && (S.zoom > 1 || ev.pointerType === 'mouse')) {
        drag = { x: ev.clientX, y: ev.clientY, cx: S.cx, cy: S.cy, moved: false };
      }
    });
    svg.addEventListener('pointermove', function (ev) {
      if (!pointers[ev.pointerId]) return;
      pointers[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var ids = Object.keys(pointers);
      if (pinch && ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        var z1 = clamp(pinch.z * d / (pinch.d || 1), 1, 8);
        var f = z1 / S.zoom;
        if (Math.abs(f - 1) > 0.001) zoomBy(f, pinch.mid);
        ev.preventDefault();
      } else if (drag && S.zoom > 1) {
        var r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
        var dx = (ev.clientX - drag.x) / r.width * vb.width, dy = (ev.clientY - drag.y) / r.height * vb.height;
        if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) drag.moved = true;
        if (drag.moved) { S.cx = drag.cx - dx; S.cy = drag.cy - dy; applyView(); ev.preventDefault(); }
      }
    });
    function up(ev) {
      delete pointers[ev.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (drag && drag.moved) { svg.classList.add('sp-dragged'); setTimeout(function () { svg.classList.remove('sp-dragged'); }, 0); }
      drag = null;
    }
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('pointerleave', function (ev) { if (ev.pointerType !== 'touch') up(ev); });
    // a click on the empty plate: nothing; a double tap or double click toggles 2.5x at the point
    var tapZoomAt = 0;
    svg.addEventListener('dblclick', function (ev) {
      if (/^\d+$/.test((ev.target.id || '').replace(/t$/, ''))) return;
      if (Date.now() - tapZoomAt < 500) return;   // the double tap already did it
      ev.preventDefault();
      if (S.zoom > 1) { S.zoom = 1; applyView(); } else zoomBy(2.5, { x: ev.clientX, y: ev.clientY });
    });
    svg.addEventListener('touchend', function (ev) {
      var now = Date.now();
      if (now - lastTap < 300 && ev.changedTouches.length === 1) {
        var t = ev.changedTouches[0];
        if (S.zoom > 1) { S.zoom = 1; applyView(); } else zoomBy(2.5, { x: t.clientX, y: t.clientY });
        tapZoomAt = now;
        ev.preventDefault();
      }
      lastTap = now;
    });
  }

  // ------------------------------------------------------------------ keyboard
  var chain = [];
  function describe(pos) {
    var r = byPos[pos], gn = gnOf(pos), seg = segOf(pos);
    var parts = [label(pos)];
    if (gn) parts.push(gn);
    if (seg) parts.push(seg);
    if (r && typeof r.active_minus_inactive === 'number') parts.push('net ' + fmtSigned(r.active_minus_inactive) + (r.active_minus_inactive >= 0 ? ', stronger in the active model' : ', stronger in the inactive model'));
    var n = (byRes[pos] || []).length;
    parts.push(n + ' partner' + (n === 1 ? '' : 's') + ' above the threshold');
    return parts.join(', ');
  }
  function announce(fromKeyboard) {
    if (!ui.live) return;
    var s = S.sel;
    if (fromKeyboard && S.kbd !== null) {
      var picked = (s.res === S.kbd && !s.pair) || (s.pair && (s.pair.a === S.kbd || s.pair.b === S.kbd));
      ui.live.textContent = describe(S.kbd) + (picked ? ', selected' : '');
      return;
    }
    if (s.pair) ui.live.textContent = 'Selected contact ' + label(s.pair.a) + ' to ' + label(s.pair.b) + (s.pair.delta !== null && s.pair.delta !== undefined && !isNaN(s.pair.delta) ? ', dRRCS ' + fmtSigned(s.pair.delta) : '');
    else if (s.res !== null) ui.live.textContent = 'Selected ' + describe(s.res);
    else if (S.kbd !== null) ui.live.textContent = describe(S.kbd);
    else ui.live.textContent = '';
  }
  function wireKeyboard() {
    chain = Object.keys(circles).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Snake plot of ' + (cfg.gene || GID) + '. Use the arrow keys to move along the chain, Enter to select a residue, Escape to step back one step at a time.');
    svg.addEventListener('keydown', function (ev) {
      var k = ev.key, i;
      if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
        ev.preventDefault();
        var cur = S.kbd !== null ? S.kbd : (S.sel.res !== null ? S.sel.res : null);
        var vis = chain.filter(visible);
        if (!vis.length) return;
        i = cur === null ? -1 : vis.indexOf(cur);
        if (k === 'Home') i = 0;
        else if (k === 'End') i = vis.length - 1;
        else if (k === 'ArrowRight') i = Math.min(vis.length - 1, i + 1);
        else if (k === 'ArrowLeft') i = Math.max(0, i - 1);
        else if (k === 'ArrowDown') i = Math.min(vis.length - 1, (i < 0 ? 0 : i) + 10);
        else if (k === 'ArrowUp') i = Math.max(0, i - 10);
        S.kbd = vis[Math.max(0, i)];
        S.hover = { res: S.kbd, pair: null };
        paintMarks(); announce(true);
        if (S.zoom > 1) { var p = pointOf(S.kbd); if (p) { S.cx = p.x + tx; S.cy = p.y + ty; applyView(); } }
      } else if (k === 'Enter' || k === ' ') {
        if (S.kbd === null) return;
        ev.preventDefault();
        if (S.sel.res === S.kbd && !S.sel.pair) clearSelection(); else selectResidue(S.kbd);
      } else if (k === 'Escape') {
        // the keyboard cursor goes first; then the page's order (report-select.js: the
        // residue drawer, the selection bar, the selection), which it runs itself
        if (S.kbd !== null) {
          ev.preventDefault();
          S.kbd = null; S.hover = { res: null, pair: null };
          paintMarks(); announce();
          return;
        }
        if (window.GPCSelect) return;
        if (S.sel.res !== null) { ev.preventDefault(); clearSelection(); }
      } else if (k === '+' || k === '=') { ev.preventDefault(); zoomBy(1.5); }
      else if (k === '-') { ev.preventDefault(); zoomBy(1 / 1.5); }
      else if (k === '0') { ev.preventDefault(); S.zoom = 1; applyView(); }
    });
    svg.addEventListener('blur', function () { S.kbd = null; S.hover = { res: null, pair: null }; paintMarks(); });
  }

  // ------------------------------------------------------------------ export
  function exportPlot(kind) {
    var clone = svg.cloneNode(true);
    clone.removeAttribute('tabindex'); clone.removeAttribute('role'); clone.removeAttribute('aria-label');
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    // bake the computed colours of the overlay (they come from CSS tokens on the page)
    var src = svg.querySelectorAll('.sp-arc, .sp-mark, .sp-ring, .sp-motif circle, .sp-motif-tag, .sp-motif-link, .sp-helix-label rect, .sp-helix-label text, .sp-side, .sp-callout rect, .sp-callout text');
    var dst = clone.querySelectorAll('.sp-arc, .sp-mark, .sp-ring, .sp-motif circle, .sp-motif-tag, .sp-motif-link, .sp-helix-label rect, .sp-helix-label text, .sp-side, .sp-callout rect, .sp-callout text');
    for (var i = 0; i < src.length && i < dst.length; i++) {
      var cs = getComputedStyle(src[i]);
      ['stroke', 'stroke-width', 'fill', 'opacity', 'stroke-dasharray', 'font-size', 'font-family', 'font-weight', 'font-style'].forEach(function (p) {
        var v = cs.getPropertyValue(p);
        if (v) dst[i].setAttribute(p, v);
      });
    }
    var dimmed = svg.classList.contains('sp-dim');
    Array.prototype.forEach.call(clone.querySelectorAll('.sp-keep'), function (n) { n.classList.remove('sp-keep'); });
    var style = svgEl('style');
    style.textContent = '.long{display:none}' + (dimmed ? '' : '');
    clone.insertBefore(style, clone.firstChild);
    Array.prototype.forEach.call(svg.querySelectorAll('.long'), function (n, idx) {
      var m = clone.querySelectorAll('.long')[idx];
      if (m && n.style.display === 'inline') m.setAttribute('style', 'display:inline');
    });
    var text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
    var view = window.SnakeAPI.getView ? window.SnakeAPI.getView() : 'view';
    var name = (GID || 'receptor') + '_snake_' + view + (S.mode === 'state' ? '_state' + Math.round(S.t * 100) : '');
    if (kind === 'svg') { download(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), name + '.svg'); return; }
    var vb = svg.viewBox.baseVal, scale = 2;
    var img = new Image();
    var url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(vb.width * scale); canvas.height = Math.round(vb.height * scale);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      if (canvas.toBlob) canvas.toBlob(function (b) { if (b) download(b, name + '.png'); }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); download(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), name + '.svg'); };
    img.src = url;
  }
  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ------------------------------------------------------------------ phones
  // Below 640 px the plot comes straight under its heading: the nine view buttons become one
  // "Colour by" menu under the plot, and the filters, the legend and the contacts bar fold into
  // one "Filters and tools". The plot opens zoomed on TM3 to TM6 with the minimap showing.
  // Run-time rearrangement only: every approved element stays on the page, moved, not changed.
  var PHONE_MQ = '(max-width: 640px)';
  function isPhone() { return !!(window.matchMedia && matchMedia(PHONE_MQ).matches); }
  function phoneLayout() {
    if (!isPhone() || section.classList.contains('sp-phone')) return;
    section.classList.add('sp-phone');
    var head = section.querySelector('.report-section-head');
    var toolbar = section.querySelector('.snake-plot-toolbar');
    if (head && head.parentNode === section) head.insertAdjacentElement('afterend', container);
    var row = el('div', 'sp-colour-by');
    var lab = el('label', 'sp-lab', 'Colour by');
    lab.htmlFor = 'sp-colour-by';
    var sel = el('select', 'sp-select');
    sel.id = 'sp-colour-by';
    Array.prototype.forEach.call(section.querySelectorAll('.snake-btn[data-view]'), function (b) {
      var op = el('option', null, b.textContent.trim());
      op.value = b.dataset.view;
      sel.appendChild(op);
    });
    sel.value = window.SnakeAPI.getView ? window.SnakeAPI.getView() : 'delta_rrcs';
    sel.addEventListener('change', function () { if (window.switchSnakeView) window.switchSnakeView(sel.value); });
    var sw = window.switchSnakeView;
    if (typeof sw === 'function') {
      window.switchSnakeView = function (name) { sw(name); if (views[name]) sel.value = name; };
      window.SnakeAPI.setView = window.switchSnakeView;
    }
    row.appendChild(lab); row.appendChild(sel);
    container.insertAdjacentElement('afterend', row);
    var tools = el('details', 'sp-tools');
    tools.id = 'sp-tools';
    tools.appendChild(el('summary', null, 'Filters and tools'));
    var links = toolbar && toolbar.querySelector('.snake-links-toggle');
    [links, document.getElementById('snake-filter-panel'), document.getElementById('snake-legend'), document.getElementById('sp-bar')]
      .forEach(function (n) { if (n) tools.appendChild(n); });
    row.insertAdjacentElement('afterend', tools);
  }
  function phoneZoom() {
    if (!section.classList.contains('sp-phone') || !fitBox) return;
    var hs = ['TM3', 'TM4', 'TM5', 'TM6'].map(function (k) { return helixBox[k]; }).filter(Boolean);
    if (!hs.length) return;
    var x0 = Math.min.apply(null, hs.map(function (b) { return b.minX; })), x1 = Math.max.apply(null, hs.map(function (b) { return b.maxX; }));
    var y0 = Math.min.apply(null, hs.map(function (b) { return b.minY; })), y1 = Math.max.apply(null, hs.map(function (b) { return b.maxY; }));
    S.zoom = 2;
    S.cx = (x0 + x1) / 2 + tx;
    S.cy = (y0 + y1) / 2 + ty;
    applyView();
  }

  // ------------------------------------------------------------------ public
  var PUBLIC = {
    state: function () { return { arcs: S.arcs, mode: S.mode, t: S.t, shown: shown.length, passing: passing.length, zoom: S.zoom, labels: S.labels, ring: S.ring, segFilter: S.segFilter, top: S.top, inited: S.inited }; },
    contacts: function () { return passing.slice(); },
    setState: function (t) { if (S.mode !== 'state') ui.setMode('state'); S.t = clamp(t, 0, 1); ui.slider.value = String(Math.round(S.t * 100)); restyleArcs(); stateText(); },
    setMode: function (m) { ui.setMode(m === 'state' ? 'state' : 'delta'); },
    play: play,
    zoomBy: zoomBy,
    fit: function () { S.zoom = 1; applyView(); },
    step: tourStep,
    setRing: function (v) { S.ring = views[v] ? v : 'none'; if (ui.ring) ui.ring.value = S.ring; drawRings(); ringLegend(); },
    toggleMotif: function (id) { S.motifs[id] = !S.motifs[id]; var c = ui.motifs && ui.motifs.querySelector('[data-motif="' + id + '"]'); if (c) { c.classList.toggle('is-on', !!S.motifs[id]); c.setAttribute('aria-pressed', String(!!S.motifs[id])); } drawMotifs(); },
    exportPlot: exportPlot,
    cursor: function () { return S.kbd; }
  };
  window.SnakePlus = PUBLIC;

  // ------------------------------------------------------------------ init, once the plot is near the screen
  // Phase 1, at once: everything that takes space on the page (the toolbar, the trimmed plot, the
  // panels, the fine print), so the section has its final height before anyone scrolls or jumps
  // to a section below it. Phase 2, when the plot comes near the screen: the arcs and the marks.
  var prepared = false;
  function prepare() {
    if (prepared) return;
    prepared = true;
    section.classList.add('sp-on');
    document.documentElement.setAttribute('data-snake-plus', 'ready');
    mount();
    buildUI();
    wireLegacy();
    wireZoom();
    wireKeyboard();
    helixBoxes();
    drawLabels();
    fit();
    phoneLayout();
    phoneZoom();
    paintGrid();
    setArcsChrome(true);
    updateSummary();
  }
  function init() {
    if (S.inited) return;
    prepare();
    S.inited = true;
    document.documentElement.setAttribute('data-snake-plus', 'on');
    // the current selection, if the hub already has one (a #res= or #pair= link)
    var cur = window.GPCSelect && window.GPCSelect.current ? window.GPCSelect.current() : null;
    if (cur && cur.res !== null && cur.res !== undefined) S.sel = { res: cur.res, pair: cur.pair ? { a: cur.pair.a, b: cur.pair.b, delta: cur.pair.delta } : null };
    else if (window.SnakeAPI.getSelectedResidue) { var r = window.SnakeAPI.getSelectedResidue(); if (r !== null && r !== undefined) S.sel = { res: r, pair: null }; }
    var queued = pendingBus.slice(); pendingBus = [];
    queued.forEach(function (q) { onBus(q[0], q[1]); });
    setArcs(true);
    document.dispatchEvent(new CustomEvent('gpc:snake-plus-ready', { detail: { gid: GID } }));
  }

  prepare();
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); init(); }
    }, { rootMargin: '240px 0px' });
    io.observe(section);
  } else {
    init();
  }
  // a link that lands on a residue or a pair opens the plot straight away
  if (/(?:^#|&)(res|pair|view|min|max|dir)=/.test(window.location.hash || '')) init();
})();
