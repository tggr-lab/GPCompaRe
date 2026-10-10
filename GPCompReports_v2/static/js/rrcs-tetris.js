/* RRCS Tetris: an easter egg on the PAR2 report page.
   The ΔRRCS histogram turns into a Tetris board whose starting stack is the
   histogram itself (binned into the board's columns). Exit restores the chart.

   Triggers: the faint ▦ button next to the "ΔRRCS distribution" heading,
   or the Konami code (↑ ↑ ↓ ↓ ← → ← → B A) anywhere on the page.

   Controls: ← → move · ↑ / X rotate · Z rotate back · ↓ soft drop
             Space hard drop · P pause · Esc exit. Touch buttons on mobile. */
(function() {
  'use strict';

  var COLS = 10;
  var ROWS = 20;
  var SEED_MAX_ROWS = 8;
  var BEST_KEY = 'gpcrsynth-rrcs-tetris-best';

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
  var LINE_SCORES = [0, 100, 300, 500, 800];
  var LINE_MSGS = ['', 'Contact broken', 'Double rearrangement', 'Triple rearrangement', 'Full activation!'];
  var KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

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

  // ---------- board seeding from the histogram ----------

  function histogramValues() {
    var payload = (window.CHART_DATA || {})['delta-chart'];
    var trace = payload && payload.data && payload.data[0];
    var xs = trace && trace.x;
    if (xs && xs.bdata) xs = decodeBdata(xs);
    if (!xs || !xs.length) return null;
    return Array.prototype.filter.call(xs,function(v) { return typeof v === 'number' && isFinite(v); });
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

  function seedBoard() {
    var board = emptyBoard();
    var xs = histogramValues();
    var counts = [];
    var c;
    if (xs && xs.length) {
      var lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
      var span = (hi - lo) || 1;
      for (c = 0; c < COLS; c++) counts.push(0);
      xs.forEach(function(v) {
        var idx = Math.min(COLS - 1, Math.floor((v - lo) / span * COLS));
        counts[idx]++;
      });
    } else {
      for (c = 0; c < COLS; c++) counts.push(Math.round(100 * Math.exp(-Math.pow((c - 4.5) / 2, 2))));
    }
    var max = Math.max.apply(null, counts) || 1;
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
    flash('Game over. Enter to restart', true);
  }

  // ---------- loop + rendering ----------

  function newGame() {
    state = {
      board: seedBoard(),
      queue: [],
      piece: null,
      score: 0, lines: 0, level: 0,
      best: readBest(),
      over: false, paused: false,
      dropAcc: 0, last: performance.now()
    };
    refillBag(state);
    spawn(state);
    flash('');
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
    if (type === 'seed') return cssVar('--brand-primary', '#0D9488');
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

  function cellSize() {
    var avail = Math.min(window.innerHeight * 0.7, 560);
    var byWidth = (wrapEl.clientWidth - 40) / COLS;
    return Math.max(14, Math.floor(Math.min(avail / ROWS, byWidth, 28)));
  }

  function resize() {
    if (!active) return;
    var cs = cellSize();
    state.cs = cs;
    ctx = fitCanvas(canvas, cs * COLS, cs * ROWS);
    nextCtx = fitCanvas(nextCanvas, cs * 4, cs * 3);
  }

  function drawCell(c, x, y, cs, color, alpha, seed) {
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.fillRect(x * cs + 1, y * cs + 1, cs - 2, cs - 2);
    if (alpha === 1) {
      c.globalAlpha = seed ? 0.15 : 0.25;
      c.fillStyle = '#fff';
      c.fillRect(x * cs + 1, y * cs + 1, cs - 2, Math.max(2, cs * 0.18));
    }
    c.globalAlpha = 1;
  }

  function draw() {
    var s = state, cs = s.cs, c = ctx;
    var bg = cssVar('--bgColor-default', '#fff');
    var grid = cssVar('--borderColor-muted', '#d0d7de');
    c.fillStyle = bg;
    c.fillRect(0, 0, cs * COLS, cs * ROWS);
    c.strokeStyle = grid;
    c.lineWidth = 1;
    c.globalAlpha = 0.5;
    for (var gx = 1; gx < COLS; gx++) {
      c.beginPath(); c.moveTo(gx * cs + 0.5, 0); c.lineTo(gx * cs + 0.5, cs * ROWS); c.stroke();
    }
    for (var gy = 1; gy < ROWS; gy++) {
      c.beginPath(); c.moveTo(0, gy * cs + 0.5); c.lineTo(cs * COLS, gy * cs + 0.5); c.stroke();
    }
    c.globalAlpha = 1;

    for (var r = 0; r < ROWS; r++) {
      for (var col = 0; col < COLS; col++) {
        var t = s.board[r][col];
        if (t) drawCell(c, col, r, cs, pieceColor(t), t === 'seed' ? 0.8 : 1, t === 'seed');
      }
    }

    if (s.piece && !s.over) {
      var p = s.piece, color = pieceColor(p.type), gyPos = ghostY();
      cellsOf(p.type, p.rot).forEach(function(cell) {
        if (gyPos + cell[1] >= 0) drawCell(c, p.x + cell[0], gyPos + cell[1], cs, color, 0.2);
      });
      cellsOf(p.type, p.rot).forEach(function(cell) {
        if (p.y + cell[1] >= 0) drawCell(c, p.x + cell[0], p.y + cell[1], cs, color, 1);
      });
    }

    if (s.paused || s.over) {
      c.globalAlpha = 0.6;
      c.fillStyle = bg;
      c.fillRect(0, 0, cs * COLS, cs * ROWS);
      c.globalAlpha = 1;
      c.fillStyle = cssVar('--fgColor-default', '#1f2328');
      c.font = '600 ' + Math.round(cs * 0.9) + 'px ' + cssVar('--font-ui', 'system-ui');
      c.textAlign = 'center';
      c.fillText(s.over ? 'GAME OVER' : 'PAUSED', cs * COLS / 2, cs * ROWS / 2);
    }

    // Next-piece preview.
    var nc = nextCtx, nt = s.queue[0];
    nc.clearRect(0, 0, cs * 4, cs * 3);
    if (nt) {
      var cells = cellsOf(nt, 0);
      var minX = Math.min.apply(null, cells.map(function(q) { return q[0]; }));
      var maxX = Math.max.apply(null, cells.map(function(q) { return q[0]; }));
      var minY = Math.min.apply(null, cells.map(function(q) { return q[1]; }));
      var maxY = Math.max.apply(null, cells.map(function(q) { return q[1]; }));
      var ox = (4 - (maxX - minX + 1)) / 2 - minX, oy = (3 - (maxY - minY + 1)) / 2 - minY;
      cells.forEach(function(q) { drawCell(nc, q[0] + ox, q[1] + oy, cs, pieceColor(nt), 1); });
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
    if (msg && !sticky) flashTimer = setTimeout(function() { ui.msg.textContent = ''; }, 1600);
  }

  // ---------- input ----------

  function act(action) {
    if (!active) return;
    var s = state;
    if (action === 'exit') { stop(); return; }
    if (action === 'restart') { newGame(); return; }
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

  var konamiPos = 0;
  function onKey(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!active) {
      var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      konamiPos = (k === KONAMI[konamiPos]) ? konamiPos + 1 : (k === KONAMI[0] ? 1 : 0);
      if (konamiPos === KONAMI.length) { konamiPos = 0; start(true); }
      return;
    }
    if (e.key === 'Enter' && state.over) { e.preventDefault(); act('restart'); return; }
    var action = KEYMAP[e.key];
    if (!action) return;
    e.preventDefault();
    act(action);
  }

  // ---------- start / stop ----------

  function buildUI() {
    wrapEl = document.createElement('div');
    wrapEl.className = 'rrcs-tetris';
    wrapEl.hidden = true;
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
          '<button type="button" class="btn" data-a="exit">Back to chart</button>' +
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
      if (b) { act(b.getAttribute('data-a')); b.blur(); }
    });
  }

  function start(scrollIntoView) {
    if (active) return;
    if (!wrapEl) buildUI();
    active = true;
    chartEl.hidden = true;
    wrapEl.hidden = false;
    if (ui.toggle) ui.toggle.setAttribute('aria-pressed', 'true');
    newGame();
    resize();
    if (scrollIntoView) wrapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.last = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!active) return;
    active = false;
    cancelAnimationFrame(rafId);
    if (state.score > state.best) writeBest(state.score);
    wrapEl.hidden = true;
    chartEl.hidden = false;
    if (ui.toggle) ui.toggle.setAttribute('aria-pressed', 'false');
    if (window.Plotly && chartEl.data) Plotly.Plots.resize(chartEl);
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
      btn.textContent = '▦';
      btn.title = 'Insert coin';
      btn.setAttribute('aria-label', 'Play RRCS Tetris');
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', function() { active ? stop() : start(false); });
      head.appendChild(btn);
      ui.toggle = btn;
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', pauseIfPlaying);
    document.addEventListener('visibilitychange', function() { if (document.hidden) pauseIfPlaying(); });
    document.addEventListener('gpcrsynth-theme-change', function() { if (active) draw(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
