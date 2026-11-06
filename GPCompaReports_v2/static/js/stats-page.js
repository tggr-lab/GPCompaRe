/* stats-page.js: the Statistics page (templates/statistics.html, _partials/chart-card.html).

   Every chart lives in a chart card. The card's payload comes either inline
   (window.STATS_CHART_DATA[id], the small manuscript charts) or from a same-origin JSON file
   fetched when the card scrolls near (data-chart-src). Four cards are "atlas" views drawn here
   from the site-layer payloads of analysis/class_atlas.py, tm_domain_analysis.py and
   cfr_variants.py (schemas in those modules):

     helix_pairs    data/stats/helix_pairs.json (+ helix_pair_cells.json on the first cell click)
     cfr_atlas      data/stats/cfr_atlas.json
     receptors      data/stats/receptors.json (+ cfr_atlas.json for the fingerprint strips)
     cfr_variants   data/stats/cfr_variants.json (+ cfr_variants/<generic>.json on click)

   Shared by every card: PNG 2x and SVG export (light background, the figure title restored for
   the file), the table view (the card's CSV, or the view's own rows), "Copy caption", the Method
   disclosure, the theme bridge (site.js relayouts the layout; this file redraws the data colors
   that depend on the theme), a phone layout (smaller heights, fewer labels, no colorbar on the
   grids) and the segment order switch (segment-order.js; 'gpc:segment-order' event).

   Colors: red = stronger in the active model, blue = stronger in the inactive model (structural
   charts only). Predicted pathogenicity uses the clinical tint (green, neutral gray, crimson),
   the same tokens as search-ui.css. No chart is drawn before it is needed, and none twice. */
