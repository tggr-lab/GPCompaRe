"""Segment order switch (2026-11-05): "Helices first" (TM1 to TM7 and H8, then the loops,
then the termini) is the default everywhere segments are listed or plotted; "Sequence"
follows the chain. One switch per display, all in step, remembered per visitor
(static/js/segment-order.js).

The approved report sections are reordered in the page only, so the build-level checks
here read the non-frozen summary, and tests/test_freeze.py guards the rest. Browser
checks skip without Playwright or a build (SMOKE_BUILD_DIR / FREEZE_BUILD_DIR, default
output_v3_demo).
"""
import re

import pytest

from .report_files import report_pages
from .test_report_v3 import (BLOCKED, BUILD_DIR, DESKTOP, PHONE, PLOTLY_JS, REPORTS_DIR,  # noqa: F401
                             _errors, _html, _pick, _summary_block, browser, needs_build,
                             needs_plotly, server)

HELIX = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']
HELICES_FIRST = HELIX + ['ICL1', 'ICL2', 'ICL3', 'ICL4', 'ECL1', 'ECL2', 'ECL3', 'N-term', 'C-term']
SEQUENCE = ['N-term', 'TM1', 'ICL1', 'TM2', 'ECL1', 'TM3', 'ICL2', 'TM4', 'ECL2', 'TM5',
            'ICL3', 'TM6', 'ECL3', 'TM7', 'ICL4', 'H8', 'C-term']
STATS = BUILD_DIR / 'statistics.html'
needs_stats = pytest.mark.skipif(not STATS.is_file(), reason='no statistics page at %s' % BUILD_DIR)


def _in(order, segs):
    return sorted(segs, key=order.index)


def _summary_segs(html):
    return re.findall(r'data-gpc-seg="([^"]+)"', _summary_block(html) or '')


# ---- the built pages -----------------------------------------------------------

@needs_build
def test_the_summary_is_built_helices_first_with_group_labels():
    pages = report_pages(REPORTS_DIR)
    assert pages
    for p in pages:
        html = p.read_text(encoding='utf-8')
        segs = _summary_segs(html)
        if not segs:
            continue
        assert segs == _in(HELICES_FIRST, segs), p.stem
        block = _summary_block(html)
        both = any(s in HELIX for s in segs) and any(s not in HELIX for s in segs)
        labels = re.findall(r'class="seg-order-label[^"]*" aria-hidden="true">([^<]+)<', block)
        assert labels == (['Helices', 'Loops and termini'] if both else []), p.stem
        assert 'data-seg-order-slot' in block
        assert '—' not in block


@needs_build
def test_the_switch_script_is_on_every_report_and_the_statistics_page():
    for p in report_pages(REPORTS_DIR):
        assert 'static/js/segment-order.js' in p.read_text(encoding='utf-8'), p.stem
    if STATS.is_file():
        html = STATS.read_text(encoding='utf-8')
        assert 'static/js/segment-order.js' in html and 'data-seg-order-slot' in html


# ---- the browser ---------------------------------------------------------------

@pytest.fixture
def open_page(browser, server):
    contexts = []

    def _open(path, viewport=DESKTOP, dark=False, init=None, ctx=None):
        if ctx is None:
            ctx = browser.new_context(viewport=viewport, color_scheme='dark' if dark else 'light')
            contexts.append(ctx)
        page = ctx.new_page()
        page.errors, page.console_errors = [], []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and page.console_errors.append(
            (m.text, (m.location or {}).get('url', ''))))
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.route('**/cdn.plot.ly/**', lambda route: route.fulfill(
            path=str(PLOTLY_JS), content_type='application/javascript'))
        if init:
            page.add_init_script(init)
        page.goto('%s/%s' % (server, path), wait_until='load')
        page.wait_for_timeout(300)
        return page

    yield _open
    for c in contexts:
        c.close()


