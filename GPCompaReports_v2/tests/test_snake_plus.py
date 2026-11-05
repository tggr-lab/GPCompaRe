"""Browser tests for the snake plot enhancement layer (static/js/snake-plus.js).

The layer upgrades the approved snake plot at run time: contact arcs from the page's own
above-threshold pairs, hover fan-out, selection through the shared event bus, an
inactive -> active scrubber, helix labels, a rewiring grid, motifs, a ring layer, keyboard
navigation, zoom and pan with a minimap, and export. The built HTML of the plot must stay
what it was: the layer lives in two static files and one include line each.

Running them
------------
Playwright lives in the project venv, so the ordinary suite skips these:

    ../.venv-test/bin/python -m pytest tests/test_snake_plus.py

Point them at a build with SNAKE_BUILD_DIR (default: output_v3_demo). A build whose report
template does not yet include snake-plus.js is fine: the test adds the stylesheet and the
script to the page after load, which exercises the same lazy start.

SNAKE_BASELINE_DIR (optional) names an earlier build of the same receptors (for example the
release candidate stage); the snake section of every report is then compared byte for byte.
"""
import functools
import http.server
import os
import pathlib
import re
import socketserver
import threading

import pytest

from .report_files import report_pages

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter; run from the project venv')

from playwright.sync_api import expect, sync_playwright  # noqa: E402

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('SNAKE_BUILD_DIR')
BUILD_DIR = (pathlib.Path(_env).expanduser() if _env else BASE / 'output_v3_demo')
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR
REPORTS_DIR = BUILD_DIR / 'reports'
_base = os.environ.get('SNAKE_BASELINE_DIR')
BASELINE_DIR = pathlib.Path(_base).expanduser() if _base else None

BLOCKED = ('**cdn.plot.ly/**', '**gc.zgo.at/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**')
DESKTOP = {'width': 1280, 'height': 900}
PHONE = {'width': 390, 'height': 844}
SETTLE_MS = 500

SECTION_RE = re.compile(r'<section class="report-section" id="sec-snake"[^>]*>(.*?)</section>', re.S)
SVG_RE = re.compile(r'<div id="snake-plot-container">\s*(<svg.*?</svg>)', re.S)


def _pages():
    if not REPORTS_DIR.is_dir():
        return []
    return [p.stem for p in report_pages(REPORTS_DIR) if 'id="sec-snake"' in p.read_text(encoding='utf-8')]


PAGES = _pages()
# one receptor for the interaction tests, never the PAR2 report
MAIN = next((p for p in ('adrb2_human', 'opsd_human', 'gpr3_human') if p in PAGES), PAGES[0] if PAGES else None)

pytestmark = pytest.mark.skipif(not PAGES, reason='no built reports with a snake plot at %s; set SNAKE_BUILD_DIR' % REPORTS_DIR)


# --------------------------------------------------------------------------
# the built HTML
# --------------------------------------------------------------------------

@pytest.mark.parametrize('gid', PAGES)
def test_built_section_carries_no_layer_markup(gid):
    """The layer is run-time only: nothing of it is in the approved section of the built page."""
    html = (REPORTS_DIR / (gid + '.html')).read_text(encoding='utf-8')
    m = SECTION_RE.search(html)
    assert m, 'no snake section in ' + gid
    body = m.group(1)
    assert 'sp-' not in body and 'snake-plus' not in body
    assert 'id="sp-' not in body


@pytest.mark.skipif(BASELINE_DIR is None, reason='set SNAKE_BASELINE_DIR to compare the snake SVG with an earlier build')
@pytest.mark.parametrize('gid', PAGES)
def test_built_snake_svg_is_byte_identical_to_baseline(gid):
    here = REPORTS_DIR / (gid + '.html')
    there = BASELINE_DIR / 'reports' / (gid + '.html')
    if not there.exists():
        pytest.skip('no baseline report for ' + gid)
    a = SVG_RE.search(here.read_text(encoding='utf-8'))
    b = SVG_RE.search(there.read_text(encoding='utf-8'))
    assert a and b
    assert a.group(1) == b.group(1)


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

