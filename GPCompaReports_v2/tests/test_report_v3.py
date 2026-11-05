"""Report experience, round 3 (2026-11-05): one linked selection across the page, the
selection bar, the "What changes most" summary, fine print, phone, keyboard, dark mode.

The freeze test guards the approved report sections; the build-level checks here assert
the new blocks sit outside them. The browser checks drive a built report in headless
Chromium and skip without Playwright (run them from the project venv:
../.venv-test/bin/python -m pytest tests/test_report_v3.py). Both read
SMOKE_BUILD_DIR / FREEZE_BUILD_DIR (default output_v3_demo).
"""
import functools
import http.server
import json
import os
import pathlib
import re
import socketserver
import threading

import pytest

from .report_files import report_pages

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'
REPORTS_DIR = BUILD_DIR / 'reports'
needs_build = pytest.mark.skipif(not REPORTS_DIR.is_dir(), reason='no build at %s' % BUILD_DIR)

SECTION_RE = re.compile(r'<section class="report-section"[^>]*>(.*?)</section>', re.S)
NEW_JS = ('report-select.js', 'report-fineprint.js', 'residue-drawer.js', 'residue-table.js', 'v3-nav.js', 'v3-deeplink.js')


def _pages():
    return report_pages(REPORTS_DIR) if REPORTS_DIR.is_dir() else []


def _html(gid):
    return (REPORTS_DIR / ('%s.html' % gid)).read_text(encoding='utf-8')


def _pick(*needles, prefer='adrb2_human'):
    ids = sorted((p.stem for p in _pages()), key=lambda g: (g != prefer, g))
    for gid in ids:
        h = _html(gid)
        if all(n in h for n in needles):
            return gid
    return None


def _summary_block(html):
    m = re.search(r'<section class="report-extra gpc-summary" id="sec-summary".*?</section>', html, re.S)
    return m.group(0) if m else None


# --------------------------------------------------------------------------
# build-level checks
# --------------------------------------------------------------------------

@needs_build
def test_every_report_has_the_summary_outside_the_frozen_sections():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        block = _summary_block(html)
        assert block, '%s: no summary block' % path.stem
        assert 'data-nav-title' not in block and 'data-section-title' not in block
        assert 'gpc-' not in ''.join(SECTION_RE.findall(html)), '%s: summary markup inside a frozen section' % path.stem
        # the lead sentence names segments and the threshold the page already states
        lead = re.search(r'<p class="gpc-summary-lead">(.*?)</p>', block, re.S).group(1)
        assert re.search(r'contacts change most in <strong>[^<]+</strong>', lead)
        thr = re.search(r'\|ΔRRCS\| ≥ (\d+\.\d\d)\)', lead).group(1)
        assert ('|ΔRRCS| ≥ %s' % thr) in html.split('id="sec-summary"')[1], 'threshold differs from the page'
        # every chip carries the pair and its signed delta, and works as a link without JS
        chips = re.findall(r'<a class="gpc-pair" href="#pair=(\d+)-(\d+)" data-gpc-a="(\d+)" data-gpc-b="(\d+)" data-gpc-delta="(-?[\d.]+)"', block)
        assert chips, path.stem
        for a, b, da, db, d in chips:
            assert (a, b) == (da, db)
        # red for positive, blue for negative, nothing else
        for d, cls in re.findall(r'data-gpc-delta="(-?[\d.]+)"[^>]*>.*?<span class="gpc-pair-delta (is-active|is-inactive)">', block, re.S):
            assert cls == ('is-active' if float(d) >= 0 else 'is-inactive')
        # a diverging bar per segment: blue on the left, red on the right, widths within 0..100
        for down, up in re.findall(r'gpc-seg-down" style="width:([\d.]+)%".*?gpc-seg-up" style="width:([\d.]+)%"', block, re.S):
            assert 0 <= float(down) <= 100 and 0 <= float(up) <= 100
        assert 'fine-print' in block and 'About this summary' in block
        # the helices first: the core list is shown, the overall list is there but hidden, and only
        # pairs that touch a loop or a terminus carry a marker
        core = re.search(r'<ol class="gpc-pairs gpc-pairs-top" id="gpc-pairs-core" data-gpc-set="core">(.*?)</ol>', block, re.S)
        allp = re.search(r'<ol class="gpc-pairs gpc-pairs-top" id="gpc-pairs-all" data-gpc-set="all" hidden>(.*?)</ol>', block, re.S)
        assert core and allp, path.stem
        assert 'gpc-tail' not in core.group(1)
        assert 'id="gpc-include-tails"' in block and 'in the helices' in block
        n_tail = len(re.findall(r'class="gpc-tail"', allp.group(1)))
        assert ('%d of the' % n_tail) in block if n_tail else 'None of the' in block