# counts the real library's newPlot calls per chart (the lazy stand-in is left alone)
COUNT_DRAWS = """(() => {
  window.__draws = {}; var real;
  Object.defineProperty(window, 'Plotly', { configurable: true, get: function () { return real; }, set: function (v) {
    if (v && v.version && v.newPlot && !v.__counted) {
      var np = v.newPlot;
      v.newPlot = function (gd) { var id = typeof gd === 'string' ? gd : gd && gd.id;
        window.__draws[id] = (window.__draws[id] || 0) + 1; return np.apply(this, arguments); };
      v.__counted = true;
    }
    real = v;
  } });
})()"""


def _page_summary(page):
    return page.evaluate("[].map.call(document.querySelectorAll('#sec-summary .gpc-segs > li[data-gpc-seg]'), li => li.dataset.gpcSeg)")


def _page_labels(page):
    return page.evaluate("[].map.call(document.querySelectorAll('#sec-summary .gpc-segs > .seg-order-label'), li => li.textContent)")


def _draw(page, chart_id):
    page.evaluate("id => document.getElementById(id).scrollIntoView()", chart_id)
    page.wait_for_function("id => { var e = document.getElementById(id); return e && e.dataset.chartRendered && e._fullLayout; }",
                           arg=chart_id, timeout=15000)
    page.wait_for_timeout(200)


def _xcats(page, chart_id, axis='xaxis'):
    return page.evaluate("""([id, ax]) => { var gd = document.getElementById(id), a = gd._fullLayout[ax];
      return {order: a.categoryorder, cats: a._categories.slice(), arr: (a.categoryarray || []).slice()}; }""",
                         [chart_id, axis])


def _legend(page, chart_id):
    """Legend texts top to bottom as drawn: group titles and entries."""
    return page.evaluate("""id => [].map.call(document.querySelectorAll('#' + id + ' .legend .groups .legendtext'),
      t => t.textContent.trim()).filter(Boolean)""", chart_id)


def _flip(page, mode):
    page.locator('.seg-order button[data-seg-order-mode="%s"]' % mode).first.click()
    page.wait_for_timeout(300)


def _no_overflow(page):
    return page.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1")


@needs_build
@needs_plotly
def test_report_default_is_helices_first_and_the_switch_flips_everything_and_persists(open_page):
    gid = _pick('class="seg-order-label', prefer='adrb2_human')
    assert gid, 'no report with both helices and loops in its summary'
    page = open_page('reports/%s.html' % gid, init=COUNT_DRAWS)
    segs = _page_summary(page)
    assert segs == _in(HELICES_FIRST, segs) and segs != _in(SEQUENCE, segs)
    assert _page_labels(page) == ['Helices', 'Loops and termini']
    assert page.evaluate("document.documentElement.dataset.segOrder") == 'helices'
    assert page.evaluate("[].map.call(document.querySelectorAll('#sec-summary .seg-order button'), b => b.getAttribute('aria-pressed'))") == ['true', 'false']
    # the TM table (approved section): rows in helix order, marked by the script
    rows = page.evaluate("[].map.call(document.querySelectorAll('#tm-summary-table tbody tr'), r => r.cells[0].textContent.trim())")
    assert rows == _in(HELICES_FIRST, rows)
    assert page.evaluate("document.getElementById('tm-summary-table').dataset.segOrder") == 'helices'
    # the TM bar chart: drawn once, with the category order in place
    _draw(page, 'tm-breakdown-chart')
    x = _xcats(page, 'tm-breakdown-chart')
    assert x['order'] == 'array' and x['arr'] == _in(HELICES_FIRST, x['arr'])

    _flip(page, 'sequence')
    segs2 = _page_summary(page)
    assert segs2 == _in(SEQUENCE, segs) and _page_labels(page) == []
    assert page.evaluate("document.getElementById('tm-summary-table').dataset.segOrder") == 'sequence'
    x2 = _xcats(page, 'tm-breakdown-chart')
    assert x2['arr'] == _in(SEQUENCE, x['arr'])
    assert page.evaluate("[].map.call(document.querySelectorAll('#sec-summary .seg-order button'), b => b.getAttribute('aria-pressed'))") == ['false', 'true']
    assert page.evaluate("localStorage.getItem('gpc-segment-order')") == 'sequence'
    assert page.evaluate("window.__draws['tm-breakdown-chart']") == 1, 'the chart is drawn once; the switch relayouts it'

    page.reload(wait_until='load')
    page.wait_for_timeout(300)
    assert _page_summary(page) == _in(SEQUENCE, segs)
    _flip(page, 'helices')
    assert _page_summary(page) == segs and _page_labels(page) == ['Helices', 'Loops and termini']
    # the Studio's convention on the shared origin: no key for the default
    assert page.evaluate("localStorage.getItem('gpc-segment-order')") is None
    assert _errors(page) == []


