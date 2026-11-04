/* residue-drawer.js: the opt-in residue drawer on report pages.

   Nothing opens by itself. A click on a snake-plot residue, on a residue cell
   of the report tables or on a residue in the ClinVar section opens a small
   panel with facts the page already carries (residue, generic number, segment,
   core functional residue, net and largest dRRCS, contacts), the variants and
   ClinVar records at that residue, and a "Show in 3D" action.

   This module is also the small hub the 3D view listens to:
     document 'rx:residue' {pos, source}   the selected residue changed (pos null: cleared)
     document 'rx:show3d'  {pos}           the drawer asked for the 3D view
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
            am: c[7].textContent.trim()
          });
        });
      }
    }
    return variantIndex[pos] || [];
  }

  function fmtSigned(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); }

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

    var vars = variantsAt(pos);
    bodyEl.appendChild(el('h3', null, 'Variants in this report'));
    if (vars.length) {
      var ul = el('ul');
      vars.forEach(function (v) {
        ul.appendChild(el('li', null, v.hgvsp + ' · AF ' + v.af + (v.am && v.am !== '-' ? ' · ' + v.am : '')));
      });
      bodyEl.appendChild(ul);
    } else {
      bodyEl.appendChild(el('p', 'rx-none', 'None'));
    }

    var cvs = clinvar.filter(function (r) { return r.pos === pos; });
    bodyEl.appendChild(el('h3', null, 'ClinVar'));
    if (cvs.length) {
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
      bodyEl.appendChild(el('p', 'rx-none', 'None'));
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

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
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

  document.getElementById('rx-drawer-close').addEventListener('click', close);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !drawer.hidden) close();
  });

  document.documentElement.classList.add('rx-drawer-on');
})();