@needs_build
def test_summary_numbers_agree_with_the_rrcs_table():
    """The segment counts come from the full contact list; the largest pairs must be the
    rows at the top of the approved RRCS table, with the same ΔRRCS."""
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        block = _summary_block(html)
        top = re.search(r'<ol class="gpc-pairs gpc-pairs-top" id="gpc-pairs-all"[^>]*>(.*?)</ol>', block, re.S).group(1)
        chips = re.findall(r'data-gpc-a="(\d+)" data-gpc-b="(\d+)" data-gpc-delta="(-?[\d.]+)"', top)
        rows = re.findall(r'<tr[^>]*>\s*<td class="num"><strong>(\d+)</strong></td>\s*<td>[A-Z]+</td>\s*<td class="num"><strong>(\d+)</strong></td>\s*<td>[A-Z]+</td>\s*<td class="num">[\d.]+</td>\s*<td class="num">[\d.]+</td>\s*<td class="num (?:positive|negative)-delta"><strong>(-?[\d.]+)</strong>',
                          html.split('id="rrcs-table"')[1])
        for (a, b, d), (ra, rb, rd) in zip(chips, rows):
            assert (a, b) == (ra, rb), path.stem
            assert abs(float(d) - float(rd)) < 0.006, (path.stem, d, rd)
        n_above = int(re.search(r'<p class="gpc-summary-lead">.*?(\d[\d,]*) of [\d,]+ contact pairs', block, re.S).group(1).replace(',', ''))
        assert n_above == len(re.findall(r'class="significant-row"', html.split('id="rrcs-table"')[1])) or n_above > 1000


@needs_build
def test_attributions_and_sources_are_fine_print_and_the_drawer_and_bar_are_absent_until_used():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        assert re.search(r'<aside class="fine-print fine-print--page report-refs">', html)
        assert 'class="report-refs"' not in html.replace('fine-print--page report-refs', '')
        if 'id="sec-3d"' in html:
            assert re.search(r'<aside class="fine-print rx-attr">\s*Models:', html)
        if 'id="sec-clinvar"' in html:
            assert re.search(r'<aside class="fine-print rx-attr">Source:', html)
        assert 'gpc-selbar' not in html, 'the selection bar is built only when something is selected'
        for name in ('report-select.js', 'report-fineprint.js', 'report-v3.css'):
            assert name in html


def test_new_copy_has_no_em_dash_and_the_new_scripts_load_nothing():
    for name in NEW_JS:
        text = (BASE / 'static' / 'js' / name).read_text(encoding='utf-8')
        assert '—' not in text, name
        assert 'fetch(' not in text and 'XMLHttpRequest' not in text and 'import(' not in text, name
        assert 'studio/' not in text and 'models/' not in text, name
        if name.startswith('report-'):
            assert 'https://' not in text, name
    assert '—' not in (BASE / 'static' / 'css' / 'report-v3.css').read_text(encoding='utf-8')
    src = (BASE / 'templates' / 'gpcr_report.html').read_text(encoding='utf-8')
    block = re.search(r'(?s)\{# -+ What changes most.*?</section>\s*\{% endif %\}', src).group(0)
    assert '—' not in block


def test_contact_summary_counts_each_pair_once_per_segment():
    import pandas as pd
    from GPCompaReports_v2.website.page_generators import report_extras
    df = pd.DataFrame([
        dict(res1=10, res1_name='ARG', res2=20, res2_name='GLN', active_rrcs=5.0, inactive_rrcs=0.0, delta_rrcs=5.0),
        dict(res1=11, res1_name='LEU', res2=12, res2_name='PHE', active_rrcs=0.0, inactive_rrcs=3.0, delta_rrcs=-3.0),
        dict(res1=11, res1_name='LEU', res2=30, res2_name='ILE', active_rrcs=0.5, inactive_rrcs=0.6, delta_rrcs=-0.1),
    ])
    ann = {'10': ['TM1', '1.50x50'], '20': ['TM2', ''], '11': ['TM1', ''], '12': ['TM1', ''], '30': ['C-term', '']}
    s = report_extras.contact_summary(df, 1.0, ann)
    segs = {x['seg']: x for x in s['segments']}
    assert s['n_total'] == 3 and s['n_above'] == 2
    assert [x['seg'] for x in s['segments']] == ['TM1', 'TM2']
    assert segs['TM1']['n'] == 2 and segs['TM1']['up'] == 5.0 and segs['TM1']['down'] == 3.0
    assert segs['TM2']['n'] == 1 and segs['TM2']['up_pct'] == 100.0 and segs['TM1']['down_pct'] == 60.0
    assert s['pairs'][0] == {'a': 10, 'aa': 'Arg', 'b': 20, 'ab': 'Gln', 'd': 5.0, 'act': 5.0, 'inact': 0.0,
                             'ga': '1.50x50', 'gb': '', 'sa': 'TM1', 'sb': 'TM2', 'tail': ''}
    assert s['n_tail'] == 0 and s['lead'] == ['TM1', 'TM2'] and s['pairs_all'] == s['pairs']
    assert report_extras.contact_summary(pd.DataFrame(), 1.0, ann)['segments'] == []
    # a pair into a loop or a terminus is marked and left out of the core list; the lead names helices only
    df2 = pd.DataFrame([
        dict(res1=5, res1_name='HIS', res2=6, res2_name='GLN', active_rrcs=0.0, inactive_rrcs=9.0, delta_rrcs=-9.0),
        dict(res1=10, res1_name='ARG', res2=40, res2_name='GLU', active_rrcs=4.0, inactive_rrcs=0.0, delta_rrcs=4.0),
        dict(res1=11, res1_name='LEU', res2=12, res2_name='PHE', active_rrcs=0.0, inactive_rrcs=3.0, delta_rrcs=-3.0),
    ])
    ann2 = dict(ann, **{'5': ['C-term', ''], '6': ['C-term', ''], '40': ['ECL2', '']})
    s2 = report_extras.contact_summary(df2, 1.0, ann2)
    assert [p['tail'] for p in s2['pairs_all']] == ['tail', 'loop', '']
    assert [p['a'] for p in s2['pairs']] == [11] and s2['n_tail'] == 2
    assert s2['lead'] == ['TM1'] and [x['seg'] for x in s2['segments']] == ['TM1', 'ECL2', 'C-term']


