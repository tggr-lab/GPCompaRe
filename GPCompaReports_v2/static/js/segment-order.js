/* segment-order.js: one site-wide switch for the order of segment lists, tables and charts.

   "Helices first" (the default): TM1 to TM7 and H8 together, then the loops (ICL1 to
   ICL3, ECL1 to ECL3), then the termini. "Sequence": N-term, TM1, ICL1, TM2, ...
   C-term, along the chain. The models are most reliable in the helices, so they lead.

   Nothing here changes the built HTML. Lists and table rows are moved in the page, and
   Plotly charts get a category or legend order (in the chart data before the chart is
   drawn, or by relayout / restyle after it is drawn, so no chart is drawn twice). The
   choice is kept per visitor in localStorage['gpc-segment-order'] when storage works:
   'sequence', or no key for the default. The Studio (same origin) uses the same key and
   values, and a change in another tab is followed (storage event).

   What it orders:
     ul / ol [data-seg-order]   its li[data-gpc-seg] children; li.seg-order-label group labels
                                are shown in "Helices first" when both groups are present
     TABLES (by id)             tbody rows by the segment named in one column, unless the
                                visitor has sorted the table by a column
     CHARTS (by id)             'x': categorical x axis, 'xy': both axes, 'legend': legend rank
     [data-seg-order-slot]      is filled with the switch
   Others ask: window.GPCSegOrder { mode(), set(mode), rank(seg), order(), group(seg),
   control() }, and listen for the 'gpc:segment-order' event on document ({mode}). */