(function () {
  'use strict';

  var ROOT = document.documentElement;
  var PHONE = window.matchMedia('(max-width: 720px)');
  var REPORT = function (gid) { return 'reports/' + gid + '.html'; };
  var SEARCH = function (q) { return 'search/index.html?q=' + encodeURIComponent(q); };

  var THEME = {
    light: { active: '#B91C1C', inactive: '#1D4ED8', brand: '#0D9488', text: '#1f2328', muted: '#59636e',
             line: '#d1d9e0', cell: '#E2E8F0', paper: '#ffffff', hilite: '#111827' },
    dark:  { active: '#F87171', inactive: '#60A5FA', brand: '#2DD4BF', text: '#e2e8f0', muted: '#94a3b8',
             line: '#334155', cell: '#2A3441', paper: '#0f1417', hilite: '#F8FAFC' }
  };
  var DIVERGING = {
    light: [[0, '#1D4ED8'], [0.25, '#93C5FD'], [0.5, '#FFFFFF'], [0.75, '#FCA5A5'], [1, '#B91C1C']],
    dark:  [[0, '#60A5FA'], [0.25, '#1E3A8A'], [0.5, '#0f1417'], [0.75, '#7F1D1D'], [1, '#F87171']]
  };
  var RAMP = {
    light: [[0, '#F1F5F9'], [1, '#0D9488']],
    dark:  [[0, '#1F2937'], [1, '#2DD4BF']]
  };
  // the clinical tint of search-ui.css (--path-*), light and dark; neutral = counts without a class
  var CLINICAL = {
    light: { benign: '#2B6E2F', ambiguous: '#555C68', pathogenic: '#B4234B', neutral: '#8C959F' },
    dark:  { benign: '#81C784', ambiguous: '#B0B4BC', pathogenic: '#F48FB1', neutral: '#6E7781' }
  };
  // ligand-group hues: the light set comes with receptors.json; the dark set are lighter steps of the same hues
  var LIGAND_DARK = {
    'Peptide receptors': '#5EEAD4', 'Orphan receptors': '#FCD34D', 'Aminergic receptors': '#C4B5FD',
    'Lipid receptors': '#F9A8D4', 'Protein receptors': '#93C5FD', 'Nucleotide receptors': '#BEF264',
    'Sensory receptors': '#D4A373', 'Other': '#A5B4FC'
  };
  var FAMILY_PALETTE = {
    light: ['#0D9488', '#D97706', '#7C3AED', '#DB2777', '#2563EB', '#65A30D', '#92400E', '#4338CA', '#0891B2', '#CA8A04', '#BE123C', '#059669'],
    dark:  ['#5EEAD4', '#FCD34D', '#C4B5FD', '#F9A8D4', '#93C5FD', '#BEF264', '#D4A373', '#A5B4FC', '#67E8F9', '#FDE68A', '#FDA4AF', '#6EE7B7']
  };

  function theme() { return ROOT.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light'; }
  function isPhone() { return PHONE.matches; }
  function overrides(el, t) {
    try { return JSON.parse(el.getAttribute('data-chart-layout-' + t) || 'null'); } catch (e) { return null; }
  }
  function fmt(n) { return (n === null || n === undefined) ? '' : Number(n).toLocaleString('en-US'); }
  function pct(v, d) { return (v === null || v === undefined) ? '' : (100 * v).toFixed(d || 0) + '%'; }
  function signed(v, d) { return v === null || v === undefined ? '' : (v > 0 ? '+' : '') + Number(v).toFixed(d === undefined ? 1 : d); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var jsonCache = {};
  function loadJSON(url) {
    if (!jsonCache[url]) {
      jsonCache[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.json();
      });
      jsonCache[url].catch(function () { delete jsonCache[url]; });
    }
    return jsonCache[url];
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
    var rows = [], row = [], field = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (!(row.length === 1 && row[0].charAt(0) === '#')) rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (!(row.length === 1 && row[0].charAt(0) === '#')) rows.push(row); }
    var notes = [];
    rows = rows.filter(function (r) { if (r[0] && r[0].charAt(0) === '#') { notes.push(r.join(',').slice(2)); return false; } return true; });
    return { header: rows[0] || [], rows: rows.slice(1), notes: notes };
  }

  // ------------------------------------------------------------------ Plotly drawing
  function baseLayout(t) {
    var p = THEME[t];
    return {
      autosize: true,
      paper_bgcolor: p.paper, plot_bgcolor: p.paper,
      font: { color: p.text, family: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', size: 12 },
      margin: { l: 56, r: 16, t: 16, b: 56 },
      title: { text: '' },
      xaxis: { gridcolor: t === 'dark' ? '#1f2937' : '#eaeef2', linecolor: p.line, tickcolor: p.muted, tickfont: { color: p.muted }, zerolinecolor: p.line },
      yaxis: { gridcolor: t === 'dark' ? '#1f2937' : '#eaeef2', linecolor: p.line, tickcolor: p.muted, tickfont: { color: p.muted }, zerolinecolor: p.line },
      legend: { font: { color: p.text }, bgcolor: 'rgba(0,0,0,0)' },
      hoverlabel: { font: { size: 12 } }
    };
  }
  function merge(target, src) {
    Object.keys(src || {}).forEach(function (k) {
      var v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
      else target[k] = v;
    });
    return target;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var CONFIG = { responsive: true, displayModeBar: false, displaylogo: false, scrollZoom: false };

  // Draw (or redraw) a card's plot: `data` and `layout` are the figure; the title goes to the file export
  // only, unless opts.title. Returns the Plotly promise.
  function plot(card, data, layout, opts) {
    opts = opts || {};
    var t = opts.theme || theme();
    var lay = merge(baseLayout(t), layout || {});
    card.exportTitle = (layout && layout.title && (layout.title.text || layout.title)) || card.el.getAttribute('data-title');
    if (typeof card.exportTitle !== 'string') card.exportTitle = card.el.getAttribute('data-title');
    if (opts.title) {
      lay.title = { text: card.exportTitle, font: { size: 13, color: THEME[t].text }, x: 0, xanchor: 'left', automargin: true };
      lay.margin = merge(lay.margin, { t: Math.max(lay.margin.t || 0, 56) });
    } else {
      lay.title = { text: '' };
    }
    delete lay.height; delete lay.width;
    var p = window.Plotly.react(card.plot, data, lay, merge(clone(CONFIG), opts.config || {}));
    return Promise.resolve(p).then(function () {
      card.plot.dataset.chartRendered = '1';
      card.drawn = true;
      var o = overrides(card.plot, t);
      if (o) {
        o = clone(o);
        if (opts.title) { delete o['title.font.color']; }
        return window.Plotly.relayout(card.plot, o);
      }
    });
  }

  // ------------------------------------------------------------------ cards
  var cards = {};

  function setupCard(fig) {
    var plotEl = fig.querySelector('.chart-card-plot');
    if (!plotEl) return null;
    var card = {
      id: plotEl.id, el: fig, plot: plotEl, body: fig.querySelector('.chart-card-body'),
      table: fig.querySelector('.chart-card-table'), side: fig.querySelector('.chart-card-side'),
      viewText: fig.querySelector('[data-view-text]'),
      src: plotEl.getAttribute('data-chart-src'), kind: plotEl.getAttribute('data-chart-kind'),
      view: plotEl.getAttribute('data-chart-view'), inline: plotEl.hasAttribute('data-chart-inline'),
      csv: fig.getAttribute('data-csv'), loaded: false, drawn: false, exportTitle: fig.getAttribute('data-title'),
      render: null, tableRows: null, caption: null
    };
    cards[card.id] = card;

    fig.querySelectorAll('[data-export]').forEach(function (b) {
      b.addEventListener('click', function () { exportImage(card, b.getAttribute('data-export'), b); });
    });
    var tbtn = fig.querySelector('[data-table-toggle]');
    if (tbtn) tbtn.addEventListener('click', function () { toggleTable(card, tbtn); });
    var cbtn = fig.querySelector('[data-copy-caption]');
    if (cbtn) cbtn.addEventListener('click', function () { copyCaption(card, cbtn); });
    var mbtn = fig.querySelector('[data-method-toggle]');
    var method = fig.querySelector('.chart-card-method');
    if (mbtn && method) {
      mbtn.addEventListener('click', function () {
        method.open = !method.open;
        mbtn.setAttribute('aria-expanded', method.open ? 'true' : 'false');
        if (method.open) method.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      method.addEventListener('toggle', function () { mbtn.setAttribute('aria-expanded', method.open ? 'true' : 'false'); });
    }
    fig.querySelectorAll('[data-chips]').forEach(function (group) {
      group.addEventListener('click', function (e) {
        var b = e.target.closest('.chip, .stats-tab');
        if (!b || !group.contains(b)) return;
        var key = group.getAttribute('data-chips');
        var sel = b.classList.contains('stats-tab') ? 'aria-selected' : 'aria-pressed';
        group.querySelectorAll('.chip, .stats-tab').forEach(function (x) { x.setAttribute(sel, x === b ? 'true' : 'false'); });
        if (card.onChip) card.onChip(key, b.getAttribute('data-value'), b);
      });
    });
    return card;
  }

  function setChip(card, key, value) {
    var group = card.el.querySelector('[data-chips="' + key + '"]');
    if (!group) return;
    group.querySelectorAll('.chip, .stats-tab').forEach(function (x) {
      var sel = x.classList.contains('stats-tab') ? 'aria-selected' : 'aria-pressed';
      x.setAttribute(sel, x.getAttribute('data-value') === value ? 'true' : 'false');
    });
  }
  function setViewText(card, text) { if (card.viewText) card.viewText.textContent = text ? 'View: ' + text + '.' : ''; }

  function showNote(card, text) {
    clear(card.plot);
    card.plot.appendChild(el('p', 'chart-card-note', text));
    card.el.classList.add('chart-card--missing');
  }

  // the card's first load: inline payload, lazy payload or an atlas view
  function loadCard(card) {
    if (card.loaded) return;
    card.loaded = true;
    if (card.kind === 'atlas') {
      var init = VIEWS[card.view];
      if (!init || !card.src) return;
      loadJSON(card.src).then(function (json) { init(card, json); })
        .catch(function (err) { showNote(card, 'This view could not be loaded (' + err.message + ').'); });
      return;
    }
    var payload = card.inline ? (window.STATS_CHART_DATA || {})[card.id] : null;
    var p = payload ? Promise.resolve(payload) : (card.src ? loadJSON(card.src) : Promise.reject(new Error('no data')));
    p.then(function (pl) { initPlotly(card, pl); })
      .catch(function (err) { showNote(card, 'This chart could not be loaded (' + err.message + ').'); });
  }

  // a plain Plotly payload: theme-dependent data colors are the clinical tint (traces with meta.path_class)
  function initPlotly(card, payload) {
    card.payload = payload;
    card.render = function (opts) {
      opts = opts || {};
      var t = opts.theme || theme();
      var data = clone(payload.data || []);
      data.forEach(function (tr) {
        var cls = tr.meta && tr.meta.path_class;
        if (cls && CLINICAL[t][cls]) {
          tr.marker = tr.marker || {};
          tr.marker.color = CLINICAL[t][cls];
          if (tr.insidetextfont) tr.insidetextfont.color = t === 'dark' && cls !== 'neutral' ? '#0f1417' : '#ffffff';
        }
        // a single-hue gray ramp (Plotly's named scale) runs light to dark; on the dark theme it runs the other way
        if (typeof tr.colorscale === 'string' && /^gr[ae]ys$/i.test(tr.colorscale)) tr.colorscale = t === 'dark' ? [[0, '#1f2937'], [1, '#f1f5f9']] : [[0, '#ffffff'], [1, '#111827']];
        if (card.id === 'chart-cfr-dotplot') legendRank(tr);
      });
      var layout = clone(payload.layout || {});
      if (card.id === 'chart-cfr-dotplot') layout.legend = merge(layout.legend || {}, { groupclick: 'toggleitem' });
      if (isPhone() && layout.legend && layout.legend.orientation !== 'h') layout.legend = merge(layout.legend, { orientation: 'h', y: -0.25, x: 0 });
      return plot(card, data, layout, { title: opts.title, theme: t, config: payload.config });
    };
    card.render();
  }

  // legend order for a chart whose traces are segments (the manuscript bubble plot): the shared switch
  function legendRank(tr) {
    var S = window.GPCSegOrder;
    if (!S || !tr.name) return;
    var order = S.order();
    var i = order.indexOf(String(tr.name).trim());
    if (i < 0) return;
    var g = S.group(tr.name);
    var split = S.mode() === 'helices';
    tr.legendrank = 1 + i;
    tr.legendgroup = split ? 'seg-' + g : '';
    var first = order.filter(function (s) { return S.group(s) === g; })[0];
    tr.legendgrouptitle = { text: split && first === tr.name ? (g === 'helix' ? 'Helices' : 'Loops and termini') : '' };
  }

  // ------------------------------------------------------------------ exports, table, caption
  function exportImage(card, format, button) {
    if (!card.drawn || !card.render || !window.Plotly || !window.Plotly.downloadImage) return;
    var w = card.plot.clientWidth || 900, h = card.plot.clientHeight || 500;
    button.disabled = true;
    card.render({ theme: 'light', title: true }).then(function () {
      return window.Plotly.downloadImage(card.plot, {
        format: format, scale: format === 'png' ? 2 : 1, width: w, height: h + 48,
        filename: 'gpcompare_' + card.id.replace(/^chart-/, '') + (card.suffix ? '_' + card.suffix : '')
      });
    }).then(function () { return card.render(); }, function () { return card.render(); })
      .then(function () { button.disabled = false; }, function () { button.disabled = false; });
  }

  function renderTable(card, header, rows, note) {
    var box = card.table, MAX = 400;
    clear(box);
    var table = el('table'), thead = el('thead'), tr = el('tr');
    header.forEach(function (h) { tr.appendChild(el('th', numeric(rows, header.indexOf(h)) ? 'num' : '', h)); });
    thead.appendChild(tr); table.appendChild(thead);
    var tbody = el('tbody');
    rows.slice(0, MAX).forEach(function (r) {
      var row = el('tr');
      r.forEach(function (v, i) {
        var td = el('td', numeric(rows, i) ? 'num' : '');
        if (v && typeof v === 'object' && v.href) { var a = el('a', '', v.text); a.href = v.href; td.appendChild(a); }
        else td.textContent = v === null || v === undefined ? '' : String(v);
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    box.appendChild(table);
    var n = el('div', 'chart-card-table-note');
    n.textContent = (rows.length > MAX ? 'Showing the first ' + fmt(MAX) + ' of ' + fmt(rows.length) + ' rows; the CSV has all of them. ' : fmt(rows.length) + ' rows. ') + (note || '');
    box.appendChild(n);
  }
  function numeric(rows, i) {
    var seen = 0;
    for (var k = 0; k < rows.length && k < 40; k++) {
      var v = rows[k][i];
      if (v === '' || v === null || v === undefined) continue;
      if (typeof v === 'object') return false;
      if (isNaN(parseFloat(v)) || !isFinite(v)) return false;
      seen++;
    }
    return seen > 0;
  }
  function toggleTable(card, button) {
    var on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (!on) { card.table.hidden = true; card.plot.hidden = false; if (card.drawn) window.Plotly.Plots.resize(card.plot); return; }
    card.plot.hidden = true; card.table.hidden = false;
    clear(card.table);
    card.table.appendChild(el('div', 'chart-card-table-note', 'Loading the table'));
    var p = card.tableRows ? Promise.resolve(card.tableRows()) : (card.csv ? loadCSV(card.csv) : Promise.reject(new Error('no table')));
    p.then(function (tb) { renderTable(card, tb.header, tb.rows, tb.note); })
      .catch(function (err) { clear(card.table); card.table.appendChild(el('div', 'chart-card-table-note', 'No table is available (' + err.message + ').')); });
  }

  function captionText(card) {
    var f = card.el;
    var view = card.viewText ? card.viewText.textContent.trim() : '';
    var cap = f.querySelector('.chart-card-caption');
    var body = cap ? cap.textContent.replace(/\s+/g, ' ').trim() : '';
    if (view) body = body.replace(view, '').trim();
    var layer = f.getAttribute('data-layer') === 'paper' ? 'paper analysis, values as submitted' : 'site layer, computed from the site data';
    return [f.getAttribute('data-title') + ' (' + layer + ').', view, body,
            'GPCompaRe database, ' + location.origin + location.pathname + '#' + f.id].filter(Boolean).join(' ');
  }
  function copyCaption(card, button) {
    var text = captionText(card);
    var done = function () { button.classList.add('is-done'); button.textContent = 'Copied'; setTimeout(function () { button.classList.remove('is-done'); button.textContent = 'Copy caption'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing to do */ }
    document.body.removeChild(ta);
  }

  // side panel
  function openSide(card, title, build) {
    var side = card.side;
    clear(side);
    var close = el('button', 'cc-btn side-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', function () { closeSide(card); });
    side.appendChild(close);
    side.appendChild(el('h4', '', title));
    build(side);
    side.hidden = false;
    card.body.classList.add('has-side');
    if (card.drawn && !card.plot.hidden) window.Plotly.Plots.resize(card.plot);
    if (isPhone()) side.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function closeSide(card) {
    card.side.hidden = true;
    card.body.classList.remove('has-side');
    clear(card.side);
    if (card.drawn && !card.plot.hidden) window.Plotly.Plots.resize(card.plot);
  }
  function link(text, href, cls) { var a = el('a', cls || '', text); a.href = href; return a; }
  function sideTable(header, rows) {
    var table = el('table'), thead = el('thead'), tr = el('tr');
    header.forEach(function (h) { tr.appendChild(el('th', h.num ? 'num' : '', h.label)); });
    thead.appendChild(tr); table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var row = el('tr');
      r.forEach(function (v, i) {
        var td = el('td', header[i].num ? 'num' : '');
        if (v instanceof Node) td.appendChild(v); else td.textContent = v === null || v === undefined ? '' : String(v);
        if (header[i].sign && typeof v === 'number') td.classList.add(v > 0 ? 'up' : v < 0 ? 'down' : '');
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    return table;
  }

  // find box with a small list of matches
  function findBox(input, items, onPick) {
    // items: [{label, sub, key}]
    var list = el('ul', 'find-list'); list.hidden = true; list.setAttribute('role', 'listbox');
    input.parentNode.appendChild(list);
    var active = -1, shown = [];
    function hide() { list.hidden = true; active = -1; }
    function show(q) {
      q = q.trim().toLowerCase();
      clear(list); shown = [];
      if (!q) { hide(); return; }
      items.forEach(function (it) {
        if (shown.length >= 12) return;
        var hay = (it.label + ' ' + (it.sub || '') + ' ' + (it.key || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return;
        shown.push(it);
        var li = el('li', '', it.label); li.setAttribute('role', 'option');
        if (it.sub) li.appendChild(el('small', '', it.sub));
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(it); });
        list.appendChild(li);
      });
      list.hidden = !shown.length;
    }
    function pick(it) { input.value = it.label; hide(); onPick(it); }
    input.addEventListener('input', function () { show(input.value); if (!input.value.trim()) onPick(null); });
    input.addEventListener('focus', function () { show(input.value); });
    input.addEventListener('blur', function () { setTimeout(hide, 120); });
    input.addEventListener('keydown', function (e) {
      if (list.hidden) { if (e.key === 'Enter' && shown.length) { e.preventDefault(); pick(shown[0]); } return; }
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(shown[active < 0 ? 0 : active]); return; }
      else if (e.key === 'Escape') { hide(); return; }
      else return;
      Array.prototype.forEach.call(list.children, function (li, i) { li.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
    });
  }

  // ------------------------------------------------------------------ views
  var VIEWS = {};

  function segRank(seg, mode) {
    var S = window.GPCSegOrder;
    if (S) return S.rank(seg, mode);
    var H = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'];
    var i = H.indexOf(seg); return i < 0 ? 99 : i;
  }
  function segMode() { return window.GPCSegOrder ? window.GPCSegOrder.mode() : 'helices'; }

  // ---------------------------------------------- helix pairs
  VIEWS.helix_pairs = function (card, json) {
    var cols = json.summary_columns, C = {};
    cols.forEach(function (c, i) { C[c] = i; });
    var state = { metric: 'mean_net', group: 'all', segments: 'helices' };
    var cellsPromise = null;

    // group chips from the payload
    var gbox = card.el.querySelector('[data-chips="group"]');
    json.groups.forEach(function (g) {
      var b = el('button', 'chip'); b.type = 'button';
      b.setAttribute('data-value', g.key);
      b.setAttribute('aria-pressed', g.key === 'all' ? 'true' : 'false');
      var name = g.key === 'all' ? 'All ' + g.n : g.label.replace(/ receptors$/, '');
      b.textContent = name + ' ';
      var s = el('small', '', g.key === 'all' ? '' : '(' + g.n + ')');
      b.appendChild(s);
      if (g.n < json.min_receptors) b.setAttribute('title', 'Fewer than ' + json.min_receptors + ' receptors: the direction view is blank, hover gives the numbers');
      gbox.appendChild(b);
    });

    function group() { return json.groups.filter(function (g) { return g.key === state.group; })[0] || json.groups[0]; }
    function segs() { return state.segments === 'helices' ? json.segments.slice(0, json.n_helices) : json.segments; }

    function matrix() {
      var g = group(), S = segs(), n = S.length;
      var z = [], text = [], hover = [], cells = [];
      for (var i = 0; i < n; i++) { z.push([]); text.push([]); hover.push([]); cells.push([]); for (var j = 0; j < n; j++) { z[i].push(null); text[i].push(''); hover[i].push(''); cells[i].push(null); } }
      g.cells.forEach(function (row) {
        var i = row[0], j = row[1];
        if (i >= n || j >= n) return;
        var np = row[C.n_present], v = row[C[state.metric]];
        var direction = state.metric !== 'coverage';
        if (direction && np < json.min_receptors) v = null;
        var agree = row[C.agree];
        var txt = v === null ? '' : (state.metric === 'coverage' ? pct(v) : signed(v, 1) + (isPhone() || agree === null ? '' : '<br><span style="font-size:9px">' + pct(agree) + ' agree</span>'));
        var hv = S[i] + ' to ' + S[j] + '<br>' + fmt(np) + ' of ' + fmt(g.n) + ' receptors (' + pct(row[C.coverage]) + ') have an above-threshold pair here'
          + '<br>mean net ΔRRCS per receptor ' + signed(row[C.mean_net], 2) + (agree === null ? '' : ' (' + pct(agree) + ' agree in direction)')
          + '<br>' + row[C.n_up] + ' stronger in the active model, ' + row[C.n_down] + ' in the inactive model'
          + '<br>among receptors with a pair: net ' + signed(row[C.mean_net_present], 2) + ', gain ' + signed(row[C.mean_gain_present], 2) + ', loss ' + signed(row[C.mean_loss_present], 2)
          + '<br>' + fmt(row[C.n_pairs]) + ' above-threshold pairs' + (direction && np < json.min_receptors ? '<br>blank: fewer than ' + json.min_receptors + ' receptors' : '');
        z[i][j] = z[j][i] = v; text[i][j] = text[j][i] = txt; hover[i][j] = hover[j][i] = hv; cells[i][j] = cells[j][i] = row;
      });
      return { segs: S, z: z, text: text, hover: hover, cells: cells, group: g };
    }

    card.render = function (opts) {
      opts = opts || {};
      var t = opts.theme || theme(), m = matrix();
      var direction = state.metric !== 'coverage';
      var lim = 1;
      m.z.forEach(function (r) { r.forEach(function (v) { if (v !== null && Math.abs(v) > lim) lim = Math.abs(v); }); });
      var phone = isPhone();
      var trace = {
        type: 'heatmap', z: m.z, x: m.segs, y: m.segs, text: m.text, hovertext: m.hover, hoverinfo: 'text',
        texttemplate: '%{text}', textfont: { size: phone ? 9 : 11 }, xgap: 2, ygap: 2, hoverongaps: false,
        colorscale: direction ? DIVERGING[t] : RAMP[t],
        zmin: direction ? -lim : 0, zmax: direction ? lim : 1, zmid: direction ? 0 : undefined,
        showscale: !phone,
        colorbar: direction
          ? { title: { text: 'Mean net ΔRRCS' }, thickness: 10, len: 0.7, tickvals: [-lim, 0, lim], ticktext: ['−' + lim.toFixed(1) + ' inactive', '0', '+' + lim.toFixed(1) + ' active'] }
          : { title: { text: 'Share of receptors' }, thickness: 10, len: 0.7, tickformat: '.0%' }
      };
      var layout = {
        title: { text: (direction ? 'Net ΔRRCS by helix pair' : 'Share of receptors with an above-threshold pair by helix pair') + ', ' + m.group.label + ' (n = ' + m.group.n + '), site layer' },
        margin: { l: phone ? 40 : 54, r: 8, t: 30, b: 8 },
        xaxis: { side: 'top', showgrid: false, constrain: 'domain', tickfont: { size: phone ? 10 : 12 } },
        yaxis: { autorange: 'reversed', showgrid: false, scaleanchor: 'x', tickfont: { size: phone ? 10 : 12 } }
      };
      card.suffix = state.metric + '_' + state.group.replace(/\W+/g, '_').toLowerCase();
      setViewText(card, (direction ? (state.metric === 'mean_net' ? 'direction, mean net ΔRRCS per receptor' : 'mean net ΔRRCS among receptors with a pair') : 'coverage, share of receptors with an above-threshold pair')
        + ', ' + (state.group === 'all' ? 'all ' + m.group.n + ' receptors' : m.group.label + ' (' + m.group.n + ')') + ', ' + (state.segments === 'helices' ? 'TM1 to TM7 and H8' : 'all segments'));
      card.matrix = m;
      return plot(card, [trace], layout, opts);
    };
    card.tableRows = function () {
      var m = card.matrix || matrix(), rows = [];
      for (var i = 0; i < m.segs.length; i++) for (var j = i; j < m.segs.length; j++) {
        var r = m.cells[i][j]; if (!r) continue;
        rows.push([m.segs[i], m.segs[j], r[C.n_present], r[C.coverage], r[C.mean_net], r[C.agree], r[C.n_up], r[C.n_down], r[C.mean_net_present], r[C.mean_gain_present], r[C.mean_loss_present], r[C.n_pairs]]);
      }
      return { header: ['segment a', 'segment b', 'receptors with a pair', 'coverage', 'mean net ΔRRCS per receptor', 'agree', 'stronger active', 'stronger inactive', 'mean net (with a pair)', 'mean gain', 'mean loss', 'above-threshold pairs'], rows: rows, note: m.group.label + ', site layer.' };
    };
    card.onChip = function (key, value) {
      state[key] = value;
      card.render();
    };
    function hint() {
      if (isPhone()) return;
      openSide(card, 'The receptors behind a cell', function (side) {
        side.appendChild(el('p', 'side-note', 'Click a cell of the grid to list every receptor with an above-threshold pair between those two helices, with its net change and a link to its report. The receptor chips above restrict the list to one ligand type.'));
      });
    }
    card.render().then(function () { card.plot.on('plotly_click', onClick); hint(); });

    function onClick(ev) {
      var p = ev.points && ev.points[0];
      if (!p) return;
      var S = segs(), i = S.indexOf(p.y), j = S.indexOf(p.x);
      if (i < 0 || j < 0) return;
      var a = Math.min(i, j), b = Math.max(i, j);
      var g = group();
      var members = null;
      if (g.key !== 'all') members = {};
      if (members) json.receptors.forEach(function (r, k) { if (r.ligand === g.key) members[k] = true; });
      cellsPromise = cellsPromise || loadJSON(card.src.replace('helix_pairs.json', 'helix_pair_cells.json'));
      cellsPromise.then(function (hc) {
        var cell = hc.cells.filter(function (c) { return c.i === a && c.j === b; })[0];
        var rows = cell ? cell.receptors.filter(function (r) { return !members || members[r[0]]; }) : [];
        openSide(card, S[a] + ' to ' + S[b] + ': the receptors behind the cell', function (side) {
          if (!rows.length) { side.appendChild(el('p', 'side-note', 'No receptor in this group has an above-threshold pair here.')); return; }
          var t = theme();
          var top = rows.slice(0, 8), bottom = rows.slice(-8);
          var sel = rows.length > 16 ? top.concat(bottom) : rows;
          var div = el('div', 'side-plot'); side.appendChild(div);
          window.Plotly.react(div, [{
            type: 'bar', orientation: 'h',
            y: sel.map(function (r) { return json.receptors[r[0]].symbol; }), x: sel.map(function (r) { return r[1]; }),
            marker: { color: sel.map(function (r) { return r[1] >= 0 ? THEME[t].active : THEME[t].inactive; }) },
            customdata: sel.map(function (r) { return [r[2], r[3], r[4]]; }),
            hovertemplate: '%{y}: net %{x:+.1f} (gain %{customdata[0]:+.1f}, loss %{customdata[1]:+.1f}, %{customdata[2]} pairs)<extra></extra>'
          }], merge(baseLayout(t), { margin: { l: 70, r: 10, t: 6, b: 36 }, yaxis: { autorange: 'reversed' }, xaxis: { title: { text: 'net ΔRRCS, above-threshold pairs' } } }), CONFIG);
          side.appendChild(el('p', 'side-note', fmt(rows.length) + ' receptors with an above-threshold pair here' + (rows.length > 16 ? '; the chart shows the eight at each end' : '') + '. Red: stronger in the active model. Blue: stronger in the inactive model.'));
          var tb = sideTable([{ label: 'Receptor' }, { label: 'Net', num: true, sign: true }, { label: 'Gain', num: true }, { label: 'Loss', num: true }, { label: 'Pairs', num: true }],
            rows.map(function (r) { var rec = json.receptors[r[0]]; return [link(rec.symbol, REPORT(rec.gid)), r[1], r[2], r[3], r[4]]; }));
          side.appendChild(tb);
        });
      }).catch(function (err) { openSide(card, S[a] + ' to ' + S[b], function (side) { side.appendChild(el('p', 'side-note', 'The receptor list could not be loaded (' + err.message + ').')); }); });
    }
  };

  // ---------------------------------------------- CFR atlas
  VIEWS.cfr_atlas = function (card, json) {
    var state = { group: 'ligand', mode: 'state', order: null, view: isPhone() ? 'summary' : 'matrix', find: null };
    if (state.view === 'summary') setChip(card, 'view', 'summary');
    var P = json.positions;

    function colOrder() {
      var order = state.order || segMode();
      if (order === 'rank') return json.rank_order.slice();
      var idx = P.map(function (p, i) { return i; });
      if (order === 'sequence') idx.sort(function (a, b) { return segRank(P[a].segment, 'sequence') - segRank(P[b].segment, 'sequence') || a - b; });
      return idx;
    }
    function rowsSorted() {
      var rows = json.receptors.map(function (r, i) { return { r: r, i: i }; });
      if (state.group === 'family') rows.sort(function (a, b) { return a.r.family.localeCompare(b.r.family) || a.r.symbol.localeCompare(b.r.symbol); });
      return rows;
    }
    function groupsOf(rows) {
      var key = state.group === 'family' ? 'family' : 'ligand', out = [], last = null;
      rows.forEach(function (x, k) {
        var g = x.r[key];
        if (g !== last) { out.push({ key: g, start: k, end: k }); last = g; } else out[out.length - 1].end = k;
      });
      return out;
    }

    card.render = function (opts) {
      opts = opts || {};
      var t = opts.theme || theme(), phone = isPhone();
      var cols = colOrder(), x = cols.map(function (k) { return P[k].gn; });
      card.suffix = state.view + '_' + state.mode + '_' + state.group;
      if (state.view === 'summary') return renderSummary(t, cols, x, opts);
      var rows = rowsSorted(), groups = groupsOf(rows);
      var y = rows.map(function (x, k) { return k; });
      var z = [], miss = [], hover = [];
      rows.forEach(function (x) {
        var r = x.r, zr = [], mr = [], hr = [];
        cols.forEach(function (k) {
          var s = r.state.charAt(k), net = r.net[k];
          var label = r.symbol + ' (' + r.family + ')<br>' + P[k].gn + ' (' + P[k].segment + ', rank ' + P[k].rank + ')<br>';
          if (s === '2') { zr.push(state.mode === 'direction' ? net : 2); mr.push(null); hr.push(label + 'above-threshold contact, net ΔRRCS ' + signed(net, 2)); }
          else if (s === '1') { zr.push(state.mode === 'direction' ? 0 : 1); mr.push(null); hr.push(label + 'numbered, no above-threshold contact'); }
          else { zr.push(null); mr.push(1); hr.push(label + 'not numbered in this receptor'); }
        });
        z.push(zr); miss.push(mr); hover.push(hr);
      });
      var data = [{ type: 'heatmap', z: miss, x: x, y: y, showscale: false, hoverinfo: 'skip', colorscale: [[0, THEME[t].cell], [1, THEME[t].cell]], zmin: 0, zmax: 1 }];
      if (state.mode === 'direction') {
        var vals = [];
        z.forEach(function (r) { r.forEach(function (v) { if (v) vals.push(Math.abs(v)); }); });
        vals.sort(function (a, b) { return a - b; });
        var lim = vals.length ? vals[Math.floor(0.95 * (vals.length - 1))] : 1;
        data.push({ type: 'heatmap', z: z, x: x, y: y, zmin: -lim, zmax: lim, zmid: 0, colorscale: DIVERGING[t], hoverongaps: false,
          hovertext: hover, hoverinfo: 'text', showscale: !phone,
          colorbar: { title: { text: 'Net ΔRRCS' }, thickness: 10, len: 0.6, tickvals: [-lim, 0, lim], ticktext: ['−' + lim.toFixed(0) + ' inactive', '0', '+' + lim.toFixed(0) + ' active'] } });
      } else {
        data.push({ type: 'heatmap', z: z, x: x, y: y, zmin: 1, zmax: 2, hoverongaps: false, hovertext: hover, hoverinfo: 'text', showscale: !phone,
          colorscale: [[0, THEME[t].paper], [0.5, THEME[t].paper], [0.5, THEME[t].brand], [1, THEME[t].brand]],
          colorbar: { thickness: 10, len: 0.3, tickvals: [1.25, 1.75], ticktext: ['numbered, no<br>above-threshold contact', 'above-threshold<br>contact'] } });
      }
      var shapes = [], ticks = [], ticktext = [];
      var MINROWS = phone ? 12 : 6, small = null;
      groups.forEach(function (g, k) {
        if (k) shapes.push({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: g.start - 0.5, y1: g.start - 0.5, line: { color: THEME[t].muted, width: 1 } });
        var n = g.end - g.start + 1;
        if (n < MINROWS) { small = small ? { start: small.start, end: g.end, n: small.n + n, k: small.k + 1 } : { start: g.start, end: g.end, n: n, k: 1 }; return; }
        if (small) { ticks.push((small.start + small.end) / 2); ticktext.push(small.k + ' smaller groups (' + small.n + ')'); small = null; }
        ticks.push((g.start + g.end) / 2);
        var name = g.key.replace(/ receptors$/, '');
        ticktext.push((phone && name.length > 12 ? name.slice(0, 11) + '…' : name) + ' (' + n + ')');
      });
      if (small) { ticks.push((small.start + small.end) / 2); ticktext.push(small.k + ' smaller groups (' + small.n + ')'); }
      if (state.find !== null) {
        var fi = rows.map(function (x) { return x.i; }).indexOf(state.find);
        if (fi >= 0) shapes.push({ type: 'rect', xref: 'paper', x0: 0, x1: 1, y0: fi - 1.5, y1: fi + 1.5, line: { color: THEME[t].hilite, width: 2 } });
      }
      // segment labels above the columns
      var ann = [];
      var lastSeg = null, segStart = 0;
      cols.forEach(function (k, c) {
        var seg = P[k].segment;
        if (seg !== lastSeg) { if (lastSeg !== null && (state.order || segMode()) !== 'rank') ann.push({ x: (segStart + c - 1) / 2, y: 1, yref: 'paper', yanchor: 'bottom', yshift: 64, text: lastSeg, showarrow: false, font: { size: 10, color: THEME[t].muted } }); lastSeg = seg; segStart = c; }
      });
      if (lastSeg !== null && (state.order || segMode()) !== 'rank') ann.push({ x: (segStart + cols.length - 1) / 2, y: 1, yref: 'paper', yanchor: 'bottom', yshift: 64, text: lastSeg, showarrow: false, font: { size: 10, color: THEME[t].muted } });
      var layout = {
        title: { text: 'The ' + P.length + ' CFR positions across ' + rows.length + ' receptors, rows by ' + (state.group === 'family' ? 'family' : 'ligand type') + ', cells ' + (state.mode === 'direction' ? 'by net ΔRRCS' : 'by state') + ', site layer' },
        margin: { l: phone ? 70 : 150, r: 8, t: phone ? 56 : 84, b: 8 },
        xaxis: { side: 'top', tickangle: -90, tickfont: { size: phone ? 7 : 9 }, showgrid: false, type: 'category' },
        yaxis: { autorange: 'reversed', tickvals: ticks, ticktext: ticktext, tickfont: { size: phone ? 9 : 11 }, showgrid: false, zeroline: false },
        shapes: shapes, annotations: phone ? [] : ann
      };
      setViewText(card, 'full matrix, rows by ' + (state.group === 'family' ? 'family' : 'ligand type') + ', cells ' + (state.mode === 'direction' ? 'colored by net ΔRRCS at the residue' : 'by state') + ', columns ' + orderText());
      card.rows = rows;
      return plot(card, data, layout, opts);
    };
    function orderText() { var o = state.order || segMode(); return o === 'rank' ? 'in CFR rank order' : o === 'sequence' ? 'in sequence order' : 'helices first'; }

    function renderSummary(t, cols, x, opts) {
      var G = json.groups[state.group === 'family' ? 'family' : 'ligand'].filter(function (g) { return g.n >= (state.group === 'family' ? 4 : 1); });
      var phone = isPhone();
      var z = G.map(function (g) { return cols.map(function (k) { return g.hit[k]; }); });
      var text = G.map(function (g) { return cols.map(function (k) { return phone ? '' : Math.round(100 * g.hit[k]); }); });
      var hover = G.map(function (g) { return cols.map(function (k) { return g.key + ' (' + g.n + ')<br>' + P[k].gn + ': ' + pct(g.hit[k]) + ' of the group has an above-threshold contact<br>' + g.numbered[k] + ' of ' + g.n + ' numbered here'; }); });
      var y = G.map(function (g) { return g.key.replace(/ receptors$/, '') + ' (' + g.n + ')'; });
      var data = [{ type: 'heatmap', z: z, x: x, y: y, text: text, texttemplate: phone ? '' : '%{text}', textfont: { size: 8 }, hovertext: hover, hoverinfo: 'text',
        zmin: 0, zmax: 1, colorscale: RAMP[t], xgap: 1, ygap: 1, showscale: !phone, colorbar: { title: { text: 'Share with a change' }, tickformat: '.0%', thickness: 10, len: 0.6 } }];
      var layout = {
        title: { text: 'Share of receptors with an above-threshold contact at each CFR position, by ' + (state.group === 'family' ? 'family (4 or more receptors)' : 'ligand type') + ', site layer' },
        margin: { l: phone ? 90 : 190, r: 8, t: 60, b: 8 },
        xaxis: { side: 'top', tickangle: -90, tickfont: { size: phone ? 7 : 9 }, showgrid: false, type: 'category' },
        yaxis: { autorange: 'reversed', tickfont: { size: phone ? 9 : 11 }, showgrid: false }
      };
      card.plot.style.height = state.group === 'family' ? Math.max(360, 22 * G.length + 90) + 'px' : '';
      setViewText(card, 'group summary (share of receptors with a change) by ' + (state.group === 'family' ? 'family' : 'ligand type') + ', columns ' + orderText());
      return plot(card, data, layout, opts);
    }

    card.tableRows = function () {
      var cols = colOrder();
      return { header: ['generic number', 'segment', 'CFR score rank', 'receptors with an above-threshold contact (site layer)', 'receptors (Supplementary Table S3)', 'receptors numbered', 'net gain', 'net loss'],
        rows: cols.map(function (k) { var c = json.columns[k]; return [P[k].gn, P[k].segment, P[k].rank, c.n_hit, P[k].s3_n_receptors, c.n_numbered, c.n_up, c.n_down]; }),
        note: 'Per position. The full 50 x 283 matrix is in the CSV.' };
    };
    card.onChip = function (key, value) {
      if (key === 'order') { state.order = value; }
      else state[key] = value;
      if (key === 'view' && value === 'matrix') card.plot.style.height = '';
      card.render();
    };
    // the shared segment switch inside the card clears the local "CFR rank" order
    var slot = card.el.querySelector('[data-seg-order-slot]');
    if (slot) slot.addEventListener('click', function (e) { if (e.target.closest('button')) { state.order = null; setChip(card, 'order', ''); card.render(); } });
    document.addEventListener('gpc:segment-order', function () { if (!state.order && card.drawn) card.render(); });

    var input = card.el.querySelector('[data-find="cfr_atlas"]');
    if (input) findBox(input, json.receptors.map(function (r, i) { return { label: r.symbol, sub: r.family, key: r.gid, i: i }; }), function (it) {
      state.find = it ? it.i : null;
      if (state.view !== 'matrix' && it) { state.view = 'matrix'; setChip(card, 'view', 'matrix'); card.plot.style.height = ''; }
      card.render();
      if (it) showReceptor(json.receptors[it.i]);
      else closeSide(card);
    });

    function showReceptor(r, k) {
      openSide(card, r.symbol + ' at the ' + P.length + ' CFR positions', function (side) {
        side.appendChild(el('p', '', r.family + ', ' + r.ligand.replace(/ receptors$/, '')));
        var cols = colOrder(), t = theme();
        var strip = el('div', 'fp-strip'); strip.style.display = 'flex'; strip.style.flexWrap = 'wrap'; strip.style.gap = '2px';
        cols.forEach(function (c) {
          var i = el('i'); var s = r.state.charAt(c);
          i.style.width = '8px'; i.style.height = '14px';
          i.style.background = s === '2' ? (r.net[c] >= 0 ? THEME[t].active : THEME[t].inactive) : s === '1' ? THEME[t].paper : THEME[t].cell;
          i.style.outline = '1px solid ' + THEME[t].line;
          if (k === c) i.style.outline = '2px solid ' + THEME[t].hilite;
          i.title = P[c].gn + ': ' + (s === '2' ? 'net ' + signed(r.net[c], 2) : s === '1' ? 'no above-threshold contact' : 'not numbered');
          strip.appendChild(i);
        });
        side.appendChild(strip);
        var hits = 0, numbered = 0;
        for (var c = 0; c < r.state.length; c++) { if (r.state.charAt(c) === '2') hits++; if (r.state.charAt(c) !== '0') numbered++; }
        side.appendChild(el('p', 'side-note', hits + ' of ' + numbered + ' numbered CFR positions carry an above-threshold contact. Red: net gain in the active model; blue: net loss; white: none; gray: not numbered.'));
        if (k !== undefined) {
          var s = r.state.charAt(k);
          side.appendChild(el('p', '', P[k].gn + ' (' + P[k].segment + ', CFR rank ' + P[k].rank + '): ' + (s === '2' ? 'above-threshold contact, net ΔRRCS ' + signed(r.net[k], 2) : s === '1' ? 'numbered, no above-threshold contact' : 'not numbered in this receptor')));
        }
        var p = el('p', '');
        p.appendChild(link('Open the report residue table', REPORT(r.gid) + '#sec-residues', 'cc-btn'));
        p.appendChild(document.createTextNode(' '));
        if (k !== undefined) p.appendChild(link('Search ' + P[k].gn, SEARCH(P[k].gn), 'cc-btn'));
        side.appendChild(p);
      });
    }
    card.render().then(function () {
      card.plot.on('plotly_click', function (ev) {
        var p = ev.points && ev.points[ev.points.length - 1];
        if (!p || state.view !== 'matrix' || !card.rows) return;
        var row = card.rows[p.y]; if (!row) return;
        var k = P.map(function (q) { return q.gn; }).indexOf(p.x);
        showReceptor(row.r, k);
      });
    });
  };

  // ---------------------------------------------- receptor explorer
  VIEWS.receptors = function (card, json) {
    var cols = json.columns, C = {};
    cols.forEach(function (c, i) { C[c] = i; });
    var rows = json.rows.map(function (r) { var o = {}; cols.forEach(function (c, i) { o[c] = r[i]; }); return o; });
    var byGid = {}; rows.forEach(function (r) { byGid[r.gid] = r; });
    var label = {}; json.metrics.forEach(function (m) { label[m.key] = m.label; });
    var state = { tab: 'scatter', x: 'n_above', y: 'share_active', color: 'ligand', find: null, sort: null, dir: 1, filter: '' };
    var atlasPromise = null;

    ['x', 'y'].forEach(function (axis) {
      var box = card.el.querySelector('[data-chips="' + axis + '"]');
      json.metrics.forEach(function (m) {
        var b = el('button', 'chip', m.label); b.type = 'button';
        b.setAttribute('data-value', m.key); b.setAttribute('aria-pressed', state[axis] === m.key ? 'true' : 'false');
        b.setAttribute('title', m.description);
        box.appendChild(b);
      });
    });
    var tableBox = el('div', 'explorer-table'); tableBox.hidden = true;
    card.body.insertBefore(tableBox, card.table);

    function ligColor(t) {
      var m = {};
      json.ligand_groups.forEach(function (g) { m[g.key] = t === 'dark' ? (LIGAND_DARK[g.key] || g.color) : g.color; });
      return m;
    }
    function famColor(t) {
      var fams = json.families.filter(function (f) { return f.plotted; }).sort(function (a, b) { return b.n - a.n; });
      var m = {}, pal = FAMILY_PALETTE[t];
      fams.forEach(function (f, i) { m[f.family] = pal[i % pal.length]; });
      return m;
    }
    function logTicks(key) {
      var vals = rows.map(function (r) { return r[key]; }).filter(function (v) { return v > 0; });
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), out = [];
      for (var e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
        [1, 2, 5].forEach(function (m) { var v = m * Math.pow(10, e); if (v >= lo * 0.8 && v <= hi * 1.25) out.push(v); });
      }
      return out;
    }
    function axisSpec(key, t) {
      var log = key === 'n_above' || key === 'sum_abs';
      var spec = { title: { text: label[key] }, type: log ? 'log' : 'linear', tickformat: key === 'share_active' ? '.0%' : undefined, gridcolor: t === 'dark' ? '#1f2937' : '#eaeef2' };
      if (log) { var tv = logTicks(key); spec.tickvals = tv; spec.ticktext = tv.map(function (v) { return fmt(v); }); }
      return spec;
    }

    function renderScatter(t, opts) {
      var phone = isPhone();
      var data = [];
      var groups, colorOf, keyOf;
      if (state.color === 'family') {
        var fc = famColor(t);
        keyOf = function (r) { return fc[r.family] ? r.family : 'Other families'; };
        colorOf = function (k) { return fc[k] || THEME[t].muted; };
        groups = Object.keys(fc).concat(['Other families']);
      } else {
        var lc = ligColor(t);
        keyOf = function (r) { return r.ligand_group; };
        colorOf = function (k) { return lc[k]; };
        groups = json.ligand_groups.map(function (g) { return g.key; });
      }
      groups.forEach(function (g) {
        var sub = rows.filter(function (r) { return keyOf(r) === g && r[state.x] !== null && r[state.y] !== null; });
        if (!sub.length) return;
        data.push({
          type: 'scatter', mode: 'markers', name: g.replace(/ receptors$/, '') + ' (' + sub.length + ')',
          x: sub.map(function (r) { return r[state.x]; }), y: sub.map(function (r) { return r[state.y]; }),
          text: sub.map(function (r) { return r.symbol; }),
          customdata: sub.map(function (r) { return [r.family, r.gid, r.cfr_hits]; }),
          marker: { color: colorOf(g), size: sub.map(function (r) { return (phone ? 4 : 5) + 0.3 * (r.cfr_hits || 0); }), opacity: 0.85, line: { width: 0.5, color: THEME[t].paper } },
          hovertemplate: '%{text} (%{customdata[0]})<br>' + label[state.x] + ': %{x}<br>' + label[state.y] + ': %{y}<br>CFR positions with a change: %{customdata[2]}<extra></extra>'
        });
      });
      if (state.find && byGid[state.find]) {
        var f = byGid[state.find];
        data.push({ type: 'scatter', mode: 'markers+text', name: f.symbol, showlegend: false, x: [f[state.x]], y: [f[state.y]], text: [f.symbol], textposition: 'top center',
          textfont: { color: THEME[t].hilite, size: 12 }, marker: { size: 18, color: 'rgba(0,0,0,0)', line: { width: 2, color: THEME[t].hilite } }, hoverinfo: 'skip' });
      }
      var layout = {
        title: { text: label[state.x] + ' and ' + label[state.y].toLowerCase() + ', ' + rows.length + ' receptors, site layer' },
        xaxis: axisSpec(state.x, t), yaxis: axisSpec(state.y, t),
        legend: { orientation: 'h', y: -0.22, x: 0, font: { size: phone ? 10 : 12 } },
        margin: { l: 56, r: 12, t: 12, b: phone ? 110 : 90 }
      };
      card.suffix = 'scatter_' + state.x + '_' + state.y;
      setViewText(card, 'scatter, x ' + label[state.x].toLowerCase() + ', y ' + label[state.y].toLowerCase() + ', point size by CFR positions with a change, color by ' + (state.color === 'family' ? 'family (the 12 largest; others gray)' : 'ligand type'));
      return plot(card, data, layout, opts);
    }

    function renderFamilies(t, opts) {
      var metric = state.x;
      var fams = json.families.filter(function (f) { return f.plotted && f['median_' + metric] !== null; }).sort(function (a, b) { return a['median_' + metric] - b['median_' + metric]; });
      var lc = ligColor(t);
      var names = fams.map(function (f) { return f.family + ' (' + f.n + ')'; });
      var data = [];
      fams.forEach(function (f, i) {
        var sub = rows.filter(function (r) { return r.family === f.family && r[metric] !== null; });
        data.push({ type: 'scatter', mode: 'markers', showlegend: false, x: sub.map(function (r) { return r[metric]; }), y: sub.map(function () { return names[i]; }),
          text: sub.map(function (r) { return r.symbol; }), customdata: sub.map(function (r) { return r.gid; }),
          marker: { size: 7, color: lc[f.ligand] || lc[ligGroup(f.ligand)] || THEME[t].muted, opacity: 0.8 }, hovertemplate: '%{text}: %{x}<extra></extra>' });
      });
      data.push({ type: 'scatter', mode: 'markers', name: 'median', x: fams.map(function (f) { return f['median_' + metric]; }), y: names,
        marker: { symbol: 'line-ns-open', size: 16, line: { width: 2, color: THEME[t].text } }, hovertemplate: 'median %{x}<extra></extra>' });
      var small = json.families.filter(function (f) { return !f.plotted; });
      var k = json.kruskal && json.kruskal[metric];
      var layout = {
        title: { text: label[metric] + ' by family (families with at least 4 receptors), site layer' },
        xaxis: merge(axisSpec(metric, t), { type: 'linear' }), yaxis: { automargin: true, tickfont: { size: isPhone() ? 9 : 11 } },
        margin: { l: 10, r: 12, t: 12, b: 50 }, legend: { orientation: 'h', y: -0.08 }
      };
      card.plot.style.height = Math.max(380, 22 * fams.length + 100) + 'px';
      card.suffix = 'families_' + metric;
      setViewText(card, 'families with 4 or more receptors, ' + label[metric].toLowerCase() + ' (x chip), one dot per receptor, tick at the median'
        + (k ? '; Kruskal-Wallis across ' + k.families.k + ' families: H = ' + k.families.H.toFixed(1) + ', p = ' + k.families.p.toPrecision(2) + ' (n = ' + k.families.n + '); across ' + k.ligand_types.k + ' ligand types: H = ' + k.ligand_types.H.toFixed(1) + ', p = ' + k.ligand_types.p.toPrecision(2) + ' (n = ' + k.ligand_types.n + ')' : '')
        + (small.length ? '; not plotted (fewer than 4 receptors): ' + small.map(function (f) { return f.family + ' (' + f.n + ')'; }).join(', ') : ''));
      return plot(card, data, layout, opts);
    }
    function ligGroup(l) { return json.ligand_groups.some(function (g) { return g.key === l; }) ? l : 'Other'; }

    var TCOLS = [
      { key: 'symbol', label: 'Receptor' }, { key: 'name', label: 'Name' }, { key: 'family', label: 'Family' }, { key: 'ligand', label: 'Ligand type' },
      { key: 'n_pairs', label: 'Contact pairs', num: true }, { key: 'n_above', label: 'Above threshold', num: true }, { key: 'above_per_100', label: 'Per 100', num: true },
      { key: 'sum_abs', label: 'Sum |ΔRRCS|', num: true }, { key: 'share_active', label: 'Share active', num: true, pct: true }, { key: 'cfr_hits', label: 'CFR positions changed', num: true },
      { key: 'threshold', label: 'Threshold', num: true }, { key: 'rank', label: 'Class rank', num: true }
    ];
    function renderTableTab() {
      var metric = state.x, rk = 'rank_' + metric;
      var list = rows.slice();
      var q = state.filter.toLowerCase();
      if (q) list = list.filter(function (r) { return (r.symbol + ' ' + r.name + ' ' + r.family + ' ' + r.ligand + ' ' + r.gid).toLowerCase().indexOf(q) >= 0; });
      var sortKey = state.sort || rk, dir = state.sort ? state.dir : 1;
      list.sort(function (a, b) {
        var va = sortKey === 'rank' ? a[rk] : a[sortKey], vb = sortKey === 'rank' ? b[rk] : b[sortKey];
        if (typeof va === 'string') return dir * va.localeCompare(vb);
        return dir * ((va === null ? Infinity : va) - (vb === null ? Infinity : vb));
      });
      clear(tableBox);
      var table = el('table'), thead = el('thead'), tr = el('tr');
      TCOLS.forEach(function (c) {
        var th = el('th', c.num ? 'num' : '', c.key === 'rank' ? 'Class rank (' + label[metric].toLowerCase() + ')' : c.label);
        th.setAttribute('aria-sort', (state.sort || 'rank') === c.key ? (dir > 0 ? 'ascending' : 'descending') : 'none');
        th.addEventListener('click', function () {
          if (state.sort === c.key) state.dir = -state.dir; else { state.sort = c.key; state.dir = c.num ? -1 : 1; }
          if (c.key === 'rank') state.dir = state.sort === 'rank' && state.dir === -1 ? -1 : state.dir;
          renderTableTab();
        });
        tr.appendChild(th);
      });
      thead.appendChild(tr); table.appendChild(thead);
      var tbody = el('tbody'), lc = ligColor(theme());
      list.forEach(function (r) {
        var row = el('tr');
        if (state.find === r.gid) row.className = 'is-found';
        TCOLS.forEach(function (c) {
          var td = el('td', c.num ? 'num' : '');
          var v = c.key === 'rank' ? r[rk] : r[c.key];
          if (c.key === 'symbol') { var sw = el('span', 'swatch'); sw.style.background = lc[r.ligand_group]; td.appendChild(sw); td.appendChild(link(r.symbol, r.report || REPORT(r.gid))); }
          else if (c.pct) td.textContent = v === null ? '' : pct(v, 1);
          else td.textContent = v === null || v === undefined ? '' : (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));
          row.appendChild(td);
        });
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      tableBox.appendChild(table);
      var note = el('div', 'chart-card-table-note', list.length + ' of ' + rows.length + ' receptors. Class rank 1 = largest ' + label[metric].toLowerCase() + '. Sum |ΔRRCS| grows with contact count; the per-100 metric corrects for it.');
      tableBox.appendChild(note);
      setViewText(card, 'table of all ' + rows.length + ' receptors with class rank by ' + label[metric].toLowerCase() + (q ? ', filtered by "' + state.filter + '"' : ''));
      card.suffix = 'table';
    }

    card.render = function (opts) {
      opts = opts || {};
      var t = opts.theme || theme();
      if (state.tab === 'table') { renderTableTab(); return card.drawn ? renderScatter(t, opts) : Promise.resolve(); }
      card.plot.style.height = '';
      return state.tab === 'families' ? renderFamilies(t, opts) : renderScatter(t, opts);
    };
    function showTab() {
      var tab = state.tab;
      tableBox.hidden = tab !== 'table';
      card.plot.hidden = tab === 'table';
      card.el.querySelector('[data-chips="y"]').hidden = tab !== 'scatter';
      card.el.querySelector('[data-chips="color"]').hidden = tab !== 'scatter';
      card.el.querySelector('[data-chips="x"] .chips-name').textContent = tab === 'scatter' ? 'x' : 'Metric';
    }
    card.tableRows = function () {
      return { header: TCOLS.map(function (c) { return c.label; }).concat(json.metrics.map(function (m) { return 'rank ' + m.label; })),
        rows: rows.map(function (r) { return TCOLS.map(function (c) { return c.key === 'rank' ? r['rank_' + state.x] : r[c.key]; }).concat(json.metrics.map(function (m) { return r['rank_' + m.key]; })); }),
        note: 'All receptors, site layer.' };
    };
    card.onChip = function (key, value) {
      state[key] = value;
      if (key === 'tab') { showTab(); card.render(); return; }
      if (state.tab === 'table') renderTableTab(); else card.render();
    };
    var input = card.el.querySelector('[data-find="receptors"]');
    if (input) {
      findBox(input, rows.map(function (r) { return { label: r.symbol, sub: r.name + ', ' + r.family, key: r.gid, gid: r.gid }; }), function (it) {
        state.find = it ? it.gid : null;
        state.filter = '';
        if (it) showSimilar(byGid[it.gid]); else closeSide(card);
        if (state.tab === 'table') renderTableTab(); else card.render();
      });
      input.addEventListener('input', function () { if (state.tab === 'table') { state.filter = input.value; renderTableTab(); } });
    }

    function strip(r, t) {
      var s = el('span', 'fp-strip');
      for (var c = 0; c < r.state.length; c++) {
        var i = el('i'); var st = r.state.charAt(c);
        i.style.background = st === '2' ? (r.net[c] >= 0 ? THEME[t].active : THEME[t].inactive) : st === '1' ? THEME[t].paper : THEME[t].cell;
        i.style.outline = '1px solid ' + THEME[t].line;
        s.appendChild(i);
      }
      return s;
    }
    function showSimilar(r) {
      openSide(card, r.symbol + ': ' + r.name, function (side) {
        side.appendChild(el('p', '', r.family + ', ' + r.ligand.replace(/ receptors$/, '') + '. Threshold ' + r.threshold.toFixed(2) + '; ' + fmt(r.n_pairs) + ' contact pairs, ' + fmt(r.n_above) + ' above threshold (' + r.above_per_100 + ' per 100); ' + pct(r.share_active) + ' stronger in the active model; ' + r.cfr_hits + ' of ' + r.cfr_numbered + ' numbered CFR positions with a change.'));
        var ranks = el('p', 'side-note', 'Class rank: ' + json.metrics.map(function (m) { return m.label.toLowerCase() + ' ' + r['rank_' + m.key]; }).join('; ') + ' (1 = largest of ' + rows.length + ').');
        side.appendChild(ranks);
        var p = el('p', ''); p.appendChild(link('Open the report', r.report || REPORT(r.gid), 'cc-btn')); side.appendChild(p);
        var sim = json.similar[r.gid];
        var h = el('h4', '', 'Most similar CFR pattern');
        side.appendChild(h);
        if (!sim || !sim.length) { side.appendChild(el('p', 'side-note', 'No similarity list: fewer than 32 numbered CFR positions.')); return; }
        var holder = el('div'); side.appendChild(holder);
        atlasPromise = atlasPromise || loadJSON(card.src.replace('receptors.json', 'cfr_atlas.json')).catch(function () { return null; });
        atlasPromise.then(function (atlas) {
          var t = theme(), byG = {};
          if (atlas) atlas.receptors.forEach(function (x) { byG[x.gid] = x; });
          var head = [{ label: 'Receptor' }, { label: 'CFR pattern' }, { label: 'Similarity', num: true }];
          var list = [[r.symbol, atlas && byG[r.gid] ? strip(byG[r.gid], t) : '', '1.00']].concat(sim.map(function (s) {
            var o = byGid[s[0]];
            return [link(o ? o.symbol : s[0], o ? (o.report || REPORT(s[0])) : REPORT(s[0])), atlas && byG[s[0]] ? strip(byG[s[0]], t) : '', s[1].toFixed(2)];
          }));
          holder.appendChild(sideTable(head, list));
          holder.appendChild(el('p', 'side-note', 'Pattern similarity: cosine over the signed 50-position CFR fingerprint (red gain, blue loss in the active model, white none, gray not numbered), helices first. A browsing aid, not a classification.'));
        });
      });
    }
    showTab();
    card.render().then(function () {
      card.plot.on('plotly_click', function (ev) {
        var p = ev.points && ev.points[0];
        if (!p || !p.customdata) return;
        var gid = Array.isArray(p.customdata) ? p.customdata[1] : p.customdata;
        if (byGid[gid]) { state.find = gid; if (input) input.value = byGid[gid].symbol; showSimilar(byGid[gid]); card.render(); }
      });
    });
  };

  // ---------------------------------------------- variants at CFR positions (site layer)
  VIEWS.cfr_variants = function (card, json) {
    var state = { order: null, set: 'cfr', panel: 'composition' };
    var P = json.positions;
    var CLASSES = ['benign', 'ambiguous', 'pathogenic'];
    var NAMES = { benign: 'Predicted benign', ambiguous: 'Ambiguous', pathogenic: 'Predicted pathogenic' };

    function ordered() {
      var order = state.order || segMode();
      var list = P.slice();
      if (order === 'pathogenic') list.sort(function (a, b) { return (b.pathogenic_pct_decisive || 0) - (a.pathogenic_pct_decisive || 0); });
      else if (order === 'sequence') list.sort(function (a, b) { return a.order_sequence - b.order_sequence; });
      else list.sort(function (a, b) { return a.order_helices - b.order_helices; });
      return list;
    }
    function orderText() { var o = state.order || segMode(); return o === 'pathogenic' ? 'sorted by % predicted pathogenic' : o === 'sequence' ? 'in sequence order' : 'helices first'; }
    function scored(am) { return am.benign + am.ambiguous + am.pathogenic; }

    card.render = function (opts) {
      opts = opts || {};
      var t = opts.theme || theme(), tint = CLINICAL[t], phone = isPhone();
      var data = [], layout;
      if (state.set === 'other') {
        var G = json.groups;
        var x = G.map(function (g) { return g.label.replace(/ \(.*\)$/, ''); });
        CLASSES.forEach(function (cls) {
          data.push({ type: 'bar', name: NAMES[cls], x: x, y: G.map(function (g) { var s = scored(g.am_substitutions); return s ? 100 * g.am_substitutions[cls] / s : 0; }),
            customdata: G.map(function (g) { return [g.am_substitutions[cls], scored(g.am_substitutions), g.positions, g.receptors_with_alleles]; }),
            marker: { color: tint[cls] }, text: G.map(function (g) { var s = scored(g.am_substitutions); return s ? (100 * g.am_substitutions[cls] / s).toFixed(1) + '%' : ''; }), textposition: 'inside', insidetextfont: { color: t === 'dark' ? '#0f1417' : '#ffffff' },
            hovertemplate: '%{x}<br>' + NAMES[cls] + ': %{customdata[0]:,} of %{customdata[1]:,} scored substitutions (%{y:.1f}%)<br>%{customdata[2]} positions, %{customdata[3]} receptors with alleles<extra></extra>' });
        });
        layout = { barmode: 'stack', title: { text: 'AlphaMissense prediction for observed gnomAD substitutions, CFR positions against the rest of the catalog, site layer' },
          yaxis: { title: { text: 'Share of scored substitutions (%)' }, range: [0, 100] }, xaxis: { type: 'category', tickfont: { size: phone ? 9 : 11 }, automargin: true },
          legend: { orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0, traceorder: 'normal' }, margin: { l: 56, r: 12, t: 36, b: 60 } };
        setViewText(card, 'pooled comparison of position sets (unique substitutions), site layer');
        card.suffix = 'groups';
        return plot(card, data, layout, opts);
      }
      var pos = ordered(), x = pos.map(function (p) { return p.generic; });
      if (state.panel === 'composition') {
        CLASSES.forEach(function (cls) {
          data.push({ type: 'bar', name: NAMES[cls], x: x,
            y: pos.map(function (p) { var s = scored(p.am_substitutions); return s ? 100 * p.am_substitutions[cls] / s : 0; }),
            customdata: pos.map(function (p) { return [p.am_substitutions[cls], scored(p.am_substitutions), p.receptors_with_alleles, p.segment, p.conservation.median === null ? '' : p.conservation.median.toFixed(2), p.cfr_rank]; }),
            marker: { color: tint[cls], opacity: pos.map(function (p) { return scored(p.am_substitutions) < 20 ? 0.45 : 1; }) },
            hovertemplate: '%{x} (%{customdata[3]}, CFR rank %{customdata[5]})<br>' + NAMES[cls] + ': %{customdata[0]:,} of %{customdata[1]:,} scored substitutions (%{y:.1f}%)<br>%{customdata[2]} receptors with alleles; conservation median %{customdata[4]} (observed)<extra></extra>' });
        });
        layout = { barmode: 'stack', title: { text: 'AlphaMissense prediction for observed gnomAD substitutions at the ' + pos.length + ' CFR positions, site layer' },
          yaxis: { title: { text: 'Share of scored substitutions (%)' }, range: [0, 100] },
          xaxis: { type: 'category', tickangle: -60, tickfont: { size: phone ? 7 : 9 }, categoryorder: 'array', categoryarray: x },
          legend: { orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0, traceorder: 'normal' }, margin: { l: 56, r: 12, t: 36, b: 70 } };
        setViewText(card, 'AlphaMissense class of unique substitutions per position, ' + orderText() + ', CFR rank 1 to ' + pos.length + '; bars with fewer than 20 scored substitutions are faded');
      } else {
        data.push({ type: 'bar', name: 'gnomAD substitutions', x: x, y: pos.map(function (p) { return p.substitutions; }), marker: { color: tint.neutral },
          customdata: pos.map(function (p) { return [p.alleles, p.allele_count, p.af_median === null ? '' : p.af_median.toExponential(2), p.conservation.median === null ? '' : p.conservation.median.toFixed(2), p.receptors_numbered]; }),
          hovertemplate: '%{x}: %{y:,} substitutions (%{customdata[0]:,} alleles, allele count %{customdata[1]:,})<br>median allele frequency %{customdata[2]}<br>%{customdata[4]} receptors numbered here; conservation median %{customdata[3]} (observed)<extra></extra>' });
        data.push({ type: 'scatter', name: 'ClinVar P/LP missense (database set)', x: x, y: pos.map(function (p) { return p.clinvar.plp_db || null; }), yaxis: 'y2', mode: 'markers',
          marker: { symbol: 'diamond', size: 9, color: tint.pathogenic }, hovertemplate: '%{x}: %{y} ClinVar pathogenic or likely pathogenic missense records<extra></extra>' });
        layout = { title: { text: 'Observed gnomAD substitutions and ClinVar P/LP records per CFR position, site layer' },
          yaxis: { title: { text: 'Substitutions (gnomAD)' }, rangemode: 'tozero' },
          yaxis2: { title: { text: 'ClinVar P/LP records' }, overlaying: 'y', side: 'right', rangemode: 'tozero', showgrid: false, tickfont: { color: THEME[t].muted } },
          xaxis: { type: 'category', tickangle: -60, tickfont: { size: phone ? 7 : 9 }, categoryorder: 'array', categoryarray: x },
          legend: { orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0 }, margin: { l: 56, r: 56, t: 36, b: 70 } };
        setViewText(card, 'unique substitutions and ClinVar pathogenic or likely pathogenic records per position, ' + orderText());
      }
      card.suffix = state.panel + '_' + (state.order || segMode());
      return plot(card, data, layout, opts);
    };
    card.tableRows = function () {
      var pos = ordered();
      return { header: ['generic number', 'segment', 'CFR rank', 'receptors numbered', 'receptors with alleles', 'substitutions', 'alleles', 'allele count', 'predicted benign', 'ambiguous', 'predicted pathogenic', 'unscored', '% pathogenic of decisive', 'ClinVar P/LP (database set)', 'conservation median'],
        rows: pos.map(function (p) { var a = p.am_substitutions; return [p.generic, p.segment, p.cfr_rank, p.receptors_numbered, p.receptors_with_alleles, p.substitutions, p.alleles, p.allele_count, a.benign, a.ambiguous, a.pathogenic, a.unscored, p.pathogenic_pct_decisive === null ? '' : p.pathogenic_pct_decisive.toFixed(1), p.clinvar.plp_db, p.conservation.median === null ? '' : p.conservation.median.toFixed(2)]; }),
        note: (json.label || 'Site layer.') };
    };
    card.onChip = function (key, value) {
      if (key === 'order') state.order = value; else state[key] = value;
      card.render();
    };
    var slot = card.el.querySelector('[data-seg-order-slot]');
    if (slot) slot.addEventListener('click', function (e) { if (e.target.closest('button')) { state.order = null; setChip(card, 'order', ''); card.render(); } });
    document.addEventListener('gpc:segment-order', function () { if (!state.order && card.drawn) card.render(); });

    card.render().then(function () {
      card.plot.on('plotly_click', function (ev) {
        var p = ev.points && ev.points[0];
        if (!p || state.set === 'other') return;
        var pos = P.filter(function (q) { return q.generic === p.x; })[0];
        if (pos) showPosition(pos);
      });
    });

    function showPosition(pos) {
      var url = (pos.links && pos.links.detail) || ('data/stats/cfr_variants/' + pos.generic + '.json');
      loadJSON(url).then(function (d) {
        var F = {}; d.fields.forEach(function (f, i) { F[f] = i; });
        var recs = json.receptors.rows, RF = {}; json.receptors.fields.forEach(function (f, i) { RF[f] = i; });
        openSide(card, pos.generic + ' (' + pos.segment + ', CFR rank ' + pos.cfr_rank + '): the receptors behind the bar', function (side) {
          var a = pos.am_substitutions;
          side.appendChild(el('p', '', fmt(pos.substitutions) + ' unique substitutions (' + fmt(pos.alleles) + ' alleles) in ' + pos.receptors_with_alleles + ' of ' + pos.receptors_numbered + ' receptors numbered here. AlphaMissense: ' + fmt(a.pathogenic) + ' predicted pathogenic, ' + fmt(a.ambiguous) + ' ambiguous, ' + fmt(a.benign) + ' predicted benign' + (a.unscored ? ', ' + fmt(a.unscored) + ' unscored' : '') + '. ClinVar P/LP missense in the database set: ' + fmt(pos.clinvar.plp_db) + '.'));
          var p = el('p', ''); p.appendChild(link('Search ' + pos.generic, SEARCH(pos.generic), 'cc-btn')); side.appendChild(p);
          var rows = d.rows.slice().sort(function (x, y) { return y[F.pathogenic] - x[F.pathogenic] || y[F.substitutions] - x[F.substitutions]; });
          side.appendChild(sideTable(
            [{ label: 'Receptor' }, { label: 'Residue' }, { label: 'Subst.', num: true }, { label: 'Path.', num: true }, { label: 'Amb.', num: true }, { label: 'Ben.', num: true }, { label: 'AC', num: true }, { label: 'P/LP', num: true }, { label: 'Cons.', num: true }, { label: '' }],
            rows.map(function (r) {
              var rec = recs[r[F.receptor]];
              return [link(rec[RF.gene], rec[RF.report_url] || REPORT(rec[RF.gid])), (r[F.aa] || '') + r[F.residue], r[F.substitutions], r[F.pathogenic], r[F.ambiguous], r[F.benign], r[F.allele_count], r[F.clinvar_plp_db] || '', r[F.conservation] === null ? '' : Number(r[F.conservation]).toFixed(2), link('search', SEARCH(r[F.search_q]))];
            })));
          side.appendChild(el('p', 'side-note', 'Path., Amb., Ben.: AlphaMissense predicted class counts of the unique substitutions (a prediction). AC: gnomAD allele count. P/LP: ClinVar pathogenic or likely pathogenic missense records in the database set. Cons.: conservation (observed). Source: ' + (json.label || 'site layer') + '.'));
        });
      }).catch(function (err) { openSide(card, pos.generic, function (side) { side.appendChild(el('p', 'side-note', 'The receptor list could not be loaded (' + err.message + ').')); }); });
    }
  };

  // ------------------------------------------------------------------ lazy loading, theme, phone
  function visible(node) { return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length); }

  var io = null;
  function watch(card) {
    if (!('IntersectionObserver' in window)) { loadCard(card); return; }
    io = io || new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var c = cards[en.target.id];
        io.unobserve(en.target);
        if (c && visible(en.target)) loadCard(c);
      });
    }, { rootMargin: '600px 0px' });
    io.observe(card.plot);
  }

  document.addEventListener('gpcrsynth-theme-change', function () {
    Object.keys(cards).forEach(function (id) {
      var c = cards[id];
      if (c.drawn && c.render && visible(c.plot)) c.render();
    });
  });
  var resizeTimer = null;
  PHONE.addEventListener('change', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      Object.keys(cards).forEach(function (id) { var c = cards[id]; if (c.drawn && c.render && visible(c.plot)) c.render(); });
    }, 200);
  });

  // sortable static tables (the manuscript tables)
  function initSortable(table) {
    var ths = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(ths, function (th, idx) {
      if (!th.hasAttribute('data-sort')) return;
      th.setAttribute('tabindex', '0'); th.setAttribute('role', 'button'); th.setAttribute('aria-sort', 'none'); th.style.cursor = 'pointer';
      var fire = function () {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        Array.prototype.forEach.call(ths, function (x) { x.setAttribute('aria-sort', 'none'); });
        th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
        var num = th.getAttribute('data-sort') === 'num';
        var tbody = table.tBodies[0], rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (a, b) {
          var va = a.cells[idx].textContent.trim(), vb = b.cells[idx].textContent.trim();
          if (num) return dir * (parseFloat(va) - parseFloat(vb));
          return dir * va.localeCompare(vb, undefined, { numeric: true });
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      };
      th.addEventListener('click', fire);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } });
    });
  }

  function init() {
    document.querySelectorAll('.chart-card').forEach(function (fig) {
      var card = setupCard(fig);
      if (!card) return;
      var details = fig.closest('details');
      if (details && !details.open) {
        details.addEventListener('toggle', function () {
          if (!details.open) return;
          if (!card.loaded) loadCard(card);
          else if (card.drawn) window.Plotly.Plots.resize(card.plot);
        });
        return;
      }
      if (card.inline) loadCard(card); else watch(card);
    });
    document.querySelectorAll('table[data-sortable]').forEach(initSortable);
    // a hash to a card (from a copied caption) opens its disclosure
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      var d = target && target.closest('details');
      if (d) d.open = true;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