@needs_build
@needs_plotly
def test_a_choice_in_another_tab_is_followed(open_page, browser):
    gid = _pick('class="seg-order-label', prefer='adrb2_human')
    ctx = browser.new_context(viewport=DESKTOP)
    try:
        a = open_page('reports/%s.html' % gid, ctx=ctx)
        b = open_page('reports/%s.html' % gid, ctx=ctx)
        segs = _page_summary(b)
        _flip(a, 'sequence')
        b.wait_for_function("document.documentElement.dataset.segOrder === 'sequence'", timeout=5000)
        assert _page_summary(b) == _in(SEQUENCE, segs)
        assert b.evaluate("document.querySelector('#sec-summary .seg-order button[data-seg-order-mode=sequence]').getAttribute('aria-pressed')") == 'true'
        # the Studio writes the same key and values
        a.evaluate("localStorage.removeItem('gpc-segment-order')")
        b.wait_for_function("document.documentElement.dataset.segOrder === 'helices'", timeout=5000)
        assert _page_summary(b) == segs
        assert _errors(a) == [] and _errors(b) == []
    finally:
        ctx.close()


@needs_build
@needs_plotly
def test_the_residue_table_sorts_by_segment_in_the_chosen_order_and_other_sorts_still_work(open_page):
    gid = _pick('id="rx-residues"', prefer='adrb2_human')
    if not gid:
        pytest.skip('no report with the residue table')
    page = open_page('reports/%s.html#sec=sec-residues' % gid)
    page.wait_for_selector('#rx-residue-table tbody tr')
    ctl = page.locator('#rx-residues-mount .seg-order')
    assert ctl.count() == 1

    def segs():
        return page.evaluate("[].map.call(document.querySelectorAll('#rx-residue-table tbody tr'), r => r.cells[2].textContent.trim())")

    def positions():
        return page.evaluate("[].map.call(document.querySelectorAll('#rx-residue-table tbody tr'), r => parseInt(r.cells[0].textContent.replace(/\\D/g, ''), 10))")

    assert positions() == sorted(positions()), 'default order is by position'
    page.locator('#rx-residue-table th[data-key="seg"] button').click()
    s = [x for x in segs() if x != '-']
    assert s == _in(HELICES_FIRST, s)
    assert s[0] == 'TM1'
    # the switch in the table's own toolbar flips the table and the summary together
    ctl.locator('button[data-seg-order-mode="sequence"]').click()
    page.wait_for_timeout(200)
    s2 = [x for x in segs() if x != '-']
    assert s2 == _in(SEQUENCE, s2)
    assert _page_summary(page) == _in(SEQUENCE, _page_summary(page))
    # descending reverses the segment order
    page.locator('#rx-residue-table th[data-key="seg"] button').click()
    s3 = [x for x in segs() if x != '-']
    assert s3 == list(reversed(_in(SEQUENCE, s3))) or s3 == sorted(s3, key=lambda v: -SEQUENCE.index(v))
    # another column still sorts numerically
    page.locator('#rx-residue-table th[data-key="max"] button').click()
    vals = page.evaluate("[].map.call(document.querySelectorAll('#rx-residue-table tbody tr'), r => parseFloat(r.cells[4].textContent))")
    assert vals == sorted(vals, reverse=True)
    assert _errors(page) == []