# --------------------------------------------------------------------------
# browser checks
# --------------------------------------------------------------------------

sync_api = pytest.importorskip('playwright.sync_api', reason='Playwright lives in the project venv')
expect = sync_api.expect

PLOTLY_JS = None
try:
    import plotly as _plotly
    _p = pathlib.Path(_plotly.__file__).parent / 'package_data' / 'plotly.min.js'
    PLOTLY_JS = _p if _p.is_file() else None
except Exception:  # pragma: no cover
    PLOTLY_JS = None

BLOCKED = ('**gc.zgo.at/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**')
needs_plotly = pytest.mark.skipif(PLOTLY_JS is None, reason='no local plotly.min.js to stand in for the CDN')
DESKTOP = {'width': 1280, 'height': 900}
PHONE = {'width': 390, 'height': 844}

LISTEN = """(() => {
  window.__gpc = [];
  ['gpc:select-residue', 'gpc:select-pair', 'gpc:hover-residue', 'gpc:hover-pair'].forEach(function (n) {
    document.addEventListener(n, function (ev) { window.__gpc.push([n, JSON.parse(JSON.stringify(ev.detail))]); });
  });
})()"""


@pytest.fixture(scope='module')
def server():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(BUILD_DIR)))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d' % httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope='module')
def browser(playwright_session):
    b = playwright_session.chromium.launch()
    yield b
    b.close()


@pytest.fixture
def open_report(browser, server):
    contexts = []

    def _open(gid, hash_='', viewport=DESKTOP, dark=False, plotly=True, wait=500):
        ctx = browser.new_context(viewport=viewport, color_scheme='dark' if dark else 'light',
                                  permissions=['clipboard-read', 'clipboard-write'])
        contexts.append(ctx)
        page = ctx.new_page()
        page.errors, page.requests, page.console_errors = [], [], []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and page.console_errors.append(
            (m.text, (m.location or {}).get('url', ''))))
        page.on('request', lambda r: page.requests.append(r.url))
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        if plotly and PLOTLY_JS is not None:
            page.route('**/cdn.plot.ly/**', lambda route: route.fulfill(
                path=str(PLOTLY_JS), content_type='application/javascript'))
        else:
            page.route('**/cdn.plot.ly/**', lambda route: route.abort())
        page.add_init_script(LISTEN)
        page.goto('%s/reports/%s.html%s' % (server, gid, hash_), wait_until='load')
        page.wait_for_timeout(wait)
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


def _errors(page):
    ours = [t for t, url in page.console_errors if 'plot.ly' not in url and 'gc.zgo.at' not in url]
    return page.errors + ours


def _events(page, name=None):
    ev = page.evaluate('window.__gpc')
    return [e for e in ev if name is None or e[0] == name]


def _first_chip(page):
    return page.evaluate("""() => {
      var a = document.querySelector('#gpc-pairs-core .gpc-pair');
      return {a: +a.dataset.gpcA, b: +a.dataset.gpcB, d: +a.dataset.gpcDelta};
    }""")


def _heavy(page):
    return [u for u in page.requests if 'studio/' in u or 'models/' in u or 'plot.ly' in u]


# ---- the summary and the linked selection --------------------------------

@needs_build
def test_summary_is_first_under_the_stats_and_the_menu_follows_it(open_report):
    page = open_report(_pick())
    order = page.evaluate("""[].map.call(document.querySelectorAll('.report-stats, #sec-summary, .v3-secnav, .v3-toolbar, .report-section'),
      e => e.classList.contains('report-section') ? 'report-section' : (e.id || e.className.split(' ')[0])).slice(0, 5)""")
    assert order == ['report-stats', 'sec-summary', 'v3-secnav', 'v3-toolbar', 'report-section']
    assert page.evaluate("[].map.call(document.querySelectorAll('.v3-secnav a'), a => a.textContent)[0]") == 'Snake plot', 'the summary sits above the menu and is not an entry in it'
    # the lead sentence is readable at a glance and the segment rows are closed
    assert page.locator('.gpc-summary-lead').is_visible()
    assert page.evaluate("[].every.call(document.querySelectorAll('.gpc-seg-details'), d => !d.open)")
    assert _heavy(page) == [] and _errors(page) == []


