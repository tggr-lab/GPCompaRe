/* search-box.js: lazy autocomplete for the search boxes in the top bar and the menu drawer.
   Loaded on every page. It does nothing until the reader focuses or types in a box; only then
   does it load the suggestion module and the receptor-name index (one small file). The forms
   work without it: they submit to the search page. */
(function () {
  'use strict';
  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/search-box\.js(\?.*)?$/, '') : null;
  if (!base) return;

  function wire(form) {
    var input = form.querySelector('input[type="search"]');
    if (!input) return;
    var started = false;
    function start() {
      if (started) return;
      started = true;
      import(base + 'search-ui/suggest.js').then(function (m) {
        var api = m.attachSuggest(input, { indexUrl: new URL(form.getAttribute('data-search-index'), document.baseURI).href });
        if (api && document.activeElement === input) api.update();
      }).catch(function () { started = false; });
    }
    input.addEventListener('focus', start);
    input.addEventListener('input', start);
  }

  document.querySelectorAll('form[data-search-index]').forEach(wire);
})();
