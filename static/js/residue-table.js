/* residue-table.js: the opt-in residue table on report pages.

   Off by default and empty: nothing is built until the "Residue table" block is
   opened. It then shows one row per residue that takes part in a contact pair, from
   data the page already carries:
     #residue-summary-data   the residue summary behind the CSV export (net and largest
                             dRRCS, partner, contact count, numbering)
     #rx-residue-extra       contacts above the receptor's threshold, AlphaMissense mean
                             and conservation per residue (the caches the snake plot's
                             colour views read), and the CFR flag (the residue's generic
                             number, as shown here, is one of the class-wide CFR positions:
                             the rx-config cfrTop top-ranked by CFR score, the rule the snake
                             plot and search use)
   Sortable, filterable (active-favouring, inactive-favouring, TM helices only) and
   downloadable as CSV. Sorting by Segment follows the site's segment order switch
   (segment-order.js), which sits in the toolbar. Residue names open the residue drawer (residue-drawer.js). */
(function () {
  'use strict';

  var details = document.getElementById('rx-residues');
  var mount = document.getElementById('rx-residues-mount');
  if (!details || !mount) return;

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

  // The class-wide CFR set the page marks: its size travels in #rx-config as cfrTop (analysis/cfr_analysis.py
  // CFR_TOP_N, the same number as the search's meta.json cfrTop and the Statistics page's ranked table).
  var cfrTop = (readJSON('rx-config') || {}).cfrTop;
  var cfrTip = 'Core functional residue (CFR) position: this generic position is one of the ' +
    (cfrTop ? cfrTop + ' ' : '') + 'top-ranked class-wide CFR positions (by CFR score), ' +
    'the positions the snake plot, search and the Statistics page mark as CFR';

  var COLUMNS = [
    { key: 'pos', label: 'Residue', num: false, tip: 'Residue and position in the model' },
    { key: 'gn', label: 'Generic number', num: false, tip: 'GPCRdb generic number' },
    { key: 'seg', label: 'Segment', num: false, tip: 'Transmembrane helix, loop or terminus' },
    { key: 'net', label: 'Net ΔRRCS', num: true, tip: 'Signed sum of ΔRRCS over all of the residue\'s contacts. Positive: stronger in the active model.' },
    { key: 'max', label: 'Largest |ΔRRCS|', num: true, tip: 'Largest single contact change at this residue' },
    { key: 'partner', label: 'Partner', num: false, tip: 'The partner residue at the largest change' },
    { key: 'above', label: 'Contacts above threshold', num: true, tip: 'Contacts with |ΔRRCS| at or above this receptor\'s threshold' },
    { key: 'cfr', label: 'CFR position', num: false, tip: cfrTip },
    { key: 'am', label: 'AlphaMissense mean', num: true, tip: 'Mean AlphaMissense score over the 19 substitutions (a prediction): 0 benign-like, 1 pathogenic-like' },
    { key: 'cons', label: 'Conservation', num: true, tip: 'Sequence conservation: 0 variable, 1 conserved' }
  ];

  var built = false;
  var state = { sort: 'pos', dir: 1, direction: '', tm: false };
  var rows = [], tbody, countEl, csvBtn, table, gid = '';

  function fmtSigned(v) { return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2); }
  function num(v, d) { return v === null || v === undefined ? '' : v.toFixed(d); }

  function prepare() {
    var summary = readJSON('residue-summary-data') || [];
    var extra = readJSON('rx-residue-extra') || { rows: {} };
    var cfg = readJSON('rx-config') || {};
    var snake = readJSON('snake-plot-data');
    // Fallback only for a page built before the CFR flag travelled with the table data.
    var cfr = (snake && snake.views && snake.views.cfr && snake.views.cfr.colors) || {};
    var ann = cfg.annotation || {};
    gid = cfg.gid || 'receptor';
    state.sig = extra.sig;
    return summary.map(function (r) {
      var x = (extra.rows || {})[String(r.position)] || [null, null, null];
      var a = ann[String(r.position)] || [];
      return {
        pos: r.position,
        aa: r.amino_acid || '',
        gn: a[1] || r.display_number || r.generic_number || '',
        seg: a[0] || r.protein_segment || '',
        net: r.active_minus_inactive,
        max: r.max_abs_delta,
        partner: r.partner_at_max || '',
        above: x[0],
        // x[3]: the flag computed at build time from the numbering this table shows
        cfr: (x.length > 3 ? x[3] : cfr[String(r.position)]) ? 'Yes' : '',
        am: x[1],
        cons: x[2]
      };
    });
  }

  function visibleRows() {
    var list = rows.filter(function (r) {
      if (state.direction === 'active' && !(r.net > 0)) return false;
      if (state.direction === 'inactive' && !(r.net < 0)) return false;
      if (state.tm && !/^TM\d/.test(r.seg)) return false;
      return true;
    });
    var key = state.sort, dir = state.dir;
    // Segment: in the site's segment order (segment-order.js: helices first, or along the chain)
    var so = window.GPCSegOrder;
    if (key === 'seg' && so) {
      list.sort(function (a, b) {
        var nx = !a.seg, ny = !b.seg;
        if (nx || ny) return nx && ny ? a.pos - b.pos : (nx ? 1 : -1);
        return (so.rank(a.seg) - so.rank(b.seg)) * dir || a.pos - b.pos;
      });
      return list;
    }
    list.sort(function (a, b) {
      var x = a[key], y = b[key];
      var nx = x === null || x === undefined || x === '', ny = y === null || y === undefined || y === '';
      if (nx && ny) return a.pos - b.pos;
      if (nx) return 1;      // blanks last, whichever way it is sorted
      if (ny) return -1;
      var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return c ? c * dir : a.pos - b.pos;
    });
    return list;
  }

  function cell(tr, text, cls) {
    var td = el('td', cls || null, text);
    tr.appendChild(td);
    return td;
  }

  function paint() {
    var list = visibleRows();
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var tr = el('tr');
      tr.setAttribute('data-gpc-res', String(r.pos));   // the page's linked selection marks rows by this
      var td = el('td');
      var b = el('button', 'rx-res-link', (r.aa ? THREE[r.aa] || r.aa : '') + r.pos);
      b.type = 'button';
      b.setAttribute('data-rx-res', String(r.pos));
      td.appendChild(b);
      tr.appendChild(td);
      cell(tr, r.gn || '-', 'mono');
      cell(tr, r.seg || '-');
      cell(tr, fmtSigned(r.net), 'num ' + (r.net >= 0 ? 'is-active' : 'is-inactive'));
      cell(tr, r.max.toFixed(2), 'num');
      cell(tr, r.partner || '-', 'mono');
      cell(tr, r.above === null ? '-' : String(r.above), 'num');
      cell(tr, r.cfr || '-');
      cell(tr, r.am === null ? '-' : r.am.toFixed(2), 'num');
      cell(tr, r.cons === null ? '-' : r.cons.toFixed(2), 'num');
      frag.appendChild(tr);
    });
    tbody.textContent = '';
    tbody.appendChild(frag);
    if (window.GPCSelect && window.GPCSelect.repaint) window.GPCSelect.repaint();
    countEl.textContent = list.length + ' of ' + rows.length + ' residues';
    csvBtn.textContent = 'Download CSV (' + list.length + ' rows)';
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function (th) {
      var k = th.getAttribute('data-key');
      th.setAttribute('aria-sort', k === state.sort ? (state.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }

  var THREE = {
    A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile',
    L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val'
  };

  // A spreadsheet runs a text cell that starts with = + - @ tab or CR as a formula, so
  // such text gets the standard leading apostrophe. Genuine numbers (a signed decimal
  // such as -0.512) are left alone and stay numeric.
  var PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  function csvEscape(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // The rows currently shown, in the order shown.
  function csvText() {
    var head = ['position', 'residue', 'generic_number', 'segment', 'net_delta_rrcs', 'largest_abs_delta_rrcs',
      'partner_at_largest', 'contacts_above_threshold', 'cfr', 'alphamissense_mean', 'conservation'];
    var lines = [head.join(',')];
    visibleRows().forEach(function (r) {
      lines.push([r.pos, r.aa, r.gn, r.seg, r.net.toFixed(3), r.max.toFixed(3), r.partner,
        r.above === null ? '' : r.above, r.cfr ? 'yes' : 'no', num(r.am, 3), num(r.cons, 3)].map(csvEscape).join(','));
    });
    return lines.join('\n') + '\n';
  }
  window.ReportExtras = window.ReportExtras || {};
  window.ReportExtras.residueTableCsv = function () { return built ? csvText() : null; };

  function download() {
    var blob = new Blob([csvText()], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = gid + '_residue_table.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function filterButton(label, pressedFn, onClick) {
    var b = el('button', 'btn btn-sm rx-filter-btn', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', function () {
      onClick();
      refreshFilterButtons();
      paint();
    });
    b._pressed = pressedFn;
    return b;
  }
  var filterButtons = [];
  function refreshFilterButtons() {
    filterButtons.forEach(function (b) {
      var on = b._pressed();
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('active', on);
    });
  }

  function build() {
    if (built) return;
    built = true;
    rows = prepare();

    var tools = el('div', 'rx-rt-tools');
    var group = el('div', 'rx-rt-filters');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Filter residues');
    var fa = filterButton('Active-favoring', function () { return state.direction === 'active'; },
      function () { state.direction = state.direction === 'active' ? '' : 'active'; });
    var fi = filterButton('Inactive-favoring', function () { return state.direction === 'inactive'; },
      function () { state.direction = state.direction === 'inactive' ? '' : 'inactive'; });
    var ft = filterButton('TM helices only', function () { return state.tm; },
      function () { state.tm = !state.tm; });
    fa.classList.add('rx-filter-active');
    fi.classList.add('rx-filter-inactive');
    filterButtons = [fa, fi, ft];
    filterButtons.forEach(function (b) { group.appendChild(b); });
    tools.appendChild(group);
    if (window.GPCSegOrder) tools.appendChild(window.GPCSegOrder.control());
    countEl = el('span', 'rx-rt-count');
    countEl.setAttribute('role', 'status');
    tools.appendChild(countEl);
    csvBtn = el('button', 'btn btn-ghost btn-sm rx-rt-csv');
    csvBtn.type = 'button';
    csvBtn.addEventListener('click', download);
    tools.appendChild(csvBtn);
    mount.appendChild(tools);

    mount.appendChild(el('p', 'rx-note',
      'Net ΔRRCS is red where the contacts are stronger in the active model and blue where they are stronger in the inactive model. ' +
      '"TM helices only" hides loops, termini and helix 8.' +
      (window.GPCSegOrder ? ' Sorting by Segment follows the order switch: helices first, or along the chain.' : '') +
      (state.sig !== undefined ? ' Threshold: |ΔRRCS| ≥ ' + Number(state.sig).toFixed(2) + '.' : '')));

    var wrap = el('div', 'v2-table-wrap');
    var scroll = el('div', 'v2-table-scroll rx-rt-scroll');
    table = el('table', 'v2-table rx-rt-table');
    table.id = 'rx-residue-table';
    var thead = el('thead');
    var htr = el('tr');
    COLUMNS.forEach(function (c) {
      var th = el('th');
      th.setAttribute('data-key', c.key);
      th.setAttribute('data-tooltip', c.tip);
      th.setAttribute('aria-sort', 'none');
      var b = el('button', 'rx-sort-btn', c.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (state.sort === c.key) state.dir = -state.dir;
        else { state.sort = c.key; state.dir = c.num ? -1 : 1; }
        paint();
      });
      th.appendChild(b);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    tbody = el('tbody');
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    mount.appendChild(wrap);
    refreshFilterButtons();
    paint();
  }

  document.addEventListener('gpc:segment-order', function () { if (built && state.sort === 'seg') paint(); });

  if (details.open) build();
  details.addEventListener('toggle', function () { if (details.open) build(); });
  // a link to #sec=sec-residues opens the block
  if (/(?:^#|&)sec=sec-residues(?:&|$)/.test(window.location.hash || '')) details.open = true;
})();