@pytest.fixture(scope='session')
def server():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(BUILD_DIR))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d' % httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope='session')
def browser(playwright_session):
    exe = os.environ.get('SNAKE_CHROMIUM')
    b = playwright_session.chromium.launch(executable_path=exe) if exe else playwright_session.chromium.launch()
    yield b
    b.close()


@pytest.fixture
def open_report(browser, server):
    """Open a report with the layer loaded, scrolled (or not) to the snake plot.

    Console errors and page errors are collected; every test asserts there are none.
    """
    contexts = []

    def _open(gid, viewport=DESKTOP, theme='light', hash_='', scroll=True, touch=False):
        ctx = browser.new_context(viewport=viewport, color_scheme=theme, has_touch=touch)
        contexts.append(ctx)
        page = ctx.new_page()
        page.add_init_script("try{localStorage.setItem('gpcrsynth-theme','%s')}catch(e){}" % theme)
        errors = []
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'ERR_FAILED' not in m.text else None)
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.goto('%s/reports/%s.html%s' % (server, gid, hash_), wait_until='load')
        if not page.evaluate("!!document.querySelector('script[src$=\"snake-plus.js\"]')"):
            page.add_style_tag(url='%s/static/css/snake-plus.css' % server)
            page.add_script_tag(url='%s/static/js/snake-plus.js' % server)
        page.errors = errors
        if scroll:
            page.locator('#sec-snake').scroll_into_view_if_needed()
            page.wait_for_function("document.documentElement.getAttribute('data-snake-plus') === 'on'")
            page.wait_for_timeout(SETTLE_MS)
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


def state(page):
    return page.evaluate('window.SnakePlus.state()')


def expected_arcs(page):
    """Above-threshold rows of the RRCS table whose two residues are drawn (not in a collapsed loop)."""
    return page.evaluate("""() => {
      const vis = (pos) => { const c = document.querySelector('#snake-plot-container circle[id="' + pos + '"]');
        return !!c && getComputedStyle(c).display !== 'none'; };
      const seen = new Set();
      for (const tr of document.querySelectorAll('#rrcs-table tbody tr.significant-row')) {
        const a = parseInt(tr.cells[0].textContent, 10), b = parseInt(tr.cells[2].textContent, 10);
        const k = Math.min(a, b) + '-' + Math.max(a, b);
        if (vis(a) && vis(b)) seen.add(k);
      }
      return seen.size;
    }""")


# --------------------------------------------------------------------------
# start-up
# --------------------------------------------------------------------------

def test_chrome_is_eager_and_arcs_are_lazy(open_report):
    """The controls and the trimmed plot are in place at once (so nothing below the plot moves
    later); the arcs wait until the plot is near the viewport."""
    page = open_report(MAIN, viewport={'width': 1280, 'height': 600}, scroll=False)
    page.wait_for_timeout(SETTLE_MS)
    assert page.evaluate("document.documentElement.getAttribute('data-snake-plus')") == 'ready'
    assert page.evaluate("!!document.getElementById('sp-bar') && !!document.getElementById('sp-panels')")
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") == 0
    h_before = page.evaluate("document.getElementById('sec-snake').getBoundingClientRect().height")
    below_before = page.evaluate("document.getElementById('sec-snake').nextElementSibling.getBoundingClientRect().top + scrollY")
    page.locator('#sec-snake').scroll_into_view_if_needed()
    page.wait_for_function("document.documentElement.getAttribute('data-snake-plus') === 'on'")
    page.wait_for_timeout(SETTLE_MS)
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") > 0
    assert page.evaluate("document.getElementById('sec-snake').getBoundingClientRect().height") == h_before
    assert page.evaluate("document.getElementById('sec-snake').nextElementSibling.getBoundingClientRect().top + scrollY") == below_before
    assert not page.errors


def test_original_svg_nodes_are_kept(open_report):
    """Every residue circle keeps its id, position and class; only new groups are added."""
    page = open_report(MAIN, scroll=False)
    before = page.evaluate("Array.from(document.querySelectorAll('#snake-plot-container circle.rcircle, #snake-plot-container circle:not([class])')).filter(c => /^\\d+$/.test(c.id)).map(c => [c.id, c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('class')])")
    page.locator('#sec-snake').scroll_into_view_if_needed()
    page.wait_for_function("document.documentElement.getAttribute('data-snake-plus') === 'on'")
    after = page.evaluate("Array.from(document.querySelectorAll('#snake-plot-container circle.rcircle, #snake-plot-container circle:not([class])')).filter(c => /^\\d+$/.test(c.id)).map(c => [c.id, c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('class')])")
    assert [b for b in before if re.match(r'^\d+$', b[0])] == after
    assert not page.errors


