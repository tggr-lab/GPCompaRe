/* v3-nav.js: sticky section nav for report pages.
   Builds itself from [data-section-title] (report sections) and [data-nav-title] (opt-in blocks), so adding a section needs no JS change.
   Navigation is wayfinding, not content: this is always on. */
(function () {
  'use strict';
  var V3Nav = (window.V3Nav = window.V3Nav || {});

  function build() {
    buildCompactToggle();
    // The approved report sections, plus the opt-in blocks that name themselves with
    // data-nav-title (3D view, ClinVar). A link only scrolls: nothing is opened or loaded.
    var sections = Array.prototype.slice.call(document.querySelectorAll(
      '.report-section[data-section-title], .report-extra[data-nav-title]'));
    if (sections.length < 2) return;
    function titleOf(sec) { return sec.dataset.sectionTitle || sec.dataset.navTitle; }

    var nav = document.createElement('nav');
    nav.className = 'v3-secnav';
    nav.setAttribute('aria-label', 'Report sections');
    var list = document.createElement('div');
    list.className = 'v3-secnav-list';
    nav.appendChild(list);

    var links = [];
    sections.forEach(function (sec) {
      var a = document.createElement('a');
      a.href = '#' + sec.id;
      a.textContent = titleOf(sec);
      a.dataset.target = sec.id;
      list.appendChild(a);
      links.push(a);
    });

    var host = document.querySelector('.report-page .section-inner');
    var anchor = document.querySelector('.report-stats');
    if (!host || !anchor) return;
    anchor.parentNode.insertBefore(nav, anchor.nextSibling);

    // The current section is the last one whose top has reached the line just under the
    // sticky chrome. (An intersection band picked the first section it touched, which
    // kept "Snake plot" lit while the short 3D block above the next table was on screen.)
    var ticking = false;
    function update() {
      ticking = false;
      var line = nav.getBoundingClientRect().bottom + 48;
      var activeId = null;
      sections.forEach(function (sec) {
        if (sec.getBoundingClientRect().top <= line) activeId = sec.id;
      });
      links.forEach(function (a) {
        a.classList.toggle('on', a.dataset.target === activeId);
        if (a.dataset.target === activeId) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
      // keep the lit link visible in the sideways-scrolling pill row (phones)
      var on = list.querySelector('a.on');
      if (on) {
        var lo = on.offsetLeft - list.offsetLeft, hi = lo + on.offsetWidth;
        if (lo < list.scrollLeft + 8) list.scrollLeft = Math.max(0, lo - 16);
        else if (hi > list.scrollLeft + list.clientWidth - 8) list.scrollLeft = hi - list.clientWidth + 16;
      }
    }
    function schedule() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('load', schedule);
    document.addEventListener('toggle', schedule, true);
    update();
  }

  var COMPACT_KEY = 'gpcompare-compact';

  function readFlag(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }
  function writeFlag(key, on) {
    try { on ? localStorage.setItem(key, '1') : localStorage.removeItem(key); } catch (e) {}
  }
  V3Nav.readFlag = readFlag;
  V3Nav.writeFlag = writeFlag;

  function ensureToolbar() {
    var existing = document.querySelector('.v3-toolbar');
    if (existing) return existing;
    var anchor = document.querySelector('.report-stats');
    if (!anchor) return null;
    var bar = document.createElement('div');
    bar.className = 'v3-toolbar';
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    return bar;
  }
  V3Nav.ensureToolbar = ensureToolbar;

  function applyCompact(on) {
    document.querySelectorAll('.report-section[data-section-title]').forEach(function (sec) {
      // Only fold sections that have a .report-section-head to reopen them with.
      // sec-understanding has no such head, it collapses through its own
      // .collapsible control instead, so it is already compact and folding it
      // here would hide it with no way back. Turning compact off still clears
      // v3-folded from every section below, so nothing can be left stranded.
      if (on && !sec.querySelector('.report-section-head')) return;
      sec.classList.toggle('v3-folded', on);
    });
  }

  function buildCompactToggle() {
    var bar = ensureToolbar();
    if (!bar) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm v3-toggle';
    btn.id = 'v3-compact-toggle';
    var on = readFlag(COMPACT_KEY);
    function paint() {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('on', on);
      btn.textContent = on ? 'Compact view: on' : 'Compact view';
    }
    btn.addEventListener('click', function () {
      on = !on;
      writeFlag(COMPACT_KEY, on);
      applyCompact(on);
      paint();
    });
    bar.appendChild(btn);
    paint();
    applyCompact(on);
  }

  document.addEventListener('click', function (ev) {
    var head = ev.target.closest ? ev.target.closest('.report-section.v3-folded .report-section-head') : null;
    if (!head) return;
    head.parentNode.classList.remove('v3-folded');
  });

  V3Nav.build = build;
  document.addEventListener('DOMContentLoaded', build);
})();