(function () {
  'use strict';

  var KEY = 'gpc-segment-order';
  var HELIX = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'];
  var LOOPS = ['ICL1', 'ICL2', 'ICL3', 'ICL4', 'ECL1', 'ECL2', 'ECL3'];  // ICL4: the TM7 to H8 linker some receptors have
  var TERMINI = ['N-term', 'C-term'];
  var ORDERS = {
    helices: HELIX.concat(LOOPS, TERMINI),
    sequence: ['N-term', 'TM1', 'ICL1', 'TM2', 'ECL1', 'TM3', 'ICL2', 'TM4', 'ECL2', 'TM5',
               'ICL3', 'TM6', 'ECL3', 'TM7', 'ICL4', 'H8', 'C-term']
  };
  var LABELS = { helix: 'Helices', rest: 'Loops and termini' };

  // Tables and charts in markup this script may not edit (approved report sections, chart
  // payloads): they are found by id.
  var TABLES = [{ id: 'tm-summary-table', col: 0 }];
  var CHARTS = [
    { id: 'tm-breakdown-chart', kind: 'x' },
    { id: 'chart-tm-heatmap', kind: 'xy' },
    { id: 'chart-cfr-dotplot', kind: 'legend' },
    { id: 'chart-cv-scatter', kind: 'legend' }
  ];

  function stored() {
    try { return window.localStorage.getItem(KEY) === 'sequence' ? 'sequence' : 'helices'; }
    catch (e) { return 'helices'; }
  }
  var mode = stored();

  function order(m) { return ORDERS[m || mode] || ORDERS.helices; }
  function rank(seg, m) {
    var o = order(m), i = o.indexOf(String(seg || '').trim());
    return i < 0 ? o.length : i;
  }
  function group(seg) { return HELIX.indexOf(String(seg || '').trim()) >= 0 ? 'helix' : 'rest'; }
  function known(seg) { return ORDERS.sequence.indexOf(String(seg || '').trim()) >= 0; }

  // stable sort by segment rank (the original position breaks ties)
  function bySegment(items, segOf) {
    return items.map(function (it, i) { return { it: it, i: i, r: rank(segOf(it)) }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
      .map(function (x) { return x.it; });
  }
  function bothGroups(segs) {
    var h = false, r = false;
    segs.forEach(function (s) { if (!known(s)) return; if (group(s) === 'helix') h = true; else r = true; });
    return h && r;
  }

  // ------------------------------------------------------------------ lists
  function labelItem(g) {
    var li = document.createElement('li');
    li.className = 'seg-order-label' + (g === 'rest' ? ' seg-order-label-rest' : '');
    li.setAttribute('aria-hidden', 'true');
    li.textContent = LABELS[g];
    return li;
  }
  function orderList(list) {
    var items = Array.prototype.filter.call(list.children, function (c) { return c.hasAttribute('data-gpc-seg'); });
    if (!items.length) return;
    Array.prototype.slice.call(list.querySelectorAll(':scope > .seg-order-label')).forEach(function (n) { n.remove(); });
    var segOf = function (li) { return li.getAttribute('data-gpc-seg'); };
    var sorted = bySegment(items, segOf);
    var labels = mode === 'helices' && bothGroups(items.map(segOf));
    var last = null;
    sorted.forEach(function (li) {
      var g = group(segOf(li));
      li.setAttribute('data-seg-group', g);
      if (labels && g !== last) list.appendChild(labelItem(g));
      last = g;
      list.appendChild(li);
    });
    list.setAttribute('data-seg-order', mode);
  }

  // ------------------------------------------------------------------ tables
  function userSorted(table) {
    var head = table.tHead && table.tHead.rows[0];
    if (!head) return false;
    return Array.prototype.some.call(head.cells, function (th) {
      var s = th.getAttribute('aria-sort');
      return s === 'ascending' || s === 'descending';
    });
  }
  function orderTable(spec) {
    var table = document.getElementById(spec.id);
    if (!table || !table.tBodies[0] || userSorted(table)) return;
    var tbody = table.tBodies[0];
    var segOf = function (tr) { var c = tr.cells[spec.col]; return c ? c.textContent.trim() : ''; };
    var rows = Array.prototype.slice.call(tbody.rows);
    var sorted = bySegment(rows, segOf);
    var split = mode === 'helices' && bothGroups(rows.map(segOf));
    var last = null;
    sorted.forEach(function (tr) {
      var g = group(segOf(tr));
      tr.classList.toggle('seg-group-start', split && last !== null && g !== last);
      last = g;
      tbody.appendChild(tr);
    });
    table.setAttribute('data-seg-order', mode);
  }

  // ------------------------------------------------------------------ charts
  function strings(v) { return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : []; }
  function categories(data, key) {
    var seen = [];
    (data || []).forEach(function (t) {
      strings(t[key]).forEach(function (c) { if (seen.indexOf(c) < 0) seen.push(c); });
    });
    // order only axes whose categories are all segment names
    if (!seen.length || !seen.every(known)) return null;
    return bySegment(seen, function (c) { return c; });
  }
  function drawn(el) { return !!(el && (el._fullLayout || el.dataset.chartRendered)); }

  function orderChart(spec) {
    var el = document.getElementById(spec.id);
    var payload = (window.CHART_DATA || {})[spec.id];
    if (!el || !payload) return;
    var data = drawn(el) && el.data ? el.data : (payload.data || []);
    if (spec.kind === 'legend') return orderLegend(el, payload, data);
    var update = {};
    var axes = spec.kind === 'xy' ? ['x', 'y'] : ['x'];
    axes.forEach(function (a) {
      var cats = categories(data, a);
      if (!cats) return;
      update[a + 'axis.categoryorder'] = 'array';
      update[a + 'axis.categoryarray'] = cats;
      // the payload, for a chart not yet drawn (a queued newPlot holds this same object)
      var layout = payload.layout || (payload.layout = {});
      var ax = layout[a + 'axis'] || (layout[a + 'axis'] = {});
      ax.categoryorder = 'array';
      ax.categoryarray = cats.slice();
    });
    if (!Object.keys(update).length) return;
    el.setAttribute('data-seg-order', mode);
    if (drawn(el) && window.Plotly && Plotly.relayout) Plotly.relayout(el, update);
  }

  // Legend: each segment trace gets a rank in the chosen order. In "Helices first", when
  // both groups are present, the traces are put into two legend groups with a title each
  // (a click on an entry still hides only that entry; a click on a title, its group);
  // "Sequence" restores each trace's own legend group.
  var ownGroups = {};
  function orderLegend(el, payload, data) {
    var names = data.map(function (t) { return t.name; });
    var segs = names.filter(known);
    if (!segs.length) return;
    var own = ownGroups[el.id] || (ownGroups[el.id] = data.map(function (t) {
      return t.legendgroup === undefined ? '' : t.legendgroup;
    }));
    var split = mode === 'helices' && bothGroups(segs);
    var sortedSegs = bySegment(segs.slice(), function (s) { return s; });
    var firstOf = {};
    sortedSegs.forEach(function (s) { var g = group(s); if (!(g in firstOf)) firstOf[g] = s; });
    var ranks = [], groups = [], titles = [], idx = [];
    names.forEach(function (n, i) {
      var isSeg = known(n), g = isSeg ? group(n) : null;
      ranks.push(isSeg ? 1 + rank(n) : 100 + i);
      groups.push(split && isSeg ? 'seg-' + g : own[i]);
      titles.push(split && isSeg && firstOf[g] === n ? LABELS[g] : '');
      idx.push(i);
    });
    (payload.data || []).forEach(function (t, i) {
      if (i >= ranks.length) return;
      t.legendrank = ranks[i];
      t.legendgroup = groups[i];
      t.legendgrouptitle = { text: titles[i] };
    });
    var layout = payload.layout || (payload.layout = {});
    var legend = layout.legend || (layout.legend = {});
    legend.groupclick = 'toggleitem';
    el.setAttribute('data-seg-order', mode);
    if (drawn(el) && window.Plotly && Plotly.update) {
      Plotly.update(el, { legendrank: ranks, legendgroup: groups, 'legendgrouptitle.text': titles },
        { 'legend.groupclick': 'toggleitem' }, idx);
    }
  }

  // ------------------------------------------------------------------ the switch
  var controls = [];
  function paintControls() {
    controls.forEach(function (c) {
      Array.prototype.forEach.call(c.querySelectorAll('button[data-seg-order-mode]'), function (b) {
        var on = b.getAttribute('data-seg-order-mode') === mode;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('active', on);
      });
    });
  }
  function control() {
    var wrap = document.createElement('span');
    wrap.className = 'seg-order';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Segment order');
    var lab = document.createElement('span');
    lab.className = 'seg-order-name';
    lab.textContent = 'Order';
    lab.setAttribute('aria-hidden', 'true');
    wrap.appendChild(lab);
    [['helices', 'Helices first', 'TM1 to TM7 and H8 together, then the loops, then the termini'],
     ['sequence', 'Sequence', 'Along the chain, from the N-terminus to the C-terminus']].forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-order-btn';
      b.setAttribute('data-seg-order-mode', o[0]);
      b.setAttribute('data-tooltip', o[2]);
      b.textContent = o[1];
      b.addEventListener('click', function () { set(o[0]); });
      wrap.appendChild(b);
    });
    controls.push(wrap);
    paintControls();
    return wrap;
  }

  function applyAll() {
    Array.prototype.forEach.call(document.querySelectorAll('ul[data-seg-order], ol[data-seg-order]'), orderList);
    TABLES.forEach(orderTable);
    CHARTS.forEach(orderChart);
  }

  function set(m, fromStorage) {
    m = m === 'sequence' ? 'sequence' : 'helices';
    if (m === mode) { paintControls(); return; }
    mode = m;
    // the same key and values as the Studio (one origin, one choice); the default is no key
    if (!fromStorage) {
      try {
        if (m === 'helices') window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, m);
      } catch (e) { /* the choice lasts for this page */ }
    }
    applyAll();
    paintControls();
    document.documentElement.setAttribute('data-seg-order', mode);
    try { document.dispatchEvent(new CustomEvent('gpc:segment-order', { detail: { mode: mode } })); } catch (e) {}
  }

  window.GPCSegOrder = {
    mode: function () { return mode; },
    set: set,
    rank: rank,
    order: function (m) { return order(m).slice(); },
    group: group,
    control: control
  };

  // a choice made in another tab (a report, the statistics page or the Studio)
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === null) set(stored(), true);
  });

  document.documentElement.setAttribute('data-seg-order', mode);
  Array.prototype.forEach.call(document.querySelectorAll('[data-seg-order-slot]'), function (slot) {
    if (!slot.firstChild) slot.appendChild(control());
  });
  // Deferred: this runs before DOMContentLoaded, when the pages draw their charts, so the
  // order is in the chart data before the first (and only) draw.
  applyAll();
})();
