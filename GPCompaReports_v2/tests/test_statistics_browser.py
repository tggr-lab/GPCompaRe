"""The Statistics page in a browser: chart cards, exports, table views, lazy charts, phone and dark.

Drives a built site (SEARCH_BUILD_DIR, SMOKE_BUILD_DIR or output_v3_demo, the same as
test_search_browser.py) in headless Chromium, desktop (1280 px) and phone (390 px), light and dark:

  * every chart card draws its Plotly chart exactly once, with no console error and no sideways scroll;
  * no card title or toolbar runs past the viewport;
  * PNG and SVG export produce a file (Plotly.downloadImage, light background);
  * the table view of a card shows the numbers the chart draws (the AlphaMissense comparison);
  * the helix-pair grid lists the receptors behind a clicked cell with report links;
  * the explorer's find box highlights a receptor and lists similar ones;
  * the copied caption names the view, the scope and the source.

    SEARCH_BUILD_DIR=<build> .venv-test/bin/python -m pytest GPCompaReports_v2/tests/test_statistics_browser.py
"""
import json
import os
import pathlib
import re

import pytest

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter. Run from the project venv.')
from playwright.sync_api import expect  # noqa: E402

from GPCompaReports_v2.tests.test_search_browser import (  # noqa: E402,F401  (fixtures)
    BLOCKED, BUILD_DIR, DESKTOP, PHONE_390, browser, server,
)

STATS = BUILD_DIR / 'statistics.html'
needs_build = pytest.mark.skipif(not STATS.is_file(), reason='no built statistics page in %s' % BUILD_DIR)

# The page loads Plotly from cdn.plot.ly, which the suite blocks; the charts here need the library, so
# the request is answered from a local copy (PLOTLY_LOCAL_JS, else a known checkout) and the tests skip
# without one.
_HOME = pathlib.Path.home()
PLOTLY_CANDIDATES = [pathlib.Path(p) for p in filter(None, [os.environ.get('PLOTLY_LOCAL_JS')])] + [
    _HOME / 'scratch' / '2026-11-04_ux_round2' / 'plotly-3.3.1.min.js',
    _HOME / 'Documents' / 'gpcr_synth' / 'gpcompare_studio_web' / 'node_modules' / 'plotly.js-dist-min' / 'plotly.min.js',
]
PLOTLY_LOCAL = next((p for p in PLOTLY_CANDIDATES if p.is_file()), None)
needs_plotly = pytest.mark.skipif(PLOTLY_LOCAL is None, reason='no local Plotly copy (set PLOTLY_LOCAL_JS)')


@pytest.fixture
def open_page(browser, server):
    """open(path, viewport=DESKTOP, scheme='light') -> the page, Plotly served from the local copy."""
    contexts = []
    body = PLOTLY_LOCAL.read_bytes() if PLOTLY_LOCAL else b''

    def _open(path, viewport=DESKTOP, scheme='light'):
        ctx = browser.new_context(viewport=viewport, color_scheme=scheme, accept_downloads=True,
                                  is_mobile=viewport is PHONE_390, has_touch=viewport is PHONE_390)
        contexts.append(ctx)
        page = ctx.new_page()
        page.errors = []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: page.errors.append(m.text)
                if m.type == 'error' and m.location.get('url', '').startswith(server) else None)
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.route('**cdn.plot.ly/**', lambda route: route.fulfill(status=200, content_type='application/javascript', body=body))
        page.goto(server + path, wait_until='load')
        return page

    yield _open
    for c in contexts:
        c.close()

CARDS = ['chart-helix-pairs', 'chart-cfr-atlas', 'chart-cfr-dotplot', 'chart-pathogenicity',
         'chart-cfr-variants', 'chart-receptors']
FOLDED = ['chart-histogram', 'chart-tm-bar', 'chart-cv-scatter', 'chart-conservation']


def _settle(page, ids, timeout=30000):
    """Scroll every card into view (they load lazily) and wait until each has a Plotly chart or a note."""
    for cid in ids:
        page.locator('#' + cid).scroll_into_view_if_needed()
        page.wait_for_timeout(120)
    page.wait_for_function(
        """ids => ids.every(id => { const e = document.getElementById(id); return e && (e.querySelector('.plotly') || e.querySelector('.chart-card-note')); })""",
        arg=ids, timeout=timeout)
    page.wait_for_timeout(400)


def _no_horizontal_scroll(page):
    return page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1


@needs_build
@needs_plotly
@pytest.mark.parametrize('scheme', ['light', 'dark'])
@pytest.mark.parametrize('viewport', ['desktop', 'phone'])
def test_every_card_draws_once_without_errors_or_sideways_scroll(open_page, scheme, viewport):
    page = open_page('/statistics.html', scheme=scheme, **({'viewport': PHONE_390} if viewport == 'phone' else {}))
    page.evaluate("document.querySelectorAll('details.stats-folded').forEach(d => d.open = true)")
    _settle(page, CARDS + FOLDED)
    for cid in CARDS + FOLDED:
        plots = page.locator('#%s .plot-container' % cid)
        assert plots.count() == 1, '%s drew %d charts' % (cid, plots.count())
        assert page.locator('#' + cid).get_attribute('data-chart-rendered') == '1'
    errors = [e for e in page.errors if 'plot' not in e.lower()]
    assert errors == [], errors
    assert _no_horizontal_scroll(page)
    # titles and toolbars stay inside the viewport
    over = page.evaluate("""() => Array.from(document.querySelectorAll('.chart-card-title, .chart-card-tools, .chips'))
        .filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.className)""")
    assert over == [], over


