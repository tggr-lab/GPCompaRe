/* RRCS Tetris: an easter egg on every receptor report page.
   The ΔRRCS histogram turns into a Tetris board whose starting stack is the
   histogram itself (binned into the board's columns). The board is drawn to
   look like the Plotly chart it replaces: same title, axes, grid and bar style,
   with real counts on the y-axis and real ΔRRCS values on the x-axis.
   Exit restores the chart.

   Triggers: the small block (a T piece) next to the "ΔRRCS distribution" heading,
   typing SLIGKV (PAR2's tethered ligand) or the Konami code
   (↑ ↑ ↓ ↓ ← → ← → B A) anywhere on the page.
   To be found by chance: resting the pointer on the histogram for a moment, or clicking
   (tapping) one of its bars, wiggles the block once and shows a one-line hint beside it,
   "Play RRCS Tetris", which starts the game. Nothing moves or
   appears until then; once a game has been played in this browser the hint stays away
   (the block remains). No wiggle under prefers-reduced-motion.

   Controls: ← → move · ↑ / X rotate · Z rotate back · ↓ soft drop
             Space hard drop · P pause · Esc exit. Touch buttons on mobile.
   The game takes the keys only while the focus is on it (the board is focused when the game
   starts; a click on it focuses it again), and the moves only while a game is running, so the
   arrow keys scroll the page otherwise. Focus leaving the game pauses it. The board is sized to
   fit the screen under the sticky chrome. */
