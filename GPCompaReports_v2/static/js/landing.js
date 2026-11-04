// landing.js: landing-only behaviors, the hero search.
// Theme toggle, tooltips, collapsibles, reveals live in site.js.
//
// The hero box is a real search form (action = search/, name = q), so it works without this
// script. With it: an exact receptor name opens that report; anything else, including a variant
// or a position, goes to the search page. The suggestion list is the shared autocomplete
// (search-ui/suggest.js), loaded only when the box is focused or typed in.

(function() {
  'use strict';

  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/landing\.js(\?.*)?$/, '') : null;
  var input = document.getElementById('search-input');
  var form = input && input.form;
  if (!input || !form) return;

  var records = [];
  try {
    var dataScript = document.getElementById('gpcr-search-data');
    records = dataScript ? JSON.parse(dataScript.textContent) : [];
  } catch (e) { records = []; }

  function squash(s) { return String(s || '').toLowerCase().replace(/\s+/g, ''); }

  // A receptor report only when the text is exactly a receptor's gene, UniProt name or id.
  function exactReceptor(q) {
    var k = squash(q);
    if (!k) return null;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (squash(r.gene_name) === k || squash(r.uniprot_name) === k || squash(r.gpcr_id) === k) return r;
    }
    return null;
  }

  function openReport(gpcrId) { window.location.href = 'reports/' + gpcrId + '.html'; }
  function openSearch(q) { window.location.href = form.getAttribute('action') + '?q=' + encodeURIComponent(q); }

  form.addEventListener('submit', function(e) {
    var q = input.value.trim();
    if (!q) { e.preventDefault(); return; }
    var hit = exactReceptor(q);
    if (hit) { e.preventDefault(); openReport(hit.gpcr_id); }
    // otherwise the form submits to search/?q=...
  });

  // clicking anywhere in the box focuses the field
  form.addEventListener('click', function(e) {
    if (e.target === form || (e.target.closest && e.target.closest('.search-icon, .search-kbd'))) input.focus();
  });

  var started = false;
  function startSuggest() {
    if (started || !base) return;
    started = true;
    import(base + 'search-ui/suggest.js').then(function(m) {
      var api = m.attachSuggest(input, {
        indexUrl: new URL(form.getAttribute('data-index'), document.baseURI).href,
        submit: function(q, item) {
          var hit = item && item.kind === 'receptor' ? exactReceptor(item.query) : null;
          if (hit) openReport(hit.gpcr_id); else openSearch(q);
        }
      });
      if (api && document.activeElement === input) api.update();
    }).catch(function() { started = false; });
  }
  input.addEventListener('focus', startSuggest);
  input.addEventListener('input', startSuggest);

  // "/" jumps to the search box
  document.addEventListener('keydown', function(e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)) return;
    e.preventDefault();
    input.focus();
  });
})();