@pytest.mark.parametrize('gid', PAGES)
def test_arcs_equal_the_above_threshold_contacts_on_the_page(open_report, gid):
    page = open_report(gid)
    s = state(page)
    assert s['inited'] and s['arcs']
    stat = page.evaluate("parseInt(document.querySelector('.report-stat-accent .report-stat-num').textContent, 10)")
    assert s['passing'] == stat
    drawn = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length")
    assert drawn == expected_arcs(page) == s['shown']
    assert drawn > 0
    # each arc has a direction class and a real width
    bad = page.evaluate("""Array.from(document.querySelectorAll('#sp-arcs .sp-arc')).filter(p =>
        !(p.classList.contains('is-active') || p.classList.contains('is-inactive')) || !(parseFloat(p.getAttribute('stroke-width')) > 0)).length""")
    assert bad == 0
    assert not page.errors


def test_plot_margins_are_trimmed_and_helix_labels_added(open_report):
    page = open_report(MAIN)
    vb = page.evaluate("document.querySelector('#snake-plot-container svg').viewBox.baseVal.height")
    assert vb < 700   # the SVG is built 925 tall with empty bands above and below the plot
    labels = page.evaluate("Array.from(document.querySelectorAll('#sp-labels .sp-helix-label text')).map(t => t.textContent)")
    assert labels[:7] == ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7']
    sides = page.evaluate("Array.from(document.querySelectorAll('#sp-labels .sp-side')).map(t => t.textContent)")
    assert sides == ['extracellular side', 'intracellular side']
    page.click('#sp-labels-btn')
    assert page.evaluate("getComputedStyle(document.getElementById('sp-labels')).display") == 'none'
    assert not page.errors


# --------------------------------------------------------------------------
# hover, selection, the event bus
# --------------------------------------------------------------------------

def residue_with_partners(page):
    return page.evaluate("""() => {
      const n = {};
      for (const p of document.querySelectorAll('#sp-arcs .sp-arc')) { n[p.dataset.a] = (n[p.dataset.a] || 0) + 1; n[p.dataset.b] = (n[p.dataset.b] || 0) + 1; }
      let best = null;
      for (const k in n) if (!best || n[k] > n[best]) best = k;
      return [parseInt(best, 10), n[best]];
    }""")


def test_hover_fans_out_the_partners(open_report):
    page = open_report(MAIN)
    pos, n = residue_with_partners(page)
    assert n >= 2
    # the residue letter sits over its circle, so aim the pointer at the circle's centre
    page.evaluate("document.querySelector('#snake-plot-container circle[id=\"%d\"]').scrollIntoView({block: 'center'})" % pos)
    box = page.locator('#snake-plot-container circle[id="%d"]' % pos).bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.wait_for_timeout(200)
    assert page.evaluate("document.querySelector('#snake-plot-container svg').classList.contains('sp-focus')")
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-hot').length") == n
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-partner').length") == n
    page.mouse.move(5, 5)
    page.wait_for_timeout(200)
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-hot').length") == 0
    assert not page.errors


