/*
 * Glossary term tooltips.
 *
 * At load time this marks the first occurrence of each glossary term (data in
 * glossary-data.js, generated from website/glossary.py) inside headings, table
 * headers and legends, and gives it a plain-language tooltip. It only decorates
 * the live DOM: the HTML the site build writes is untouched, so the approved
 * report-section content (and its freeze hash) stays exactly as built.
 *
 * Accessibility: the trigger is focusable (or, when the term sits inside an
 * element that is already interactive, such as a sortable column header, that
 * element is used as the trigger), is linked to its tooltip by
 * aria-describedby, and the tooltip has role="tooltip". The tooltip shows on
 * hover and on keyboard focus, hides on Escape, and a tap toggles it on touch
 * screens. It is position:fixed and starts hidden, so nothing on the page moves.
 */
(function () {
  'use strict';
  var TERMS = window.GPC_GLOSSARY;
  if (!TERMS || !TERMS.length || !document.body) return;

  var SCOPE = 'h1, h2, h3, th, .report-stat-label, .browse-legend, .callout-head, ' +
              '.v2-table-toolbar > strong, .snake-filter-label, .release-list dt, [data-glossary-scope]';
  var SKIP = 'a, button, input, select, textarea, label, script, style, svg, .gloss-term, [data-glossary-skip]';
  var INTERACTIVE = 'th[data-sort], [role="button"]';

  var compiled = [];
  TERMS.forEach(function (t) {
    t.match.forEach(function (src) {
      try { compiled.push({ term: t, re: new RegExp(src), len: src.length }); } catch (e) { /* skip */ }
    });
  });
  // Longest pattern first, so "Total |ΔRRCS|" and "ΔRRCS" claim their text before "RRCS".
  compiled.sort(function (a, b) { return b.len - a.len; });

  function visible(el) { return el.getClientRects().length > 0; }

  function textNodes(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  var scopes = Array.prototype.filter.call(document.querySelectorAll(SCOPE), visible);
  var used = {};
  var tips = {};
  var open = null;
  var lastPointer = 'mouse';

  function tipFor(t) {
    if (tips[t.id]) return tips[t.id];
    var tip = document.createElement('div');
    tip.className = 'gloss-tip';
    tip.id = 'gloss-tip-' + t.id;
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    var strong = document.createElement('strong');
    strong.textContent = t.term + (t.full ? ' (' + t.full + ')' : '');
    tip.appendChild(strong);
    tip.appendChild(document.createTextNode(' ' + t.def));
    document.body.appendChild(tip);
    tips[t.id] = tip;
    return tip;
  }

  function place(tip, anchor) {
    var r = anchor.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var vh = window.innerHeight;
    tip.style.left = '0px';
    tip.style.top = '0px';
    var w = tip.offsetWidth, h = tip.offsetHeight;
    // The host's own CSS tooltip (data-tooltip) sits above it by default; go to the other side.
    var host = anchor.closest('[data-tooltip]');
    var hostBelow = host && host.getAttribute('data-tooltip-position') === 'bottom';
    var below = !hostBelow;
    if (below && r.bottom + 8 + h > vh && r.top - 8 - h > 0) below = false;
    if (!below && r.top - 8 - h < 0) below = true;
    var top = below ? r.bottom + 8 : r.top - 8 - h;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    tip.style.left = Math.round(Math.max(8, left)) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function show(trigger) {
    var tip = document.getElementById(trigger.getAttribute('data-gloss-tip'));
    if (!tip) return;
    if (open && open.tip !== tip) hide();
    tip.hidden = false;
    place(tip, trigger.querySelector('.gloss-term') || trigger);
    open = { tip: tip, trigger: trigger };
  }

  function hide() {
    if (!open) return;
    open.tip.hidden = true;
    open = null;
  }

  function wire(trigger) {
    trigger.addEventListener('mouseenter', function () { if (lastPointer !== 'touch') show(trigger); });
    trigger.addEventListener('mouseleave', function () { if (lastPointer !== 'touch') hide(); });
    trigger.addEventListener('focus', function () { if (lastPointer !== 'touch') show(trigger); });
    trigger.addEventListener('blur', function () { if (open && open.trigger === trigger) hide(); });
    trigger.addEventListener('click', function () {
      if (lastPointer !== 'touch') return;
      if (open && open.trigger === trigger) hide(); else show(trigger);
    });
  }

  function decorate(item, node, m) {
    var t = item.term;
    var tip = tipFor(t);
    var before = node.nodeValue.slice(0, m.index);
    var after = node.nodeValue.slice(m.index + m[0].length);
    var span = document.createElement('span');
    span.className = 'gloss-term';
    span.textContent = m[0];
    var parent = node.parentNode;
    if (before) parent.insertBefore(document.createTextNode(before), node);
    parent.insertBefore(span, node);
    if (after) parent.insertBefore(document.createTextNode(after), node);
    parent.removeChild(node);

    var host = span.parentElement.closest(INTERACTIVE);
    var trigger = host || span;
    if (trigger.hasAttribute('data-gloss-tip')) {
      // An interactive host already describes one term; do not stack a second.
      span.classList.add('gloss-term-passive');
      return;
    }
    if (!host) span.setAttribute('tabindex', '0');
    var described = trigger.getAttribute('aria-describedby');
    trigger.setAttribute('aria-describedby', (described ? described + ' ' : '') + tip.id);
    trigger.setAttribute('data-gloss-tip', tip.id);
    wire(trigger);
  }

  function run() {
    compiled.forEach(function (item) {
      if (used[item.term.id]) return;
      for (var s = 0; s < scopes.length; s++) {
        var nodes = textNodes(scopes[s]);
        for (var n = 0; n < nodes.length; n++) {
          var m = item.re.exec(nodes[n].nodeValue);
          if (m && m[0]) {
            decorate(item, nodes[n], m);
            used[item.term.id] = true;
            return;
          }
        }
      }
    });
  }

  document.addEventListener('keydown', function () { lastPointer = 'keyboard'; }, true);
  document.addEventListener('pointerdown', function (e) {
    lastPointer = e.pointerType || 'mouse';
    if (open && !open.trigger.contains(e.target)) hide();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide();
  });
  function follow() {
    if (open) place(open.tip, open.trigger.querySelector('.gloss-term') || open.trigger);
  }
  window.addEventListener('scroll', follow, { passive: true, capture: true });
  window.addEventListener('resize', follow);

  run();
})();
