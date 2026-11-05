/* viewer3d.js: the opt-in 3D view on report pages.

   Off by default. Nothing but this small file loads with the page; the viewer
   (Mol*, about 1 MB gzipped) and the two model files are requested only when
   "Show 3D view" is pressed, and only from this site:
     ../studio/embed/pair-viewer.js   the Studio's pair viewer (built from the Studio repo)
     ../models/{active,inactive}/<gid>_<state>.pdb.gz   the GPCRdb models, unmodified bytes, gzipped

   The cartoon is coloured by the report's own net dRRCS per residue (the same
   numbers as the snake plot's "Residue net" view). The contacts, residue pairs
   whose RRCS changes, are drawn as cylinders between the two side chains: red
   where the contact is stronger in active, blue where it is stronger in
   inactive, thicker for a larger |dRRCS|. They are the rows of the page's
   complete RRCS table (#rrcs-table, read when the view opens); by default only
   the highlighted rows, those above the receptor's dRRCS threshold. With both
   models shown, a contact is drawn in the model where it is stronger.

   Events (plain CustomEvents on document, see the shared contract):
     listens  gpc:select-residue  frame the residue and show its contacts
              gpc:select-pair     frame the pair, both side chains, a label
              gpc:hover-residue / gpc:hover-pair   transient highlight
              rx:residue, rx:focus-pair, rx:show3d  (the residue drawer)
     fires    gpc:select-residue / gpc:select-pair  on a click in 3D (source '3d')
              gpc:hover-residue / gpc:hover-pair    on hover in 3D (source '3d')
              gpc:3d-ready                          once the models are drawn
   Events from source '3d' are ignored here. */