def test_arc_click_selects_the_pair_on_the_bus(open_report):
    page = open_report(MAIN)
    page.evaluate("""window.__pairs = []; document.addEventListener('gpc:select-pair', e => window.__pairs.push(e.detail));
                     window.__hover = []; document.addEventListener('gpc:hover-pair', e => window.__hover.push(e.detail));""")
    a, b, d = page.evaluate("(() => { const p = document.querySelector('#sp-arcs .sp-arc'); return [parseInt(p.dataset.a,10), parseInt(p.dataset.b,10), parseFloat(p.dataset.delta)]; })()")
    page.evaluate("document.querySelector('#sp-arcs .sp-arc').dispatchEvent(new MouseEvent('mouseover', {bubbles: true}))")
    page.evaluate("document.querySelector('#sp-arcs .sp-arc').dispatchEvent(new MouseEvent('click', {bubbles: true}))")
    page.wait_for_timeout(200)
    pairs = page.evaluate('window.__pairs')
    assert pairs and pairs[-1]['a'] == a and pairs[-1]['b'] == b and pairs[-1]['source'] == 'snake'
    assert abs(pairs[-1]['delta'] - d) < 1e-6
    hover = page.evaluate('window.__hover')
    assert hover and hover[0]['a'] == a and hover[0]['b'] == b
    # the selection bar, the hash and the plot's own marks follow
    expect(page.locator('#gpc-selbar')).to_be_visible()
    assert page.evaluate('location.hash') .find('pair=%d-%d' % (a, b)) >= 0
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-sel').length") == 2
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-hot').length") == 1
    assert not page.errors


def test_bus_selection_from_a_table_marks_the_plot(open_report):
    page = open_report(MAIN)
    pos, n = residue_with_partners(page)
    page.evaluate("document.dispatchEvent(new CustomEvent('gpc:select-residue', {detail: {gid: '%s', res: %d, source: 'table'}}))" % (MAIN, pos))
    page.wait_for_timeout(200)
    assert page.evaluate("document.querySelector('#sp-marks .sp-sel').dataset.pos") == str(pos)
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-partner').length") == n
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-callout').length") == min(n, 8)
    # a hover from the 3D view marks a pair too
    a, b = page.evaluate("(() => { const p = document.querySelector('#sp-arcs .sp-arc'); return [parseInt(p.dataset.a,10), parseInt(p.dataset.b,10)]; })()")
    page.evaluate("document.dispatchEvent(new CustomEvent('gpc:hover-pair', {detail: {gid: '%s', a: %d, b: %d, source: '3d'}}))" % (MAIN, a, b))
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-hot').length") == 1
    page.evaluate("document.dispatchEvent(new CustomEvent('gpc:hover-pair', {detail: {gid: '%s', a: null, b: null, source: '3d'}}))" % MAIN)
    page.evaluate("document.dispatchEvent(new CustomEvent('gpc:select-residue', {detail: {gid: '%s', res: null, source: 'selbar'}}))" % MAIN)
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-sel').length") == 0
    # another receptor's events are ignored
    page.evaluate("document.dispatchEvent(new CustomEvent('gpc:select-residue', {detail: {gid: 'other_human', res: %d, source: 'table'}}))" % pos)
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-sel').length") == 0
    assert not page.errors


def test_pair_deep_link_is_marked_on_load(open_report):
    """A #pair= link starts the layer at once (no scrolling) and marks both residues."""
    first = open_report(MAIN)
    a, b = first.evaluate("(() => { const p = document.querySelector('#sp-arcs .sp-arc'); return [parseInt(p.dataset.a,10), parseInt(p.dataset.b,10)]; })()")
    page = open_report(MAIN, hash_='#pair=%d-%d' % (a, b), scroll=False)
    page.wait_for_function("document.documentElement.getAttribute('data-snake-plus') === 'on'")
    page.wait_for_timeout(SETTLE_MS)
    marks = page.evaluate("Array.from(document.querySelectorAll('#sp-marks .sp-sel')).map(m => parseInt(m.dataset.pos, 10))")
    assert sorted(marks) == sorted([a, b])
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-hot').length") == 1
    assert not page.errors


# --------------------------------------------------------------------------
# views, rings, scrubber, grid, motifs
# --------------------------------------------------------------------------

def test_view_switch_keeps_the_layer_and_ring_adds_a_second_one(open_report):
    page = open_report(MAIN)
    before = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length")
    page.click('.snake-btn[data-view="conservation"]')
    page.wait_for_timeout(100)
    assert page.evaluate("document.querySelector('.snake-btn.active').dataset.view") == 'conservation'
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") == before
    assert page.evaluate("document.querySelectorAll('#sp-labels .sp-helix-label').length") >= 7
    page.select_option('#sp-ring', 'cfr')
    page.wait_for_timeout(100)
    n_cfr = page.evaluate("Object.keys(JSON.parse(document.getElementById('snake-plot-data').textContent).views.cfr.colors).length")
    rings = page.evaluate("document.querySelectorAll('#sp-rings .sp-ring').length")
    assert 0 < rings <= n_cfr
    assert page.evaluate("document.querySelector('#sp-bar .sp-ring-legend').textContent").strip() != ''
    page.select_option('#sp-ring', 'none')
    assert page.evaluate("document.querySelectorAll('#sp-rings .sp-ring').length") == 0
    assert not page.errors