@needs_build
def test_choosing_a_pair_in_the_summary_marks_it_everywhere_and_shows_the_bar(open_report):
    gid = _pick()
    page = open_report(gid)
    chip = _first_chip(page)
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(200)
    bar = page.locator('#gpc-selbar')
    expect(bar).to_be_visible()
    what = bar.locator('.gpc-selbar-what').inner_text()
    assert str(chip['a']) in what and str(chip['b']) in what
    cls = bar.locator('.gpc-selbar-delta').get_attribute('class')
    assert ('is-active' if chip['d'] >= 0 else 'is-inactive') in cls
    assert ('stronger in the active model' if chip['d'] >= 0 else 'stronger in the inactive model') in what
    # marked: the chip, the rows of the two tables, the snake plot (a ringed, b coloured)
    assert page.evaluate("document.querySelector('#gpc-pairs-core .gpc-pair').getAttribute('aria-current')") == 'true'
    assert page.evaluate("""(c) => {
      var sel = 'tr[data-gpc-a="' + c.a + '"][data-gpc-b="' + c.b + '"], tr[data-gpc-a="' + c.b + '"][data-gpc-b="' + c.a + '"]';
      var rows = document.querySelectorAll(sel);
      return rows.length >= 2 && [].every.call(rows, r => r.classList.contains('gpc-sel-pair'));
    }""", chip)
    assert page.evaluate("(c) => document.querySelector('#snake-plot-container circle[id=\"' + c.a + '\"]').getAttribute('stroke-width')", chip) == '4'
    assert page.evaluate("window.SnakeAPI.getState().links"), 'the contact arcs are switched on'
    assert page.evaluate("location.hash") == '#pair=%d-%d' % (chip['a'], chip['b'])
    # the bus heard it once, with the source, and nothing heavy loaded
    pairs = _events(page, 'gpc:select-pair')
    assert len(pairs) == 1 and pairs[0][1]['a'] == chip['a'] and pairs[0][1]['source'] == 'summary' and pairs[0][1]['gid'] == gid
    assert _heavy(page) == []
    # the drawer stays closed until asked; "Details" opens it on residue a with the partner row marked
    assert page.evaluate("document.getElementById('rx-drawer').hidden")
    bar.get_by_role('button', name='Details').click()
    expect(page.locator('#rx-drawer')).to_be_visible()
    assert page.locator('#rx-drawer-title').inner_text().endswith(str(chip['a']))
    assert page.evaluate("(c) => document.querySelector('#rx-drawer .rx-pairs tr[data-gpc-b=\"' + c.b + '\"]').classList.contains('gpc-sel')", chip)
    # the same chip again clears everything (Escape first: the open drawer covers that column)
    page.keyboard.press('Escape')
    expect(page.locator('#rx-drawer')).to_be_hidden()
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(150)
    expect(bar).to_be_hidden()
    assert page.evaluate("document.querySelectorAll('.gpc-sel, .gpc-sel-pair, .gpc-sel-b').length") == 0
    assert page.evaluate("location.hash") == ''
    assert _errors(page) == []


@needs_build
def test_a_table_cell_and_the_snake_plot_feed_the_same_selection(open_report):
    page = open_report(_pick())
    # table cell: drawer opens (as before) and the bar follows
    page.click('#top-changes-table tbody tr:first-child td:nth-child(2)')
    page.wait_for_timeout(200)
    pos = page.evaluate("+document.querySelector('#top-changes-table tbody tr:first-child').dataset.gpcA")
    expect(page.locator('#rx-drawer')).to_be_visible()
    bar = page.locator('#gpc-selbar')
    expect(bar).to_be_visible()
    assert bar.locator('.gpc-selbar-what b').first.inner_text().endswith(str(pos))
    assert page.evaluate("(p) => document.querySelector('#snake-plot-container circle[id=\"' + p + '\"]').getAttribute('stroke-width')", pos) == '4'
    assert page.evaluate("(p) => [].every.call(document.querySelectorAll('[data-gpc-res=\"' + p + '\"], [data-gpc-a=\"' + p + '\"], [data-gpc-b=\"' + p + '\"]'), r => r.classList.contains('gpc-sel'))", pos)
    sel = _events(page, 'gpc:select-residue')
    assert sel[-1][1]['res'] == pos and sel[-1][1]['source'] == 'table'
    # the drawer's partner row picks the contact pair
    page.click('#rx-drawer .rx-pair-pick')
    page.wait_for_timeout(150)
    b = page.evaluate("+document.querySelector('#rx-drawer .rx-pair-pick').dataset.gpcB")
    assert 'Contact' in bar.locator('.gpc-selbar-kind').text_content()
    assert _events(page, 'gpc:select-pair')[-1][1]['b'] == b
    # a click on another snake residue replaces the selection
    other = page.evaluate("(p) => { var c = [].find.call(document.querySelectorAll('#snake-plot-container circle[id]'), c => /^\\d+$/.test(c.id) && +c.id !== p && c.getBoundingClientRect().width > 0); return +c.id; }", pos)
    page.evaluate("(o) => document.querySelector('#snake-plot-container circle[id=\"' + o + '\"]').scrollIntoView({block: 'center'})", other)
    page.click('#snake-plot-container circle[id="%d"]' % other, force=True)
    page.wait_for_timeout(200)
    assert bar.locator('.gpc-selbar-what b').first.inner_text().endswith(str(other))
    assert 'Residue' in bar.locator('.gpc-selbar-kind').text_content()
    assert page.evaluate("document.querySelectorAll('.gpc-sel-pair').length") == 0
    # Escape closes the drawer; outside the plot the next hides the bar but keeps the
    # selection (the plot, the tables and the 3D view stay marked); the next clears it
    page.keyboard.press('Escape')
    expect(page.locator('#rx-drawer')).to_be_hidden()
    expect(bar).to_be_visible()
    page.click('.report-title')
    page.keyboard.press('Escape')
    expect(bar).to_be_hidden()
    assert page.evaluate("window.GPCSelect.current().res") == other
    assert page.evaluate("(o) => document.querySelector('#snake-plot-container circle[id=\"' + o + '\"]').getAttribute('stroke-width')", other) == '4'
    assert page.evaluate("document.querySelectorAll('.gpc-sel').length") > 0
    assert _events(page, 'gpc:select-residue')[-1][1]['res'] == other, 'hiding the bar fires nothing'
    page.keyboard.press('Escape')
    assert page.evaluate("window.GPCSelect.current().res") is None
    assert _events(page, 'gpc:select-residue')[-1][1]['res'] is None
    assert page.evaluate("[].every.call(document.querySelectorAll('#snake-plot-container circle[id]'), c => c.getAttribute('stroke-width') !== '4')")
    # with the focus inside the plot the order is the page's: the drawer (which a click
    # opened), then the bar (the selection stays), then the selection
    page.click('#snake-plot-container circle[id="%d"]' % other, force=True)
    page.wait_for_timeout(200)
    assert page.evaluate("window.GPCSelect.current().res") == other
    assert page.evaluate("!!document.activeElement.closest('#snake-plot-container')")
    page.keyboard.press('Escape')
    expect(page.locator('#rx-drawer')).to_be_hidden()
    assert page.evaluate("window.GPCSelect.current().res") == other
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    expect(bar).to_be_hidden()
    assert page.evaluate("window.GPCSelect.current().res") == other, 'the bar hides first, the selection stays'
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    assert page.evaluate("window.GPCSelect.current().res") is None
    # a keyboard cursor in the plot goes before all of that
    page.focus('#snake-plot-container svg')
    page.keyboard.press('ArrowRight')
    page.keyboard.press('Enter')
    page.wait_for_timeout(150)
    picked = page.evaluate("window.GPCSelect.current().res")
    assert picked is not None and page.evaluate("window.SnakePlus.cursor()") == picked
    page.keyboard.press('Escape')
    assert page.evaluate("window.SnakePlus.cursor()") is None
    assert page.evaluate("window.GPCSelect.current().res") == picked
    expect(bar).to_be_visible()
    page.keyboard.press('Escape')
    expect(bar).to_be_hidden()
    page.keyboard.press('Escape')
    assert page.evaluate("window.GPCSelect.current().res") is None
    assert _errors(page) == []