@needs_build
@needs_plotly
@needs_stats
def test_statistics_page_default_is_helices_first_and_the_switch_flips_the_legend(open_page):
    page = open_page('statistics.html', init=COUNT_DRAWS)
    assert page.locator('.seg-order').count() == 1
    _draw(page, 'chart-cfr-dotplot')
    names = _legend(page, 'chart-cfr-dotplot')
    segs = [n for n in names if n in SEQUENCE]
    assert segs and segs == _in(HELICES_FIRST, segs)
    if any(s not in HELIX for s in segs) and any(s in HELIX for s in segs):
        first_rest = next(s for s in segs if s not in HELIX)
        assert names[0] == 'Helices'
        assert names[names.index(first_rest) - 1] == 'Loops and termini'
        assert [n for n in names if n not in SEQUENCE] == ['Helices', 'Loops and termini']
        # a click on an entry still hides only that entry
        assert page.evaluate("document.getElementById('chart-cfr-dotplot')._fullLayout.legend.groupclick") == 'toggleitem'
    # 2026-11-06: the helix-pair atlas (site layer, all segments view) replaced the unsigned heatmap
    page.locator('#card-chart-helix-pairs [data-chips="segments"] [data-value="all"]').click()
    _draw(page, 'chart-helix-pairs')
    hx = _xcats(page, 'chart-helix-pairs')
    hy = _xcats(page, 'chart-helix-pairs', 'yaxis')
    assert hx['arr'] == _in(HELICES_FIRST, hx['arr']) and hy['arr'] == _in(HELICES_FIRST, hy['arr'])

    _flip(page, 'sequence')
    names2 = _legend(page, 'chart-cfr-dotplot')
    assert names2 == _in(SEQUENCE, segs), 'sequence order, no group titles'
    draws = page.evaluate("window.__draws")
    hx2 = _xcats(page, 'chart-helix-pairs')
    assert hx2['arr'] == _in(SEQUENCE, hx2['arr'])
    assert draws.get('chart-cfr-dotplot') == 1 and draws.get('chart-helix-pairs') == 1, draws
    # the choice made on the statistics page holds on a report too (one switch, site-wide)
    gid = _pick('class="seg-order-label', prefer='adrb2_human')
    if gid:
        page.goto(page.url.replace('statistics.html', 'reports/%s.html' % gid), wait_until='load')
        page.wait_for_timeout(300)
        segs_r = _page_summary(page)
        assert segs_r == _in(SEQUENCE, segs_r)
    assert _errors(page) == []


@needs_build
@needs_plotly
def test_without_storage_the_page_still_renders_helices_first(open_page):
    gid = _pick('class="seg-order-label', prefer='adrb2_human') or _pick()
    block = "Object.defineProperty(window, 'localStorage', {get: function () { throw new Error('blocked'); }});"
    page = open_page('reports/%s.html' % gid, init=block)
    segs = _page_summary(page)
    assert segs == _in(HELICES_FIRST, segs)
    _flip(page, 'sequence')
    assert _page_summary(page) == _in(SEQUENCE, segs)
    assert page.errors == []


@needs_build
@needs_plotly
@pytest.mark.parametrize('dark', [False, True])
def test_phone_width_has_no_horizontal_overflow(open_page, dark):
    gid = _pick('class="seg-order-label', prefer='adrb2_human') or _pick()
    page = open_page('reports/%s.html' % gid, viewport=PHONE, dark=dark)
    assert page.locator('#sec-summary .seg-order').is_visible()
    assert _no_overflow(page)
    _flip(page, 'sequence')
    assert _no_overflow(page)
    if STATS.is_file():
        page = open_page('statistics.html', viewport=PHONE, dark=dark)
        assert _no_overflow(page)
        assert _errors(page) == []