(function() {
  'use strict';

  var COLS = 10;
  var ROWS = 20;
  var SEED_MAX_ROWS = 8;
  var BEST_KEY = 'gpcrsynth-rrcs-tetris-best';
  var SEEN_KEY = 'gpcrsynth-rrcs-tetris-seen';
  var HOVER_MS = 700;
  // a T piece, drawn like four histogram cells
  var ICON = '<svg class="rrcs-tetris-icon" viewBox="0 0 17 12" width="17" height="12" aria-hidden="true" focusable="false">' +
    '<rect x="0.75" y="6.25" width="5" height="5" rx="1"/><rect x="5.75" y="6.25" width="5" height="5" rx="1"/>' +
    '<rect x="10.75" y="6.25" width="5" height="5" rx="1"/><rect x="5.75" y="0.75" width="5" height="5" rx="1"/></svg>';
  // Plot margins around the board, in px (roughly the figure's own margins).
  var M = { l: 56, r: 16, t: 44, b: 52 };

  var SHAPES = {
    I: [[0, 1], [1, 1], [2, 1], [3, 1]],
    O: [[1, 0], [2, 0], [1, 1], [2, 1]],
    T: [[1, 0], [0, 1], [1, 1], [2, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    J: [[0, 0], [0, 1], [1, 1], [2, 1]],
    L: [[2, 0], [0, 1], [1, 1], [2, 1]]
  };
  var BOX = { I: 4, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };
  // Piece colours: site semantic tokens where they exist, fixed hues otherwise.
  var COLOR_VARS = {
    I: [null, '#0891B2'],
    O: ['--brand-accent', '#EA580C'],
    T: ['--semantic-active', '#1D4ED8'],
    S: [null, '#16A34A'],
    Z: ['--semantic-inactive', '#B91C1C'],
    J: [null, '#7C3AED'],
    L: [null, '#CA8A04']
  };
  // Fallbacks match website/plotly_theming.py, used if the chart div lacks its overrides.
  var PLOT_THEME = {
    light: { paper: '#ffffff', font: '#1f2328', tick: '#59636e', grid: '#eaeef2', line: '#d1d9e0' },
    dark:  { paper: '#0f1417', font: '#e2e8f0', tick: '#94a3b8', grid: '#1f2937', line: '#334155' }
  };
  var PLOT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var LINE_SCORES = [0, 100, 300, 500, 800];
  var LINE_MSGS = ['', 'Contact broken', 'Double rearrangement', 'Triple rearrangement', 'Full activation!'];
  var CODES = [
    { keys: ['s', 'l', 'i', 'g', 'k', 'v'], msg: 'SLIGKV bound. Receptor active.' },
    { keys: ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'], msg: '' }
  ];

  var chartEl, wrapEl, canvas, ctx, nextCanvas, nextCtx;
  var ui = {};
  var state = null;
  var active = false;
  var rafId = null;

  function cssVar(name, fallback) {
    if (!name) return fallback;
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function readBest() {
    try { return parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { return 0; }
  }
  function writeBest(v) {
    try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) {}
  }

  // ---------- chart data + theme ----------

  function chartPayload() {
    return (window.CHART_DATA || {})['delta-chart'] || {};
  }

  function histogramTrace() {
    return (chartPayload().data || [])[0] || {};
  }

  function histogramValues() {
    var xs = histogramTrace().x;
    if (xs && xs.bdata) xs = decodeBdata(xs);
    if (!xs || !xs.length) return null;
    return Array.prototype.filter.call(xs, function(v) { return typeof v === 'number' && isFinite(v); });
  }

  // Plotly >= 6 may serialise numeric arrays as {dtype: 'f8', bdata: <base64>}.
  function decodeBdata(obj) {
    var types = { f8: Float64Array, f4: Float32Array, i4: Int32Array, i2: Int16Array, i1: Int8Array,
                  u4: Uint32Array, u2: Uint16Array, u1: Uint8Array };
    var T = types[obj.dtype];
    if (!T) return null;
    try {
      var bin = atob(obj.bdata), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new T(bytes.buffer);
    } catch (e) { return null; }
  }

  function plotTitle() {
    var t = (chartPayload().layout || {}).title;
    var text = (t && typeof t === 'object') ? t.text : t;
    return text ? String(text).replace('Distribution', 'Tetris') : 'ΔRRCS Tetris';
  }

  function isDark() {
    var root = document.documentElement;
    var mode = root.getAttribute('data-color-mode');
    if (mode === 'dark' || mode === 'light') return mode === 'dark';
    var forced = root.getAttribute('data-theme');
    if (forced === 'dark' || forced === 'light') return forced === 'dark';
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Colours from the same light/dark layout overrides site.js applies to the real chart.
  function plotTheme() {
    var key = isDark() ? 'dark' : 'light';
    var t = {}, base = PLOT_THEME[key], o = {};
    for (var k in base) t[k] = base[k];
    try { o = JSON.parse(chartEl.getAttribute('data-chart-layout-' + key) || '{}'); } catch (e) {}
    if (o.paper_bgcolor) t.paper = o.paper_bgcolor;
    if (o['font.color']) t.font = o['font.color'];
    if (o['yaxis.tickfont.color']) t.tick = o['yaxis.tickfont.color'];
    if (o['yaxis.gridcolor']) t.grid = o['yaxis.gridcolor'];
    if (o['yaxis.linecolor']) t.line = o['yaxis.linecolor'];
    t.family = o['font.family'] || PLOT_FONT;
    return t;
  }

  // ---------- board seeding from the histogram ----------

  function seedBoard(s) {
    var board = emptyBoard();
    var xs = histogramValues();
    var counts = [];
    var c;
    if (xs && xs.length) {
      // Bin over the 2nd–98th percentile so long tails don't squash the shape
      // into one column; outliers are clamped into the edge columns.
      var sorted = Array.prototype.slice.call(xs).sort(function(a, b) { return a - b; });
      var lo = sorted[Math.floor((sorted.length - 1) * 0.02)];
      var hi = sorted[Math.ceil((sorted.length - 1) * 0.98)];
      var span = (hi - lo) || 1;
      for (c = 0; c < COLS; c++) counts.push(0);
      xs.forEach(function(v) {
        var idx = Math.max(0, Math.min(COLS - 1, Math.floor((v - lo) / span * COLS)));
        counts[idx]++;
      });
      s.xLo = lo; s.xHi = lo + span;
    } else {
      for (c = 0; c < COLS; c++) counts.push(Math.round(100 * Math.exp(-Math.pow((c - 4.5) / 2, 2))));
      s.xLo = -5; s.xHi = 5;
    }
    var max = Math.max.apply(null, counts) || 1;
    s.countsPerRow = max / SEED_MAX_ROWS;
    var heights = counts.map(function(n) {
      if (!n) return 0;
      return Math.max(1, Math.round(n / max * SEED_MAX_ROWS));
    });
    for (c = 0; c < COLS; c++) {
      for (var h = 0; h < heights[c]; h++) board[ROWS - 1 - h][c] = 'seed';
    }
    // A seeded row must never start out complete: punch a hole in each full row.
    for (var r = 0; r < ROWS; r++) {
      if (board[r].every(Boolean)) board[r][(r * 7 + 3) % COLS] = null;
    }
    return board;
  }

  function emptyBoard() {
    var b = [];
    for (var r = 0; r < ROWS; r++) {
      var row = [];
      for (var c = 0; c < COLS; c++) row.push(null);
      b.push(row);
    }
    return b;
  }

  // ---------- pieces ----------

  function refillBag(s) {
    var bag = Object.keys(SHAPES);
    for (var i = bag.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
    s.queue = s.queue.concat(bag);
  }

  function nextType(s) {
    if (s.queue.length < 2) refillBag(s);
    return s.queue.shift();
  }

  function cellsOf(type, rot) {
    var n = BOX[type];
    return SHAPES[type].map(function(p) {
      var x = p[0], y = p[1];
      for (var i = 0; i < rot; i++) { var t = x; x = n - 1 - y; y = t; }
      return [x, y];
    });
  }

  function spawn(s) {
    var type = nextType(s);
    s.piece = { type: type, rot: 0, x: Math.floor((COLS - BOX[type]) / 2), y: -1 };
    if (s.queue.length < 1) refillBag(s);
    if (collides(s, s.piece.x, s.piece.y, s.piece.rot) &&
        collides(s, s.piece.x, s.piece.y - 1, s.piece.rot)) {
      gameOver(s);
    } else if (collides(s, s.piece.x, s.piece.y, s.piece.rot)) {
      s.piece.y -= 1;
    }
  }

  function collides(s, px, py, rot) {
    var cells = cellsOf(s.piece.type, rot);
    for (var i = 0; i < cells.length; i++) {
      var x = px + cells[i][0], y = py + cells[i][1];
      if (x < 0 || x >= COLS || y >= ROWS) return true;
      if (y >= 0 && s.board[y][x]) return true;
    }
    return false;
  }

  function move(dx, dy) {
    var s = state, p = s.piece;
    if (!collides(s, p.x + dx, p.y + dy, p.rot)) {
      p.x += dx; p.y += dy;
      return true;
    }
    return false;
  }

  function rotate(dir) {
    var s = state, p = s.piece;
    var rot = (p.rot + dir + 4) % 4;
    var kicks = [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1]];
    for (var i = 0; i < kicks.length; i++) {
      if (!collides(s, p.x + kicks[i][0], p.y + kicks[i][1], rot)) {
        p.x += kicks[i][0]; p.y += kicks[i][1]; p.rot = rot;
        return;
      }
    }
  }

  function ghostY() {
    var p = state.piece, y = p.y;
    while (!collides(state, p.x, y + 1, p.rot)) y++;
    return y;
  }

  function hardDrop() {
    var y = ghostY();
    state.score += 2 * (y - state.piece.y);
    state.piece.y = y;
    lock();
  }

  function softDrop() {
    if (move(0, 1)) { state.score += 1; state.dropAcc = 0; }
    else lock();
  }

  function lock() {
    var s = state, p = s.piece;
    var toppedOut = false;
    cellsOf(p.type, p.rot).forEach(function(c) {
      var x = p.x + c[0], y = p.y + c[1];
      if (y < 0) toppedOut = true;
      else s.board[y][x] = p.type;
    });
    if (toppedOut) { gameOver(s); return; }
    clearLines(s);
    spawn(s);
  }

  function clearLines(s) {
    var cleared = 0;
    for (var r = ROWS - 1; r >= 0; r--) {
      if (s.board[r].every(Boolean)) {
        s.board.splice(r, 1);
        s.board.unshift(emptyBoard()[0]);
        cleared++;
        r++;
      }
    }
    if (!cleared) return;
    s.lines += cleared;
    s.score += LINE_SCORES[cleared] * (s.level + 1);
    s.level = Math.floor(s.lines / 10);
    flash(LINE_MSGS[cleared]);
    if (s.board.every(function(row) { return row.every(function(c) { return !c; }); })) {
      s.score += 2000 * (s.level + 1);
      flash('Perfect clear: ΔRRCS = 0');
    }
  }

  function gravityMs() {
    return Math.max(70, 800 - state.level * 70);
  }

  function gameOver(s) {
    s.over = true;
    if (s.score > s.best) { s.best = s.score; writeBest(s.best); }
    flash('β-arrestin recruited. Receptor internalized. Press Enter to recycle it.', true);
  }

  // ---------- loop + rendering ----------

  function newGame(msg) {
    state = {
      board: null,
      queue: [],
      piece: null,
      score: 0, lines: 0, level: 0,
      best: readBest(),
      over: false, paused: false,
      dropAcc: 0, last: performance.now()
    };
    state.board = seedBoard(state);
    refillBag(state);
    spawn(state);
    flash(msg || '');
    updatePanel();
  }

  function tick(now) {
    if (!active) return;
    var s = state;
    var dt = Math.min(now - s.last, 250);
    s.last = now;
    if (!s.over && !s.paused) {
      s.dropAcc += dt;
      if (s.dropAcc >= gravityMs()) {
        s.dropAcc = 0;
        if (!move(0, 1)) lock();
      }
    }
    draw();
    updatePanel();
    rafId = requestAnimationFrame(tick);
  }

  function pieceColor(type) {
    if (type === 'seed') {
      var marker = histogramTrace().marker || {};
      return typeof marker.color === 'string' ? marker.color : '#008080';
    }
    var v = COLOR_VARS[type];
    return cssVar(v[0], v[1]);
  }

  function fitCanvas(cv, w, h) {
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }

  // The sticky chrome at the top of the screen (the top bar and the section menu).
  function chromeHeight() {
    var h = 0;
    ['.topbar', '.v3-secnav'].forEach(function(sel) {
      var e = document.querySelector(sel);
      if (!e) return;
      var pos = getComputedStyle(e).position;
      if (pos === 'sticky' || pos === 'fixed') h += e.offsetHeight;
    });
    return h;
  }
  // Space the board's box needs besides the board: the box's padding and border, a margin
  // above and below it, and the touch buttons when they sit under the board.
  function frameHeight() {
    var cs = getComputedStyle(wrapEl);
    var h = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + 16;
    var touch = wrapEl.querySelector('.rrcs-tetris-touch');
    if (touch && getComputedStyle(touch).display !== 'none') h += touch.offsetHeight + parseFloat(cs.rowGap || 0);
    return h;
  }
  function cellSize() {
    var avail = window.innerHeight - chromeHeight() - frameHeight() - M.t - M.b;
    var byWidth = (wrapEl.clientWidth - 32 - M.l - M.r) / COLS;
    return Math.max(8, Math.floor(Math.min(avail / ROWS, byWidth, 26)));
  }
  // Bring the whole board on screen under the sticky chrome.
  function reveal() {
    var r = wrapEl.getBoundingClientRect();
    var top = chromeHeight() + 8;
    var board = canvas.getBoundingClientRect();
    if (r.top < top || board.bottom > window.innerHeight) {
      window.scrollBy({ top: r.top - top, behavior: 'auto' });
    }
  }

  function resize() {
    if (!active) return;
    var cs = cellSize();
    state.cs = cs;
    ctx = fitCanvas(canvas, M.l + cs * COLS + M.r, M.t + cs * ROWS + M.b);
    nextCtx = fitCanvas(nextCanvas, cs * 4, cs * 3);
  }

  // A block drawn like a histogram bar: flat fill at the trace's opacity, with a
  // 1px gutter between columns. Seed cells have no vertical gap so they read as bars.
  function drawCell(c, ox, oy, x, y, cs, color, alpha, bar) {
    c.globalAlpha = alpha;
    c.fillStyle = color;
    if (bar) c.fillRect(ox + x * cs + 1, oy + y * cs, cs - 2, cs);
    else c.fillRect(ox + x * cs + 1, oy + y * cs + 1, cs - 2, cs - 2);
    c.globalAlpha = 1;
  }

  // Round tick spacing (1, 2 or 5 × 10^k), as Plotly picks for its axes.
  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    var f = raw / p;
    return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
  }

  function drawAxes(c, t, cs) {
    var s = state, W = cs * COLS, H = cs * ROWS, ox = M.l, oy = M.t;
    c.font = '12px ' + t.family;
    c.lineWidth = 1;

    // Horizontal grid + y ticks: real counts, as on the histogram's y-axis.
    c.strokeStyle = t.grid;
    c.fillStyle = t.tick;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    var topCount = (ROWS - 1) * s.countsPerRow, step = niceStep(topCount / 5);
    for (var n = 0; n <= topCount; n += step) {
      var y = Math.round(oy + H - n / s.countsPerRow * cs) + 0.5;
      if (n > 0) { c.beginPath(); c.moveTo(ox, y); c.lineTo(ox + W, y); c.stroke(); }
      c.fillText(String(n), ox - 8, y);
    }

    // Baseline.
    c.strokeStyle = t.line;
    c.beginPath(); c.moveTo(ox, oy + H + 0.5); c.lineTo(ox + W, oy + H + 0.5); c.stroke();

    // x ticks: ΔRRCS at every other column edge.
    c.fillStyle = t.tick;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    var span = s.xHi - s.xLo;
    for (var i = 0; i <= COLS; i += 2) {
      var v = s.xLo + span * i / COLS;
      c.fillText(Math.abs(v) < 0.05 ? '0' : v.toFixed(1), ox + i * cs, oy + H + 6);
    }

    // Axis titles.
    c.fillStyle = t.font;
    c.font = '13px ' + t.family;
    c.fillText('ΔRRCS (Active − Inactive)', ox + W / 2, oy + H + 26);
    c.save();
    c.translate(16, oy + H / 2);
    c.rotate(-Math.PI / 2);
    c.textBaseline = 'middle';
    c.fillText('Count', 0, 0);
    c.restore();

    // Figure title, shrunk to fit narrow screens.
    var title = plotTitle(), size = 17, maxW = M.l + W + M.r - 16;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    do { c.font = size + 'px ' + t.family; size--; } while (size > 11 && c.measureText(title).width > maxW);
    c.fillText(title, 8, 26);
  }

  function drawOverlay(c, t, cs, text) {
    var W = cs * COLS, H = cs * ROWS, ox = M.l, oy = M.t;
    c.globalAlpha = 0.7;
    c.fillStyle = t.paper;
    c.fillRect(ox, oy, W, H);
    c.globalAlpha = 1;
    // Styled like a Plotly annotation box.
    c.font = '600 ' + Math.round(cs * 0.75) + 'px ' + t.family;
    var tw = c.measureText(text).width + 20, th = cs * 1.4;
    var bx = ox + (W - tw) / 2, by = oy + (H - th) / 2;
    c.fillStyle = t.paper;
    c.fillRect(bx, by, tw, th);
    c.strokeStyle = t.line;
    c.strokeRect(bx + 0.5, by + 0.5, tw - 1, th - 1);
    c.fillStyle = t.font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, ox + W / 2, by + th / 2);
  }

  function draw() {
    var s = state, cs = s.cs, c = ctx, t = plotTheme();
    var ox = M.l, oy = M.t, alpha = histogramTrace().opacity || 0.8;
    c.fillStyle = t.paper;
    c.fillRect(0, 0, M.l + cs * COLS + M.r, M.t + cs * ROWS + M.b);
    drawAxes(c, t, cs);

    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        var type = s.board[r][col];
        if (type) drawCell(c, ox, oy, col, r, cs, pieceColor(type), alpha, type === 'seed');
      }
    }

    if (s.piece && !s.over) {
      var p = s.piece, color = pieceColor(p.type), gyPos = ghostY();
      cellsOf(p.type, p.rot).forEach(function(cell) {
        if (gyPos + cell[1] >= 0) drawCell(c, ox, oy, p.x + cell[0], gyPos + cell[1], cs, color, 0.18);
      });
      cellsOf(p.type, p.rot).forEach(function(cell) {
        if (p.y + cell[1] >= 0) drawCell(c, ox, oy, p.x + cell[0], p.y + cell[1], cs, color, alpha);
      });
    }

    if (s.over) drawOverlay(c, t, cs, 'Internalized');
    else if (s.paused) drawOverlay(c, t, cs, 'Desensitized');

    // Next-piece preview.
    var nc = nextCtx, nt = s.queue[0];
    nc.clearRect(0, 0, cs * 4, cs * 3);
    if (nt) {
      var cells = cellsOf(nt, 0);
      var minX = Math.min.apply(null, cells.map(function(q) { return q[0]; }));
      var maxX = Math.max.apply(null, cells.map(function(q) { return q[0]; }));
      var minY = Math.min.apply(null, cells.map(function(q) { return q[1]; }));
      var maxY = Math.max.apply(null, cells.map(function(q) { return q[1]; }));
      var nx = (4 - (maxX - minX + 1)) / 2 - minX, ny = (3 - (maxY - minY + 1)) / 2 - minY;
      cells.forEach(function(q) { drawCell(nc, 0, 0, q[0] + nx, q[1] + ny, cs, pieceColor(nt), alpha); });
    }
  }

  function updatePanel() {
    ui.score.textContent = state.score.toLocaleString();
    ui.lines.textContent = state.lines;
    ui.level.textContent = state.level + 1;
    ui.best.textContent = Math.max(state.best, state.score).toLocaleString();
    ui.pause.textContent = state.paused ? 'Resume' : 'Pause';
  }

  var flashTimer = null;
  function flash(msg, sticky) {
    ui.msg.textContent = msg;
    clearTimeout(flashTimer);
    if (msg && !sticky) flashTimer = setTimeout(function() { ui.msg.textContent = ''; }, 2000);
  }

  // ---------- input ----------

  function act(action) {
    if (!active) return;
    var s = state;
    if (action === 'exit') { stop(); return; }
    if (action === 'restart') { newGame('Recycled to the membrane'); return; }
    if (action === 'pause') { if (!s.over) s.paused = !s.paused; return; }
    if (s.over || s.paused) return;
    if (action === 'left') move(-1, 0);
    else if (action === 'right') move(1, 0);
    else if (action === 'down') softDrop();
    else if (action === 'rotate') rotate(1);
    else if (action === 'rotateBack') rotate(-1);
    else if (action === 'drop') hardDrop();
  }

  var KEYMAP = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'rotate',
    x: 'rotate', X: 'rotate', z: 'rotateBack', Z: 'rotateBack', ' ': 'drop',
    p: 'pause', P: 'pause', Escape: 'exit'
  };

  var recentKeys = [];
  function matchCode(key) {
    recentKeys.push(key.length === 1 ? key.toLowerCase() : key);
    if (recentKeys.length > 12) recentKeys.shift();
    for (var i = 0; i < CODES.length; i++) {
      var code = CODES[i].keys, tail = recentKeys.slice(-code.length);
      if (tail.length === code.length && tail.every(function(k, j) { return k === code[j]; })) {
        recentKeys = [];
        return CODES[i];
      }
    }
    return null;
  }

  function focused() {
    return !!wrapEl && wrapEl.contains(document.activeElement);
  }
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!active) {
      var code = matchCode(e.key);
      if (code) start(true, code.msg);
      return;
    }
    // the keys belong to the page unless the game has the focus
    if (!focused()) return;
    if (e.key === 'Enter' && state.over) { e.preventDefault(); act('restart'); return; }
    var action = KEYMAP[e.key];
    if (!action) return;
    // a paused or finished game lets the moves through (the page scrolls); P and Esc still work
    if (action !== 'pause' && action !== 'exit' && (state.over || state.paused)) return;
    e.preventDefault();
    act(action);
  }

  // ---------- start / stop ----------

  function buildUI() {
    wrapEl = document.createElement('div');
    wrapEl.className = 'rrcs-tetris';
    wrapEl.hidden = true;
    // focusable, so the game can hold the keys; a click anywhere on it focuses it
    wrapEl.setAttribute('tabindex', '-1');
    wrapEl.setAttribute('role', 'group');
    wrapEl.setAttribute('aria-label', 'RRCS Tetris. Arrow keys move and rotate, Space drops, P pauses, Escape returns to the chart.');
    wrapEl.innerHTML =
      '<div class="rrcs-tetris-board"><canvas aria-label="RRCS Tetris board" role="img"></canvas></div>' +
      '<div class="rrcs-tetris-side">' +
        '<div class="rrcs-tetris-title">RRCS Tetris</div>' +
        '<div class="rrcs-tetris-sub">Your starting stack is this receptor\'s ΔRRCS histogram.</div>' +
        '<div class="rrcs-tetris-label">Next</div><canvas class="rrcs-tetris-next"></canvas>' +
        '<dl class="rrcs-tetris-stats">' +
          '<dt>Score</dt><dd data-k="score">0</dd>' +
          '<dt>Contacts cleared</dt><dd data-k="lines">0</dd>' +
          '<dt>Level</dt><dd data-k="level">1</dd>' +
          '<dt>Best</dt><dd data-k="best">0</dd>' +
        '</dl>' +
        '<div class="rrcs-tetris-msg" aria-live="polite"></div>' +
        '<div class="rrcs-tetris-btns">' +
          '<button type="button" class="btn" data-k="pause">Pause</button>' +
          '<button type="button" class="btn" data-a="restart">Restart</button>' +
          '<button type="button" class="btn" data-a="exit">Back to science</button>' +
        '</div>' +
        '<div class="rrcs-tetris-help">← → move · ↑/X rotate · Z rotate back · ↓ soft drop · Space hard drop · P pause · Esc exit</div>' +
      '</div>' +
      '<div class="rrcs-tetris-touch">' +
        '<button type="button" data-a="left" aria-label="Move left">◀</button>' +
        '<button type="button" data-a="rotate" aria-label="Rotate">⟳</button>' +
        '<button type="button" data-a="right" aria-label="Move right">▶</button>' +
        '<button type="button" data-a="down" aria-label="Soft drop">▼</button>' +
        '<button type="button" data-a="drop" aria-label="Hard drop">⤓</button>' +
      '</div>';
    chartEl.parentNode.insertBefore(wrapEl, chartEl.nextSibling);
    canvas = wrapEl.querySelector('.rrcs-tetris-board canvas');
    nextCanvas = wrapEl.querySelector('.rrcs-tetris-next');
    ['score', 'lines', 'level', 'best', 'pause'].forEach(function(k) {
      ui[k] = wrapEl.querySelector('[data-k="' + k + '"]');
    });
    ui.msg = wrapEl.querySelector('.rrcs-tetris-msg');
    ui.pause.setAttribute('data-a', 'pause');
    wrapEl.addEventListener('click', function(e) {
      var b = e.target.closest('[data-a]');
      if (b) { act(b.getAttribute('data-a')); if (active) wrapEl.focus({ preventScroll: true }); }
    });
    // focus leaving the game pauses it (the page has the keys again)
    wrapEl.addEventListener('focusout', function(e) {
      if (!active || !state || state.over || state.paused) return;
      if (e.relatedTarget && wrapEl.contains(e.relatedTarget)) return;
      state.paused = true;
      flash('Paused. Click the board or press P on it to play.', true);
    });
    wrapEl.addEventListener('pointerdown', function(e) {
      if (e.target.closest && e.target.closest('button')) return;
      if (active && state && state.paused && !state.over && document.activeElement !== wrapEl) {
        state.paused = false;
        flash('');
      }
    });
  }

  function start(scrollIntoView, msg) {
    if (active) return;
    if (!wrapEl) buildUI();
    active = true;
    chartEl.hidden = true;
    wrapEl.hidden = false;
    if (ui.toggle) ui.toggle.setAttribute('aria-pressed', 'true');
    hideHint();
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
    newGame(msg);
    resize();
    reveal();
    wrapEl.focus({ preventScroll: true });
    state.last = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(rafId);
    if (state.score > state.best) writeBest(state.score);
    var hadFocus = focused();
    wrapEl.hidden = true;
    chartEl.hidden = false;
    if (ui.toggle) ui.toggle.setAttribute('aria-pressed', 'false');
    if (hadFocus && ui.toggle) ui.toggle.focus({ preventScroll: true });
    if (window.Plotly && chartEl.data) Plotly.Plots.resize(chartEl);
  }

  // ---------- being found by chance ----------

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
  }
  var hinted = false;
  function nudge() {
    if (active || !ui.toggle) return;
    if (!hinted) {
      hinted = true;
      ui.toggle.classList.add('is-wiggle');     // CSS drops it under prefers-reduced-motion
      if (ui.hint && !seen()) ui.hint.hidden = false;
    }
  }
  function hideHint() {
    if (ui.hint) ui.hint.hidden = true;
  }
  // A pointer resting on the histogram (devices that hover), or a click or tap on a bar.
  function watchForCuriosity() {
    var timer = null;
    var canHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (canHover) {
      chartEl.addEventListener('pointerenter', function() {
        clearTimeout(timer);
        timer = setTimeout(nudge, HOVER_MS);
      });
      chartEl.addEventListener('pointerleave', function() { clearTimeout(timer); });
    }
    function hookBars() {
      if (chartEl.on && !chartEl.dataset.tetrisHooked) {
        chartEl.dataset.tetrisHooked = '1';
        chartEl.on('plotly_click', nudge);
      }
    }
    if (chartEl.dataset.chartRendered) hookBars();
    else if ('MutationObserver' in window) {
      var mo = new MutationObserver(function() {
        if (chartEl.dataset.chartRendered) { mo.disconnect(); hookBars(); }
      });
      mo.observe(chartEl, { attributes: true, attributeFilter: ['data-chart-rendered'] });
    }
  }

  function pauseIfPlaying() {
    if (active && state && !state.over) state.paused = true;
  }

  function init() {
    chartEl = document.getElementById('delta-chart');
    if (!chartEl) return;
    var head = chartEl.previousElementSibling;
    if (head && head.classList.contains('report-chart-head')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rrcs-tetris-toggle';
      btn.innerHTML = ICON;
      btn.title = 'Play RRCS Tetris';
      btn.setAttribute('aria-label', 'Play RRCS Tetris');
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', function() { active ? stop() : start(false); });
      btn.addEventListener('animationend', function() { btn.classList.remove('is-wiggle'); });
      head.appendChild(btn);
      ui.toggle = btn;
      var hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'rrcs-tetris-hint';
      hint.hidden = true;
      hint.textContent = 'Play RRCS Tetris';
      hint.addEventListener('click', function() { if (!active) start(false); });
      head.appendChild(hint);
      ui.hint = hint;
      watchForCuriosity();
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', pauseIfPlaying);
    document.addEventListener('visibilitychange', function() { if (document.hidden) pauseIfPlaying(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
