// atlas-render.js: canvas drawing for the GPCRome Atlas (glyphs, heat map, decorations, ruler,
// the panel's large glyph and fingerprint strip). Shapes are collected per color and drawn as
// one path per color, so a frame with every glyph costs a few dozen fill calls.
(function() {
  'use strict';

  var A = window.GPCAtlas;
  var TAU = Math.PI * 2;

  // ------------------------------------------------------------------ batching

  function Buckets() { this.lists = []; this.used = []; }
  Buckets.prototype.get = function(id) {
    var l = this.lists[id];
    if (!l) l = this.lists[id] = [];
    if (!l.length) this.used.push(id);
    return l;
  };
  Buckets.prototype.reset = function() {
    for (var i = 0; i < this.used.length; i++) this.lists[this.used[i]].length = 0;
    this.used.length = 0;
  };

  function Group() {
    this.plates = [];          // x, y, r (plain plates)
    this.tplates = new Buckets(); // tinted plates by color id
    this.quads = new Buckets();
    this.discs = new Buckets();
    this.dots = new Buckets();
    this.rings = [];           // x, y, r: outlines (lens helix)
    this.any = false;
  }
  Group.prototype.reset = function() {
    this.plates.length = 0; this.rings.length = 0;
    this.tplates.reset(); this.quads.reset(); this.discs.reset(); this.dots.reset();
    this.any = false;
  };

  var ALPHA_STEPS = 5;                 // crossfade levels between the dot and the bundle glyph
  var groups = [];
  function group(level, dim) {
    var k = level * 2 + (dim ? 1 : 0);
    return groups[k] || (groups[k] = new Group());
  }

  function fillCircles(ctx, list) {
    ctx.beginPath();
    for (var k = 0; k < list.length; k += 3) {
      ctx.moveTo(list[k] + list[k + 2], list[k + 1]);
      ctx.arc(list[k], list[k + 1], list[k + 2], 0, TAU);
    }
  }
  function flushCircles(ctx, B, fills) {
    for (var u = 0; u < B.used.length; u++) {
      var id = B.used[u];
      ctx.fillStyle = fills[id];
      fillCircles(ctx, B.lists[id]);
      ctx.fill();
    }
  }
  function flushQuads(ctx, B, fills) {
    for (var u = 0; u < B.used.length; u++) {
      var id = B.used[u], l = B.lists[id];
      ctx.fillStyle = fills[id];
      ctx.beginPath();
      for (var k = 0; k < l.length; k += 8) {
        ctx.moveTo(l[k], l[k + 1]); ctx.lineTo(l[k + 2], l[k + 3]);
        ctx.lineTo(l[k + 4], l[k + 5]); ctx.lineTo(l[k + 6], l[k + 7]);
        ctx.closePath();
      }
      ctx.fill();
    }
  }
  function quad(list, x1, y1, x2, y2, w) {
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len * w / 2, ny = dx / len * w / 2;
    list.push(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny);
  }

  // ------------------------------------------------------------------ per-palette colors

  // Color ids of each receptor's helices and helix pairs in the activation-pattern coloring.
  A.prepareColors = function(data, P) {
    data.receptors.forEach(function(r) {
      var hc = new Int16Array(8);
      for (var h = 0; h < 8; h++) hc[h] = A.divId(P, r.helix_net[h] || 0, A.SCALE.helixNet);
      r._hc = hc;
      r._pc = r.helix_pairs.map(function(p) { return A.divId(P, p[2], A.SCALE.pairNet); });
      if (!r._dr) {
        r._dr = r.helix_abs.map(function(a) { return A.discRadius(a); });
        r._pw = r.helix_pairs.map(function(p) { return 0.022 + 0.085 * Math.min(1, Math.abs(p[2]) / A.SCALE.pairNet); });
        var t = Math.min(1, (r.helix_abs[7] || 0) / A.SCALE.helixAbs);
        r._h8 = 0.05 + 0.1 * Math.sqrt(t);
        // far level: dot area proportional to the total above-threshold change, clamped
        var tc = A.clamp(r.sum_abs_above || 0, A.SCALE.dotMin, A.SCALE.dotMax);
        r._dotf = 0.95 * Math.sqrt(tc / A.SCALE.dotMax);
      }
    });
  };

  // ------------------------------------------------------------------ glyphs

  // G: frame description built by atlas.js:
  //   ctx, P, data, n, X, Y, S (screen x, y, radius per receptor), vis (Uint8Array),
  //   colorOf(i) -> { scalar: id or -1, dot: id, dim: bool, lensHelix: -1..7 }
  A.drawGlyphs = function(G) {
    var ctx = G.ctx, P = G.P, R = G.data.receptors, HXY = A.HELIX_XY;
    var i, g;
    for (i = 0; i < groups.length; i++) if (groups[i]) groups[i].reset();
    var used = [];
    for (i = 0; i < G.n; i++) {
      if (!G.vis[i]) continue;
      var S = G.S[i], X = G.X[i], Y = G.Y[i], r = R[i], col = G.colors[i];
      // 0 = dot only .. ALPHA_STEPS = bundle only
      var lv = Math.round(A.clamp((S - 4.2) / 2.6, 0, 1) * ALPHA_STEPS);
      g = group(lv, col.dim);
      if (!g.any) { g.any = true; used.push(lv * 2 + (col.dim ? 1 : 0)); }
      if (lv < ALPHA_STEPS) {
        g.dots.get(col.dot).push(X, Y, Math.max(1.2, S * r._dotf));
      }
      if (lv > 0) {
        if (col.scalar >= 0) g.tplates.get(col.scalar).push(X, Y, S);
        else g.plates.push(X, Y, S);
        var sc = S * 0.9, pairs = r.helix_pairs, k, a, b;
        for (k = 0; k < pairs.length; k++) {
          a = HXY[pairs[k][0]]; b = HXY[pairs[k][1]];
          quad(g.quads.get(col.scalar >= 0 ? P.lineNeutralId : r._pc[k]),
               X + a[0] * sc, Y - a[1] * sc, X + b[0] * sc, Y - b[1] * sc, Math.max(0.6, r._pw[k] * S));
        }
        // H8 bar
        var c8 = HXY[7], L = 0.2, ca = Math.cos(A.H8_ANGLE), sa = Math.sin(A.H8_ANGLE);
        quad(g.quads.get(col.scalar >= 0 ? (col.lensHelix === 7 ? col.scalar : P.neutralId) : r._hc[7]),
             X + (c8[0] - ca * L) * sc, Y - (c8[1] - sa * L) * sc,
             X + (c8[0] + ca * L) * sc, Y - (c8[1] + sa * L) * sc, Math.max(0.8, r._h8 * sc));
        for (k = 0; k < 7; k++) {
          var id;
          if (col.scalar < 0) id = r._hc[k];
          else if (col.lensHelix >= 0) id = k === col.lensHelix ? col.scalar : P.neutralId;
          else id = col.scalar;
          var rr = Math.max(0.5, r._dr[k] * sc);
          g.discs.get(id).push(X + HXY[k][0] * sc, Y - HXY[k][1] * sc, rr);
          if (k === col.lensHelix && S > 9) g.rings.push(X + HXY[k][0] * sc, Y - HXY[k][1] * sc, rr + Math.max(1, S * 0.03));
        }
        if (col.lensHelix === 7 && S > 9) g.rings.push(X + c8[0] * sc, Y - c8[1] * sc, Math.max(2, S * 0.2));
      }
    }
    used.sort(function(a, b) { return (b & 1) - (a & 1) || a - b; }); // dimmed first, underneath
    for (var u = 0; u < used.length; u++) {
      var key = used[u], lvl = key >> 1, dim = key & 1;
      g = groups[key];
      var aB = lvl / ALPHA_STEPS, aD = 1 - aB, base = dim ? (P.dark ? 0.2 : 0.22) : 1;
      if (g.dots.used.length && aD > 0) {
        ctx.globalAlpha = base * aD;
        flushCircles(ctx, g.dots, P.fill);
      }
      if (aB > 0) {
        ctx.globalAlpha = base * aB;
        if (g.plates.length) {
          ctx.fillStyle = P.plate;
          fillCircles(ctx, g.plates);
          ctx.fill();
          ctx.strokeStyle = P.plateEdge; ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (g.tplates.used.length) {
          flushCircles(ctx, g.tplates, P.tint);
          ctx.strokeStyle = P.plateEdge; ctx.lineWidth = 1;
          for (var t = 0; t < g.tplates.used.length; t++) {
            fillCircles(ctx, g.tplates.lists[g.tplates.used[t]]); ctx.stroke();
          }
        }
        flushQuads(ctx, g.quads, P.fill);
        flushCircles(ctx, g.discs, P.fill);
        if (g.rings.length) {
          ctx.strokeStyle = P.fgCss; ctx.lineWidth = 1.4;
          ctx.beginPath();
          for (var q = 0; q < g.rings.length; q += 3) {
            ctx.moveTo(g.rings[q] + g.rings[q + 2], g.rings[q + 1]);
            ctx.arc(g.rings[q], g.rings[q + 1], g.rings[q + 2], 0, TAU);
          }
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  };

  // ------------------------------------------------------------------ heat map images

  // One canvas, m x n pixels, a pixel per (receptor, position). rows: receptor index per row.
  A.buildHeat = function(data, P, layer, rows) {
    var L = data.layers, n = L.n, m = L.m;
    var cv = document.createElement('canvas');
    cv.width = m; cv.height = n;
    var cx = cv.getContext('2d'), img = cx.createImageData(m, n), px = img.data;
    var base = P.heatBase;
    var act = P.act, ina = P.ina;
    for (var row = 0; row < n; row++) {
      var i = rows ? rows[row] : row;
      for (var j = 0; j < m; j++) {
        var k = i * m + j, o = (row * m + j) * 4, c;
        if (L.aa[k] === 45) { px[o + 3] = 0; continue; }
        if (layer === 'net') {
          var v = L.net[k] / L.netScale;
          var t = Math.pow(Math.min(1, Math.abs(v) / A.SCALE.posNet), 0.8);
          if (!L.hit[k]) t *= 0.26;
          c = v === 0 ? base : A.mix(base, v > 0 ? act : ina, t);
        } else if (layer === 'cons') {
          c = L.cons[k] === 255 ? base : A.ramp(P.consStops, L.cons[k] / 100);
        } else {
          c = L.am[k] === 255 ? base : A.ramp(P.amStops, L.am[k] / 100);
        }
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return cv;
  };

  // ------------------------------------------------------------------ halo sprites

  A.buildHalos = function(groupsList, P, strength) {
    return groupsList.map(function(g) {
      var c = document.createElement('canvas'), s = 96;
      c.width = c.height = s;
      var x = c.getContext('2d'), col = A.parseColor(g.color);
      var grd = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      var a = (P.dark ? 0.12 : 0.12) * (strength || 1);
      grd.addColorStop(0, A.css(col, a));
      grd.addColorStop(0.5, A.css(col, a * 0.45));
      grd.addColorStop(1, A.css(col, 0));
      x.fillStyle = grd;
      x.fillRect(0, 0, s, s);
      return c;
    });
  };

  // ------------------------------------------------------------------ text helpers

  A.haloText = function(ctx, text, x, y, P, color, halo) {
    ctx.lineWidth = halo == null ? 3 : halo;
    ctx.strokeStyle = P.dark ? 'rgba(9,13,20,0.85)' : 'rgba(250,250,248,0.92)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color || P.fgCss;
    ctx.fillText(text, x, y);
  };

  // ------------------------------------------------------------------ the panel's large glyph

  A.drawBigGlyph = function(canvas, r, P, lensHelix) {
    var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 220, h = canvas.clientHeight || 220;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var X = w / 2, Y = h / 2, S = Math.min(w, h) / 2 - 10, sc = S * 0.9, HXY = A.HELIX_XY;
    ctx.fillStyle = P.plate; ctx.strokeStyle = P.plateEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(X, Y, S, 0, TAU); ctx.fill(); ctx.stroke();
    r.helix_pairs.forEach(function(p, k) {
      var a = HXY[p[0]], b = HXY[p[1]], l = [];
      quad(l, X + a[0] * sc, Y - a[1] * sc, X + b[0] * sc, Y - b[1] * sc, Math.max(1, r._pw[k] * S));
      ctx.fillStyle = P.fill[r._pc[k]];
      ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(l[2], l[3]); ctx.lineTo(l[4], l[5]); ctx.lineTo(l[6], l[7]); ctx.fill();
    });
    var c8 = HXY[7], L = 0.2, ca = Math.cos(A.H8_ANGLE), sa = Math.sin(A.H8_ANGLE), l8 = [];
    quad(l8, X + (c8[0] - ca * L) * sc, Y - (c8[1] - sa * L) * sc, X + (c8[0] + ca * L) * sc, Y - (c8[1] + sa * L) * sc, r._h8 * sc);
    ctx.fillStyle = P.fill[r._hc[7]];
    ctx.beginPath(); ctx.moveTo(l8[0], l8[1]); ctx.lineTo(l8[2], l8[3]); ctx.lineTo(l8[4], l8[5]); ctx.lineTo(l8[6], l8[7]); ctx.fill();
    ctx.font = '600 11px ' + (getComputedStyle(document.body).fontFamily || 'system-ui');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var k = 0; k < 7; k++) {
      var x = X + HXY[k][0] * sc, y = Y - HXY[k][1] * sc, rr = r._dr[k] * sc;
      ctx.fillStyle = P.fill[r._hc[k]];
      ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
      if (k === lensHelix) {
        ctx.strokeStyle = P.fgCss; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, rr + 3, 0, TAU); ctx.stroke();
      }
      // helix number: inside a large disc, beside a small one
      var big = rr > 13;
      var lx = big ? x : x + (HXY[k][0] * sc) / (Math.hypot(HXY[k][0], HXY[k][1]) * sc || 1) * (rr + 9);
      var ly = big ? y : y - (HXY[k][1] * sc) / (Math.hypot(HXY[k][0], HXY[k][1]) * sc || 1) * (rr + 9);
      if (k === 2 && !big) { lx = x; ly = y - rr - 8; }
      A.haloText(ctx, String(k + 1), lx, ly, P, big ? '#fff' : P.mutedCss, big ? 0 : 3);
    }
    var hx = X + c8[0] * sc, hy = Y - c8[1] * sc;
    A.haloText(ctx, '8', hx + 12, hy - 8, P, P.mutedCss);
    if (lensHelix === 7) {
      ctx.strokeStyle = P.fgCss; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, r._h8 * sc + 8, 0, TAU); ctx.stroke();
    }
  };

  // ------------------------------------------------------------------ fingerprint strip (panel)

  // Draws one receptor's row (from the net heat image, rows by receptor index) with segment
  // labels and the lens marker. Returns the x layout for hit testing.
  A.drawStrip = function(canvas, data, heatByIndex, i, P, lens, hoverCol) {
    var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 300, h = canvas.clientHeight || 44;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var m = data.layers.m, sh = 22, top = 4, cw = w / m;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.04)' : 'rgba(31,35,40,0.04)';
    ctx.fillRect(0, top, w, sh);
    ctx.drawImage(heatByIndex, 0, i, m, 1, 0, top, w, sh);
    ctx.font = '10px ' + (getComputedStyle(document.body).fontFamily || 'system-ui');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    data.segRuns.forEach(function(run, k) {
      var x0 = run.start * cw, x1 = (run.end + 1) * cw;
      if (k) { ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.35)' : 'rgba(31,35,40,0.35)'; ctx.fillRect(Math.round(x0) - 0.5, top - 2, 1, sh + 4); }
      if (/^TM|H8/.test(run.seg) && x1 - x0 > 16) {
        ctx.fillStyle = P.mutedCss;
        ctx.fillText(run.seg.replace('TM', ''), (x0 + x1) / 2, top + sh + 4);
      }
    });
    function mark(j, strong) {
      var x = (j + 0.5) * cw;
      ctx.fillStyle = strong ? P.fgCss : P.mutedCss;
      ctx.fillRect(Math.round(x) - 1, top - 3, 2, sh + 6);
    }
    if (hoverCol >= 0) mark(hoverCol, false);
    if (lens >= 0) mark(lens, true);
    return { cw: cw };
  };

  // ------------------------------------------------------------------ ruler

  // Bars per position: receptors with an above-threshold change there, n_up up (red), n_down down
  // (blue). Returns the x of each column center for hit testing.
  A.drawRuler = function(canvas, data, P, lens, hover) {
    var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var pos = data.positions, m = pos.length, runs = data.segRuns;
    var gap = w < 500 ? 2 : 4, pad = 4;
    var cw = (w - 2 * pad - gap * (runs.length - 1)) / m;
    var xs = new Float32Array(m), x = pad;
    runs.forEach(function(run, k) {
      if (k) x += gap;
      for (var j = run.start; j <= run.end; j++) { xs[j] = x + cw / 2; x += cw; }
      run.x0 = xs[run.start] - cw / 2; run.x1 = xs[run.end] + cw / 2;
    });
    var labelH = 13, mid = Math.round((h - labelH) / 2), half = mid - 2, maxN = 1;
    pos.forEach(function(p) { maxN = Math.max(maxN, p.n_up, p.n_down); });
    // segment backdrop for helices
    runs.forEach(function(run) {
      if (/^TM|H8/.test(run.seg)) {
        ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.035)' : 'rgba(31,35,40,0.035)';
        ctx.fillRect(run.x0, 1, run.x1 - run.x0, h - labelH - 2);
      }
    });
    var bw = Math.max(1, cw - (cw > 3 ? 1 : 0));
    ctx.fillStyle = P.fill[P.divBase + A.DIV * 2];
    pos.forEach(function(p, j) {
      var hh = p.n_up / maxN * half;
      if (hh > 0) ctx.fillRect(xs[j] - bw / 2, mid - hh, bw, hh);
    });
    ctx.fillStyle = P.fill[P.divBase];
    pos.forEach(function(p, j) {
      var hh = p.n_down / maxN * half;
      if (hh > 0) ctx.fillRect(xs[j] - bw / 2, mid + 1, bw, hh);
    });
    ctx.fillStyle = P.dark ? 'rgba(255,255,255,0.25)' : 'rgba(31,35,40,0.25)';
    ctx.fillRect(pad, mid, w - 2 * pad, 1);
    ctx.font = '10px ' + (getComputedStyle(document.body).fontFamily || 'system-ui');
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = P.mutedCss;
    runs.forEach(function(run) {
      var label = run.seg, wd = run.x1 - run.x0;
      if (wd < ctx.measureText(label).width + 2) {
        if (/^TM/.test(label) && wd > 8) label = label.slice(2); else return;
      }
      ctx.fillText(label, (run.x0 + run.x1) / 2, h - 1);
    });
    function marker(j, strong) {
      var xx = xs[j];
      ctx.fillStyle = strong ? P.fgCss : P.mutedCss;
      ctx.globalAlpha = strong ? 1 : 0.8;
      ctx.fillRect(Math.round(xx) - 1, 0, 2, h - labelH);
      ctx.beginPath();
      ctx.moveTo(xx - 5, 0); ctx.lineTo(xx + 5, 0); ctx.lineTo(xx, 6); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (hover >= 0 && hover !== lens) marker(hover, false);
    if (lens >= 0) marker(lens, true);
    return { xs: xs, cw: cw, gap: gap };
  };

  // small legend glyph: numbered helix layout
  A.drawKeyGlyph = function(canvas, P) {
    var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 64, h = canvas.clientHeight || 64;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var X = w / 2, Y = h / 2, S = Math.min(w, h) / 2 - 2, sc = S * 0.9, HXY = A.HELIX_XY;
    ctx.fillStyle = P.plate; ctx.strokeStyle = P.plateEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(X, Y, S, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.font = '600 9px ' + (getComputedStyle(document.body).fontFamily || 'system-ui');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var c8 = HXY[7], L = 0.2, ca = Math.cos(A.H8_ANGLE), sa = Math.sin(A.H8_ANGLE), l8 = [];
    quad(l8, X + (c8[0] - ca * L) * sc, Y - (c8[1] - sa * L) * sc, X + (c8[0] + ca * L) * sc, Y - (c8[1] + sa * L) * sc, 0.1 * sc);
    ctx.fillStyle = P.fill[P.neutralId];
    ctx.beginPath(); ctx.moveTo(l8[0], l8[1]); ctx.lineTo(l8[2], l8[3]); ctx.lineTo(l8[4], l8[5]); ctx.lineTo(l8[6], l8[7]); ctx.fill();
    for (var k = 0; k < 7; k++) {
      var x = X + HXY[k][0] * sc, y = Y - HXY[k][1] * sc;
      ctx.fillStyle = P.fill[P.neutralId];
      ctx.beginPath(); ctx.arc(x, y, 0.2 * sc, 0, TAU); ctx.fill();
      ctx.fillStyle = P.fgCss;
      ctx.fillText(String(k + 1), x, y + 0.5);
    }
  };
})();
