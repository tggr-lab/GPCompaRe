/* residue-drawer.js: the opt-in residue drawer on report pages.

   Nothing opens by itself. A click on a snake-plot residue, on a residue cell
   of the report tables or on a residue in the ClinVar section opens a small
   panel with facts the page already carries (residue, generic number, segment,
   core functional residue, net and largest dRRCS, contacts), the contact
   partners with their active, inactive and dRRCS values, the variants and
   ClinVar records at that residue, and "Show in 3D" / "Focus this pair in 3D"
   actions. A link to the page with #res=<n> (the search page writes these)
   opens the drawer on that residue.

   This module is also the small hub the 3D view listens to:
     document 'rx:residue' {pos, source}   the selected residue changed (pos null: cleared)
     document 'rx:show3d'  {pos}           the drawer asked for the 3D view
     document 'rx:focus-pair' {a, b}       the drawer asked for a contact pair to be framed in 3D
     document 'rx:3d-state' {open}         (from viewer3d.js) the 3D view was opened or closed
   Selection is shared with the snake plot through window.SnakeAPI
   (selectResidue, and the 'snake-residue-select' event it fires). */
(function () {
  'use strict';

  var RX = (window.ReportExtras = window.ReportExtras || {});

  function readJSON(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  var cfg = readJSON('rx-config') || {};
  var drawer = document.getElementById('rx-drawer');
  var titleEl = document.getElementById('rx-drawer-title');
  var bodyEl = document.getElementById('rx-drawer-body');
  if (!drawer || !titleEl || !bodyEl) return;

  var annotation = cfg.annotation || {};
  var clinvar = cfg.clinvar || [];
  var summary = readJSON('residue-summary-data') || [];
  var snake = readJSON('snake-plot-data');
  var cfrColors = (snake && snake.views && snake.views.cfr && snake.views.cfr.colors) || null;

  var byPos = {};
  summary.forEach(function (r) { byPos[r.position] = r; });

  var THREE = {
    A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile',
    L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val'
  };

  var current = null;
  var lastTrigger = null;
  var variantIndex = null;
  var pairIndex = null;
  var PAIRS_SHOWN = 8;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // The variants table of the report, read from the page (rows stay in the DOM
  // when the table pages or filters them).
  function variantsAt(pos) {
    if (!variantIndex) {
      variantIndex = {};
      var table = document.getElementById('variants-table');
      if (table && table.tBodies[0]) {
        Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
          var c = row.cells;
          if (c.length < 8) return;
          var p = parseInt(c[0].textContent, 10);
          if (isNaN(p)) return;
          (variantIndex[p] = variantIndex[p] || []).push({
            hgvsp: c[1].textContent.trim(),
            af: c[3].textContent.trim(),
            amScore: c[6].textContent.trim(),
            amClass: c[7].textContent.trim()
          });
        });
      }
    }
    return variantIndex[pos] || [];
  }

  // AlphaMissense class (and score, when the report has one), labelled
  function amText(v) {
    var has = function (x) { return x && x !== '-'; };
    if (!has(v.amClass) && !has(v.amScore)) return '';
    return ' · AlphaMissense: ' + (has(v.amClass) ? v.amClass.toLowerCase() : '') +
      (has(v.amScore) ? (has(v.amClass) ? ' (' + v.amScore + ')' : v.amScore) : '');
  }

  function fmtSigned(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); }

  function aa3(name) {
    var n = String(name || '').trim();
    if (/^[A-Za-z]{3}$/.test(n)) return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
    return THREE[n.toUpperCase()] || n;
  }

  // Contact pairs of the report's RRCS table (the top contact pairs by |dRRCS|; the page
  // says how many it shows). The residue-table rows stay in the DOM when it pages or sorts.
  function pairsAt(pos) {
    if (!pairIndex) {
      pairIndex = {};
      var table = document.getElementById('rrcs-table');
      if (table && table.tBodies[0]) {
        Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
          var c = row.cells;
          if (c.length < 7) return;
          var r1 = parseInt(c[0].textContent, 10), r2 = parseInt(c[2].textContent, 10);
          var act = parseFloat(c[4].textContent), inact = parseFloat(c[5].textContent), d = parseFloat(c[6].textContent);
          if ([r1, r2, act, inact, d].some(isNaN)) return;
          var n1 = aa3(c[1].textContent), n2 = aa3(c[3].textContent);
          (pairIndex[r1] = pairIndex[r1] || []).push({ other: r2, name: n2, active: act, inactive: inact, delta: d });
          (pairIndex[r2] = pairIndex[r2] || []).push({ other: r1, name: n1, active: act, inactive: inact, delta: d });
        });
      }
    }
    return pairIndex[pos] || [];
  }

  function searchHref(q) { return (cfg.search || '../search/') + '?q=' + encodeURIComponent(q); }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function threeDOpen() {
    var panel = document.getElementById('rx-3d-panel');
    return !!panel && !panel.hidden;
  }

  function paintPairButton(b) {
    var open = threeDOpen();
    b.textContent = open ? 'Focus' : 'Open 3D';
    b.setAttribute('aria-label', (open ? 'Focus this pair in 3D: ' : 'Open the 3D view and focus this pair: ') + b.getAttribute('data-pair-label'));
  }

  function contactsBlock(pos) {
    var pairs = pairsAt(pos).slice().sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
    var wrap = el('div', 'rx-contacts');
    wrap.appendChild(el('h3', null, 'Contact partners'));
    if (!pairs.length) {
      wrap.appendChild(el('p', 'rx-none', 'No contact pairs for this residue in the RRCS table.'));
      return wrap;
    }
    var table = el('table', 'rx-pairs');
    var head = el('tr');
    ['Partner', 'Active', 'Inactive', 'ΔRRCS'].forEach(function (t) { head.appendChild(el('th', null, t)); });
    if (cfg.has3d) head.appendChild(el('th', null, '3D'));
    var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    var tbody = el('tbody');
    pairs.forEach(function (p, i) {
      var tr = el('tr');
      if (i >= PAIRS_SHOWN) tr.hidden = true;
      var ann = annotation[String(p.other)] || [];
      var td = el('td', null, p.name + p.other);
      if (ann[1]) { td.appendChild(document.createTextNode(' ')); td.appendChild(el('small', 'muted', '(' + ann[1] + ')')); }
      tr.appendChild(td);
      tr.appendChild(el('td', 'num', p.active.toFixed(2)));
      tr.appendChild(el('td', 'num', p.inactive.toFixed(2)));
      tr.appendChild(el('td', 'num ' + (p.delta >= 0 ? 'is-active' : 'is-inactive'), fmtSigned(p.delta)));
      if (cfg.has3d) {
        var cell = el('td');
        var b = el('button', 'btn btn-ghost btn-sm rx-pair-focus');
        b.type = 'button';
        b.setAttribute('data-a', String(pos));
        b.setAttribute('data-b', String(p.other));
        b.setAttribute('data-pair-label', (titleEl.textContent || '') + ' and ' + p.name + p.other);
        paintPairButton(b);
        cell.appendChild(b);
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var scroller = el('div', 'rx-pairs-scroll');
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    var row = byPos[pos];
    if (pairs.length > PAIRS_SHOWN) {
      var more = el('button', 'btn btn-ghost btn-sm', 'Show all ' + pairs.length);
      more.type = 'button';
      more.addEventListener('click', function () {
        Array.prototype.forEach.call(tbody.rows, function (r) { r.hidden = false; });
        more.hidden = true;
      });
      wrap.appendChild(more);
    }
    if (row && row.n_contact_partners > pairs.length) {
      wrap.appendChild(el('p', 'rx-note', pairs.length + ' of ' + row.n_contact_partners +
        ' contacts: the RRCS table lists the pairs with the largest |ΔRRCS|.'));
    }
    return wrap;
  }

  function fact(list, label, value, cls) {
    list.appendChild(el('dt', null, label));
    list.appendChild(el('dd', cls || null, value));
  }

  function render(pos) {
    var row = byPos[pos];
    var ann = annotation[String(pos)] || [];
    var gn = ann[1] || (row && (row.display_number || row.generic_number)) || '';
    var seg = ann[0] || (row && row.protein_segment) || '';
    var aa = row && row.amino_acid ? row.amino_acid : '';
    if (!aa) {
      var cv = clinvar.filter(function (r) { return r.pos === pos; })[0];
      if (cv) aa = cv.ref;
    }

    titleEl.textContent = (aa && THREE[aa] ? THREE[aa] : '') + pos;
    bodyEl.textContent = '';

    var facts = el('dl', 'rx-facts');
    fact(facts, 'Generic number', gn || '-');
    fact(facts, 'Segment', seg || '-');
    if (cfrColors) fact(facts, 'Core functional residue', cfrColors[String(pos)] ? 'Yes' : 'No');
    if (row) {
      fact(facts, 'Net ΔRRCS', fmtSigned(row.active_minus_inactive),
        row.active_minus_inactive >= 0 ? 'is-active' : 'is-inactive');
      fact(facts, 'Largest |ΔRRCS|',
        row.max_abs_delta.toFixed(2) + (row.partner_at_max ? ' with ' + row.partner_at_max : ''));
      fact(facts, 'Contacts', String(row.n_contact_partners));
    } else {
      fact(facts, 'Contacts', '0');
    }
    bodyEl.appendChild(facts);

    var tools = el('div', 'rx-drawer-tools');
    if (gn) {
      var all = el('a', 'btn btn-ghost btn-sm', gn + ' in all receptors');
      all.href = searchHref(gn);
      all.setAttribute('data-tooltip', 'Residues at this GPCRdb generic position in every receptor');
      tools.appendChild(all);
    }
    var copy = el('button', 'btn btn-ghost btn-sm', 'Copy link to this residue');
    copy.type = 'button';
    copy.id = 'rx-copy-link';
    var copied = el('span', 'rx-copied');
    copied.setAttribute('role', 'status');
    copy.addEventListener('click', function () {
      var url = window.location.href.split('#')[0] + '#res=' + pos;
      copyText(url).then(function () { copied.textContent = 'Link copied'; },
        function () { copied.textContent = 'Copy failed: ' + url; });
      setTimeout(function () { copied.textContent = ''; }, 2500);
    });
    tools.appendChild(copy);
    tools.appendChild(copied);
    bodyEl.appendChild(tools);

    bodyEl.appendChild(contactsBlock(pos));

    var vars = variantsAt(pos);
    bodyEl.appendChild(el('h3', null, 'Variants in this report'));
    if (vars.length) {
      var ul = el('ul');
      vars.forEach(function (v) {
        ul.appendChild(el('li', null, v.hgvsp + ' · AF ' + v.af + amText(v)));
      });
      bodyEl.appendChild(ul);
    } else {
      bodyEl.appendChild(el('p', 'rx-none', 'None in this report\'s variant table'));
    }

    var cvs = clinvar.filter(function (r) { return r.pos === pos; });
    if (cfg.clinvarLabel) bodyEl.appendChild(el('h3', null, 'ClinVar'));
    if (!cfg.clinvarLabel) {
      // this build carries no ClinVar data: say nothing about it
    } else if (cvs.length) {
      var ul2 = el('ul');
      cvs.forEach(function (r) {
        var li = el('li');
        li.appendChild(document.createTextNode(r.hgvsp + ' · ' + r.cls + ' · ' + r.stars + '/4 stars · '));
        var a = el('a', null, r.vcv);
        a.href = 'https://www.ncbi.nlm.nih.gov/clinvar/variation/' + encodeURIComponent(r.vid) + '/';
        a.target = '_blank';
        a.rel = 'noopener';
        li.appendChild(a);
        ul2.appendChild(li);
      });
      bodyEl.appendChild(ul2);
    } else {
      bodyEl.appendChild(el('p', 'rx-none', 'No ' + (cfg.clinvarScope || 'pathogenic or likely pathogenic missense records') +
        ' in ' + cfg.clinvarLabel));
    }
    if (cfg.clinvarLabel && cfg.gene) {
      var cvAll = el('a', 'rx-more-link', 'Search all ClinVar records for ' + cfg.gene);
      cvAll.href = searchHref(cfg.gene);
      bodyEl.appendChild(cvAll);
    }

    if (cfg.has3d) {
      var actions = el('div', 'rx-drawer-actions');
      var b = el('button', 'btn btn-sm', 'Show in 3D');
      b.type = 'button';
      b.id = 'rx-show-in-3d';
      b.addEventListener('click', function () {
        document.dispatchEvent(new CustomEvent('rx:show3d', { detail: { pos: pos } }));
      });
      actions.appendChild(b);
      bodyEl.appendChild(actions);
    }
  }

  function emit(pos, source) {
    document.dispatchEvent(new CustomEvent('rx:residue', { detail: { pos: pos, source: source || '' } }));
  }

  function open(pos, opts) {
    opts = opts || {};
    current = pos;
    render(pos);
    drawer.hidden = false;
    if (opts.focus) {
      drawer.setAttribute('tabindex', '-1');
      drawer.focus({ preventScroll: true });
    }
  }

  function close() {
    drawer.hidden = true;
    current = null;
    if (lastTrigger && document.contains(lastTrigger) && lastTrigger.focus) {
      lastTrigger.focus({ preventScroll: true });
    }
    lastTrigger = null;
  }

  // Select a residue from anywhere: opens the drawer, marks it on the snake
  // plot and tells the 3D view. source: 'snake' | 'table' | '3d' | 'clinvar'.
  function select(pos, opts) {
    opts = opts || {};
    if (typeof pos !== 'number' || isNaN(pos)) return;
    open(pos, opts);
    if (opts.source !== 'snake' && window.SnakeAPI && window.SnakeAPI.selectResidue) {
      window.SnakeAPI.selectResidue(pos);
    }
    emit(pos, opts.source);
  }

  RX.select = select;
  RX.close = close;
  RX.current = function () { return current; };

  // Snake plot -> drawer. Only a real click opens the drawer; a residue
  // selected by a link (#res=) or by code leaves it closed.
  document.addEventListener('snake-residue-select', function (ev) {
    var d = ev.detail || {};
    if (d.residue === null || d.residue === undefined) {
      if (!drawer.hidden) { drawer.hidden = true; current = null; }
      emit(null, 'snake');
      return;
    }
    if (d.residue === current && !drawer.hidden) return;
    if (d.user || !drawer.hidden) open(d.residue);
    emit(d.residue, 'snake');
  });

  // Report tables: the cells that name a residue.
  var CELLS = [
    ['top-changes-table', 'td:nth-child(2), td:nth-child(3)', /^[A-Za-z]+(\d+)/],
    ['variants-table', 'td:nth-child(1)', /^(\d+)/],
    ['rrcs-table', 'td:nth-child(1), td:nth-child(3)', /^(\d+)/],
    ['tm-summary-table', '.tm-res', /^(\d+)/]
  ];

  function residueOfCell(cell, table) {
    for (var i = 0; i < CELLS.length; i++) {
      if (CELLS[i][0] !== table.id) continue;
      if (!cell.matches(CELLS[i][1])) return null;
      var m = CELLS[i][2].exec(cell.textContent.trim());
      return m ? parseInt(m[1], 10) : null;
    }
    return null;
  }

  function cellOf(t) {
    var table = t.closest('table');
    if (!table) return null;
    var cell = t.closest('.tm-res') || t.closest('td');
    if (!cell || !table.contains(cell)) return null;
    return { table: table, cell: cell, pos: residueOfCell(cell, table) };
  }

  // Cells that open the drawer take the keyboard too: they are tab stops and open on
  // Enter or Space. (Set from here because the table markup is frozen. Rows the table
  // pages out are hidden and so are not reachable until paged in.)
  function makeCellsFocusable() {
    CELLS.forEach(function (c) {
      var table = document.getElementById(c[0]);
      if (!table) return;
      Array.prototype.forEach.call(table.querySelectorAll('tbody ' + c[1].split(',').join(', tbody ')), function (cell) {
        if (residueOfCell(cell, table) === null) return;
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('data-rx-cell', '');
      });
    });
  }
  makeCellsFocusable();

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var t = ev.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-rx-cell')) return;
    var info = cellOf(t);
    if (!info || info.pos === null) return;
    ev.preventDefault();
    lastTrigger = t;
    select(info.pos, { source: 'table', focus: true });
  });

  // Contact pairs: frame the pair in the 3D view (which opens it if it is closed).
  function pairButtons() { return bodyEl.querySelectorAll('.rx-pair-focus'); }
  document.addEventListener('rx:3d-state', function () {
    Array.prototype.forEach.call(pairButtons(), paintPairButton);
  });

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var pairBtn = t.closest('.rx-pair-focus');
    if (pairBtn) {
      document.dispatchEvent(new CustomEvent('rx:focus-pair', { detail: {
        a: parseInt(pairBtn.getAttribute('data-a'), 10), b: parseInt(pairBtn.getAttribute('data-b'), 10) } }));
      return;
    }
    // The residue letter sits on top of its circle and takes the click, so the
    // plot's own handler (on the circle) never sees it: pass it on.
    var label = /^(\d+)t$/.exec(t.id || '');
    if (label && t.closest('#snake-plot-container') && window.SnakeAPI && window.SnakeAPI.toggleResidue) {
      window.SnakeAPI.toggleResidue(parseInt(label[1], 10), ev.isTrusted);
      return;
    }
    var link = t.closest('[data-rx-res]');
    if (link) {
      lastTrigger = link;
      select(parseInt(link.getAttribute('data-rx-res'), 10), { source: 'clinvar', focus: ev.detail === 0 });
      return;
    }
    var table = t.closest('table');
    if (!table) return;
    var cell = t.closest('.tm-res') || t.closest('td');
    if (!cell || !table.contains(cell)) return;
    var pos = residueOfCell(cell, table);
    if (pos === null) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return; // the visitor is selecting text
    select(pos, { source: 'table' });
  });

  // A link with #res=<n> (the search page writes these) opens the drawer on that residue.
  // The snake plot has already selected it (v3-deeplink.js runs first).
  function openFromHash() {
    var m = /(?:^#|&)res=(\d+)(?:&|$)/.exec(window.location.hash || '');
    if (!m) return;
    var pos = parseInt(m[1], 10);
    if (!byPos[pos] && !annotation[String(pos)]) return;
    open(pos);
    emit(pos, 'hash');
  }
  openFromHash();
  window.addEventListener('hashchange', openFromHash);

  document.getElementById('rx-drawer-close').addEventListener('click', close);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !drawer.hidden) close();
  });

  document.documentElement.classList.add('rx-drawer-on');
})();