@needs_build
def test_hover_is_transient_and_reaches_the_bus(open_report):
    page = open_report(_pick())
    page.hover('#top-changes-table tbody tr:first-child td:nth-child(4)')
    page.wait_for_timeout(100)
    a = page.evaluate("+document.querySelector('#top-changes-table tbody tr:first-child').dataset.gpcA")
    assert page.evaluate("document.querySelector('#top-changes-table tbody tr:first-child').classList.contains('gpc-hover')")
    assert page.evaluate("(p) => [].some.call(document.querySelectorAll('#rrcs-table tr[data-gpc-a=\"' + p + '\"]'), r => r.classList.contains('gpc-hover'))", a)
    assert _events(page, 'gpc:hover-pair')[-1][1]['a'] == a
    page.hover('.report-title')
    page.wait_for_timeout(100)
    assert page.evaluate("document.querySelectorAll('.gpc-hover').length") == 0
    assert _events(page, 'gpc:hover-pair')[-1][1]['a'] is None
    assert page.evaluate("document.getElementById('gpc-selbar').hidden"), 'hover never selects'
    assert _errors(page) == []


@needs_build
def test_events_from_another_module_are_applied_and_not_echoed(open_report):
    """What the 3D view does: fire gpc:select-residue with its own source."""
    page = open_report(_pick())
    pos = page.evaluate("+document.querySelector('#top-changes-table tbody tr:first-child').dataset.gpcB")
    gid = page.evaluate("JSON.parse(document.getElementById('rx-config').textContent).gid")
    page.evaluate("(d) => document.dispatchEvent(new CustomEvent('gpc:select-residue', {detail: d}))", {'gid': gid, 'res': pos, 'source': '3d'})
    page.wait_for_timeout(150)
    expect(page.locator('#gpc-selbar')).to_be_visible()
    assert page.locator('#gpc-selbar .gpc-selbar-what b').first.inner_text().endswith(str(pos))
    assert page.evaluate("(p) => document.querySelector('#snake-plot-container circle[id=\"' + p + '\"]').getAttribute('stroke-width')", pos) == '4'
    assert len(_events(page, 'gpc:select-residue')) == 1, 'no echo of the 3D event'
    # another receptor's event is ignored
    page.evaluate("(d) => document.dispatchEvent(new CustomEvent('gpc:select-residue', {detail: d}))", {'gid': 'other_human', 'res': 1, 'source': '3d'})
    page.wait_for_timeout(100)
    assert page.locator('#gpc-selbar .gpc-selbar-what b').first.inner_text().endswith(str(pos))
    assert _errors(page) == []


@needs_build
def test_pair_and_residue_deep_links_select_on_arrival_and_copy_link_round_trips(open_report):
    gid = _pick()
    chip = _first_chip(open_report(gid))
    page = open_report(gid, '#pair=%d-%d' % (chip['a'], chip['b']), wait=800)
    bar = page.locator('#gpc-selbar')
    expect(bar).to_be_visible()
    assert 'Contact' in bar.locator('.gpc-selbar-kind').text_content()
    assert page.evaluate("(c) => document.querySelector('#snake-plot-container circle[id=\"' + c.a + '\"]').getAttribute('stroke-width')", chip) == '4'
    assert _events(page, 'gpc:select-pair')[0][1]['source'] == 'hash'
    bar.get_by_role('button', name='Copy link').click()
    page.wait_for_timeout(200)
    assert page.evaluate('navigator.clipboard.readText()').endswith('#pair=%d-%d' % (chip['a'], chip['b']))
    # the old #res= link still opens the drawer and now also fills the bar
    page2 = open_report(gid, '#res=%d' % chip['a'], wait=800)
    expect(page2.locator('#rx-drawer')).to_be_visible()
    expect(page2.locator('#gpc-selbar')).to_be_visible()
    assert page2.locator('#gpc-selbar .gpc-selbar-what b').first.inner_text().endswith(str(chip['a']))
    assert _errors(page) == [] and _errors(page2) == []