def test_state_scrubber(open_report):
    page = open_report(MAIN)
    assert page.evaluate("document.getElementById('sp-scrub').hidden")
    page.click('#sp-bar .sp-mode[data-mode="state"]')
    assert not page.evaluate("document.getElementById('sp-scrub').hidden")
    assert state(page)['mode'] == 'state' and state(page)['t'] == 0
    w0 = page.evaluate("Array.from(document.querySelectorAll('#sp-arcs .sp-arc')).map(p => parseFloat(p.getAttribute('stroke-width')))")
    absent0 = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-absent').length")
    page.evaluate("const s = document.getElementById('sp-state'); s.value = '100'; s.dispatchEvent(new Event('input', {bubbles: true}))")
    assert state(page)['t'] == 1
    w1 = page.evaluate("Array.from(document.querySelectorAll('#sp-arcs .sp-arc')).map(p => parseFloat(p.getAttribute('stroke-width')))")
    absent1 = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-absent').length")
    assert w0 != w1
    # a contact stronger in the active model is wider at the active end, and the other way round
    cmp = page.evaluate("""(w0) => Array.from(document.querySelectorAll('#sp-arcs .sp-arc')).map((p, i) => {
        const w1 = parseFloat(p.getAttribute('stroke-width')); const up = p.classList.contains('is-active');
        return up ? w1 >= w0[i] - 1e-6 : w1 <= w0[i] + 1e-6; })""", w0)
    assert all(cmp)
    assert absent0 + absent1 >= 0
    assert 'active model' in page.evaluate("document.querySelector('#sp-bar .sp-scrub-text').textContent")
    # play runs to the active end
    page.evaluate("window.SnakePlus.setState(0)")
    page.click('#sp-bar .sp-play')
    page.wait_for_function("window.SnakePlus.state().t >= 0.999", timeout=6000)
    page.click('#sp-bar .sp-mode[data-mode="delta"]')
    assert state(page)['mode'] == 'delta'
    assert not page.errors


def test_rewiring_grid_filters_the_arcs(open_report):
    page = open_report(MAIN)
    cells = page.evaluate("Array.from(document.querySelectorAll('#sp-grid .sp-cell')).map(b => [b.dataset.pair, parseInt(b.textContent, 10)])")
    assert cells
    total_in_grid = sum(n for _, n in cells)
    loops = page.evaluate("(() => { const b = document.querySelector('#sp-grid .sp-chip-loops'); return b ? parseInt(b.textContent, 10) : 0; })()")
    assert total_in_grid + loops == state(page)['passing']
    pair, n = max(cells, key=lambda c: c[1])
    page.click('#sp-grid .sp-cell[data-pair="%s"]' % pair)
    page.wait_for_timeout(100)
    shown = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length")
    assert 0 < shown <= n
    assert state(page)['segFilter'] == pair.split('|')
    page.click('#sp-grid .sp-cell[data-pair="%s"]' % pair)
    assert state(page)['segFilter'] is None
    assert not page.errors


def test_motif_chips_mark_generic_positions(open_report):
    page = open_report(MAIN)
    chips = page.evaluate("Array.from(document.querySelectorAll('#sp-motif-chips .sp-chip')).map(b => [b.dataset.motif, b.querySelector('.sp-chip-res').textContent])")
    names = dict(chips)
    assert 'dry' in names and 'npxxy' in names
    assert re.match(r'^[A-Z]\d+ [A-Z]\d+ [A-Z]\d+$', names['dry'])
    page.click('#sp-motif-chips .sp-chip[data-motif="dry"]')
    page.wait_for_timeout(100)
    assert page.evaluate("document.querySelectorAll('#sp-motifs .sp-motif').length") == 3
    tags = page.evaluate("Array.from(document.querySelectorAll('#sp-motifs .sp-motif-tag')).map(t => t.textContent)")
    assert tags == ['3.49', '3.50', '3.51']
    assert page.evaluate("document.querySelector('#snake-plot-container svg').classList.contains('sp-dim')")
    page.click('#sp-motif-chips .sp-chip[data-motif="dry"]')
    assert page.evaluate("document.querySelectorAll('#sp-motifs .sp-motif').length") == 0
    assert not page.errors