@needs_build
@needs_plotly
def test_png_and_svg_export_produce_files(open_page):
    page = open_page('/statistics.html')
    _settle(page, ['chart-pathogenicity'])
    card = page.locator('#card-chart-pathogenicity')
    for fmt, ext in (('png', '.png'), ('svg', '.svg')):
        with page.expect_download(timeout=20000) as dl:
            card.locator('[data-export="%s"]' % fmt).click()
        name = dl.value.suggested_filename
        assert name.startswith('gpcompare_pathogenicity') and name.endswith(ext), name
        path = pathlib.Path(dl.value.path())
        assert path.stat().st_size > 1000
    # the page is back on its own theme after the export (the file is drawn on a light background)
    assert page.locator('#chart-pathogenicity').get_attribute('data-chart-rendered') == '1'
    assert [e for e in page.errors if 'plot' not in e.lower()] == []


@needs_build
@needs_plotly
def test_table_view_shows_the_chart_data(open_page):
    page = open_page('/statistics.html')
    _settle(page, ['chart-pathogenicity'])
    html = STATS.read_text(encoding='utf-8')
    payload = json.loads(re.search(r"\['chart-pathogenicity'\] = (\{.*?\});\n", html, re.S).group(1))
    card = page.locator('#card-chart-pathogenicity')
    card.locator('[data-table-toggle]').click()
    expect(card.locator('.chart-card-table table')).to_be_visible()
    assert page.locator('#chart-pathogenicity').is_hidden()
    rows = card.locator('.chart-card-table tbody tr').evaluate_all(
        'trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent.trim()))')
    header = card.locator('.chart-card-table thead th').evaluate_all('ths => ths.map(th => th.textContent.trim())')
    assert header[:3] == ['series', 'x', 'y']
    by_series = {}
    for r in rows:
        by_series.setdefault(r[0], []).append(float(r[2]))
    for tr in payload['data']:
        assert by_series[tr['name']] == pytest.approx(tr['y'], abs=1e-6), tr['name']
    card.locator('[data-table-toggle]').click()
    expect(page.locator('#chart-pathogenicity')).to_be_visible()


@needs_build
@needs_plotly
def test_helix_pair_cell_lists_the_receptors_behind_it(open_page):
    page = open_page('/statistics.html')
    _settle(page, ['chart-helix-pairs'])
    plot = page.locator('#chart-helix-pairs')
    # the TM3 to TM6 cell: row 3, column 6 of an 8 x 8 grid drawn in the plot area
    box = plot.locator('.heatmaplayer').bounding_box()
    page.mouse.click(box['x'] + box['width'] * (5 + 0.5) / 8, box['y'] + box['height'] * (2 + 0.5) / 8)
    side = page.locator('#card-chart-helix-pairs .chart-card-side')
    expect(side.locator('h4')).to_contain_text('TM3 to TM6', timeout=15000)
    expect(side.locator('table tbody tr').first).to_be_visible()
    href = side.locator('table tbody tr a').first.get_attribute('href')
    assert href.startswith('reports/') and href.endswith('.html')
    assert side.locator('table tbody tr').count() > 100
    # a ligand-type chip refilters the grid and the caption says so
    page.locator('#card-chart-helix-pairs [data-chips="group"] .chip').nth(1).click()
    page.wait_for_timeout(600)
    assert 'View:' in page.locator('#card-chart-helix-pairs [data-view-text]').inner_text()
    assert page.locator('#chart-helix-pairs .plot-container').count() == 1
    assert [e for e in page.errors if 'plot' not in e.lower()] == []


@needs_build
@needs_plotly
def test_explorer_find_highlights_a_receptor_and_lists_similar_ones(open_page):
    page = open_page('/statistics.html')
    _settle(page, ['chart-receptors'])
    box = page.locator('#receptors-find')
    box.fill('ADRB2')
    page.locator('#card-chart-receptors .find-list li').first.click()
    side = page.locator('#card-chart-receptors .chart-card-side')
    expect(side.locator('h4').first).to_contain_text('ADRB2', timeout=15000)
    expect(side.locator('table tbody tr').first).to_be_visible(timeout=15000)
    assert side.locator('table tbody tr').count() >= 2
    assert 'not a classification' in side.inner_text()
    # the table tab lists every receptor and marks the found one
    page.locator('#card-chart-receptors [data-value="table"]').click()
    expect(page.locator('#card-chart-receptors .explorer-table tbody tr').first).to_be_visible()
    assert page.locator('#card-chart-receptors .explorer-table tbody tr').count() == 283
    assert page.locator('#card-chart-receptors .explorer-table tr.is-found').count() == 1


@needs_build
@needs_plotly
def test_copied_caption_names_view_scope_and_source(open_page):
    page = open_page('/statistics.html')
    _settle(page, ['chart-pathogenicity'])
    page.evaluate("""() => { window.__copied = null; navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; }""")
    page.locator('#card-chart-pathogenicity [data-copy-caption]').click()
    page.wait_for_timeout(200)
    text = page.evaluate('window.__copied')
    assert text and 'AlphaMissense predicted class at CFR positions' in text
    assert 'Scope: 276 receptors' in text and 'gnomAD v4.1.0' in text
    assert 'paper' not in text.lower() and 'layer' not in text.lower() and 'Supplementary' not in text
    assert 'statistics.html#card-chart-pathogenicity' in text