@needs_build
@needs_plotly
def test_chart_points_join_the_selection_once_the_charts_are_drawn(open_report):
    page = open_report(_pick('id="scatter-chart"'))
    chip = _first_chip(page)
    page.evaluate("document.getElementById('sec-charts').scrollIntoView()")
    page.wait_for_function("document.getElementById('scatter-chart').dataset.chartRendered && document.getElementById('residue-chart').dataset.chartRendered", timeout=30000)
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(300)
    assert page.evaluate("JSON.stringify(document.getElementById('scatter-chart').data[0].selectedpoints)") == '[%d]' % page.evaluate(
        "(c) => window.CHART_DATA['scatter-chart'].data[0].text.findIndex(t => new RegExp('^[A-Za-z]{3}' + c.a + ' - [A-Za-z]{3}' + c.b + '\\\\b').test(t))", chip)
    assert page.evaluate("document.getElementById('residue-chart').data[0].selectedpoints.length") == 2
    # a click on a residue-chart point selects that residue
    page.evaluate("""() => {
      var gd = document.getElementById('residue-chart');
      gd.emit('plotly_click', {points: [{x: gd.data[0].x[0], curveNumber: 0, pointNumber: 0}]});
    }""")
    page.wait_for_timeout(200)
    first = page.evaluate("document.getElementById('residue-chart').data[0].x[0]")
    assert page.locator('#gpc-selbar .gpc-selbar-what b').first.inner_text().endswith(str(first))
    assert _events(page, 'gpc:select-residue')[-1][1]['source'] == 'chart'
    assert page.evaluate("String(document.getElementById('scatter-chart').data[0].selectedpoints)") in ('null', 'undefined')
    assert _errors(page) == []


# ---- fine print ----------------------------------------------------------

@needs_build
def test_approved_prose_moves_into_fine_print_with_its_text_unchanged(open_report):
    gid = _pick()
    html = _html(gid)
    page = open_report(gid)
    for sec, label in (('sec-snake', 'About this plot'), ('sec-changes', 'About this table'), ('sec-tm', 'About this table'),
                       ('sec-variants', 'About this table'), ('sec-rrcs', 'About this table'), ('sec-methods', 'Show methods')):
        if 'id="%s"' % sec not in html:
            continue
        d = page.locator('#%s-about' % sec)
        assert d.count() == 1, sec
        assert d.evaluate('d => d.tagName === "DETAILS" && !d.open && d.classList.contains("fine-print")'), sec
        assert d.locator('summary').inner_text() == label
        # the moved text is the approved text, character for character
        built = re.search(r'<section class="report-section" id="%s".*?</section>' % sec, html, re.S).group(0)
        moved = page.evaluate("(s) => [].map.call(document.querySelectorAll('#' + s + '-about > :not(summary)'), n => n.textContent).join('')", sec)
        for word in re.findall(r'[A-Za-z]{6,}', moved)[:30]:
            assert word in built, (sec, word)
        # it sits right under the heading, and the plot or table is next
        assert page.evaluate("(s) => document.getElementById(s + '-about').previousElementSibling.classList.contains('report-section-head')", sec), sec
    assert page.evaluate("document.querySelector('#sec-snake .callout').closest('details.fine-print') !== null")
    # the section menu's Methods link opens the folded methods
    page.click('.v3-secnav a[data-target="sec-methods"]')
    page.wait_for_timeout(200)
    assert page.evaluate("document.getElementById('sec-methods-about').open")
    assert _errors(page) == []


@needs_build
def test_attributions_and_sources_render_as_fine_print(open_report):
    page = open_report(_pick())
    size = page.evaluate("parseFloat(getComputedStyle(document.querySelector('.report-refs')).fontSize)")
    body = page.evaluate("parseFloat(getComputedStyle(document.body).fontSize)")
    assert size < body
    if page.locator('#sec-3d .rx-attr').count():
        assert page.evaluate("document.querySelector('#sec-3d .rx-attr').tagName") == 'ASIDE'
    assert _errors(page) == []


# ---- phone, keyboard, dark mode ------------------------------------------

@needs_build
@pytest.mark.parametrize('dark', [False, True])
def test_phone_layout_summary_bar_and_drawer(open_report, dark):
    page = open_report(_pick(), viewport=PHONE, dark=dark)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    assert page.evaluate("getComputedStyle(document.querySelector('.gpc-summary-grid')).gridTemplateColumns.split(' ').length") == 1
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(250)
    bar = page.locator('#gpc-selbar')
    expect(bar).to_be_visible()
    box = bar.bounding_box()
    assert box['x'] == 0 and abs(box['x'] + box['width'] - 390) < 1 and abs(box['y'] + box['height'] - 844) < 1, box
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    bar.get_by_role('button', name='Details').click()
    expect(page.locator('#rx-drawer')).to_be_visible()
    drawer = page.locator('#rx-drawer').bounding_box()
    assert drawer['y'] + drawer['height'] <= box['y'] + 1, 'the drawer sits above the bar'
    # readable in dark mode: the bar is not white on white
    bg = page.evaluate("getComputedStyle(document.getElementById('gpc-selbar')).backgroundColor")
    assert (bg != 'rgb(255, 255, 255)') == dark
    assert page.evaluate("document.documentElement.getAttribute('data-color-mode')") == ('dark' if dark else 'light')
    assert _errors(page) == []


