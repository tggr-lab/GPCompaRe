/* v3-nav.js: sticky section nav for report pages.
   Builds itself from [data-section-title] (report sections) and [data-nav-title] (opt-in blocks), so adding a section needs no JS change.
   Navigation is wayfinding, not content: this is always on. */
(function () {
  'use strict';
  var V3Nav = (window.V3Nav = window.V3Nav || {});

  function build() {
    buildCompactToggle();
    // The approved report sections, plus the opt-in blocks that name themselves with
    // data-nav-title (3D view, ClinVar). A link scrolls (and opens its section if Compact view folded it); nothing is loaded.
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
    var anchor = navAnchor();
    if (!host || !anchor) return;
    anchor.parentNode.insertBefore(nav, anchor.nextSibling);
    buildExpandAll(nav);
    // a link that lands on a folded section (v3-deeplink.js scrolled before the fold) opens it
    revealHash(true);

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

  // The menu and the toolbar sit under the summary block when the page has one, else
  // under the stat cards.
  function navAnchor() {
    return document.getElementById('sec-summary') || document.querySelector('.report-stats');
  }

  function ensureToolbar() {
    var existing = document.querySelector('.v3-toolbar');
    if (existing) return existing;
    var anchor = navAnchor();
    if (!anchor) return null;
    var bar = document.createElement('div');
    bar.className = 'v3-toolbar';
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    return bar;
  }
  V3Nav.ensureToolbar = ensureToolbar;

  // ---------------------------------------------------------------- folding (Compact view)
  // Compact view folds every report section to its heading, and is remembered in this
  // browser. A folded section must never be a dead end, so while the view is on:
  //   - each section heading carries a real button (Show / Hide, keyboard operable);
  //   - a click anywhere on a folded heading opens it, as before;
  //   - the sticky section menu shows "Expand all" whenever anything is folded, and that
  //     also leaves Compact view, so the next visit opens unfolded;
  //   - following a link to a section (the section menu, #sec=..., #sec-..., a search
  //     landing, the selection bar's "show in table") opens the section it lands in.
  // With Compact view off none of this is drawn: the default page is unchanged.
  var compactOn = false;
  var paintCompact = function () {};
  var expandAllBtn = null;

  function foldables() {
    return Array.prototype.filter.call(
      document.querySelectorAll('.report-section[data-section-title]'),
      function (sec) { return !!headOf(sec); });
  }
  // Only sections with a .report-section-head of their own can fold. sec-understanding has
  // no such head (it collapses through its own .collapsible control), so folding it would
  // hide it with no way back.
  function headOf(sec) {
    for (var i = 0; i < sec.children.length; i++) {
      if (sec.children[i].classList.contains('report-section-head')) return sec.children[i];
    }
    return null;
  }

  function paintFoldBtn(btn, folded, title) {
    btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    btn.setAttribute('aria-label', (folded ? 'Show ' : 'Hide ') + title);
    btn.innerHTML = '<span class="v3-fold-icon" aria-hidden="true"></span>' + (folded ? 'Show' : 'Hide');
  }

  function ensureFoldBtn(sec) {
    var head = headOf(sec);
    if (!head) return null;
    var btn = head.querySelector('.v3-fold-btn');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm v3-fold-btn';
    btn.setAttribute('aria-controls', sec.id);
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setFolded(sec, !sec.classList.contains('v3-folded'));
    });
    head.classList.add('v3-foldable');
    head.appendChild(btn);
    return btn;
  }

  function dropFoldBtn(sec) {
    var head = headOf(sec);
    if (!head) return;
    var btn = head.querySelector('.v3-fold-btn');
    if (btn) btn.remove();
    head.classList.remove('v3-foldable');
  }

  // Charts drawn while their section was folded were laid out at Plotly's default width;
  // fit them to the section once it is open.
  function refit(sec) {
    window.requestAnimationFrame(function () {
      if (!window.Plotly || !window.Plotly.Plots) return;
      sec.querySelectorAll('.js-plotly-plot').forEach(function (el) {
        try { window.Plotly.Plots.resize(el); } catch (e) {}
      });
    });
  }

  function setFolded(sec, on) {
    var was = sec.classList.contains('v3-folded');
    sec.classList.toggle('v3-folded', on);
    var btn = headOf(sec) && headOf(sec).querySelector('.v3-fold-btn');
    if (btn) paintFoldBtn(btn, on, sec.dataset.sectionTitle || 'section');
    if (was && !on) refit(sec);
    syncExpandAll();
  }

  function syncExpandAll() {
    if (!expandAllBtn) return;
    expandAllBtn.hidden = !document.querySelector('.report-section.v3-folded');
  }

  function applyCompact(on) {
    foldables().forEach(function (sec) {
      if (on) ensureFoldBtn(sec); else dropFoldBtn(sec);
      setFolded(sec, on);
    });
    // Turning compact off also clears v3-folded from anything else, so nothing can be left
    // stranded whatever folded it.
    if (!on) document.querySelectorAll('.report-section.v3-folded').forEach(function (sec) { setFolded(sec, false); });
    syncExpandAll();
  }

  function setCompact(on) {
    compactOn = on;
    writeFlag(COMPACT_KEY, on);
    applyCompact(on);
    paintCompact();
  }

  function buildCompactToggle() {
    var bar = ensureToolbar();
    if (!bar) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm v3-toggle';
    btn.id = 'v3-compact-toggle';
    compactOn = readFlag(COMPACT_KEY);
    paintCompact = function () {
      btn.setAttribute('aria-pressed', compactOn ? 'true' : 'false');
      btn.classList.toggle('on', compactOn);
      btn.textContent = compactOn ? 'Compact view: on' : 'Compact view';
    };
    btn.addEventListener('click', function () { setCompact(!compactOn); });
    bar.appendChild(btn);
    paintCompact();
    applyCompact(compactOn);
  }

  // "Expand all" in the sticky section menu: always within reach while anything is folded.
  function buildExpandAll(nav) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'v3-secnav-expand';
    b.id = 'v3-expand-all';
    b.textContent = 'Expand all';
    b.title = 'Open every folded section (leaves Compact view)';
    b.hidden = true;
    b.addEventListener('click', function () {
      setCompact(false);
      var t = document.getElementById('v3-compact-toggle');
      if (t && document.activeElement === b) t.focus({ preventScroll: true });
    });
    nav.appendChild(b);
    expandAllBtn = b;
    syncExpandAll();
  }

  // ---------------------------------------------------------------- links open what they land on
  function reveal(node) {
    if (!node || !node.closest) return false;
    var sec = node.closest('.report-section.v3-folded');
    if (!sec) return false;
    setFolded(sec, false);
    return true;
  }
  V3Nav.reveal = reveal;
  V3Nav.expandAll = function () { setCompact(false); };

  // what the hash points at: {id, scroll} where scroll says the hash itself asks for a
  // scroll to that section (#sec=... or #sec-...), as against a residue landing (#res=...),
  // which v3-deeplink.js centres on the residue once the page has loaded
  function hashTarget() {
    var h = (window.location.hash || '').replace(/^#/, '');
    if (!h) return null;
    var m = /(?:^|&)sec=([\w-]+)(?:&|$)/.exec(h);
    if (m) return { id: m[1], scroll: true };
    if (/(?:^|&)(res|pair)=/.test(h)) return { id: 'sec-snake', scroll: false };
    if (/^[\w-]+$/.test(h)) return { id: h, scroll: true };
    return null;
  }
  function revealHash(rescroll) {
    var h = hashTarget();
    var t = h && document.getElementById(h.id);
    if (t && reveal(t) && rescroll && h.scroll) t.scrollIntoView();
  }

  // capture: open the target before the browser scrolls to it
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
    if (a) {
      var href = a.getAttribute('href').slice(1);
      var m = /(?:^|&)sec=([\w-]+)/.exec(href);
      var t = document.getElementById(m ? m[1] : href);
      if (t) reveal(t);
    }
  }, true);
  window.addEventListener('hashchange', function () { revealHash(false); });

  document.addEventListener('click', function (ev) {
    var head = ev.target.closest ? ev.target.closest('.report-section.v3-folded > .report-section-head') : null;
    if (!head) return;
    setFolded(head.parentNode, false);
  });

  V3Nav.build = build;
  document.addEventListener('DOMContentLoaded', build);
})();
