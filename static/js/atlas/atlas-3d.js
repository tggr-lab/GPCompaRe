/* atlas-3d.js: the receptor 3D view of the GPCRome Atlas page.

   A small Canvas 2D renderer with no dependencies. It draws one receptor as a
   smooth backbone tube and morphs it between the inactive and the active model.

     var h = GPCAtlas3D.mount(container, {
       dataUrl: 'atlas/r/',          // fetched as <dataUrl><gid>.json, nothing else
       gid: 'adrb2_human',           // optional first receptor
       onResidueHover: fn(resNum|null),
       onResidueClick: fn(resNum),
       onMorph: fn(t),               // optional: t while play() runs
       labelFor: fn(gid) -> 'ADRB2'  // optional: name used in the aria-label
     });
     h.setReceptor(gid)  -> Promise (true when shown, false when superseded by a
                            later call; rejects when the file cannot be read)
     h.setMorph(t)       0 = inactive model, 1 = active model (stops play)
     h.play(bool)        calm eased back-and-forth loop
     h.setHighlight(resNum|null)
     h.setContactsVisible(bool)
     h.theme()           re-read the CSS colors (also on html[data-color-mode]
                         changes and on a 'gpc:theme' event on document)
     h.resize(); h.destroy()

   Geometry. Coordinates arrive in 0.1 A, superposed, +y = extracellular side.
   Helices (TM1..TM7, H8) are drawn along a smoothed helix axis (a weighted
   five-residue average of the C-alphas), loops and termini through the
   C-alphas themselves; both through a Catmull-Rom spline with SUB samples per
   residue. The spline is linear in its control points, so the morph is a
   linear blend of two precomputed sample sets.

   Drawing. Segments are bucketed into depth slabs and painted back to front;
   inside a slab all outlines go first, then the bodies, then a thin highlight
   stripe, so the tube reads as one continuous shaded cylinder. Color blends
   toward the panel background with depth (fog). Long disordered loops and
   termini are thin, translucent and fade out away from the TM bundle; the
   view is framed on the bundle only.

   Colors. Contacts: --semantic-active (red, stronger in the active model) and
   --semantic-inactive (blue, stronger in the inactive model). The movement
   tint uses a warm amber (override with --atlas-motion), never red or blue. */