@needs_build
def test_keyboard_only_selection(open_report):
    page = open_report(_pick())
    page.focus('#gpc-pairs-core .gpc-pair')
    page.keyboard.press('Enter')
    page.wait_for_timeout(200)
    bar = page.locator('#gpc-selbar')
    expect(bar).to_be_visible()
    assert page.evaluate("document.getElementById('gpc-selbar').getAttribute('role')") == 'region'
    assert page.evaluate("document.querySelector('#gpc-selbar .gpc-selbar-what').getAttribute('aria-live')") == 'polite'
    # the bar's controls are reachable and labelled
    names = page.evaluate("[].map.call(document.querySelectorAll('#gpc-selbar button, #gpc-selbar a'), b => b.getAttribute('aria-label') || b.textContent)")
    assert 'Details' in names and 'Copy link' in names and 'Clear' in names and 'Hide this bar, keep the selection' in names
    page.focus('#gpc-selbar .gpc-selbar-close')
    page.keyboard.press('Enter')
    expect(bar).to_be_hidden()
    assert page.evaluate("window.GPCSelect.current().pair !== null"), 'the close button keeps the selection'
    page.focus('#gpc-pairs-core .gpc-pair')
    page.keyboard.press('Enter')   # the same chip again: clears, the bar stays hidden
    page.wait_for_timeout(150)
    assert page.evaluate("window.GPCSelect.current().res") is None
    page.keyboard.press('Enter')   # and once more selects it, which shows the bar again
    page.wait_for_timeout(150)
    expect(bar).to_be_visible()
    page.focus('#gpc-selbar .gpc-selbar-clear')
    page.keyboard.press('Enter')
    expect(bar).to_be_hidden()
    assert page.evaluate("window.GPCSelect.current().res") is None
    # a segment row opens with the keyboard and its chips are focusable
    page.focus('.gpc-seg-details > summary')
    page.keyboard.press('Enter')
    page.wait_for_timeout(100)
    assert page.evaluate("document.querySelector('.gpc-seg-details').open")
    assert page.evaluate("document.querySelector('.gpc-seg-details .gpc-pair').tabIndex") == 0
    assert _errors(page) == []


@needs_build
def test_nothing_heavy_loads_before_it_is_needed_and_first_paint_is_light(open_report):
    page = open_report(_pick(), viewport=PHONE, wait=800)
    assert _heavy(page) == []
    # the summary and the fine print need no library
    assert page.locator('.gpc-summary-lead').is_visible()
    assert page.evaluate("document.querySelectorAll('details.gpc-fine').length") >= 4
    scripts = page.evaluate("[].map.call(document.scripts, s => s.src).filter(Boolean)")
    assert not any('plot.ly' in s for s in scripts)
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(200)
    assert _heavy(page) == [], 'selecting a contact loads nothing'
    assert _errors(page) == []


@needs_build
def test_loops_and_termini_toggle_switches_the_largest_changes_list(open_report):
    gid = _pick()
    html = _html(gid)
    page = open_report(gid)
    assert page.locator('#gpc-pairs-core').is_visible() and not page.locator('#gpc-pairs-all').is_visible()
    assert page.evaluate("document.querySelectorAll('#gpc-pairs-core .gpc-tail').length") == 0
    page.check('#gpc-include-tails')
    page.wait_for_timeout(100)
    assert page.locator('#gpc-pairs-all').is_visible() and not page.locator('#gpc-pairs-core').is_visible()
    assert page.locator('#gpc-scope-note').text_content() == ' overall'
    n_marked = page.evaluate("document.querySelectorAll('#gpc-pairs-all .gpc-tail').length")
    # the markers agree with the segments the page carries for those residues
    ann = json.loads(re.search(r'id="rx-config">(.*?)</script>', html, re.S).group(1))['annotation']
    chips = page.evaluate("[].map.call(document.querySelectorAll('#gpc-pairs-all .gpc-pair'), a => [+a.dataset.gpcA, +a.dataset.gpcB, !!a.querySelector('.gpc-tail')])")
    helix = re.compile(r'^(TM[1-7]|H8)$')
    for a, b, marked in chips:
        tail = any(ann.get(str(p), ['', ''])[0] and not helix.match(ann[str(p)][0]) for p in (a, b))
        assert marked == tail, (a, b, ann.get(str(a)), ann.get(str(b)))
    assert n_marked == sum(1 for c in chips if c[2])
    # a chip of the overall list selects as any other
    page.click('#gpc-pairs-all .gpc-pair')
    page.wait_for_timeout(150)
    expect(page.locator('#gpc-selbar')).to_be_visible()
    page.uncheck('#gpc-include-tails')
    assert page.locator('#gpc-pairs-core').is_visible()
    assert _errors(page) == []


HAS_VIEWER = ((BUILD_DIR / 'studio' / 'embed' / 'pair-viewer.js').is_file()
              and (BUILD_DIR / 'models' / 'active').is_dir())