def _carries_xmy(gid):
    """Met at 3.36 and Tyr at 3.37 in the page's own snake plot titles ('M120 3.36x36')."""
    html = (REPORTS_DIR / (gid + '.html')).read_text(encoding='utf-8')
    def aa(bw):
        m = re.search(r'<title>([A-Z])\d+ ' + re.escape(bw) + r'x\d+</title>', html)
        return m.group(1) if m else None
    return aa('3.36') == 'M' and aa('3.37') == 'Y'


# an xMY receptor for the chip test, never the PAR2 report
XMY = next((g for g in PAGES if g != 'par2_human' and _carries_xmy(g)), None)


@pytest.mark.skipif(XMY is None, reason='no xMY receptor (Met3.36, Tyr3.37) other than PAR2 in this build')
def test_xmy_chip_marks_the_motif_and_its_contacts(open_report):
    page = open_report(XMY)
    chip = page.locator('#sp-motif-chips .sp-chip[data-motif="xmy"]')
    assert chip.count() == 1
    assert chip.locator('b').inner_text() == 'xMY'
    res = chip.locator('.sp-chip-res').inner_text()
    assert re.match(r'^[A-Z]\d+ M\d+ Y\d+$', res), res
    assert '—' not in chip.inner_text() + (chip.get_attribute('title') or '')
    # the line under the chips links to the glossary entry
    more = page.locator('.sp-motif-more a')
    assert more.count() == 1 and more.get_attribute('href').endswith('glossary.html#xmy')
    chip.click()
    page.wait_for_timeout(100)
    assert chip.get_attribute('aria-pressed') == 'true'
    tags = page.evaluate("Array.from(document.querySelectorAll('#sp-motifs .sp-motif .sp-motif-tag')).map(t => t.textContent)")
    assert tags == ['3.35', '3.36', '3.37']
    # its contacts, where the page lists them: M3.36-Y3.37 and M3.36-6.48, coloured by sign
    pairs = page.evaluate("""Array.from(document.querySelectorAll('#sp-motifs .sp-motif-contact')).map(p =>
        [p.dataset.pair, p.classList.contains('is-active') ? 1 : (p.classList.contains('is-inactive') ? -1 : 0)])""")
    assert pairs, 'no xMY contact drawn'
    assert set(p for p, _ in pairs) <= {'3.36-3.37', '3.36-6.48'}
    assert all(sign != 0 for _, sign in pairs)
    deltas = chip.locator('.sp-chip-delta').all_inner_texts()
    assert len(deltas) == len(pairs)
    for (pair, sign), text in zip(pairs, deltas):
        assert text.startswith(pair + ' ') and (text.split(' ')[1].startswith('+') == (sign > 0)), (pair, text)
    if any(p == '3.36-6.48' for p, _ in pairs):
        partner = page.evaluate("Array.from(document.querySelectorAll('#sp-motifs .sp-motif-partner .sp-motif-tag')).map(t => t.textContent)")
        assert partner == ['6.48']
    chip.click()
    assert page.evaluate("document.querySelectorAll('#sp-motifs .sp-motif, #sp-motifs .sp-motif-contact').length") == 0
    assert not page.errors


@pytest.mark.skipif('adrb2_human' not in PAGES, reason='no ADRB2 report in this build')
def test_no_xmy_chip_on_a_receptor_without_met_and_tyr(open_report):
    assert not _carries_xmy('adrb2_human')     # ADRB2 has C3.35 V3.36 T3.37
    page = open_report('adrb2_human')
    assert page.locator('#sp-motif-chips .sp-chip[data-motif="dry"]').count() == 1
    assert page.locator('#sp-motif-chips .sp-chip[data-motif="xmy"]').count() == 0
    assert page.locator('.sp-motif-more').count() == 0
    assert not page.errors