(function () {
  'use strict';

  function readJSON(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  var cfg = readJSON('rx-config') || {};
  var toggle = document.getElementById('rx-3d-toggle');
  var panel = document.getElementById('rx-3d-panel');
  var pane = document.getElementById('rx-3d-pane');
  var statusEl = document.getElementById('rx-3d-status');
  if (!cfg.has3d || !toggle || !panel || !pane) return;

  var GID = cfg.gid || '';
  var SRC = '3d';
  var RX = (window.ReportExtras = window.ReportExtras || {});
  var handle = null;
  var starting = false;
  var selected = null;
  var pendingPair = null;
  var contacts = null;
  var contactOpts = { show: 'passing', top: 25, sign: 'both' };
  var ui = null;
  var hovered = null;

  function absolute(url) { return new URL(url, document.baseURI).href; }
  function setStatus(text, state) {
    if (statusEl) statusEl.textContent = text || '';
    pane.setAttribute('data-state', state || '');
  }
  function fire(name, detail) {
    detail.gid = GID;
    detail.source = SRC;
    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }
  function mine(d) { return !d || d.source === SRC || (d.gid && GID && d.gid !== GID); }
  function num(v) { var n = typeof v === 'string' ? parseInt(v, 10) : v; return typeof n === 'number' && isFinite(n) ? n : null; }

  function residueValues() {
    var rows = readJSON('residue-summary-data') || [];
    var out = {};
    rows.forEach(function (r) {
      if (typeof r.active_minus_inactive === 'number') out[r.position] = r.active_minus_inactive;
    });
    return out;
  }

  // The contacts: the rows of the complete RRCS table; a highlighted row is above the threshold.
  function readContacts() {
    if (contacts) return contacts;
    contacts = [];
    var table = document.getElementById('rrcs-table');
    if (!table || !table.tBodies[0]) return contacts;
    Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
      var c = row.cells;
      if (c.length < 7) return;
      var a = parseInt(c[0].textContent, 10), b = parseInt(c[2].textContent, 10);
      var act = parseFloat(c[4].textContent), inact = parseFloat(c[5].textContent), d = parseFloat(c[6].textContent);
      if ([a, b, d].some(isNaN)) return;
      contacts.push({ a: a, b: b, delta: d, active: isNaN(act) ? undefined : act, inactive: isNaN(inact) ? undefined : inact,
                      passes: row.classList.contains('significant-row') });
    });
    return contacts;
  }

  function threshold() {
    var x = readJSON('rx-residue-extra');
    return x && typeof x.sig === 'number' ? x.sig : null;
  }

  function currentSelection() {
    if (selected !== null) return selected;
    var api = window.SnakeAPI;
    var s = api && api.getSelectedResidue ? api.getSelectedResidue() : null;
    return s === undefined ? null : s;
  }

  // ---- the contact controls and legend (built when the view first opens) ----

  var STYLE = [
    '.rx-3d-contacts{display:inline-flex;flex-wrap:wrap;align-items:center;gap:var(--s-2,8px)}',
    '.rx-3d-contacts label{display:inline-flex;align-items:center;gap:4px;font-size:.82rem;color:var(--fgColor-muted)}',
    '.rx-3d-contacts .v2-select{width:auto;min-width:0;max-width:100%;min-height:32px;padding-top:3px;padding-bottom:3px;font-size:.875rem}',
    '.rx-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;font-size:.82rem;color:var(--fgColor-muted);margin:var(--s-2,8px) 0 0}',
    '.rx-legend .rx-key{display:inline-flex;align-items:center;gap:6px}',
    '.rx-legend .rx-k{display:inline-block;flex:none;width:20px;border-radius:2px}',
    '.rx-legend .rx-k-active{background:var(--semantic-active)}',
    '.rx-legend .rx-k-inactive{background:var(--semantic-inactive)}',
    '.rx-legend .rx-k-width{background:var(--fgColor-muted)}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function select(id, label, options, value, onChange) {
    var wrap = el('label');
    wrap.setAttribute('for', id);
    wrap.appendChild(document.createTextNode(label));
    var s = el('select', 'v2-select');
    s.id = id;
    options.forEach(function (o) {
      var opt = el('option', null, o[1]);
      opt.value = o[0];
      if (o[0] === value) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', function () { onChange(s.value); });
    wrap.appendChild(s);
    return wrap;
  }

  // a short bar standing for a contact cylinder: its colour and width
  function line(cls, width) {
    var b = el('span', 'rx-k ' + cls);
    b.setAttribute('aria-hidden', 'true');
    b.style.height = width + 'px';
    return b;
  }

  function buildUi() {
    if (ui) return;
    if (!document.getElementById('rx-3d-contacts-style')) {
      var st = el('style');
      st.id = 'rx-3d-contacts-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    var tools = panel.querySelector('.rx-3d-tools');
    var group = el('div', 'rx-3d-contacts');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Contacts drawn');
    group.appendChild(select('rx-3d-contacts-show', 'Contacts', [
      ['passing', 'Above threshold'], ['top', 'Top 25'], ['off', 'Off']
    ], contactOpts.show, function (v) { contactOpts.show = v; applyContactOpts(); }));
    group.appendChild(select('rx-3d-contacts-sign', 'Stronger in', [
      ['both', 'Both states'], ['active', 'Active'], ['inactive', 'Inactive']
    ], contactOpts.sign, function (v) { contactOpts.sign = v; applyContactOpts(); }));
    if (tools) {
      var status = document.getElementById('rx-3d-status');
      tools.insertBefore(group, status || null);
    }
    var legend = el('p', 'rx-legend');
    legend.id = 'rx-3d-legend';
    var k1 = el('span', 'rx-key'); k1.appendChild(line('rx-k-active', 3)); k1.appendChild(document.createTextNode('Contact stronger in active'));
    var k2 = el('span', 'rx-key'); k2.appendChild(line('rx-k-inactive', 3)); k2.appendChild(document.createTextNode('Contact stronger in inactive'));
    var k3 = el('span', 'rx-key'); k3.appendChild(line('rx-k-width', 1.5)); k3.appendChild(line('rx-k-width', 4)); k3.appendChild(document.createTextNode('Width: |ΔRRCS|'));
    var count = el('span', 'rx-legend-count');
    count.id = 'rx-3d-contact-count';
    count.setAttribute('aria-live', 'polite');
    legend.appendChild(k1); legend.appendChild(k2); legend.appendChild(k3); legend.appendChild(count);
    var caption = panel.querySelector('.rx-caption');
    if (caption && caption.parentNode) caption.parentNode.insertBefore(legend, caption.nextSibling);
    else panel.appendChild(legend);
    ui = { count: count };
  }

  function updateCount() {
    if (!ui || !handle) return;
    var n = handle.drawnContacts().length;
    var sig = threshold();
    var what = contactOpts.show === 'off' ? 'Contacts off' :
      n + (n === 1 ? ' contact' : ' contacts') + ' drawn' +
      (contactOpts.show === 'passing' && sig !== null ? ' (|ΔRRCS| ≥ ' + sig.toFixed(2) + ')' : '');
    ui.count.textContent = what;
  }

  function applyContactOpts() {
    if (!handle) return;
    handle.setContactOptions({ show: contactOpts.show, top: contactOpts.top, sign: contactOpts.sign });
    settleCount();
  }

  // the drawn set changes after the viewer's next update; read it back then
  function settleCount() {
    var tries = 0;
    (function tick() {
      updateCount();
      if (++tries < 6) setTimeout(tick, 120);
    })();
  }

  // ---- the viewer ----

  function start() {
    if (handle || starting) return;
    starting = true;
    buildUi();
    setStatus('Loading viewer', 'loading');
    import(absolute(cfg.embed)).then(function (mod) {
      var sel = currentSelection();
      // colorMode is left out on purpose: the viewer then follows <html data-color-mode>
      // and recolours when the theme switch is used.
      handle = mod.mountPairViewer(pane, {
        activeUrl: absolute(cfg.models.active),
        inactiveUrl: absolute(cfg.models.inactive),
        residueValues: residueValues(),
        highlight: sel === null ? [] : [sel],
        segments: cfg.segments || undefined,
        contacts: readContacts(),
        contactOptions: { show: contactOpts.show, top: contactOpts.top, sign: contactOpts.sign },
        onPick: function (n) {
          selected = n;
          pane.setAttribute('data-focus', String(n));
          pane.removeAttribute('data-pair');
          if (RX.select) RX.select(n, { source: SRC });
          fire('gpc:select-residue', { res: n });
        },
        onPickContact: function (c) {
          applyPair({ a: c.a, b: c.b });
          fire('gpc:select-pair', { a: c.a, b: c.b, delta: c.delta });
        },
        onHover: function (t) {
          // clear the other kind only when it was set, so a sweep over residues sends one event per residue
          if (t && typeof t.res === 'number') {
            if (hovered === 'pair') fire('gpc:hover-pair', { a: null, b: null });
            fire('gpc:hover-residue', { res: t.res });
            hovered = 'residue';
          } else if (t && typeof t.a === 'number') {
            if (hovered === 'residue') fire('gpc:hover-residue', { res: null });
            fire('gpc:hover-pair', { a: t.a, b: t.b, delta: t.delta });
            hovered = 'pair';
          } else {
            if (hovered === 'residue') fire('gpc:hover-residue', { res: null });
            if (hovered === 'pair') fire('gpc:hover-pair', { a: null, b: null });
            hovered = null;
          }
        },
        onError: function (err) { setStatus(err && err.message ? err.message : 'The 3D view could not start.', 'error'); }
      });
      if (pendingPair) { applyPair(pendingPair); pendingPair = null; }
      else if (sel !== null) handle.focus(sel);
      handle.ready.then(function (r) {
        // The fit uses every residue of the receptor, floppy tails included, so a
        // single RMSD would overstate the difference between the states: say what was
        // fitted and leave the number out.
        setStatus('Superposed on ' + r.n + ' Cα atoms (all residues)', 'ready');
        settleCount();
        document.dispatchEvent(new CustomEvent('gpc:3d-ready', { detail: { gid: GID } }));
      }, function () { /* onError reported it */ });
    }).catch(function () {
      starting = false;
      setStatus('The 3D viewer could not be loaded.', 'error');
    });
  }

  function setOpen(on) {
    panel.hidden = !on;
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    toggle.textContent = on ? 'Hide 3D view' : 'Show 3D view';
    if (on) start();
    document.dispatchEvent(new CustomEvent('rx:3d-state', { detail: { open: !!on } }));
  }

  function applyPair(pair) {
    selected = null;
    pane.setAttribute('data-focus', '');
    pane.setAttribute('data-pair', pair.a + ',' + pair.b);
    handle.setHighlight([]);
    handle.focusContact(pair.a, pair.b);
    settleCount();
  }

  function focusResidue(pos) {
    selected = pos;
    pane.setAttribute('data-focus', pos === null ? '' : String(pos));
    pane.removeAttribute('data-pair');
    if (!handle) return;
    handle.setHighlight(pos === null ? [] : [pos]);
    handle.focus(pos);
    settleCount();
  }

  function paneOnScreen() {
    var r = pane.getBoundingClientRect();
    return r.bottom > 80 && r.top < window.innerHeight - 80;
  }

  toggle.addEventListener('click', function () { setOpen(panel.hidden); });

  Array.prototype.forEach.call(panel.querySelectorAll('[data-rx-show]'), function (btn) {
    btn.addEventListener('click', function () {
      var which = btn.getAttribute('data-rx-show');
      Array.prototype.forEach.call(panel.querySelectorAll('[data-rx-show]'), function (b) {
        var on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (handle) handle.setShow(which);
    });
  });

  var whole = document.getElementById('rx-3d-whole');
  if (whole) whole.addEventListener('click', function () {
    if (!handle) return;
    selected = null;
    pane.setAttribute('data-focus', '');
    pane.removeAttribute('data-pair');
    handle.setHighlight([]);
    handle.focus(null);
    settleCount();
  });

  // ---- the shared event bus ----

  // A residue chosen anywhere (snake plot, a table, the drawer): framed here with its contacts.
  document.addEventListener('gpc:select-residue', function (ev) {
    var d = ev.detail || {};
    if (mine(d)) return;
    var pos = num(d.res);
    if (pos === null && d.res !== null) return;
    pendingPair = null;
    focusResidue(pos);
  });

  // A contact pair chosen anywhere: framed with both side chains and labelled. The view
  // is not opened for it (it stays opt-in); a pair chosen while it is closed is applied
  // when it opens.
  document.addEventListener('gpc:select-pair', function (ev) {
    var d = ev.detail || {};
    if (mine(d)) return;
    var a = num(d.a), b = num(d.b);
    if (a === null || b === null) return;
    if (handle) applyPair({ a: a, b: b }); else pendingPair = { a: a, b: b };
  });

  document.addEventListener('gpc:hover-residue', function (ev) {
    var d = ev.detail || {};
    if (mine(d) || !handle) return;
    handle.hoverResidue(num(d.res));
  });

  document.addEventListener('gpc:hover-pair', function (ev) {
    var d = ev.detail || {};
    if (mine(d) || !handle) return;
    var a = num(d.a), b = num(d.b);
    if (a === null || b === null) handle.highlightContact(null);
    else handle.highlightContact(a, b);
  });

  // ---- the residue drawer's own events ----

  document.addEventListener('rx:residue', function (ev) {
    var d = ev.detail || {};
    if (d.source === SRC) return;
    focusResidue(d.pos === null || d.pos === undefined ? null : d.pos);
  });

  // "Focus this pair in 3D" in the residue drawer: acts at once when the view is open,
  // otherwise opens it (the button says so) and applies the pair when the viewer is up.
  document.addEventListener('rx:focus-pair', function (ev) {
    var d = ev.detail || {};
    if (typeof d.a !== 'number' || typeof d.b !== 'number' || isNaN(d.a) || isNaN(d.b)) return;
    if (panel.hidden) setOpen(true);
    if (handle) applyPair(d); else pendingPair = d;
    if (!paneOnScreen()) {
      var section = document.getElementById('sec-3d');
      if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
    }
  });

  // "Show in 3D" in the residue drawer.
  document.addEventListener('rx:show3d', function (ev) {
    var pos = ev.detail && ev.detail.pos;
    if (panel.hidden) setOpen(true);
    if (typeof pos === 'number') focusResidue(pos);
    var section = document.getElementById('sec-3d');
    if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
  });
})();