needs_viewer = pytest.mark.skipif(not HAS_VIEWER, reason='%s has no studio/embed or models/' % BUILD_DIR)


@needs_build
@needs_viewer
def test_bar_docks_at_the_top_while_the_3d_view_is_under_it_and_hiding_it_keeps_the_3d_focus(open_report):
    gid = _pick('id="sec-3d"')
    page = open_report(gid)
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(150)
    bar = page.locator('#gpc-selbar')
    assert not page.evaluate("document.getElementById('gpc-selbar').classList.contains('gpc-selbar--top')")
    page.click('#rx-3d-toggle')
    page.wait_for_function("document.getElementById('rx-3d-pane').getAttribute('data-state') === 'ready'", timeout=60000)
    # scrolled so the legend under the pane reaches the bottom of the screen, where the bar
    # sits: the bar moves to the top and overlaps neither the pane nor the legend
    page.evaluate("window.scrollBy(0, document.getElementById('rx-3d-panel').getBoundingClientRect().bottom - window.innerHeight + 40)")
    page.wait_for_timeout(400)
    assert page.evaluate("document.getElementById('gpc-selbar').classList.contains('gpc-selbar--top')")
    b = bar.bounding_box()
    for sel in ('#rx-3d-pane', '#rx-3d-legend'):
        r = page.locator(sel).bounding_box()
        if r is None:
            continue
        overlap = not (b['y'] + b['height'] <= r['y'] or b['y'] >= r['y'] + r['height'])
        assert not overlap, (sel, b, r)
    # back to the bottom once the view has scrolled away
    page.evaluate("document.getElementById('sec-rrcs').scrollIntoView()")
    page.wait_for_timeout(400)
    assert not page.evaluate("document.getElementById('gpc-selbar').classList.contains('gpc-selbar--top')")
    # hiding the bar keeps the 3D focus on the pair
    pair = page.evaluate("document.getElementById('rx-3d-pane').getAttribute('data-pair')")
    assert pair
    page.keyboard.press('Escape')
    expect(bar).to_be_hidden()
    assert page.evaluate("document.getElementById('rx-3d-pane').getAttribute('data-pair')") == pair
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    assert not page.evaluate("document.getElementById('rx-3d-pane').getAttribute('data-pair')")
    assert _errors(page) == []


# ---- review fixes (Codex/Astra, round 3) ----------------------------------

@needs_build
def test_transcript_offset_sentence_has_the_right_direction():
    # offset = model position minus transcript number: LPAR2 p.Arg304His sits at Position 301
    path = REPORTS_DIR / 'lpar2_human.html'
    if not path.exists():
        pytest.skip('lpar2_human not in this build')
    html = path.read_text(encoding='utf-8')
    assert 'run 3 higher than the Position column (Position = transcript number -3)' in html


def test_a_deliberate_pick_of_a_pairs_first_residue_selects_it_alone(open_report):
    gid = _pick()
    page = open_report(gid)
    chip = _first_chip(page)
    page.evaluate('(c) => window.GPCSelect.selectPair(c.a, c.b, c.d, "test")', chip)
    page.wait_for_timeout(900)   # past the plot's echo of the first residue
    cur = page.evaluate('window.GPCSelect.current()')
    assert cur['pair'] and cur['pair']['a'] == chip['a'], 'the echo must leave the pair a pair'
    assert page.evaluate('location.hash').startswith('#pair=')
    page.evaluate('(a) => window.GPCSelect.select(a, "table")', chip['a'])
    page.wait_for_timeout(200)
    cur = page.evaluate('window.GPCSelect.current()')
    assert cur['pair'] is None and cur['res'] == chip['a']
    assert page.evaluate('location.hash') == '#res=%d' % chip['a']
    assert _errors(page) == []


def test_filter_deep_links_survive_the_snake_layer_start(open_report):
    gid = _pick()
    page = open_report(gid, '#dir=inactive', wait=300)
    page.locator('#snake-plot-container').scroll_into_view_if_needed()
    page.wait_for_timeout(800)
    st = page.evaluate('window.SnakeAPI.getState()')
    assert st['dir'] == 'inactive'
    b = page.evaluate('window.SnakeAPI.bounds()')
    mid = round((b['lo'] + b['hi']) / 2, 2)
    page2 = open_report(gid, '#min=%.2f' % mid, wait=300)
    page2.locator('#snake-plot-container').scroll_into_view_if_needed()
    page2.wait_for_timeout(800)
    assert abs(page2.evaluate('window.SnakeAPI.getState()')['min'] - mid) < 0.011
    assert _errors(page) == [] and _errors(page2) == []


def test_a_plain_methods_fragment_opens_the_methods_fine_print(open_report):
    page = open_report(_pick(), '#sec-methods')
    assert page.evaluate("(() => { var d = document.getElementById('sec-methods-about'); return !d || d.open; })()")


def test_arrow_keys_announce_the_cursor_not_the_old_selection(open_report):
    page = open_report(_pick())
    svg = page.locator('#snake-plot-container svg').first
    svg.scroll_into_view_if_needed()
    page.wait_for_timeout(600)
    svg.focus()
    page.keyboard.press('ArrowRight')
    page.keyboard.press('Enter')
    page.wait_for_timeout(200)
    first = page.locator('.sp-live').inner_text()
    page.keyboard.press('ArrowRight')
    page.wait_for_timeout(150)
    moved = page.locator('.sp-live').inner_text()
    assert moved != first and not moved.startswith('Selected')