def test_largest_changes_step_through_pairs(open_report):
    page = open_report(MAIN)
    page.evaluate("window.__pairs = []; document.addEventListener('gpc:select-pair', e => window.__pairs.push(e.detail))")
    page.click('#sp-bar .sp-step[aria-label="Next largest change"]')
    page.wait_for_timeout(100)
    first = page.evaluate("(() => { const p = Array.from(document.querySelectorAll('#sp-arcs .sp-arc')).sort((x, y) => Math.abs(y.dataset.delta) - Math.abs(x.dataset.delta))[0]; return [parseInt(p.dataset.a,10), parseInt(p.dataset.b,10)]; })()")
    pairs = page.evaluate('window.__pairs')
    assert pairs and [pairs[-1]['a'], pairs[-1]['b']] == first
    assert page.evaluate("document.querySelector('#sp-bar .sp-tour-n').textContent").startswith('1 of ')
    page.click('#sp-bar .sp-step[aria-label="Next largest change"]')
    assert page.evaluate("document.querySelector('#sp-bar .sp-tour-n').textContent").startswith('2 of ')
    assert not page.errors


# --------------------------------------------------------------------------
# the approved controls still work
# --------------------------------------------------------------------------

def test_legacy_checkbox_and_filters_drive_the_arcs(open_report):
    page = open_report(MAIN)
    assert page.evaluate("document.getElementById('snake-links-cb').checked")
    page.uncheck('#snake-links-cb')
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") == 0
    assert page.evaluate("window.SnakeAPI.getState().links") is False
    assert page.evaluate("document.getElementById('snake-filter-panel').hidden")
    page.check('#snake-links-cb')
    n_all = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length")
    assert n_all > 0
    page.click('.snake-dir-btn[data-dir="active"]')
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc.is-inactive').length") == 0
    assert page.evaluate("window.SnakeAPI.getState().dir") == 'active'
    page.click('#snake-filter-reset')
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") == n_all
    page.evaluate("window.SnakeAPI.setMagRange(%f, undefined)" % 1e9)
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") <= n_all
    assert 'of' in page.evaluate("document.getElementById('snake-filter-summary').textContent")
    assert not page.errors


def test_loop_toggle_adds_the_loop_contacts(open_report):
    page = open_report(MAIN)
    before = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length")
    page.evaluate("document.querySelector('#snake-plot-container text.segment').dispatchEvent(new MouseEvent('click', {bubbles: true}))")
    page.wait_for_timeout(200)
    after = page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length")
    assert after == expected_arcs(page) >= before
    assert not page.errors


# --------------------------------------------------------------------------
# keyboard, phone, dark, export
# --------------------------------------------------------------------------

def test_keyboard_moves_along_the_chain_and_selects(open_report):
    page = open_report(MAIN)
    page.focus('#snake-plot-container svg')
    page.keyboard.press('ArrowRight')
    page.keyboard.press('ArrowRight')
    live = page.evaluate("document.getElementById('sp-live').textContent")
    assert re.search(r'[A-Z][a-z]{2}\d+', live) and 'partner' in live
    kbd = page.evaluate("parseInt(document.querySelector('#sp-marks .sp-kbd').dataset.pos, 10)")
    page.keyboard.press('ArrowDown')
    kbd2 = page.evaluate("parseInt(document.querySelector('#sp-marks .sp-kbd').dataset.pos, 10)")
    assert kbd2 > kbd
    page.keyboard.press('Enter')
    page.wait_for_timeout(100)
    assert page.evaluate("window.GPCSelect.current().res") == kbd2
    assert page.evaluate("document.getElementById('sp-live').textContent").startswith('Selected ')
    # Escape steps back the way it does on the rest of the page: the keyboard cursor first,
    # then the selection bar (the selection stays), then the selection
    page.keyboard.press('Escape')
    page.wait_for_timeout(100)
    assert page.evaluate("document.querySelectorAll('#sp-marks .sp-kbd').length") == 0
    assert page.evaluate("window.GPCSelect.current().res") == kbd2
    page.keyboard.press('Escape')
    page.wait_for_timeout(100)
    assert page.evaluate("window.GPCSelect.current().res") == kbd2
    assert page.evaluate("document.getElementById('gpc-selbar').hidden")
    page.keyboard.press('Escape')
    page.wait_for_timeout(100)
    assert page.evaluate("window.GPCSelect.current().res") is None
    assert not page.errors


