/* report-fineprint.js: the approved prose of the report sections moves into fine print.

   The text inside every <section class="report-section"> is approved and is built
   unchanged. This moves (not copies, not rewords) each section's explanatory callout or
   subtitle into a collapsed <details class="fine-print"> placed under the section heading,
   so the plot or table is the first thing under its title and the explanation is one
   click away. The Methods section folds the same way; a link to it (the section menu or
   #sec=sec-methods) opens it. Nothing happens without JavaScript, and the markup of the
   built page is untouched. */
(function () {
  'use strict';

  // section id, what to move (direct descendants of the section or of its header), label
  var MOVES = [
    ['sec-snake', '.callout', 'About this plot'],
    ['sec-changes', '.section-sub', 'About this table'],
    ['sec-tm', '.callout', 'About this table'],
    ['sec-variants', '.section-sub', 'About this table'],
    ['sec-rrcs', '.section-sub', 'About this table'],
    ['sec-methods', '.callout', 'Show methods']
  ];

  function fold(secId, selector, label) {
    var sec = document.getElementById(secId);
    if (!sec) return;
    var nodes = Array.prototype.filter.call(sec.querySelectorAll(selector), function (n) {
      var p = n.parentNode;
      return (p === sec || (p.classList && p.classList.contains('report-section-head') && p.parentNode === sec)) && !n.closest('.gpc-fine');
    });
    if (!nodes.length) return;
    var details = document.createElement('details');
    details.className = 'fine-print gpc-fine';
    details.id = secId + '-about';
    var summary = document.createElement('summary');
    summary.textContent = label;
    details.appendChild(summary);
    nodes.forEach(function (n) { details.appendChild(n); });
    var head = sec.querySelector('.report-section-head');
    if (head && head.parentNode === sec) head.insertAdjacentElement('afterend', details);
    else sec.insertBefore(details, sec.firstChild);
  }

  function openFor(secId) {
    var d = document.getElementById(secId + '-about');
    if (d) d.open = true;
  }
  function openFromHash() {
    var h = window.location.hash || '';
    var m = /(?:^#|&)sec=([\w-]+)(?:&|$)/.exec(h);
    if ((m && m[1] === 'sec-methods') || h === '#sec-methods') openFor('sec-methods');
  }

  MOVES.forEach(function (m) { fold(m[0], m[1], m[2]); });
  document.documentElement.classList.add('gpc-fine-on');

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('.v3-secnav a, a[href="#sec-methods"]') : null;
    if (a && (a.dataset.target === 'sec-methods' || a.getAttribute('href') === '#sec-methods')) openFor('sec-methods');
  });
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
})();