(function () {
  'use strict';
  if (window.GPCAtlas3D) return;

  var HELICES = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'];
  var SUB = 4;                 // spline samples per residue
  var NSLAB = 32;              // depth slabs
  var MAX_CONTACTS = 60;
  var TINT = 8;                // movement tint levels
  var FAINT_ALPHA = [0.05, 0.09, 0.14, 0.2, 0.28];
  var HELIX_D = 3.6, LOOP_D = 1.2, FAINT_D = 0.8;   // tube diameters, A
  var MOVE_MS = 3000, HOLD_MS = 900;
  var CACHE_MAX = 8;

  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reducedMotion() { return !!(reduceMQ && reduceMQ.matches); }
  function numAsc(a, b) { return a - b; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstep(a, b, x) { var u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); }
  function easeInOutSine(u) { return 0.5 - 0.5 * Math.cos(Math.PI * u); }

  // ------------------------------------------------------------------ colors
  var probe = null;
  function parseColor(str, fallback) {
    str = (str || '').trim();
    if (str) {
      if (!probe) probe = document.createElement('canvas').getContext('2d');
      probe.fillStyle = '#010203';
      probe.fillStyle = str;
      var v = String(probe.fillStyle);
      if (!(v === '#010203' && str.toLowerCase() !== '#010203')) {
        if (v.charAt(0) === '#' && v.length === 7) {
          return [parseInt(v.substr(1, 2), 16), parseInt(v.substr(3, 2), 16), parseInt(v.substr(5, 2), 16), 1];
        }
        var m = v.match(/rgba?\(([^)]+)\)/);
        if (m) {
          var p = m[1].split(',').map(parseFloat);
          return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
        }
      }
    }
    return fallback ? parseColor(fallback) : null;
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];
  }
  function css(c, alpha) {
    var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
    if (alpha === undefined || alpha >= 1) return 'rgb(' + r + ',' + g + ',' + b + ')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.round(alpha * 1000) / 1000) + ')';
  }
  function luminance(c) { return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  var WHITE = [255, 255, 255, 1];

  // ------------------------------------------------------------ model prep
  function percentile(arr, q) {
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    return a[clamp(Math.round(q * (a.length - 1)), 0, a.length - 1)];
  }

  function helixAxis(src, hel, n) {
    var out = new Float32Array(src);
    var i = 0;
    while (i < n) {
      if (hel[i] < 0) { i++; continue; }
      var s = i, h = hel[i];
      while (i < n && hel[i] === h) i++;
      var e = i - 1;
      if (e - s + 1 < 6) continue;
      var a = s + 2, b = e - 2, j, k, c;
      for (j = a; j <= b; j++) {
        for (c = 0; c < 3; c++) {
          out[j * 3 + c] = (src[(j - 2) * 3 + c] + 2 * src[(j - 1) * 3 + c] + 2 * src[j * 3 + c] +
                            2 * src[(j + 1) * 3 + c] + src[(j + 2) * 3 + c]) / 8;
        }
      }
      // extrapolate the two residues at each end along the local axis
      var ends = [[a, Math.min(a + 3, b), -1], [b, Math.max(b - 3, a), 1]];
      for (k = 0; k < 2; k++) {
        var p = ends[k][0], q = ends[k][1], sgn = ends[k][2];
        if (p === q) continue;
        var dx = out[p * 3] - out[q * 3], dy = out[p * 3 + 1] - out[q * 3 + 1], dz = out[p * 3 + 2] - out[q * 3 + 2];
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        var rise = len / Math.abs(p - q);
        dx /= len; dy /= len; dz /= len;
        for (j = 1; j <= 2; j++) {
          var t = p + sgn * j;
          out[t * 3] = out[p * 3] + dx * rise * j;
          out[t * 3 + 1] = out[p * 3 + 1] + dy * rise * j;
          out[t * 3 + 2] = out[p * 3 + 2] + dz * rise * j;
        }
      }
    }
    return out;
  }

  function spline(P, n) {
    var M = (n - 1) * SUB + 1, out = new Float32Array(M * 3), w = 0;
    for (var i = 0; i < n - 1; i++) {
      var i0 = Math.max(i - 1, 0) * 3, i1 = i * 3, i2 = (i + 1) * 3, i3 = Math.min(i + 2, n - 1) * 3;
      for (var s = 0; s < SUB; s++) {
        var u = s / SUB, u2 = u * u, u3 = u2 * u;
        var c0 = -0.5 * u3 + u2 - 0.5 * u, c1 = 1.5 * u3 - 2.5 * u2 + 1,
            c2 = -1.5 * u3 + 2 * u2 + 0.5 * u, c3 = 0.5 * u3 - 0.5 * u2;
        for (var c = 0; c < 3; c++) {
          out[w * 3 + c] = c0 * P[i0 + c] + c1 * P[i1 + c] + c2 * P[i2 + c] + c3 * P[i3 + c];
        }
        w++;
      }
    }
    out[w * 3] = P[(n - 1) * 3]; out[w * 3 + 1] = P[(n - 1) * 3 + 1]; out[w * 3 + 2] = P[(n - 1) * 3 + 2];
    return out;
  }

  function prepare(data, gid) {
    var res = data && data.residues, n = res ? res.length : 0;
    if (n < 4 || !data.active || !data.inactive || data.active.length < n * 3 || data.inactive.length < n * 3) {
      throw new Error('This model file is incomplete.');
    }
    var idx = {}, i, j, c;
    for (i = 0; i < n; i++) idx[res[i]] = i;
    var A = new Float32Array(n * 3), I = new Float32Array(n * 3);
    for (i = 0; i < n * 3; i++) { A[i] = data.active[i] / 10; I[i] = data.inactive[i] / 10; }

    var seg = new Array(n), hel = new Int8Array(n);
    for (i = 0; i < n; i++) { hel[i] = -1; seg[i] = ''; }
    (data.segments || []).forEach(function (s) {
      var h = HELICES.indexOf(s[0]);
      for (var r = s[1]; r <= s[2]; r++) {
        var k = idx[r];
        if (k !== undefined) { seg[k] = s[0]; if (h >= 0) hel[k] = h; }
      }
    });

    // sequence distance to the nearest helix residue
    var kd = new Float32Array(n), last = -1e9;
    for (i = 0; i < n; i++) { if (hel[i] >= 0) last = i; kd[i] = i - last; }
    last = 1e9;
    for (i = n - 1; i >= 0; i--) { if (hel[i] >= 0) last = i; kd[i] = Math.min(kd[i], last - i); }

    var kind = new Uint8Array(n), alpha = new Float32Array(n);
    for (i = 0; i < n; i++) {
      if (hel[i] >= 0) { kind[i] = 0; alpha[i] = 1; continue; }
      var term = seg[i] === 'N-term' || seg[i] === 'C-term' || seg[i] === '';
      var lim = term ? 4 : 14;
      if (kd[i] <= lim) { kind[i] = 1; alpha[i] = 1; }
      else { kind[i] = 2; alpha[i] = 0.24 * Math.exp(-(kd[i] - lim) / 30) + 0.05; }
    }

    // framing on the TM bundle (helices and loop residues next to them)
    var fx = [], fy = [], fz = [];
    for (i = 0; i < n; i++) {
      if (kind[i] === 0 || (kind[i] === 1 && kd[i] <= 6)) {
        fx.push(A[i * 3], I[i * 3]); fy.push(A[i * 3 + 1], I[i * 3 + 1]); fz.push(A[i * 3 + 2], I[i * 3 + 2]);
      }
    }
    if (fx.length < 8) {
      for (i = 0; i < n; i++) { fx.push(A[i * 3], I[i * 3]); fy.push(A[i * 3 + 1], I[i * 3 + 1]); fz.push(A[i * 3 + 2], I[i * 3 + 2]); }
    }
    var cx = (percentile(fx, 0.02) + percentile(fx, 0.98)) / 2;
    var cy = (percentile(fy, 0.01) + percentile(fy, 0.99)) / 2;
    var cz = (percentile(fz, 0.02) + percentile(fz, 0.98)) / 2;
    var rh = [], r3 = [];
    for (i = 0; i < fx.length; i++) {
      var ddx = fx[i] - cx, ddy = fy[i] - cy, ddz = fz[i] - cz;
      rh.push(Math.sqrt(ddx * ddx + ddz * ddz)); r3.push(Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz));
    }
    var Rh = Math.max(8, percentile(rh, 0.985));
    var Ry = Math.max(10, Math.max(percentile(fy, 0.99) - cy, cy - percentile(fy, 0.01)));
    var R3 = Math.max(12, percentile(r3, 0.985));
    for (i = 0; i < n; i++) {
      A[i * 3] -= cx; A[i * 3 + 1] -= cy; A[i * 3 + 2] -= cz;
      I[i * 3] -= cx; I[i * 3 + 1] -= cy; I[i * 3 + 2] -= cz;
    }

    // terminus fade away from the bundle
    for (i = 0; i < n; i++) {
      if (kind[i] !== 2) continue;
      var dmax = 0;
      for (var st = 0; st < 2; st++) {
        var Q = st ? I : A;
        dmax = Math.max(dmax, Math.sqrt(Q[i * 3] * Q[i * 3] + Q[i * 3 + 1] * Q[i * 3 + 1] + Q[i * 3 + 2] * Q[i * 3 + 2]));
      }
      alpha[i] *= 1 - smoothstep(1.0 * R3, 1.65 * R3, dmax);
    }

    var axA = helixAxis(A, hel, n), axI = helixAxis(I, hel, n);
    var sA = spline(axA, n), sI = spline(axI, n);
    var M = (n - 1) * SUB + 1;

    // movement per residue (axis for helices, C-alpha elsewhere)
    var tintF = new Float32Array(n), move = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var P = kind[i] === 0 ? axA : A, Q2 = kind[i] === 0 ? axI : I, d2 = 0;
      for (c = 0; c < 3; c++) { var dd = P[i * 3 + c] - Q2[i * 3 + c]; d2 += dd * dd; }
      move[i] = Math.sqrt(d2);
      tintF[i] = kind[i] === 2 ? 0 : smoothstep(1.5, 8, move[i]);
    }

    // per segment attributes, at full sampling (stride 1) and at half
    // sampling (stride 2, used while animating on a slow device)
    function buildLevel(stride) {
      var nseg = (M - 1) / stride;
      var L = { stride: stride, nseg: nseg, res: new Uint16Array(nseg), kind: new Uint8Array(nseg),
                alphaLvl: new Int8Array(nseg), par: new Uint8Array(nseg),
                slabOf: new Uint8Array(nseg), order: new Uint32Array(nseg), start: new Int32Array(NSLAB + 1) };
      for (var q = 0; q < nseg; q++) {
        var r0 = Math.min(n - 1, Math.round((q * stride + stride * 0.5) / SUB));
        L.res[q] = r0; L.kind[q] = kind[r0]; L.par[q] = hel[r0] >= 0 ? (hel[r0] % 2) : 0;
        if (kind[r0] === 2) {
          var lv = -1;
          for (var f = 0; f < FAINT_ALPHA.length; f++) if (alpha[r0] >= FAINT_ALPHA[f] * 0.75) lv = f;
          L.alphaLvl[q] = lv;
        }
      }
      return L;
    }

    // contacts: the strongest MAX_CONTACTS by |dRRCS|
    var cl = [];
    (data.contacts || []).forEach(function (ct) {
      var ia = idx[ct[0]], ib = idx[ct[1]];
      if (ia === undefined || ib === undefined || !isFinite(ct[2]) || ct[2] === 0) return;
      cl.push({ ia: ia, ib: ib, d: +ct[2] });
    });
    cl.forEach(function (ct) {
      var fa = kind[ct.ia] === 2 ? alpha[ct.ia] * 2.5 : 1, fb = kind[ct.ib] === 2 ? alpha[ct.ib] * 2.5 : 1;
      ct.fade = clamp(Math.min(fa, fb), 0, 1);
      ct.w = 0.35 + 0.85 * clamp(Math.abs(ct.d) / 8, 0, 1);
    });
    // the strongest contacts in the framed part (helices and the loops next
    // to them) first; contacts inside faded termini only fill remaining slots
    cl.sort(function (a, b) {
      var va = a.fade >= 0.5 ? 1 : 0, vb = b.fade >= 0.5 ? 1 : 0;
      return (vb - va) || (Math.abs(b.d) - Math.abs(a.d));
    });
    cl = cl.slice(0, MAX_CONTACTS);

    // helix labels: anchor beyond the extracellular end (H8: its C-terminal end)
    var labels = [];
    for (var h = 0; h < 8; h++) {
      var s0 = -1, e0 = -1;
      for (i = 0; i < n; i++) if (hel[i] === h) { if (s0 < 0) s0 = i; e0 = i; }
      if (s0 < 0 || e0 - s0 < 3) continue;
      var end, inner;
      if (h === 7) { end = e0; inner = Math.max(s0, e0 - 4); }
      else {
        var ys = (sA[s0 * SUB * 3 + 1] + sI[s0 * SUB * 3 + 1]) / 2, ye = (sA[e0 * SUB * 3 + 1] + sI[e0 * SUB * 3 + 1]) / 2;
        if (ys >= ye) { end = s0; inner = Math.min(e0, s0 + 4); } else { end = e0; inner = Math.max(s0, e0 - 4); }
      }
      labels.push({ name: HELICES[h], end: end, inner: inner });
    }

    // default yaw: put the TM6 movement (intracellular half) across the screen
    var vx = 0, vz = 0, nv = 0;
    for (i = 0; i < n; i++) {
      if (hel[i] === 5 && (axA[i * 3 + 1] + axI[i * 3 + 1]) < 0) {
        vx += axA[i * 3] - axI[i * 3]; vz += axA[i * 3 + 2] - axI[i * 3 + 2]; nv++;
      }
    }
    var yaw0 = -0.45;
    if (nv && Math.sqrt(vx * vx + vz * vz) / nv > 0.8) yaw0 = Math.atan2(vz, vx) - 0.55;  // TM6 front right

    return {
      gid: gid, n: n, M: M, levels: [buildLevel(1), buildLevel(2)], res: res, seg: seg, hel: hel, kind: kind, alpha: alpha,
      A: A, I: I, sA: sA, sI: sI, tintF: tintF, move: move,
      contacts: cl, labels: labels, Rh: Rh, Ry: Ry, R3: R3, yaw0: yaw0, idx: idx,
      // per-frame buffers
      px: new Float32Array(M), py: new Float32Array(M), pz: new Float32Array(M),
      cax: new Float32Array(n), cay: new Float32Array(n), caz: new Float32Array(n)
    };
  }

  // ------------------------------------------------------------------ mount
  function mount(container, opts) {
    opts = opts || {};
    var dataUrl = opts.dataUrl || 'atlas/r/';
    if (dataUrl && dataUrl.charAt(dataUrl.length - 1) !== '/') dataUrl += '/';

    var wrap = document.createElement('div');
    wrap.className = 'atlas3d';
    wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;left:0;top:0;display:block;width:100%;height:100%;touch-action:none;cursor:grab;' +
      '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', 'Receptor 3D view');
    var msg = document.createElement('div');
    msg.style.cssText = 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
      'text-align:center;padding:1rem;font-size:13px;pointer-events:none;color:var(--fgColor-muted,#59636e);';
    msg.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(msg);
    container.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    var snap = document.createElement('canvas'), snapCtx = snap.getContext('2d');
    var layer = document.createElement('canvas'), layerCtx = layer.getContext('2d');

    var W = 0, H = 0, dpr = 1, autoH = false, hoverPause = false;
    var model = null, theme = null, colorCache = {};
    var destroyed = false, raf = 0, lastT = 0, visible = true;
    var view = { yaw: -0.45, pitch: 0.24, zoom: 1, yawBase: -0.45 };
    var tween = null, inertia = { vy: 0, vp: 0 };
    var autoRot = !reducedMotion(), autoPhase = 0, interacted = false;
    var morph = 0, tintStrength = 0, contactsOn = true, contactsVis = 1;
    var playing = false, pl = null;
    var fade = null;
    var hover = -1, highlight = -1, hoverXY = null;
    var pointers = {}, drag = null, pinch = null, lastTap = null;
    var reqToken = 0, abortCtl = null, cache = {}, cacheOrder = [];
    var stateText = '', ariaBase = 'Receptor';
    var loadTimer = 0, stats = { frames: 0, drawMs: 0, maxDrawMs: 0, liteSwitches: 0 };
    var themeTimer = 0;
    // adaptive quality: when animated frames keep arriving late, draw with
    // half the spline samples and no x-ray contact pass until motion stops
    var lite = false, chained = false, ema = 16.7, slowRun = 0;

    function labelFor(gid) {
      if (typeof opts.labelFor === 'function') { try { var l = opts.labelFor(gid); if (l) return String(l); } catch (e) {} }
      return String(gid || '').replace(/_human$/, '').toUpperCase();
    }

    // ---------------------------------------------------------- theme
    function effectiveBg() {
      var el = container;
      while (el && el.nodeType === 1) {
        var c = parseColor(getComputedStyle(el).backgroundColor);
        if (c && c[3] > 0.5) return c;
        el = el.parentElement;
      }
      return null;
    }
    function readTheme() {
      var cs = getComputedStyle(container);
      var g = function (name) { return cs.getPropertyValue(name).trim(); };
      var bg = effectiveBg() || parseColor(g('--bgColor-default'), '#ffffff');
      var dark = luminance(bg) < 0.45;
      var fg = parseColor(g('--fgColor-default'), dark ? '#f0f6fc' : '#1f2328');
      theme = {
        dark: dark, bg: bg, fg: fg,
        fgMuted: parseColor(g('--fgColor-muted'), dark ? '#9198a1' : '#59636e'),
        active: parseColor(g('--semantic-active'), dark ? '#F87171' : '#B91C1C'),
        inactive: parseColor(g('--semantic-inactive'), dark ? '#60A5FA' : '#1D4ED8'),
        // teal brand color for the marked residue (the primer accent is blue, which would read as 'inactive')
        accent: parseColor(g('--brand-primary'), dark ? '#2DD4BF' : '#0D9488'),
        motion: parseColor(g('--atlas-motion'), dark ? '#FBBF24' : '#D97706'),
        tube: parseColor(g('--atlas-tube'), dark ? '#A7B0BD' : '#8E9AAA'),
        outline: dark ? mix(bg, [0, 0, 0, 1], 0.55) : parseColor('#38414D'),
        font: g('--font-ui') || 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
      };
      colorCache = {};
      requestRender();
    }
    function themeSoon() {
      readTheme();
      // the page background eases over about 240 ms; read once more after it settles
      clearTimeout(themeTimer);
      themeTimer = setTimeout(function () { if (!destroyed) readTheme(); }, 320);
    }

    function fogAt(s) { var dn = (s + 0.5) / NSLAB; return 0.6 * Math.pow(1 - dn, 1.25); }
    // pass: 0 outline, 1 body, 2 highlight, 3 faint, 4 contact active, 5 contact inactive
    function color(pass, s, kind, tint, par) {
      var key = ((((pass * NSLAB) + s) * 3 + kind) * TINT + tint) * 2 + par;
      var v = colorCache[key];
      if (v) return v;
      var T = theme, fog = fogAt(s), dn = (s + 0.5) / NSLAB, base, out;
      if (pass === 4 || pass === 5) {
        out = css(mix(pass === 4 ? T.active : T.inactive, T.bg, fog * 0.75));
      } else if (pass === 3) {
        out = css(mix(mix(T.tube, T.fgMuted, 0.35), T.bg, fog * 0.6));
      } else if (pass === 0) {
        out = css(mix(T.outline, T.bg, fog * (T.dark ? 0.5 : 0.85)));
      } else {
        base = T.tube;
        if (kind === 0 && par) base = mix(base, T.dark ? T.bg : WHITE, 0.1);
        if (kind === 1) base = mix(base, T.bg, T.dark ? 0.18 : 0.22);
        if (tint > 0) base = mix(base, T.motion, 0.92 * tint / (TINT - 1));
        base = mix(base, WHITE, (T.dark ? 0.05 : 0.1) * dn);
        if (pass === 2) base = mix(base, WHITE, T.dark ? 0.42 : 0.5);
        out = css(mix(base, T.bg, fog));
      }
      colorCache[key] = out;
      return out;
    }

    // ---------------------------------------------------------- size
    function resize() {
      if (destroyed) return;
      var r = wrap.getBoundingClientRect();
      if (r.width < 2) return;            // hidden; the ResizeObserver calls again when shown
      var w = Math.round(r.width), h;
      // a container without a height of its own gets a height from its width
      if (autoH || r.height < 2) { autoH = true; h = Math.round(w * 0.86); wrap.style.height = h + 'px'; }
      else h = Math.round(r.height);
      dpr = clamp(window.devicePixelRatio || 1, 1, 3);
      if (w === W && h === H && canvas.width === Math.round(w * dpr)) { requestRender(); return; }
      W = w; H = h;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      layer.width = canvas.width; layer.height = canvas.height;
      requestRender();
    }

    // ---------------------------------------------------------- projection
    function frameScale(m) {
      var p = view.pitch, rh = m.Rh * 1.05, ry = m.Ry * Math.cos(p) + m.Rh * Math.abs(Math.sin(p));
      var sx = (W / 2 - 18) / rh, sy = (H / 2 - 26) / (ry + 2);
      return Math.max(0.5, Math.min(sx, sy)) * view.zoom;
    }
    function project(m) {
      var t = morph, u = 1 - t;
      var cyw = Math.cos(view.yaw), syw = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      var sc = frameScale(m), D = m.R3 * 4.2, cx = W / 2, cy = H / 2 + 4;
      var sA = m.sA, sI = m.sI, px = m.px, py = m.py, pz = m.pz, i, k, x, y, z, x1, z1, y2, z2, f;
      for (i = 0, k = 0; i < m.M; i++, k += 3) {
        x = sI[k] * u + sA[k] * t; y = sI[k + 1] * u + sA[k + 1] * t; z = sI[k + 2] * u + sA[k + 2] * t;
        x1 = x * cyw + z * syw; z1 = -x * syw + z * cyw;
        y2 = y * cp - z1 * sp; z2 = y * sp + z1 * cp;
        f = D / (D - z2);
        px[i] = cx + x1 * sc * f; py[i] = cy - y2 * sc * f; pz[i] = z2;
      }
      var A = m.A, I = m.I;
      for (i = 0, k = 0; i < m.n; i++, k += 3) {
        x = I[k] * u + A[k] * t; y = I[k + 1] * u + A[k + 1] * t; z = I[k + 2] * u + A[k + 2] * t;
        x1 = x * cyw + z * syw; z1 = -x * syw + z * cyw;
        m.cax[i] = x1; m.cay[i] = y * cp - z1 * sp; m.caz[i] = y * sp + z1 * cp;
      }
      m._sc = sc; m._D = D; m._cx = cx; m._cy = cy;
    }
    function toScreen(m, x, y, z, out) {
      var f = m._D / (m._D - z);
      out[0] = m._cx + x * m._sc * f; out[1] = m._cy - y * m._sc * f; out[2] = z; out[3] = f;
      return out;
    }
    function slabIndex(m, z) {
      var Rz = m.R3 * 1.35;
      return clamp(Math.floor((z + Rz) / (2 * Rz) * NSLAB), 0, NSLAB - 1);
    }

    // ---------------------------------------------------------- scene
    var bucket = [], bucketR = [], rebody = [], tmp4 = [0, 0, 0, 0], tmp4b = [0, 0, 0, 0];
    for (var bi = 0; bi < 64; bi++) { bucket.push([]); bucketR.push([]); }
    for (var si = 0; si < NSLAB; si++) rebody.push([]);

    function strokeBucket(c, list, px, py, st) {
      if (!list.length) return;
      c.beginPath();
      var prev = -2;
      for (var q = 0; q < list.length; q++) {
        var j = list[q], a = j * st;
        if (j !== prev + 1) c.moveTo(px[a], py[a]);
        c.lineTo(px[a + st], py[a + st]);
        prev = j;
      }
      c.stroke();
    }

    function drawScene(c, m) {
      project(m);
      var Lv = m.levels[lite ? 1 : 0], st = Lv.stride;
      var px = m.px, py = m.py, pz = m.pz, nseg = Lv.nseg, j, s, q, b;
      var slabOf = Lv.slabOf, order = Lv.order, start = Lv.start;
      var segKind = Lv.kind, segRes = Lv.res, segPar = Lv.par, segAlphaLvl = Lv.alphaLvl, tintF = m.tintF;
      for (s = 0; s <= NSLAB; s++) start[s] = 0;
      for (j = 0; j < nseg; j++) { s = slabIndex(m, (pz[j * st] + pz[j * st + st]) * 0.5); slabOf[j] = s; start[s + 1]++; }
      for (s = 0; s < NSLAB; s++) { start[s + 1] += start[s]; rebody[s].length = 0; }
      var fill = new Int32Array(NSLAB);
      for (j = 0; j < nseg; j++) { s = slabOf[j]; order[start[s] + fill[s]++] = j; }
      // where the chain steps forward into slab s, the outline drawn for s
      // would cut across the tube just behind it; repaint that stretch of
      // body (about four residues) after the outline so the tube stays whole
      var K = SUB * 4 / st, kk;
      for (j = 0; j < nseg; j++) {
        if (segKind[j] === 2) continue;
        s = slabOf[j];
        if (j > 0 && slabOf[j - 1] < s) {
          for (kk = j - 1; kk >= 0 && kk >= j - K && segKind[kk] !== 2 && slabOf[kk] < s; kk--) rebody[s].push(kk);
        }
        if (j + 1 < nseg && slabOf[j + 1] < s) {
          for (kk = j + 1; kk < nseg && kk <= j + K && segKind[kk] !== 2 && slabOf[kk] < s; kk++) rebody[s].push(kk);
        }
      }

      // contacts split into pieces for depth sorting
      var cs = contactsOn || contactsVis > 0.01 ? m.contacts : [];
      var pieces = [], NP = 4;
      var ta = morph, tb = 1 - morph, cvis = contactsVis;
      for (q = 0; q < cs.length; q++) {
        var ct = cs[q], op = (ct.d > 0 ? ta : tb) * ct.fade * cvis;
        if (op < 0.02) continue;
        var ax = m.cax[ct.ia], ay = m.cay[ct.ia], az = m.caz[ct.ia];
        var bx = m.cax[ct.ib], by = m.cay[ct.ib], bz = m.caz[ct.ib];
        for (var p = 0; p < NP; p++) {
          var u0 = p / NP, u1 = (p + 1) / NP;
          toScreen(m, ax + (bx - ax) * u0, ay + (by - ay) * u0, az + (bz - az) * u0, tmp4);
          toScreen(m, ax + (bx - ax) * u1, ay + (by - ay) * u1, az + (bz - az) * u1, tmp4b);
          pieces.push({ s: slabIndex(m, (tmp4[2] + tmp4b[2]) / 2), x0: tmp4[0], y0: tmp4[1], x1: tmp4b[0], y1: tmp4b[1],
                        f: (tmp4[3] + tmp4b[3]) / 2, ct: ct, op: op });
        }
      }
      pieces.sort(function (a, b2) { return a.s - b2.s; });
      m._pieces = pieces;

      var sc = m._sc, D = m._D, Rz = m.R3 * 1.35, pi = 0;
      c.lineCap = 'round'; c.lineJoin = 'round';
      for (s = 0; s < NSLAB; s++) {
        var z = -Rz + (s + 0.5) * (2 * Rz / NSLAB), f = D / (D - z), k = sc * f;
        var wH = Math.max(2.6, HELIX_D * k), wL = Math.max(1.1, LOOP_D * k), wF = Math.max(0.7, FAINT_D * k);
        var a0 = start[s], a1 = start[s + 1];
        if (a1 > a0 || rebody[s].length) {
          // faint loops and termini: translucent, no outline
          for (b = 0; b < FAINT_ALPHA.length; b++) bucket[b].length = 0;
          for (q = a0; q < a1; q++) { j = order[q]; if (segKind[j] === 2 && segAlphaLvl[j] >= 0) bucket[segAlphaLvl[j]].push(j); }
          c.lineWidth = wF; c.strokeStyle = color(3, s, 2, 0, 0);
          for (b = 0; b < FAINT_ALPHA.length; b++) {
            if (!bucket[b].length) continue;
            c.globalAlpha = FAINT_ALPHA[b];
            strokeBucket(c, bucket[b], px, py, st);
          }
          c.globalAlpha = 1;
          // outlines
          bucket[0].length = 0; bucket[1].length = 0;
          for (q = a0; q < a1; q++) { j = order[q]; if (segKind[j] < 2) bucket[segKind[j]].push(j); }
          if (bucket[1].length) { c.lineWidth = wL + 1.6; c.strokeStyle = color(0, s, 1, 0, 0); strokeBucket(c, bucket[1], px, py, st); }
          if (bucket[0].length) { c.lineWidth = wH + 2 + 0.06 * wH; c.strokeStyle = color(0, s, 0, 0, 0); strokeBucket(c, bucket[0], px, py, st); }
          // bodies: first the stretches behind that join this slab (butt
          // ends, so they cover the outline cap but nothing beyond), then
          // this slab's own segments
          for (b = 0; b < 2 * TINT * 2; b++) { bucket[b].length = 0; bucketR[b].length = 0; }
          var addBody = function (jj, into) {
            var r = segRes[jj], kk = segKind[jj];
            var tl = Math.round(tintF[r] * tintStrength * (TINT - 1));
            into[(kk * TINT + tl) * 2 + (kk === 0 ? segPar[jj] : 0)].push(jj);
          };
          var rb = rebody[s];
          if (rb.length > 1) rb.sort(numAsc);
          for (q = 0; q < rb.length; q++) if (q === 0 || rb[q] !== rb[q - 1]) addBody(rb[q], bucketR);
          for (q = a0; q < a1; q++) { j = order[q]; if (segKind[j] < 2) addBody(j, bucket); }
          for (var pass = 0; pass < 2; pass++) {
            var bk = pass ? bucket : bucketR;
            c.lineCap = pass ? 'round' : 'butt';
            for (b = 0; b < 2 * TINT * 2; b++) {
              if (!bk[b].length) continue;
              var kk2 = Math.floor(b / (TINT * 2)), tl2 = Math.floor(b / 2) % TINT, par2 = b % 2;
              c.lineWidth = kk2 === 0 ? wH : wL;
              c.strokeStyle = color(1, s, kk2, tl2, par2);
              strokeBucket(c, bk[b], px, py, st);
            }
          }
          c.lineCap = 'round';
          // highlight stripe on the helices
          var off = wH * 0.16;
          c.save();
          c.translate(-off, -off * 0.8);
          c.lineWidth = wH * 0.3;
          for (b = 0; b < TINT * 2; b++) {
            if (!bucket[b].length && !bucketR[b].length) continue;
            c.strokeStyle = color(2, s, 0, Math.floor(b / 2), b % 2);
            strokeBucket(c, bucketR[b], px, py, st);
            strokeBucket(c, bucket[b], px, py, st);
          }
          c.restore();
        }
        // contacts in this slab (butt ends: the pieces of one contact abut
        // without doubling up their transparency)
        c.lineCap = 'butt';
        while (pi < pieces.length && pieces[pi].s === s) {
          var pc = pieces[pi++];
          c.globalAlpha = pc.op;
          c.strokeStyle = color(pc.ct.d > 0 ? 4 : 5, s, 0, 0, 0);
          c.lineWidth = Math.max(1, pc.ct.w * sc * pc.f);
          c.beginPath(); c.moveTo(pc.x0, pc.y0); c.lineTo(pc.x1, pc.y1); c.stroke();
        }
        c.globalAlpha = 1;
        c.lineCap = 'round';
      }
      c.lineCap = 'butt';
      // faint x-ray pass so contacts behind a helix stay traceable
      for (q = 0; q < (lite ? 0 : pieces.length); q++) {
        var pc2 = pieces[q];
        c.globalAlpha = pc2.op * 0.22;
        c.strokeStyle = color(pc2.ct.d > 0 ? 4 : 5, NSLAB - 1, 0, 0, 0);
        c.lineWidth = Math.max(1, pc2.ct.w * sc * pc2.f * 0.8);
        c.beginPath(); c.moveTo(pc2.x0, pc2.y0); c.lineTo(pc2.x1, pc2.y1); c.stroke();
      }
      c.globalAlpha = 1;
      c.lineCap = 'round';
    }

    // ---------------------------------------------------------- overlays
    function helixLabels(c, m) {
      var T = theme, sc = m._sc, out = [];
      for (var q = 0; q < m.labels.length; q++) {
        var L = m.labels[q], je = L.end * SUB, ji = L.inner * SUB;
        var t = morph, u = 1 - t, k1 = je * 3, k2 = ji * 3;
        var ex = m.sI[k1] * u + m.sA[k1] * t, ey = m.sI[k1 + 1] * u + m.sA[k1 + 1] * t, ez = m.sI[k1 + 2] * u + m.sA[k1 + 2] * t;
        var ix = m.sI[k2] * u + m.sA[k2] * t, iy = m.sI[k2 + 1] * u + m.sA[k2 + 1] * t, iz = m.sI[k2 + 2] * u + m.sA[k2 + 2] * t;
        var cyw = Math.cos(view.yaw), syw = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
        var x1 = ex * cyw + ez * syw, z1 = -ex * syw + ez * cyw;
        toScreen(m, x1, ey * cp - z1 * sp, ey * sp + z1 * cp, tmp4);
        var sx0 = tmp4[0], sy0 = tmp4[1], sz0 = tmp4[2];
        x1 = ix * cyw + iz * syw; z1 = -ix * syw + iz * cyw;
        toScreen(m, x1, iy * cp - z1 * sp, iy * sp + z1 * cp, tmp4b);
        // push the label past the tube end along the helix as seen on screen
        var dx = sx0 - tmp4b[0], dy = sy0 - tmp4b[1], dl = Math.sqrt(dx * dx + dy * dy);
        var reach = Math.max(3, HELIX_D * sc * 0.5) + 10;
        if (dl < 6) { dx = 0; dy = -1; } else { dx /= dl; dy /= dl; }
        out.push({ name: L.name, x: sx0 + dx * reach, y: sy0 + dy * reach, z: sz0 });
      }
      // occlusion: a helix sample in front, covering the label point
      var px = m.px, py = m.py, pz = m.pz, rad = Math.max(3, HELIX_D * sc * 0.5) + 2;
      out.forEach(function (L) {
        L.hidden = L.x < 8 || L.x > W - 8 || L.y < 8 || L.y > H - 8;
        if (L.hidden) return;
        for (var j = 0; j < m.M; j += 2) {
          if (m.kind[Math.min(m.n - 1, Math.round(j / SUB))] !== 0) continue;
          if (pz[j] > L.z + 4) {
            var ddx = px[j] - L.x, ddy = py[j] - L.y;
            if (ddx * ddx + ddy * ddy < rad * rad) { L.hidden = true; return; }
          }
        }
      });
      out.sort(function (a, b) { return b.z - a.z; });
      var shown = [];
      c.font = '600 11px ' + T.font;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineJoin = 'round';
      out.forEach(function (L) {
        if (L.hidden) return;
        for (var q2 = 0; q2 < shown.length; q2++) {
          if (Math.abs(shown[q2].x - L.x) < 24 && Math.abs(shown[q2].y - L.y) < 13) return;
        }
        shown.push(L);
        var s = slabIndex(m, L.z), col = mix(T.fgMuted, T.bg, fogAt(s) * 0.6);
        c.lineWidth = 3; c.strokeStyle = css(T.bg, 0.85); c.strokeText(L.name, L.x, L.y);
        c.fillStyle = css(col); c.fillText(L.name, L.x, L.y);
      });
    }

    function residueScreen(m, r, out) {
      return toScreen(m, m.cax[r], m.cay[r], m.caz[r], out);
    }
    function drawRing(c, m, r, strong) {
      var T = theme, p = residueScreen(m, r, tmp4);
      var rad = Math.max(4, 1.5 * m._sc * p[3]);
      c.save();
      c.beginPath(); c.arc(p[0], p[1], rad + 3, 0, Math.PI * 2);
      c.fillStyle = css(strong ? T.accent : T.fg, 0.16); c.fill();
      c.beginPath(); c.arc(p[0], p[1], rad, 0, Math.PI * 2);
      var g = c.createRadialGradient(p[0] - rad * 0.35, p[1] - rad * 0.4, rad * 0.1, p[0], p[1], rad);
      var base = strong ? T.accent : T.fg;
      g.addColorStop(0, css(mix(base, WHITE, 0.55)));
      g.addColorStop(1, css(base));
      c.fillStyle = g; c.fill();
      c.lineWidth = 1.5; c.strokeStyle = css(T.bg, 0.9); c.stroke();
      c.restore();
      return p;
    }
    function residueText(m, r) {
      var sname = m.seg[r] || '';
      return m.res[r] + (sname ? ' · ' + sname : '');
    }
    function drawTag(c, text, x, y) {
      var T = theme;
      c.font = '600 12px ' + T.font;
      var w = c.measureText(text).width + 14, h = 22;
      var bx = clamp(x + 12, 4, W - w - 4), by = clamp(y - h - 10, 4, H - h - 4);
      c.beginPath();
      if (c.roundRect) c.roundRect(bx, by, w, h, 6); else c.rect(bx, by, w, h);
      c.fillStyle = css(T.bg, 0.94); c.fill();
      c.lineWidth = 1; c.strokeStyle = css(mix(T.fgMuted, T.bg, 0.55)); c.stroke();
      c.fillStyle = css(T.fg); c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(text, bx + 7, by + h / 2 + 0.5);
    }
    function drawStateLabel(c) {
      var T = theme, t = morph, x = 12, y = H - 12;
      var text = t <= 0.02 ? 'Inactive model' : (t >= 0.98 ? 'Active model' : 'Inactive → Active');
      var col = t <= 0.02 ? T.inactive : (t >= 0.98 ? T.active : mix(T.inactive, T.active, t));
      c.font = '600 12px ' + T.font;
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.lineJoin = 'round'; c.lineWidth = 3; c.strokeStyle = css(T.bg, 0.8);
      c.strokeText(text, x, y - 8); c.fillStyle = css(col); c.fillText(text, x, y - 8);
      // a small track with the morph position
      var tw = 64;
      var gr = c.createLinearGradient(x, 0, x + tw, 0);
      gr.addColorStop(0, css(T.inactive, 0.5)); gr.addColorStop(1, css(T.active, 0.5));
      c.beginPath();
      if (c.roundRect) c.roundRect(x, y - 1.5, tw, 3, 1.5); else c.rect(x, y - 1.5, tw, 3);
      c.fillStyle = gr; c.fill();
      c.beginPath(); c.arc(x + tw * t, y, 3.5, 0, Math.PI * 2);
      c.fillStyle = css(col); c.fill();
      c.lineWidth = 1.5; c.strokeStyle = css(T.bg); c.stroke();
    }

    // ---------------------------------------------------------- frame loop
    function requestRender() {
      if (destroyed || raf) return;
      raf = requestAnimationFrame(frame);
    }
    function animating() {
      if (!model && !fade) return false;
      if (fade || tween || playing) return true;
      if (autoRot && visible && !hoverPause && !drag && !pinch) return true;
      if (Math.abs(inertia.vy) > 1e-4 || Math.abs(inertia.vp) > 1e-4) return true;
      if (Math.abs(tintStrength - tintTarget()) > 0.004) return true;
      if (Math.abs(contactsVis - (contactsOn ? 1 : 0)) > 0.004) return true;
      return false;
    }
    function tintTarget() { return playing ? 1 : Math.sin(Math.PI * clamp(morph, 0, 1)); }

    function step(tNow, dt) {
      var rm = reducedMotion();
      if (tween) {
        var u = clamp((tNow - tween.t0) / tween.dur, 0, 1), e = easeInOutSine(u);
        view.yaw = tween.y0 + (tween.y1 - tween.y0) * e;
        view.pitch = tween.p0 + (tween.p1 - tween.p0) * e;
        view.zoom = tween.z0 + (tween.z1 - tween.z0) * e;
        if (u >= 1) tween = null;
      } else if (!drag && !pinch) {
        if (Math.abs(inertia.vy) > 1e-4 || Math.abs(inertia.vp) > 1e-4) {
          view.yaw += inertia.vy * dt; view.pitch = clamp(view.pitch + inertia.vp * dt, -1.3, 1.3);
          var k = Math.pow(0.04, dt / 1000); inertia.vy *= k; inertia.vp *= k;
        }
        if (autoRot && visible && !hoverPause && !rm) {
          autoPhase += dt / 1000;
          view.yaw = view.yawBase + 0.62 * Math.sin(autoPhase * 2 * Math.PI / 26);
        }
      }
      if (playing && pl) {
        var prev = morph;
        if (rm) {
          if (tNow - pl.t0 >= 2600) { morph = morph < 0.5 ? 1 : 0; pl.t0 = tNow; }
        } else if (pl.hold) {
          if (tNow - pl.t0 >= HOLD_MS) {
            pl.hold = false; pl.from = morph; pl.to = morph < 0.5 ? 1 : 0; pl.t0 = tNow; pl.dur = MOVE_MS;
          }
        } else {
          var v = clamp((tNow - pl.t0) / pl.dur, 0, 1);
          morph = pl.from + (pl.to - pl.from) * easeInOutSine(v);
          if (v >= 1) { morph = pl.to; pl.hold = true; pl.t0 = tNow; }
        }
        if (morph !== prev && typeof opts.onMorph === 'function') { try { opts.onMorph(morph); } catch (e) {} }
      }
      var tt = tintTarget();
      tintStrength = rm ? tt : tintStrength + (tt - tintStrength) * Math.min(1, dt / 1000 * 5);
      var ct = contactsOn ? 1 : 0;
      contactsVis = rm ? ct : contactsVis + (ct - contactsVis) * Math.min(1, dt / 1000 * 9);
      if (Math.abs(contactsVis - ct) < 0.005) contactsVis = ct;
      if (fade) {
        fade.p = rm ? 1 : clamp((tNow - fade.t0) / 380, 0, 1);
        if (fade.p >= 1) fade = null;
      }
    }

    function frame(tNow) {
      raf = 0;
      if (destroyed) return;
      var raw = lastT ? tNow - lastT : 16.7, dt = clamp(raw, 0, 50);
      lastT = tNow;
      if (chained) {
        ema = ema * 0.9 + Math.min(raw, 100) * 0.1;
        slowRun = ema > 21 ? slowRun + 1 : 0;
        if (!lite && slowRun > 20) { lite = true; stats.liteSwitches++; }
      }
      step(tNow, dt);
      var anim = animating();
      if (!anim && lite) { lite = false; ema = 16.7; slowRun = 0; }   // the still frame at full quality
      var t0 = now();
      draw();
      var ms = now() - t0;
      stats.frames++; stats.drawMs += ms; if (ms > stats.maxDrawMs) stats.maxDrawMs = ms;
      chained = anim;
      if (anim) raf = requestAnimationFrame(frame); else lastT = 0;
    }

    function draw() {
      if (!theme || !W) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (fade && fade.hasSnap) {
        ctx.globalAlpha = 1 - easeInOutSine(fade.p);
        ctx.drawImage(snap, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (!model) return;
      var target = ctx, a = 1;
      if (fade) {
        a = easeInOutSine(fade.p);
        layerCtx.setTransform(1, 0, 0, 1, 0, 0);
        layerCtx.clearRect(0, 0, layer.width, layer.height);
        target = layerCtx;
      }
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScene(target, model);
      helixLabels(target, model);
      if (highlight >= 0) drawRing(target, model, highlight, true);
      if (hover >= 0 && hover !== highlight) drawRing(target, model, hover, false);
      if (hover >= 0 && hoverXY) {
        var hp = residueScreen(model, hover, tmp4b);
        drawTag(target, residueText(model, hover), hp[0], hp[1]);
      }
      drawStateLabel(target);
      if (fade) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = a; ctx.drawImage(layer, 0, 0); ctx.globalAlpha = 1;
      }
      updateAria();
    }

    function updateAria() {
      var st = morph < 0.5 ? 'inactive model' : 'active model';
      if (st === stateText && canvas._ariaBase === ariaBase) return;
      stateText = st; canvas._ariaBase = ariaBase;
      canvas.setAttribute('aria-label', '3D backbone of ' + ariaBase + ', ' + st +
        '. Drag to rotate, scroll or pinch to zoom, double-click to reset the view.');
    }

    // ---------------------------------------------------------- picking
    function pick(x, y) {
      var m = model;
      if (!m || !m._sc) return -1;
      var best = -1, bestZ = -1e9, bestD2 = 1e9, sc = m._sc;
      var rH = Math.max(6, HELIX_D * sc * 0.5 + 3), rL = Math.max(6, LOOP_D * sc * 0.5 + 4);
      for (var r = 0; r < m.n; r++) {
        var kd = m.kind[r];
        if (kd === 2 && m.alpha[r] < 0.08) continue;
        var j = r * SUB, ddx = m.px[j] - x, ddy = m.py[j] - y, d2 = ddx * ddx + ddy * ddy;
        var rad = kd === 0 ? rH : rL;
        if (d2 >= rad * rad) continue;
        var z = m.pz[j];
        // front-most wins; within 2 A of depth the closer one on screen wins
        if (best < 0 || z > bestZ + 2 || (z > bestZ - 2 && d2 < bestD2)) { best = r; bestZ = z; bestD2 = d2; }
      }
      return best;
    }
    function setHover(r, xy) {
      hoverXY = xy;
      if (r === hover) { if (r >= 0) requestRender(); return; }
      hover = r;
      canvas.style.cursor = drag ? 'grabbing' : (r >= 0 ? 'pointer' : 'grab');
      if (typeof opts.onResidueHover === 'function') {
        try { opts.onResidueHover(r >= 0 && model ? model.res[r] : null); } catch (e) {}
      }
      requestRender();
    }

    // ---------------------------------------------------------- input
    function localXY(ev) {
      var r = canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    }
    function stopAuto() {
      interacted = true;
      if (autoRot) { autoRot = false; view.yawBase = view.yaw; }
      tween = null;
    }
    function onPointerDown(ev) {
      if (destroyed) return;
      if (ev.button !== undefined && ev.button > 0 && ev.pointerType === 'mouse') return;
      var xy = localXY(ev);
      pointers[ev.pointerId] = xy;
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      stopAuto();
      inertia.vy = 0; inertia.vp = 0;
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z0: view.zoom };
        drag = null;
      } else if (ids.length === 1) {
        drag = { x: xy[0], y: xy[1], x0: xy[0], y0: xy[1], t0: now(), lt: now(), moved: false, type: ev.pointerType };
        canvas.style.cursor = 'grabbing';
      }
    }
    function onPointerMove(ev) {
      if (destroyed) return;
      var xy = localXY(ev);
      if (pointers[ev.pointerId]) pointers[ev.pointerId] = xy;
      if (pinch) {
        var ids = Object.keys(pointers);
        if (ids.length >= 2) {
          var a = pointers[ids[0]], b = pointers[ids[1]];
          view.zoom = clamp(pinch.z0 * (Math.hypot(a[0] - b[0], a[1] - b[1]) || 1) / pinch.d0, 0.5, 5);
          requestRender();
        }
        return;
      }
      if (drag) {
        var dx = xy[0] - drag.x, dy = xy[1] - drag.y, tn = now(), dtm = Math.max(1, tn - drag.lt);
        if (Math.abs(xy[0] - drag.x0) + Math.abs(xy[1] - drag.y0) > 5) drag.moved = true;
        if (drag.moved) {
          var k = 0.0085;
          view.yaw += dx * k; view.pitch = clamp(view.pitch + dy * k, -1.3, 1.3);
          inertia.vy = 0.7 * inertia.vy + 0.3 * (dx * k / dtm);
          inertia.vp = 0.7 * inertia.vp + 0.3 * (dy * k / dtm);
          if (hover >= 0) setHover(-1, null);
          requestRender();
        }
        drag.x = xy[0]; drag.y = xy[1]; drag.lt = tn;
        return;
      }
      if (ev.pointerType === 'mouse' || ev.pointerType === 'pen' || !ev.pointerType) setHover(pick(xy[0], xy[1]), xy);
    }
    function onPointerUp(ev) {
      if (destroyed) return;
      var xy = localXY(ev);
      delete pointers[ev.pointerId];
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
      if (pinch) {
        if (Object.keys(pointers).length < 2) pinch = null;
        drag = null;
        return;
      }
      if (!drag) return;
      var d = drag; drag = null;
      canvas.style.cursor = hover >= 0 ? 'pointer' : 'grab';
      if (d.moved) {
        if (now() - d.lt > 80 || reducedMotion()) { inertia.vy = 0; inertia.vp = 0; }
        requestRender();
        return;
      }
      var r = pick(xy[0], xy[1]);
      if (d.type === 'touch') {
        var tn = now();
        if (lastTap && tn - lastTap.t < 320 && Math.hypot(xy[0] - lastTap.x, xy[1] - lastTap.y) < 30) {
          lastTap = null; resetView(); return;
        }
        lastTap = { t: tn, x: xy[0], y: xy[1] };
        setHover(r, r >= 0 ? xy : null);
      }
      if (r >= 0 && typeof opts.onResidueClick === 'function') {
        try { opts.onResidueClick(model.res[r]); } catch (e) {}
      }
    }
    function onPointerCancel(ev) {
      delete pointers[ev.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      drag = null;
      canvas.style.cursor = 'grab';
    }
    function onEnter(ev) {
      // hold the idle sway while a mouse is over the view, so residues stay put
      if (ev.pointerType === 'mouse') hoverPause = true;
    }
    function onLeave(ev) {
      if (ev.pointerType !== 'mouse') return;
      hoverPause = false;
      if (!drag) setHover(-1, null);
      requestRender();
    }
    function onWheel(ev) {
      if (destroyed || !model) return;
      ev.preventDefault();
      stopAuto();
      var dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 300 : 1));
      view.zoom = clamp(view.zoom * Math.exp(-dy * 0.0015), 0.5, 5);
      requestRender();
    }
    function onDbl(ev) { ev.preventDefault(); resetView(); }
    function onKey(ev) {
      var k = ev.key, used = true;
      if (k === 'ArrowLeft') view.yaw -= 0.15;
      else if (k === 'ArrowRight') view.yaw += 0.15;
      else if (k === 'ArrowUp') view.pitch = clamp(view.pitch - 0.15, -1.3, 1.3);
      else if (k === 'ArrowDown') view.pitch = clamp(view.pitch + 0.15, -1.3, 1.3);
      else if (k === '+' || k === '=') view.zoom = clamp(view.zoom * 1.15, 0.5, 5);
      else if (k === '-' || k === '_') view.zoom = clamp(view.zoom / 1.15, 0.5, 5);
      else if (k === '0') { resetView(); return void ev.preventDefault(); }
      else used = false;
      if (used) { ev.preventDefault(); stopAuto(); requestRender(); }
    }
    function resetView() {
      var y1 = model ? model.yaw0 : -0.45;
      // turn the short way back
      var y0 = view.yaw, dy = ((y0 - y1) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      inertia.vy = 0; inertia.vp = 0;
      if (reducedMotion()) { view.yaw = y1; view.pitch = 0.24; view.zoom = 1; tween = null; }
      else tween = { t0: now(), dur: 520, y0: y1 + dy, y1: y1, p0: view.pitch, p1: 0.24, z0: view.zoom, z1: 1 };
      view.yawBase = y1;
      requestRender();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerenter', onEnter);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('keydown', onKey);

    // theme watchers
    var mo = null;
    if (window.MutationObserver) {
      mo = new MutationObserver(themeSoon);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-light-theme', 'data-dark-theme'] });
    }
    var onThemeEvent = function () { themeSoon(); };
    document.addEventListener('gpc:theme', onThemeEvent);
    var schemeMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var onScheme = function () { themeSoon(); };
    if (schemeMQ && schemeMQ.addEventListener) schemeMQ.addEventListener('change', onScheme);
    var onRM = function () {
      if (reducedMotion()) { autoRot = false; tween = null; }
      requestRender();
    };
    if (reduceMQ && reduceMQ.addEventListener) reduceMQ.addEventListener('change', onRM);

    var ro = null, roPending = 0;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () {
        if (roPending) return;
        roPending = requestAnimationFrame(function () { roPending = 0; resize(); });
      });
      ro.observe(container);
    }
    var onWinResize = function () { resize(); };
    window.addEventListener('resize', onWinResize);
    var io = null;
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) requestRender();
      });
      io.observe(canvas);
    }

    // ---------------------------------------------------------- data
    function showMsg(text) {
      msg.textContent = text || '';
      msg.style.display = text ? 'flex' : 'none';
    }
    function remember(gid, m) {
      cache[gid] = m;
      cacheOrder = cacheOrder.filter(function (g) { return g !== gid; });
      cacheOrder.push(gid);
      while (cacheOrder.length > CACHE_MAX) delete cache[cacheOrder.shift()];
    }
    function present(m) {
      // freeze the current picture for the cross-fade
      var had = !!model && W > 0;
      if (had && !reducedMotion()) {
        snap.width = canvas.width; snap.height = canvas.height;
        snapCtx.setTransform(1, 0, 0, 1, 0, 0);
        snapCtx.clearRect(0, 0, snap.width, snap.height);
        snapCtx.drawImage(canvas, 0, 0);
        fade = { t0: now(), p: 0, hasSnap: true };
      } else if (!reducedMotion()) {
        fade = { t0: now(), p: 0, hasSnap: false };
      } else fade = null;
      model = m;
      ariaBase = labelFor(m.gid);
      if (hover >= 0) { hover = -1; if (typeof opts.onResidueHover === 'function') { try { opts.onResidueHover(null); } catch (e) {} } }
      highlight = -1;
      view.yaw = view.yawBase = m.yaw0; view.pitch = 0.24; autoPhase = 0; tween = null;
      inertia.vy = 0; inertia.vp = 0;
      stateText = '';
      showMsg('');
      requestRender();
    }
    function setReceptor(gid) {
      if (destroyed) return Promise.resolve(false);
      var token = ++reqToken;
      if (abortCtl) { try { abortCtl.abort(); } catch (e) {} abortCtl = null; }
      clearTimeout(loadTimer);
      if (!gid) { model = null; showMsg(''); requestRender(); return Promise.resolve(false); }
      if (cache[gid]) { present(cache[gid]); return Promise.resolve(true); }
      loadTimer = setTimeout(function () { if (token === reqToken && !destroyed) showMsg('Loading model'); }, 220);
      var ctl = window.AbortController ? new AbortController() : null;
      abortCtl = ctl;
      return fetch(dataUrl + encodeURIComponent(gid) + '.json', ctl ? { signal: ctl.signal } : undefined)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (token !== reqToken || destroyed) return false;
          var m = prepare(data, gid);
          remember(gid, m);
          clearTimeout(loadTimer);
          abortCtl = null;
          present(m);
          return true;
        }, function (err) {
          if (token !== reqToken || destroyed || (err && err.name === 'AbortError')) return false;
          throw err;
        })
        .catch(function (err) {
          if (token !== reqToken || destroyed) return false;
          clearTimeout(loadTimer);
          abortCtl = null;
          model = null; fade = null;
          requestRender();
          showMsg('Model unavailable');
          throw err;
        });
    }

    // ---------------------------------------------------------- handle
    var handle = {
      setReceptor: setReceptor,
      setMorph: function (t) {
        t = clamp(+t || 0, 0, 1);
        if (playing) { playing = false; pl = null; }
        morph = t;
        requestRender();
      },
      getMorph: function () { return morph; },
      play: function (on) {
        on = !!on;
        if (on === playing) return;
        playing = on;
        if (on) {
          var to = morph >= 0.999 ? 0 : 1;
          pl = { hold: false, from: morph, to: to, t0: now(), dur: Math.max(400, MOVE_MS * Math.abs(to - morph)) };
          if (reducedMotion()) { pl.t0 = now(); }
        } else pl = null;
        requestRender();
      },
      isPlaying: function () { return playing; },
      setHighlight: function (resNum) {
        var r = -1;
        if (resNum !== null && resNum !== undefined && model && model.idx[resNum] !== undefined) r = model.idx[resNum];
        highlight = r;
        requestRender();
      },
      setContactsVisible: function (on) { contactsOn = !!on; requestRender(); },
      theme: function () { themeSoon(); },
      resize: resize,
      resetView: resetView,
      stats: function () {
        return { frames: stats.frames, meanDrawMs: stats.frames ? stats.drawMs / stats.frames : 0, maxDrawMs: stats.maxDrawMs,
                 residues: model ? model.n : 0, contacts: model ? model.contacts.length : 0,
                 lite: lite, liteSwitches: stats.liteSwitches };
      },
      resetStats: function () { stats = { frames: 0, drawMs: 0, maxDrawMs: 0, liteSwitches: 0 }; },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (raf) cancelAnimationFrame(raf); raf = 0;
        if (roPending) cancelAnimationFrame(roPending);
        clearTimeout(loadTimer); clearTimeout(themeTimer);
        if (abortCtl) { try { abortCtl.abort(); } catch (e) {} }
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.removeEventListener('pointerenter', onEnter);
        canvas.removeEventListener('pointerleave', onLeave);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('dblclick', onDbl);
        canvas.removeEventListener('keydown', onKey);
        document.removeEventListener('gpc:theme', onThemeEvent);
        if (schemeMQ && schemeMQ.removeEventListener) schemeMQ.removeEventListener('change', onScheme);
        if (reduceMQ && reduceMQ.removeEventListener) reduceMQ.removeEventListener('change', onRM);
        window.removeEventListener('resize', onWinResize);
        if (mo) mo.disconnect();
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        model = null; cache = {}; cacheOrder = [];
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };

    readTheme();
    resize();
    if (opts.gid) setReceptor(opts.gid).catch(function () {});
    return handle;
  }

  window.GPCAtlas3D = { mount: mount };
})();
