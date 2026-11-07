/* GPCompaReports — site.js
   Shared runtime for all v2 pages. No framework, no Materialize.
   Public: window.Site = { initBrowse, initTable, initCharts } for page-specific hooks. */

(function() {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var Site = (window.Site = window.Site || {});

  // -------------------- Theme toggle --------------------
  function readStoredTheme() {
    try { return localStorage.getItem('gpcrsynth-theme'); }
    catch (e) { return null; }
  }
  function writeStoredTheme(v) {
    try { if (v) localStorage.setItem('gpcrsynth-theme', v); else localStorage.removeItem('gpcrsynth-theme'); }
    catch (e) {}
  }
  function applyThemeMode(stored) {
    var mode;
    if (stored === 'light' || stored === 'dark') {
      mode = stored;
      root.removeAttribute('data-theme-auto');
    } else {
      mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.setAttribute('data-theme-auto', '');
    }
    root.setAttribute('data-color-mode', mode);
    document.dispatchEvent(new CustomEvent('gpcrsynth-theme-change', { detail: { mode: mode, stored: stored } }));
    var toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.title = mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    }
  }
  function initThemeToggle() {
    applyThemeMode(readStoredTheme());
    var toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    // 2-state flip: always invert the currently-rendered mode. Initial auto
    // behavior still applies on first page load when nothing is stored, but
    // clicks always produce a visible change.
    toggle.addEventListener('click', function() {
      var cur = root.getAttribute('data-color-mode');
      var next = cur === 'dark' ? 'light' : 'dark';
      writeStoredTheme(next);
      applyThemeMode(next);
    });
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
        if (readStoredTheme() === null) applyThemeMode(null);
      });
    } catch (e) {}
  }

  // -------------------- Mobile drawer --------------------
  function initMobileDrawer() {
    var trigger = document.getElementById('mobile-nav-toggle');
    var drawer = document.getElementById('mobile-drawer');
    if (!trigger || !drawer) return;

    // Closed, the drawer is inert (set in the markup too) and hidden by the stylesheet, so
    // its search box and links are not in the page's Tab order.
    drawer.setAttribute('inert', '');
    function open() {
      drawer.removeAttribute('inert');
      drawer.setAttribute('aria-hidden', 'false');
      trigger.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      var firstLink = drawer.querySelector('.mobile-drawer-nav a');
      if (firstLink) firstLink.focus();
    }
    function close() {
      drawer.setAttribute('aria-hidden', 'true');
      drawer.setAttribute('inert', '');
      trigger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      trigger.focus();
    }
    trigger.addEventListener('click', open);
    drawer.querySelectorAll('[data-drawer-close]').forEach(function(el) {
      el.addEventListener('click', close);
    });
    drawer.querySelectorAll('.mobile-drawer-nav a').forEach(function(a) {
      a.addEventListener('click', close);
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && drawer.getAttribute('aria-hidden') === 'false') close();
    });
  }

  // -------------------- Tooltips --------------------
  function initTooltips() {
    document.querySelectorAll('[data-tooltip]').forEach(function(el) {
      el.addEventListener('mouseenter', function() {
        var rect = el.getBoundingClientRect();
        var viewW = window.innerWidth;
        var pos = '';
        if (rect.top < 80) pos = 'bottom';
        else if (viewW - rect.right < 160) pos = 'left';
        else if (rect.left < 160) pos = 'right';
        if (pos) el.setAttribute('data-tooltip-position', pos);
        else el.removeAttribute('data-tooltip-position');
      });
    });
  }

  // -------------------- Collapsibles --------------------
  function initCollapsibles() {
    document.querySelectorAll('.collapsible-head').forEach(function(head) {
      if (head.dataset.collapsibleBound) return;
      head.dataset.collapsibleBound = '1';
      if (!head.hasAttribute('aria-expanded')) head.setAttribute('aria-expanded', 'false');
      head.addEventListener('click', function() {
        var open = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
    });
  }

  // -------------------- Tables (search + sort + paginate + CSV export) --------------------
  // Table HTML contract:
  //   <div class="v2-table-wrap">
  //     <div class="v2-table-toolbar">
  //       <input class="v2-input" data-table-search="<id>" placeholder="Search…">
  //       <button class="btn btn-ghost btn-sm" data-table-export="<id>" data-filename="foo.csv">Export CSV</button>
  //     </div>
  //     <div class="v2-table-scroll">
  //       <table class="v2-table" id="<id>">
  //         <thead><tr><th data-sort="name">Name</th>...</tr></thead>
  //         <tbody>...</tbody>
  //       </table>
  //     </div>
  //     <div class="v2-pagination" data-table-pagination="<id>"></div>
  //   </div>

  var tableState = {};  // id -> { page, pageSize, sortCol, sortDir }

  function initTable(opts) {
    var id = opts.id;
    var pageSize = opts.pageSize || 25;
    var table = document.getElementById(id);
    if (!table) return;
    if (tableState[id]) return;  // idempotent
    tableState[id] = { page: 1, pageSize: pageSize, sortCol: null, sortDir: null };

    // Wire header sorting (any <th data-sort> attribute triggers sort on that column index)
    var ths = table.tHead ? table.tHead.rows[0].cells : [];
    for (var i = 0; i < ths.length; i++) {
      (function(idx, th) {
        if (!th.hasAttribute('data-sort')) return;
        th.setAttribute('tabindex', '0');
        th.setAttribute('role', 'button');
        th.setAttribute('aria-sort', 'none');
        var fire = function() { sortTable(id, idx); };
        th.addEventListener('click', fire);
        th.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
        });
      })(i, ths[i]);
    }

    // Wire toolbar controls by data-attr matching
    document.querySelectorAll('[data-table-search="' + id + '"]').forEach(function(input) {
      input.addEventListener('input', function() { searchTable(id, input.value); });
    });
    document.querySelectorAll('[data-table-export="' + id + '"]').forEach(function(btn) {
      btn.addEventListener('click', function() { exportTableCSV(id, btn.dataset.filename || (id + '.csv')); });
    });

    paginateTable(id);
  }

  function visibleRows(table) {
    if (!table.tBodies[0]) return [];
    return Array.from(table.tBodies[0].rows).filter(function(r) { return !r.hasAttribute('data-search-hidden'); });
  }

  function paginateTable(id) {
    var table = document.getElementById(id);
    if (!table) return;
    var st = tableState[id];
    var rows = Array.from(table.tBodies[0].rows);
    var vrows = rows.filter(function(r) { return !r.hasAttribute('data-search-hidden'); });
    var total = vrows.length;
    var totalPages = Math.max(1, Math.ceil(total / st.pageSize));
    if (st.page > totalPages) st.page = totalPages;
    var start = (st.page - 1) * st.pageSize;
    var end = start + st.pageSize;

    rows.forEach(function(r) { r.hidden = true; });
    vrows.slice(start, end).forEach(function(r) { r.hidden = false; });

    var pagDiv = document.querySelector('[data-table-pagination="' + id + '"]');
    if (!pagDiv) return;
    var showingFrom = total === 0 ? 0 : start + 1;
    var showingTo = Math.min(end, total);
    var html = '';
    html += '<button type="button" ' + (st.page <= 1 ? 'disabled' : '') + ' data-page="prev">← Prev</button>';
    var maxBtns = 7;
    var sp = Math.max(1, st.page - Math.floor(maxBtns / 2));
    var ep = Math.min(totalPages, sp + maxBtns - 1);
    if (ep - sp < maxBtns - 1) sp = Math.max(1, ep - maxBtns + 1);
    if (sp > 1) {
      html += '<button type="button" data-page="1">1</button>';
      if (sp > 2) html += '<span class="v2-pagination-info">…</span>';
    }
    for (var p = sp; p <= ep; p++) {
      html += '<button type="button" data-page="' + p + '"' + (p === st.page ? ' aria-current="page"' : '') + '>' + p + '</button>';
    }
    if (ep < totalPages) {
      if (ep < totalPages - 1) html += '<span class="v2-pagination-info">…</span>';
      html += '<button type="button" data-page="' + totalPages + '">' + totalPages + '</button>';
    }
    html += '<button type="button" ' + (st.page >= totalPages ? 'disabled' : '') + ' data-page="next">Next →</button>';
    html += '<select class="v2-select" data-page-size>';
    [25, 50, 100, 99999].forEach(function(ps) {
      html += '<option value="' + ps + '"' + (st.pageSize === ps ? ' selected' : '') + '>' +
              (ps === 99999 ? 'All' : (ps + ' per page')) + '</option>';
    });
    html += '</select>';
    html += '<span class="v2-pagination-info">' + showingFrom + '–' + showingTo + ' of ' + total + '</span>';
    pagDiv.innerHTML = html;

    pagDiv.querySelectorAll('button[data-page]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var p = btn.dataset.page;
        if (p === 'prev') st.page = Math.max(1, st.page - 1);
        else if (p === 'next') st.page = Math.min(totalPages, st.page + 1);
        else st.page = parseInt(p, 10);
        paginateTable(id);
      });
    });
    var sel = pagDiv.querySelector('[data-page-size]');
    if (sel) sel.addEventListener('change', function() {
      st.pageSize = parseInt(sel.value, 10);
      st.page = 1;
      paginateTable(id);
    });
  }

  function searchTable(id, query) {
    var table = document.getElementById(id);
    if (!table) return;
    var raw = (query || '').trim();
    var q = raw.toLowerCase();
    // Digit-only queries use a non-digit boundary regex so e.g. "5" matches
    // a residue numbered 5 but NOT 55, 501, or any RRCS value containing 5.
    // Non-digit queries fall through to substring match (so "P45L" still works).
    var digitRe = /^\d+$/.test(raw) ? new RegExp('(?:^|\\D)' + raw + '(?:\\D|$)') : null;
    var rows = Array.from(table.tBodies[0].rows);
    rows.forEach(function(r) {
      var hit;
      if (q === '') hit = true;
      else if (digitRe) hit = digitRe.test(r.textContent);
      else hit = r.textContent.toLowerCase().indexOf(q) !== -1;
      if (hit) r.removeAttribute('data-search-hidden');
      else r.setAttribute('data-search-hidden', '');
    });
    if (tableState[id]) tableState[id].page = 1;
    paginateTable(id);
  }

  function sortTable(id, colIdx) {
    var table = document.getElementById(id);
    if (!table || !table.tBodies[0]) return;
    var st = tableState[id];
    var ths = table.tHead.rows[0].cells;
    var dir;
    if (st.sortCol === colIdx) dir = st.sortDir === 'asc' ? 'desc' : 'asc';
    else dir = 'asc';
    st.sortCol = colIdx;
    st.sortDir = dir;
    for (var i = 0; i < ths.length; i++) {
      ths[i].setAttribute('aria-sort', i === colIdx ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    var tbody = table.tBodies[0];
    var rows = Array.from(tbody.rows);
    rows.sort(function(a, b) {
      var ac = a.cells[colIdx], bc = b.cells[colIdx];
      if (!ac || !bc) return 0;
      var av = (ac.dataset.sortValue !== undefined) ? ac.dataset.sortValue : ac.textContent.trim();
      var bv = (bc.dataset.sortValue !== undefined) ? bc.dataset.sortValue : bc.textContent.trim();
      var an = parseFloat(String(av).replace(/[^0-9.eE+\-]/g, ''));
      var bn = parseFloat(String(bv).replace(/[^0-9.eE+\-]/g, ''));
      if (!isNaN(an) && !isNaN(bn)) return dir === 'asc' ? an - bn : bn - an;
      return dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
    rows.forEach(function(r) { tbody.appendChild(r); });
    st.page = 1;
    paginateTable(id);
  }

  function exportTableCSV(id, filename) {
    var table = document.getElementById(id);
    if (!table) return;
    var csv = [];
    var thRow = table.tHead && table.tHead.rows[0];
    if (thRow) {
      var hdrs = Array.from(thRow.cells).map(function(c) { return csvCell(c.textContent); });
      csv.push(hdrs.join(','));
    }
    Array.from(table.tBodies[0].rows).forEach(function(r) {
      if (r.hasAttribute('data-search-hidden')) return;
      var cells = Array.from(r.cells).map(function(c) { return csvCell(c.textContent); });
      csv.push(cells.join(','));
    });
    var blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { URL.revokeObjectURL(link.href); }, 1000);
  }
  function csvCell(s) {
    var v = String(s || '').replace(/\s+/g, ' ').trim().replace(/"/g, '""');
    return '"' + v + '"';
  }

  Site.initTable = initTable;

  // -------------------- Reveals (IntersectionObserver) --------------------
  function initReveals() {
    var reveals = document.querySelectorAll('.reveal');
    if (!reveals.length) return;
    if (!('IntersectionObserver' in window) || reduceMotion) {
      reveals.forEach(function(el) { el.classList.add('is-visible'); });
      return;
    }
    var obs = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function(el) { obs.observe(el); });
  }

  // -------------------- Plotly theme bridge --------------------
  // Pages that render Plotly charts should, for each chart, embed:
  //   <div class="v2-chart" id="chart-x"
  //        data-chart-layout-light='{"paper_bgcolor":"#fff",...}'
  //        data-chart-layout-dark='{"paper_bgcolor":"#0F1417",...}'></div>
  //   <script>window.CHART_DATA=window.CHART_DATA||{};window.CHART_DATA['chart-x']={data:..., layout:...};</script>
  // Then call Site.initCharts() after the payload is present.

  function currentTheme() { return root.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light'; }

  function readOverride(el, theme) {
    try {
      var raw = el.getAttribute('data-chart-layout-' + theme);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function renderedCharts() {
    return Array.from(document.querySelectorAll('.v2-chart[id]'));
  }

  function renderChart(el) {
    if (typeof Plotly === 'undefined') return;
    var id = el.id;
    var payload = (window.CHART_DATA || {})[id];
    if (!payload) return;
    var config = Object.assign({ responsive: true, displaylogo: false }, payload.config || {});
    Plotly.newPlot(id, payload.data || [], payload.layout || {}, config).then(function() {
      el.dataset.chartRendered = '1';
      var theme = currentTheme();
      var override = readOverride(el, theme);
      if (override) Plotly.relayout(id, override);
    });
  }

  function relayoutCharts(theme) {
    if (typeof Plotly === 'undefined') return;
    renderedCharts().forEach(function(el) {
      if (!el.dataset.chartRendered) return;
      var override = readOverride(el, theme);
      if (override) Plotly.relayout(el.id, override);
    });
  }

  function initCharts() {
    renderedCharts().forEach(function(el) {
      if (!el.dataset.chartRendered) renderChart(el);
    });
  }
  Site.initCharts = initCharts;

  document.addEventListener('gpcrsynth-theme-change', function(e) {
    relayoutCharts(e.detail.mode);
  });

  // -------------------- Browse page (gpcr_index) --------------------
  // Contract:
  //   window.GPCR_DATA = [ {gpcr_id, uniprot_name, gene_name, receptor_family, ligand_type,
  //                         total_contacts, significant_changes, sum_abs_delta, variants_found}, ... ]
  //   DOM:
  //     #search-input (v2-input)
  //     #filter-ligand, #filter-family (v2-select)
  //     #per-page (v2-select)
  //     #gpcr-table (v2-table with thead and tbody)
  //     [data-table-pagination="gpcr-table"]
  //     #result-count (span)
  //   Row navigation target: reports/{gpcr_id}.html (configurable via opts.reportPathPrefix)

  function initBrowse(opts) {
    opts = opts || {};
    var reportPrefix = opts.reportPathPrefix || '../reports/';
    var reportSuffix = opts.reportPathSuffix || '.html';
    var data = window.GPCR_DATA || [];
    if (!data.length) return;
    var filtered = data.slice();
    var state = { page: 1, pageSize: 25, sortCol: 'sum_abs_delta', sortDir: 'desc' };

    var tbody = document.querySelector('#gpcr-table tbody');
    var searchInput = document.getElementById('search-input');
    var ligandSel = document.getElementById('filter-ligand');
    var familySel = document.getElementById('filter-family');
    var perPageSel = document.getElementById('per-page');
    var pagDiv = document.querySelector('[data-table-pagination="gpcr-table"]');
    var resultCount = document.getElementById('result-count');
    if (!tbody) return;

    // Populate dropdowns
    function fillSelect(sel, values) {
      if (!sel) return;
      values.sort().forEach(function(v) {
        var o = document.createElement('option');
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      });
    }
    fillSelect(ligandSel, Array.from(new Set(data.map(function(d) { return d.ligand_type; }).filter(Boolean))));
    fillSelect(familySel, Array.from(new Set(data.map(function(d) { return d.receptor_family; }).filter(Boolean))));

    // UniProt protein names ("Beta-2 adrenergic receptor") come from the search index, loaded the
    // first time the reader types in the filter box. Until then (or if it fails) the filter
    // matches name, gene, family and id as before.
    var proteinNames = null;
    var namesRequested = false;
    function loadProteinNames() {
      if (namesRequested || !opts.metaUrl || typeof fetch !== 'function') return;
      namesRequested = true;
      fetch(opts.metaUrl).then(function(r) { return r.ok ? r.json() : null; }).then(function(meta) {
        if (!meta || !meta.receptorFields || !meta.receptors) return;
        var gi = meta.receptorFields.indexOf('gid');
        var ni = meta.receptorFields.indexOf('name');
        var map = {};
        meta.receptors.forEach(function(rec) { map[rec[gi]] = String(rec[ni] || '').toLowerCase(); });
        proteinNames = map;
        if (searchInput && searchInput.value.trim()) applyFilters();
      }).catch(function() { namesRequested = false; });
    }
    function squash(s) { return s.replace(/[^a-z0-9]/g, ''); }

    function applyFilters() {
      var q = (searchInput ? searchInput.value : '').toLowerCase().trim();
      var qs = squash(q);
      var lg = ligandSel ? ligandSel.value : '';
      var fm = familySel ? familySel.value : '';
      filtered = data.filter(function(d) {
        if (lg && d.ligand_type !== lg) return false;
        if (fm && d.receptor_family !== fm) return false;
        if (q) {
          var hay = (d.uniprot_name + ' ' + d.gene_name + ' ' + d.receptor_family + ' ' + d.gpcr_id).toLowerCase();
          if (proteinNames && proteinNames[d.gpcr_id]) hay += ' ' + proteinNames[d.gpcr_id];
          // "beta 2" finds "Beta-2"; punctuation-free text needs two characters to avoid noise
          if (hay.indexOf(q) === -1 && !(qs.length >= 2 && squash(hay).indexOf(qs) !== -1)) return false;
        }
        return true;
      });
      state.page = 1;
      sortAndRender();
    }

    function sortAndRender() {
      filtered.sort(function(a, b) {
        var av = a[state.sortCol], bv = b[state.sortCol];
        if (typeof av === 'string') {
          av = av.toLowerCase(); bv = (bv || '').toLowerCase();
          return state.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        }
        return state.sortDir === 'asc' ? (av - bv) : (bv - av);
      });
      render();
    }

    function render() {
      var totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
      if (state.page > totalPages) state.page = totalPages;
      var start = (state.page - 1) * state.pageSize;
      var page = filtered.slice(start, start + state.pageSize);
      tbody.innerHTML = page.map(function(d, i) {
        var href = reportPrefix + d.gpcr_id + reportSuffix;
        return '<tr class="clickable-row" data-href="' + escapeAttr(href) + '">' +
          '<td class="num">' + (start + i + 1) + '</td>' +
          '<td><a href="' + escapeAttr(href) + '">' + escapeHtml(d.uniprot_name) + '</a></td>' +
          '<td>' + escapeHtml(d.gene_name || '') + '</td>' +
          '<td>' + escapeHtml(d.receptor_family || '') + '</td>' +
          '<td><span class="badge badge-teal">' + escapeHtml(d.ligand_type || '') + '</span></td>' +
          '<td class="num">' + d.total_contacts + '</td>' +
          '<td class="num">' + d.significant_changes + '</td>' +
          '<td class="num"><strong>' + Number(d.sum_abs_delta).toFixed(1) + '</strong></td>' +
          '<td class="num">' + d.variants_found + '</td>' +
        '</tr>';
      }).join('');
      tbody.querySelectorAll('tr.clickable-row').forEach(function(tr) {
        tr.addEventListener('click', function(e) {
          if (e.target.closest('a')) return;
          window.location.href = tr.dataset.href;
        });
      });
      renderPagination(totalPages);
      if (resultCount) resultCount.textContent = filtered.length + ' of ' + data.length + ' GPCRs';
    }

    function renderPagination(totalPages) {
      if (!pagDiv) return;
      var start = (state.page - 1) * state.pageSize;
      var end = Math.min(start + state.pageSize, filtered.length);
      var html = '';
      html += '<button type="button" ' + (state.page <= 1 ? 'disabled' : '') + ' data-page="prev">← Prev</button>';
      var maxBtns = 7;
      var sp = Math.max(1, state.page - Math.floor(maxBtns / 2));
      var ep = Math.min(totalPages, sp + maxBtns - 1);
      if (ep - sp < maxBtns - 1) sp = Math.max(1, ep - maxBtns + 1);
      if (sp > 1) {
        html += '<button type="button" data-page="1">1</button>';
        if (sp > 2) html += '<span class="v2-pagination-info">…</span>';
      }
      for (var p = sp; p <= ep; p++) {
        html += '<button type="button" data-page="' + p + '"' + (p === state.page ? ' aria-current="page"' : '') + '>' + p + '</button>';
      }
      if (ep < totalPages) {
        if (ep < totalPages - 1) html += '<span class="v2-pagination-info">…</span>';
        html += '<button type="button" data-page="' + totalPages + '">' + totalPages + '</button>';
      }
      html += '<button type="button" ' + (state.page >= totalPages ? 'disabled' : '') + ' data-page="next">Next →</button>';
      html += '<span class="v2-pagination-info">' + (filtered.length === 0 ? 0 : (start + 1)) + '–' + end + ' of ' + filtered.length + '</span>';
      pagDiv.innerHTML = html;
      pagDiv.querySelectorAll('button[data-page]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var p = btn.dataset.page;
          if (p === 'prev') state.page = Math.max(1, state.page - 1);
          else if (p === 'next') state.page = Math.min(totalPages, state.page + 1);
          else state.page = parseInt(p, 10);
          render();
        });
      });
    }

    function updateSortIndicators() {
      document.querySelectorAll('#gpcr-table thead th[data-sort]').forEach(function(th) {
        th.setAttribute('aria-sort', th.dataset.sort === state.sortCol
          ? (state.sortDir === 'asc' ? 'ascending' : 'descending')
          : 'none');
      });
    }

    // Wire events
    if (searchInput) {
      searchInput.addEventListener('input', applyFilters);
      searchInput.addEventListener('focus', loadProteinNames);
      searchInput.addEventListener('input', loadProteinNames);
    }
    if (ligandSel) ligandSel.addEventListener('change', applyFilters);
    if (familySel) familySel.addEventListener('change', applyFilters);
    if (perPageSel) perPageSel.addEventListener('change', function() {
      state.pageSize = parseInt(perPageSel.value, 10);
      state.page = 1;
      render();
    });
    document.querySelectorAll('#gpcr-table thead th[data-sort]').forEach(function(th) {
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      th.setAttribute('aria-sort', 'none');
      var fire = function() {
        var col = th.dataset.sort;
        if (state.sortCol === col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortCol = col; state.sortDir = 'desc'; }
        updateSortIndicators();
        sortAndRender();
      };
      th.addEventListener('click', fire);
      th.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
      });
    });

    updateSortIndicators();
    sortAndRender();
  }
  Site.initBrowse = initBrowse;

  // -------------------- Helpers --------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // -------------------- Boot --------------------
  function boot() {
    initThemeToggle();
    initMobileDrawer();
    initTooltips();
    initCollapsibles();
    initReveals();
    // Auto-init any tables marked for auto-wire via data-table-auto on wrapper
    document.querySelectorAll('[data-table-auto]').forEach(function(el) {
      var id = el.getAttribute('data-table-auto');
      var pageSize = parseInt(el.getAttribute('data-page-size') || '25', 10);
      initTable({ id: id, pageSize: pageSize });
    });
    // Auto-init charts if CHART_DATA was populated before script loaded
    if (window.CHART_DATA) initCharts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
