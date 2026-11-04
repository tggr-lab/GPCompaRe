/* viewer3d.js: the opt-in 3D view on report pages.

   Off by default. Nothing but this small file loads with the page; the viewer
   (Mol*, about 1 MB gzipped) and the two model files are requested only when
   "Show 3D view" is pressed, and only from this site:
     ../studio/embed/pair-viewer.js   the Studio's pair viewer (built from the Studio repo)
     ../models/{active,inactive}/<gid>_<state>.pdb.gz   the GPCRdb models, unmodified bytes, gzipped

   The cartoon is coloured by the report's own net dRRCS per residue (the same
   numbers as the snake plot's "Residue net" view). A residue clicked in the
   structure is selected on the snake plot and opens the residue drawer, and a
   residue selected there (or in a table) is framed in the structure. */
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

  var RX = (window.ReportExtras = window.ReportExtras || {});
  var handle = null;
  var starting = false;
  var selected = null;

  function absolute(url) { return new URL(url, document.baseURI).href; }
  function setStatus(text, state) {
    if (statusEl) statusEl.textContent = text || '';
    pane.setAttribute('data-state', state || '');
  }

  function residueValues() {
    var rows = readJSON('residue-summary-data') || [];
    var out = {};
    rows.forEach(function (r) {
      if (typeof r.active_minus_inactive === 'number') out[r.position] = r.active_minus_inactive;
    });
    return out;
  }

  function currentSelection() {
    if (selected !== null) return selected;
    var api = window.SnakeAPI;
    var s = api && api.getSelectedResidue ? api.getSelectedResidue() : null;
    return s === undefined ? null : s;
  }

  function start() {
    if (handle || starting) return;
    starting = true;
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
        onPick: function (n) {
          selected = n;
          if (RX.select) RX.select(n, { source: '3d' });
        },
        onError: function (err) { setStatus(err && err.message ? err.message : 'The 3D view could not start.', 'error'); }
      });
      if (sel !== null) handle.focus(sel);
      handle.ready.then(function (r) {
        setStatus('Superposed on ' + r.n + ' Cα atoms, RMSD ' + r.rmsd.toFixed(2) + ' Å', 'ready');
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
  if (whole) whole.addEventListener('click', function () { if (handle) handle.focus(null); });

  // A residue selected elsewhere (snake plot, table, ClinVar row) is framed here.
  document.addEventListener('rx:residue', function (ev) {
    var d = ev.detail || {};
    selected = d.pos === null || d.pos === undefined ? null : d.pos;
    pane.setAttribute('data-focus', selected === null ? '' : String(selected));
    if (!handle || d.source === '3d') return;
    handle.setHighlight(selected === null ? [] : [selected]);
    handle.focus(selected);
  });

  // "Show in 3D" in the residue drawer.
  document.addEventListener('rx:show3d', function (ev) {
    var pos = ev.detail && ev.detail.pos;
    if (typeof pos === 'number') { selected = pos; pane.setAttribute('data-focus', String(pos)); }
    if (panel.hidden) setOpen(true);
    if (handle && typeof pos === 'number') {
      handle.setHighlight([pos]);
      handle.focus(pos);
    }
    var section = document.getElementById('sec-3d');
    if (section && section.scrollIntoView) section.scrollIntoView({ block: 'start' });
  });
})();
