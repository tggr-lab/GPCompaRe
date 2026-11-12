// atlas-core.js: data decoding, color scales and the four layouts of the GPCRome Atlas.
// Pure functions on plain objects; drawing and interaction live in atlas-render.js and atlas.js.
(function() {
  'use strict';

  var A = window.GPCAtlas = window.GPCAtlas || {};

  // ------------------------------------------------------------------ data

  function b64bytes(s) {
    var bin = atob(s), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  var METRICS = {
    n_above: { label: 'Contacts above threshold', short: 'contacts', fmt: function(v) { return String(Math.round(v)); } },
    share_active: { label: 'Share stronger in active', short: 'stronger in active', fmt: function(v) { return Math.round(v * 100) + '%'; } },
    tm6_shift: { label: 'TM6 displacement', short: 'TM6 shift', fmt: function(v) { return v.toFixed(1) + ' Å'; } },
    sum_abs_above: { label: 'Total change', short: 'total |ΔRRCS|', fmt: function(v) { return String(Math.round(v)); } }
  };
  A.METRICS = METRICS;
  A.METRIC_KEYS = ['n_above', 'share_active', 'tm6_shift', 'sum_abs_above'];

  // Shared, fixed scales so every glyph uses the same yardstick (roughly the 99th percentile
  // over all receptors; larger values are drawn at the maximum).
  A.SCALE = {
    helixAbs: 90,     // summed |dRRCS| on one helix -> disc area
    helixNet: 30,     // net dRRCS on one helix -> full color
    pairNet: 25,      // net dRRCS between two helices -> full line width and color
    posNet: 8,        // net dRRCS of one residue -> full color (lens, heat map, strips)
    share: 0.25,      // share stronger in active: 0.5 +- this -> full color
    dotMin: 150,      // total above-threshold change (sum |dRRCS|) -> dot area, clamped to this range
    dotMax: 700
  };

  A.decode = function(index) {
    var L = index.layers, n = L.shape[0], m = L.shape[1];
    var pb = b64bytes(L.pos.data), pos = new Uint16Array(n * m);
    for (var i = 0; i < n * m; i++) pos[i] = pb[2 * i] | (pb[2 * i + 1] << 8);
    var netb = b64bytes(L.net.data);
    var D = {
      n: n, m: m,
      net: new Int8Array(netb.buffer, netb.byteOffset, netb.length),
      netScale: L.net.scale || 10,
      hit: b64bytes(L.hit.data),
      cons: b64bytes(L.cons.data),
      am: b64bytes(L.am.data),
      aa: b64bytes(L.aa.data),
      pos: pos
    };
    var groups = index.ligand_groups.map(function(g, gi) {
      return { key: g.key, n: g.n, color: g.color, index: gi };
    });
    var gIndex = {};
    groups.forEach(function(g) { gIndex[g.key] = g.index; });
    var byGid = {}, positions = index.positions, gnIndex = {};
    positions.forEach(function(p, j) { p.index = j; gnIndex[p.gn] = j; });
    index.receptors.forEach(function(r, i) {
      r.index = i;
      r.group = gIndex[r.ligand] != null ? gIndex[r.ligand] : groups.length - 1;
      r.fullName = '';
      byGid[r.gid] = r;
    });
    // segment runs on the shared position axis (for rulers, strips and the heat map)
    var segRuns = [], cur = null;
    positions.forEach(function(p, j) {
      if (!cur || cur.seg !== p.segment) { cur = { seg: p.segment, start: j, end: j }; segRuns.push(cur); }
      else cur.end = j;
    });
    return {
      index: index, receptors: index.receptors, positions: positions, groups: groups,
      byGid: byGid, gnIndex: gnIndex, layers: D, segRuns: segRuns,
      helices: index.helices || ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']
    };
  };

  // value of receptor i at position j
  A.cell = function(data, i, j) {
    var L = data.layers, k = i * L.m + j, aa = L.aa[k];
    var present = aa !== 45; // '-'
    return {
      present: present,
      aa: present ? String.fromCharCode(aa) : '',
      resnum: L.pos[k],
      net: L.net[k] / L.netScale,
      clipped: Math.abs(L.net[k]) >= 127,
      hit: L.hit[k],
      cons: L.cons[k] === 255 ? null : L.cons[k] / 100,
      am: L.am[k] === 255 ? null : L.am[k] / 100
    };
  };

  // Parse "3.50", "3.50x50", "6x48", "6.48x48" to a column index on the shared axis, or -1.
  A.parseGn = function(data, text) {
    var s = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return -1;
    if (data.gnIndex[s] != null) return data.gnIndex[s];
    var P = data.positions, j, m;
    if ((m = /^(\d+)\.(\d+)$/.exec(s))) {
      for (j = 0; j < P.length; j++) if (P[j].gn.indexOf(m[1] + '.' + m[2] + 'x') === 0) return j;
      return -1;
    }
    if ((m = /^(\d+)x(\d+)$/.exec(s))) {
      for (j = 0; j < P.length; j++) {
        var g = /^(\d+)\.\d+x(\d+)$/.exec(P[j].gn);
        if (g && g[1] === m[1] && g[2] === m[2]) return j;
      }
      return -1;
    }
    if ((m = /^(\d+)\.(\d+)x(\d+)$/.exec(s))) {
      for (j = 0; j < P.length; j++) if (P[j].gn.indexOf(m[1] + '.' + m[2] + 'x') === 0) return j;
    }
    return -1;
  };

  // ------------------------------------------------------------------ color

  function parseColor(c) {
    c = String(c || '').trim();
    var m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(c))) {
      var h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    }
    if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c))) {
      return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16),
              m[2] ? parseInt(m[2], 16) / 255 : 1];
    }
    if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return [128, 128, 128, 1];
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
            (a[3] == null ? 1 : a[3]) + ((b[3] == null ? 1 : b[3]) - (a[3] == null ? 1 : a[3])) * t];
  }
  function css(c, alpha) {
    var a = alpha == null ? (c[3] == null ? 1 : c[3]) : alpha;
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (+a.toFixed(3)) + ')';
  }
  A.parseColor = parseColor; A.mix = mix; A.css = css;

  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    var x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x));
    return mix(stops[i], stops[i + 1], x - i);
  }
  A.ramp = ramp;

  // Number of steps on each side of a diverging scale and along a sequential one.
  var DIV = 12, SEQ = 16;
  A.DIV = DIV; A.SEQ = SEQ;

  // Palette for one theme. Every glyph primitive refers to a color by an integer id so the
  // renderer can batch all shapes of one color into one path.
  A.buildPalette = function(el, groups) {
    var cs = getComputedStyle(el);
    var dark = document.documentElement.getAttribute('data-color-mode') === 'dark';
    function v(name, fallback) { var s = cs.getPropertyValue(name).trim(); return s || fallback; }
    var act = parseColor(v('--semantic-active', dark ? '#F87171' : '#B91C1C'));
    var ina = parseColor(v('--semantic-inactive', dark ? '#60A5FA' : '#1D4ED8'));
    var fg = parseColor(v('--fgColor-default', dark ? '#f0f6fc' : '#1f2328'));
    var muted = parseColor(v('--fgColor-muted', dark ? '#9198a1' : '#59636e'));
    var accent = parseColor(v('--brand-primary', dark ? '#2DD4BF' : '#0D9488'));
    var bg = dark ? [11, 15, 22, 1] : [250, 250, 248, 1];
    var neutral = dark ? [92, 101, 116, 1] : [176, 182, 192, 1];
    var plate = dark ? [255, 255, 255, 0.045] : [255, 255, 255, 0.92];
    var plateEdge = dark ? [255, 255, 255, 0.10] : [31, 35, 40, 0.10];
    // conservation: neutral to deep slate-teal; AlphaMissense: viridis-like (never red/blue)
    var consStops = dark
      ? [[58, 66, 80, 1], [70, 120, 130, 1], [94, 200, 190, 1], [200, 246, 236, 1]]
      : [[226, 230, 234, 1], [150, 196, 196, 1], [42, 128, 128, 1], [14, 66, 72, 1]];
    var amStops = dark
      ? [[94, 60, 153, 1], [59, 82, 139, 1], [33, 145, 140, 1], [94, 201, 98, 1], [253, 231, 37, 1]]
      : [[68, 1, 84, 1], [59, 82, 139, 1], [33, 145, 140, 1], [94, 201, 98, 1], [235, 205, 20, 1]];

    var colors = [];           // rgba arrays
    function add(c) { colors.push(c); return colors.length - 1; }
    var P = { dark: dark, act: act, ina: ina, fg: fg, muted: muted, accent: accent, bg: bg, neutral: neutral,
              consStops: consStops, amStops: amStops };
    // diverging: id DIV is neutral; DIV+k (k=1..DIV) toward active; DIV-k toward inactive
    P.divBase = colors.length;
    for (var k = -DIV; k <= DIV; k++) {
      var t = Math.abs(k) / DIV;
      add(k === 0 ? neutral : mix(neutral, k > 0 ? act : ina, 0.25 + 0.75 * t));
    }
    P.ligBase = colors.length;
    groups.forEach(function(g) { add(parseColor(g.color)); });
    P.consBase = colors.length;
    for (var s = 0; s < SEQ; s++) add(ramp(consStops, s / (SEQ - 1)));
    P.amBase = colors.length;
    for (s = 0; s < SEQ; s++) add(ramp(amStops, s / (SEQ - 1)));
    P.neutralId = add(neutral);
    P.lineNeutralId = add([neutral[0], neutral[1], neutral[2], dark ? 0.55 : 0.7]);
    P.missingId = add(dark ? [70, 76, 88, 1] : [205, 209, 215, 1]);
    P.colors = colors;
    P.fill = colors.map(function(c) { return css(c); });
    // a lightly tinted plate behind a glyph in single-color modes
    P.tint = colors.map(function(c) { return css(mix(dark ? [24, 30, 40, 1] : [255, 255, 255, 1], c, dark ? 0.24 : 0.22), dark ? 0.85 : 0.95); });
    P.plate = css(plate);
    P.plateEdge = css(plateEdge);
    P.fgCss = css(fg);
    P.mutedCss = css(muted);
    P.accentCss = css(accent);
    P.bgCss = css(bg);
    P.lineNeutral = css(neutral, dark ? 0.5 : 0.6);
    return P;
  };

  // signed value -> diverging color id
  A.divId = function(P, v, scale) {
    if (!(v === v) || v === 0) return P.divBase + DIV;
    var t = Math.min(1, Math.abs(v) / scale);
    var k = Math.max(1, Math.round(Math.pow(t, 0.8) * DIV));
    return P.divBase + DIV + (v > 0 ? k : -k);
  };
  A.seqId = function(base, t) {
    return base + Math.max(0, Math.min(SEQ - 1, Math.round(t * (SEQ - 1))));
  };

  // ------------------------------------------------------------------ glyph geometry

  // Helix bundle seen from the extracellular side: TM1..TM7 counterclockwise, TM3 near the
  // center, H8 as a bar beside TM7 and TM1. Unit radius; y points up (flipped when drawn).
  (function() {
    function polar(deg, r) { var a = deg * Math.PI / 180; return [Math.cos(a) * r, Math.sin(a) * r]; }
    var c = [
      polar(152, 0.63),  // TM1
      polar(207, 0.64),  // TM2
      polar(262, 0.17),  // TM3 (central)
      polar(258, 0.69),  // TM4
      polar(313, 0.64),  // TM5
      polar(10, 0.63),   // TM6
      polar(70, 0.62)    // TM7
    ];
    var h8 = polar(112, 0.93);
    c.push(h8);
    A.HELIX_XY = c;             // index 7 = H8 bar center
    A.H8_ANGLE = (112 + 90) * Math.PI / 180;  // the bar lies along the ring
  })();

  A.discRadius = function(abs) {
    var t = Math.min(1, Math.max(0, abs) / A.SCALE.helixAbs);
    return 0.075 + 0.205 * Math.sqrt(t);
  };

  // ------------------------------------------------------------------ ordering + layouts

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // receptors grouped by ligand group (index order), then family (largest first, then name),
  // then gene symbol.
  A.familyOrder = function(data) {
    var famSize = {};
    data.receptors.forEach(function(r) { famSize[r.family] = (famSize[r.family] || 0) + 1; });
    var rs = data.receptors.slice().sort(function(a, b) {
      return a.group - b.group || famSize[b.family] - famSize[a.family] || cmp(a.family, b.family) ||
             cmp(a.symbol, b.symbol);
    });
    var blocks = [], cur = null;
    rs.forEach(function(r) {
      if (!cur || cur.family !== r.family || cur.group !== r.group) {
        cur = { family: r.family, group: r.group, members: [] };
        blocks.push(cur);
      }
      cur.members.push(r);
    });
    return { order: rs, blocks: blocks };
  };

  // Each layout: { key, xy: Float32Array(2n) world, s: glyph radius (world), order: delay rank 0..1,
  //   bounds: [x0,y0,x1,y1], deco: {...} }
  var SP = 2.6; // spacing between glyph centers (glyph radius 1)

  A.layoutFamilies = function(data) {
    var n = data.receptors.length, K = 4, fo = A.familyOrder(data);
    var FAM_GAP = 0.45, GROUP_GAP = 1.8;
    var slots = 0, prevGroup = -1;
    var famSlots = fo.blocks.map(function(b) {
      if (b.group !== prevGroup) { slots += prevGroup < 0 ? GROUP_GAP / 2 : GROUP_GAP; prevGroup = b.group; }
      else slots += FAM_GAP;
      var start = slots, cols = Math.ceil(b.members.length / K);
      slots += cols;
      return { start: start, cols: cols };
    });
    slots += GROUP_GAP / 2;
    var R0 = slots * SP / (2 * Math.PI);
    var xy = new Float32Array(2 * n), ord = new Float32Array(n);
    var a0 = -Math.PI / 2;
    function ang(slot) { return a0 + slot / slots * 2 * Math.PI; }
    var famDeco = [], groupDeco = [];
    fo.blocks.forEach(function(b, bi) {
      var fs = famSlots[bi];
      b.members.forEach(function(r, k) {
        var col = Math.floor(k / K), ring = k % K;
        var a = ang(fs.start + col + 0.5), rad = R0 + ring * SP;
        xy[2 * r.index] = Math.cos(a) * rad;
        xy[2 * r.index + 1] = Math.sin(a) * rad;
        ord[r.index] = (fs.start + col) / slots;
      });
      famDeco.push({ family: b.family, group: b.group, n: b.members.length,
                     a0: ang(fs.start), a1: ang(fs.start + fs.cols), rings: Math.min(K, b.members.length) });
    });
    // group arcs
    data.groups.forEach(function(g) {
      var fams = famDeco.filter(function(f) { return f.group === g.index; });
      if (!fams.length) return;
      groupDeco.push({ group: g.index, key: g.key, n: g.n, a0: fams[0].a0, a1: fams[fams.length - 1].a1 });
    });
    var Rout = R0 + (K - 1) * SP;
    var ext = Rout + 2.2;
    return { key: 'families', xy: xy, s: 1, order: ord, R0: R0, Rout: Rout, K: K,
             bounds: [-ext, -ext, ext, ext], deco: { fams: famDeco, groups: groupDeco } };
  };

  A.layoutSimilarity = function(data) {
    var R = data.receptors, n = R.length, S = 31;
    var xy = new Float32Array(2 * n), home = new Float32Array(2 * n);
    R.forEach(function(r, i) {
      var p = r.sim_xy || [0, 0];
      xy[2 * i] = home[2 * i] = p[0] * S;
      xy[2 * i + 1] = home[2 * i + 1] = -p[1] * S;
    });
    // overlap removal: pairwise push apart below the minimum distance, weak pull to home
    var minD = 2.45, cell = minD, it, i, j;
    for (it = 0; it < 220; it++) {
      var grid = {};
      for (i = 0; i < n; i++) {
        var key = Math.floor(xy[2 * i] / cell) + ',' + Math.floor(xy[2 * i + 1] / cell);
        (grid[key] || (grid[key] = [])).push(i);
      }
      var moved = 0;
      for (i = 0; i < n; i++) {
        var gx = Math.floor(xy[2 * i] / cell), gy = Math.floor(xy[2 * i + 1] / cell);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          var list = grid[(gx + dx) + ',' + (gy + dy)];
          if (!list) continue;
          for (var q = 0; q < list.length; q++) {
            j = list[q];
            if (j <= i) continue;
            var ex = xy[2 * j] - xy[2 * i], ey = xy[2 * j + 1] - xy[2 * i + 1];
            var d2 = ex * ex + ey * ey;
            if (d2 >= minD * minD) continue;
            var d = Math.sqrt(d2) || 1e-3;
            if (d2 === 0) { ex = Math.cos(i + j); ey = Math.sin(i + j); d = 1; }
            var push = (minD - d) / 2 * 0.9;
            xy[2 * i] -= ex / d * push; xy[2 * i + 1] -= ey / d * push;
            xy[2 * j] += ex / d * push; xy[2 * j + 1] += ey / d * push;
            moved++;
          }
        }
      }
      var pull = it < 160 ? 0.02 : 0;
      for (i = 0; i < 2 * n; i++) xy[i] += (home[i] - xy[i]) * pull;
      if (!moved && it > 20) break;
    }
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, cx = 0, cy = 0;
    for (i = 0; i < n; i++) { cx += xy[2 * i] / n; cy += xy[2 * i + 1] / n; }
    var ord = new Float32Array(n);
    for (i = 0; i < n; i++) {
      xy[2 * i] -= cx; xy[2 * i + 1] -= cy;
      x0 = Math.min(x0, xy[2 * i]); x1 = Math.max(x1, xy[2 * i]);
      y0 = Math.min(y0, xy[2 * i + 1]); y1 = Math.max(y1, xy[2 * i + 1]);
    }
    for (i = 0; i < n; i++) ord[i] = (xy[2 * i] - x0) / Math.max(1, x1 - x0);
    return { key: 'similarity', xy: xy, s: 1, order: ord, bounds: [x0 - 2, y0 - 2, x1 + 2, y1 + 2], deco: {} };
  };

  A.layoutRanked = function(data, metric, aspect) {
    var R = data.receptors, n = R.length;
    var asp = A.clamp(aspect || 1.6, 0.45, 3.2);
    var cols = Math.max(6, Math.round(Math.sqrt(n * asp * 1.24))), rows = Math.ceil(n / cols);
    var sorted = R.slice().sort(function(a, b) {
      return (b[metric] - a[metric]) || cmp(a.symbol, b.symbol);
    });
    var xy = new Float32Array(2 * n), ord = new Float32Array(n), rank = new Int32Array(n);
    var sx = SP * 1.05, sy = SP * 1.3;
    sorted.forEach(function(r, k) {
      var c = k % cols, row = Math.floor(k / cols);
      xy[2 * r.index] = (c - (cols - 1) / 2) * sx;
      xy[2 * r.index + 1] = (row - (rows - 1) / 2) * sy;
      ord[r.index] = k / n;
      rank[r.index] = k + 1;
    });
    var hx = (cols - 1) / 2 * sx + 2, hy = (rows - 1) / 2 * sy + 2.6;
    return { key: 'ranked', xy: xy, s: 1, order: ord, metric: metric, rank: rank,
             bounds: [-hx, -hy - 2.5, hx, hy], deco: { cols: cols, rows: rows, sx: sx, sy: sy } };
  };

  // Heat map: one row per receptor, 298 columns. Rows are 1 world unit high, columns CW wide; the
  // heat map spans x 0..m*CW. Glyphs sit at the row heads.
  var CW = 1.8;
  A.layoutFingerprints = function(data) {
    var n = data.receptors.length, m = data.layers.m, fo = A.familyOrder(data);
    var xy = new Float32Array(2 * n), ord = new Float32Array(n), rowY = new Float32Array(n);
    var y = 0, prevGroup = -1, blocks = [], groupsDeco = [], gcur = null;
    var FAM_GAP = 0.35, GROUP_GAP = 2.4;
    fo.blocks.forEach(function(b, bi) {
      if (b.group !== prevGroup) {
        if (prevGroup >= 0) y += GROUP_GAP;
        prevGroup = b.group;
        gcur = { group: b.group, y0: y, y1: y };
        groupsDeco.push(gcur);
      } else y += FAM_GAP;
      var blk = { family: b.family, group: b.group, y0: y, rows: [] };
      b.members.forEach(function(r) {
        rowY[r.index] = y;
        xy[2 * r.index] = -1.3;
        xy[2 * r.index + 1] = y + 0.5;
        blk.rows.push(r.index);
        y += 1;
      });
      blk.y1 = y;
      gcur.y1 = y;
      blocks.push(blk);
    });
    for (var i = 0; i < n; i++) ord[i] = rowY[i] / y;
    return { key: 'fingerprints', xy: xy, s: 0.42, order: ord, rowY: rowY, height: y, m: m, cw: CW,
             bounds: [-3, -1, m * CW + 1, y + 1], deco: { blocks: blocks, groups: groupsDeco } };
  };

  // ------------------------------------------------------------------ easing

  A.easeInOut = function(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  A.easeOut = function(t) { return 1 - Math.pow(1 - t, 3); };
  A.clamp = function(v, a, b) { return v < a ? a : v > b ? b : v; };
})();