def test_phone_zoom_pan_and_minimap(open_report):
    page = open_report(MAIN, viewport=PHONE, touch=True)
    svg = page.locator('#snake-plot-container svg').first
    full = page.evaluate("document.querySelector('#snake-plot-container svg').viewBox.baseVal.width")
    assert page.evaluate("getComputedStyle(document.getElementById('sp-minimap')).display") == 'none'
    page.click('#sp-zoom button[aria-label="Zoom in"]')
    z1 = page.evaluate("(() => { const v = document.querySelector('#snake-plot-container svg').viewBox.baseVal; return {x: v.x, y: v.y, width: v.width, height: v.height}; })()")
    assert z1['width'] < full
    assert page.evaluate("getComputedStyle(document.getElementById('sp-minimap')).display") == 'block'
    assert page.evaluate("getComputedStyle(document.getElementById('snake-plot-container')).touchAction") == 'none'
    # drag to pan
    box = svg.bounding_box()
    page.mouse.move(box['x'] + box['width'] * 0.6, box['y'] + box['height'] * 0.5)
    page.mouse.down()
    page.mouse.move(box['x'] + box['width'] * 0.3, box['y'] + box['height'] * 0.5, steps=6)
    page.mouse.up()
    z2 = page.evaluate("(() => { const v = document.querySelector('#snake-plot-container svg').viewBox.baseVal; return {x: v.x, y: v.y, width: v.width, height: v.height}; })()")
    assert z2['x'] > z1['x']
    # the minimap pans too
    page.click('#sp-minimap', position={'x': 5, 'y': 5})
    z3 = page.evaluate("(() => { const v = document.querySelector('#snake-plot-container svg').viewBox.baseVal; return {x: v.x, y: v.y, width: v.width, height: v.height}; })()")
    assert z3['x'] < z2['x']
    page.click('#sp-zoom button[aria-label="Fit the whole plot"]')
    assert page.evaluate("document.querySelector('#snake-plot-container svg').viewBox.baseVal.width") == full
    assert page.evaluate("document.body.scrollWidth <= window.innerWidth")
    assert not page.errors


def test_dark_mode_inks_read_on_the_white_plate(open_report):
    page = open_report(MAIN, theme='dark')
    assert page.evaluate("document.documentElement.getAttribute('data-color-mode')") == 'dark'
    ink = page.evaluate("getComputedStyle(document.querySelector('#sp-arcs .sp-arc.is-active')).stroke")
    assert ink == 'rgb(185, 28, 28)'
    bg = page.evaluate("getComputedStyle(document.getElementById('snake-plot-container')).backgroundColor")
    assert bg == 'rgb(255, 255, 255)'
    assert page.evaluate("document.querySelectorAll('#sp-arcs .sp-arc').length") > 0
    assert not page.errors


def test_export_svg_and_png(open_report):
    page = open_report(MAIN)
    with page.expect_download() as dl:
        page.click('#sp-bar button[title^="Download the plot as it is shown now, as SVG"]')
    d = dl.value
    assert d.suggested_filename.endswith('.svg') and MAIN in d.suggested_filename
    text = pathlib.Path(d.path()).read_text(encoding='utf-8')
    assert text.startswith('<?xml') and '<svg' in text and 'sp-arc' in text and 'TM1' in text
    with page.expect_download(timeout=15000) as dl2:
        page.click('#sp-bar button[title^="Download the plot as it is shown now, as PNG"]')
    assert dl2.value.suggested_filename.endswith('.png')
    assert pathlib.Path(dl2.value.path()).stat().st_size > 1000
    assert not page.errors


@pytest.mark.parametrize('gid', PAGES)
def test_every_report_loads_the_layer_without_errors(open_report, gid):
    page = open_report(gid)
    assert state(page)['inited']
    assert page.evaluate("document.querySelectorAll('#sp-grid .sp-cell, #sp-grid .sp-chip-loops').length") > 0
    assert not page.errors
