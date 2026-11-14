"""The Statistics page in a browser: every card, the shared selection, exports, phone and dark.

Drives a built site (SEARCH_BUILD_DIR, SMOKE_BUILD_DIR or output_v3_demo, the same as test_search_browser.py)
in headless Chromium, desktop (1280 px) and phone (390 px), light and dark:

  * every card draws once (data-chart-rendered="1"), with no console error and no sideways scroll;
  * exports are named gpcompare_<card>*, the CSVs carry plain column names;
  * the helix bundle lists the receptors behind a line or a ledger row with report links;
  * a small ligand group (Melatonin) shows the carried-by state and one chip per receptor;
  * the selection box follows a receptor (?sel=rec:), the explorer table marks it;
  * a ranking row opens the position profile, Esc closes it and clears the position;
  * ?sel=pos:6.48x48, ?sel=pair:TM3-TM6 and ?sel=bogus:1 on load;
  * a theme change while the histogram is folded redraws it in the new theme when it is opened;
  * with reduced motion nothing animates;
  * the copied caption names the title, the scope and the source.

    SEARCH_BUILD_DIR=<build> .venv-test/bin/python -m pytest GPCompaReports_v2/tests/test_statistics_browser.py
"""
import csv
import io
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

# Plotly (explorer scatter only) comes from cdn.plot.ly, which the suite blocks; it is answered from a local copy
_HOME = pathlib.Path.home()
PLOTLY_CANDIDATES = [pathlib.Path(p) for p in filter(None, [os.environ.get('PLOTLY_LOCAL_JS')])] + [
    _HOME / 'scratch' / '2026-11-04_ux_round2' / 'plotly-3.3.1.min.js',
    _HOME / 'Documents' / 'gpcr_synth' / 'gpcompare_studio_web' / 'node_modules' / 'plotly.js-dist-min' / 'plotly.min.js',
]
PLOTLY_LOCAL = next((p for p in PLOTLY_CANDIDATES if p.is_file()), None)
needs_plotly = pytest.mark.skipif(PLOTLY_LOCAL is None, reason='no local Plotly copy (set PLOTLY_LOCAL_JS)')

CARDS = ['chart-thresholds', 'chart-histogram', 'chart-helix-pairs', 'chart-segments', 'chart-scaffold', 'chart-ranking',
         'chart-recovery', 'chart-partners', 'chart-cfr-atlas', 'chart-pathogenicity', 'chart-am-bands',
         'chart-position-conservation', 'chart-am-quintiles', 'chart-cfr-variants', 'chart-receptors']


@pytest.fixture
def open_page(browser, server):
    """open(path, viewport=DESKTOP, scheme='light', reduced_motion=None) -> the page."""
    contexts = []
    body = PLOTLY_LOCAL.read_bytes() if PLOTLY_LOCAL else b''

    def _open(path='/statistics.html', viewport=DESKTOP, scheme='light', reduced_motion=None):
        kw = {'reduced_motion': reduced_motion} if reduced_motion else {}
        ctx = browser.new_context(viewport=viewport, color_scheme=scheme, accept_downloads=True,
                                  is_mobile=viewport is PHONE_390, has_touch=viewport is PHONE_390, **kw)
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
        page.wait_for_timeout(200)
        return page

    yield _open
    for c in contexts:
        c.close()


def _settle(page, ids, timeout=30000):
    """Scroll each card into view (they load when within 600 px) and wait until each one has drawn."""
    page.evaluate("document.querySelectorAll('details.more').forEach(d => d.open = true)")
    for cid in ids:
        page.locator('#card-' + cid).scroll_into_view_if_needed()
        page.wait_for_timeout(100)
    page.wait_for_function("""ids => ids.every(id => { const e = document.getElementById(id);
        return e && (e.dataset.chartRendered === '1' || e.querySelector('.load-note')); })""", arg=ids, timeout=timeout)
    page.wait_for_timeout(300)


def _no_horizontal_scroll(page):
    return page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1


def _errors(page):
    return [e for e in page.errors if 'ERR_FAILED' not in e]


@needs_build
@needs_plotly
@pytest.mark.parametrize('scheme', ['light', 'dark'])
@pytest.mark.parametrize('viewport', ['desktop', 'phone'])
def test_every_card_draws_once_without_errors_or_sideways_scroll(open_page, scheme, viewport):
    page = open_page(scheme=scheme, viewport=PHONE_390 if viewport == 'phone' else DESKTOP)
    _settle(page, CARDS)
    for cid in CARDS:
        assert page.locator('#' + cid).get_attribute('data-chart-rendered') == '1', cid
        assert page.locator('#%s .load-note' % cid).count() == 0, cid
    assert page.locator('#chart-receptors .plot-container').count() == 1
    assert _errors(page) == []
    assert _no_horizontal_scroll(page)
    over = page.evaluate("""() => Array.from(document.querySelectorAll('.scard-title, .scard-foot, .chips, .seg, .glance-fact'))
        .filter(e => e.getClientRects().length && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map(e => e.className)""")
    assert over == [], over


@needs_build
def test_no_selection_on_load_and_nothing_par_specific(open_page):
    page = open_page()
    assert 'sel=' not in page.url
    assert page.locator('.pos-profile').count() == 0
    assert page.locator('#sel-input').input_value() == ''
    assert 'Nothing selected' in page.locator('[data-sel-summary]').inner_text()
    html = STATS.read_text(encoding='utf-8')
    for bad in ('par1_human', 'par2_human', 'par3_human', 'par4_human', 'f2r_human', 'Met159'):
        assert bad not in html, bad


@needs_build
def test_exports_are_named_and_the_csv_is_plain(open_page):
    page = open_page()
    _settle(page, ['chart-pathogenicity', 'chart-ranking'])
    card = page.locator('#card-chart-pathogenicity')
    for fmt, ext in (('png', '.png'), ('svg', '.svg')):
        card.locator('[data-export-toggle]').click()
        with page.expect_download(timeout=20000) as dl:
            card.locator('[data-export="%s"]' % fmt).click()
        name = dl.value.suggested_filename
        assert name.startswith('gpcompare_pathogenicity') and name.endswith(ext), name
        path = pathlib.Path(dl.value.path())
        assert path.stat().st_size > 1000
        if ext == '.svg':
            text = path.read_text(encoding='utf-8')
            assert 'Predicted class of the substitutions seen in people' in text and '#ffffff' in text
    card.locator('[data-export-toggle]').click()
    with page.expect_download(timeout=20000) as dl:
        card.locator('[data-export="csv"]').click()
    assert dl.value.suggested_filename == 'gpcompare_pathogenicity.csv'
    header = next(csv.reader(io.StringIO(pathlib.Path(dl.value.path()).read_text(encoding='utf-8'))))
    assert header[:3] == ['group', 'scored', 'decisive'] and 'series' not in header
    # the matrix (canvas) exports a PNG too
    _settle(page, ['chart-cfr-atlas'])
    m = page.locator('#card-chart-cfr-atlas')
    m.locator('[data-export-toggle]').click()
    with page.expect_download(timeout=20000) as dl:
        m.locator('[data-export="png"]').click()
    assert dl.value.suggested_filename.startswith('gpcompare_cfr-atlas') and dl.value.suggested_filename.endswith('.png')
    assert _errors(page) == []


@needs_build
def test_every_card_csv_has_plain_headers():
    stats = BUILD_DIR / 'data' / 'stats'
    for path in stats.glob('*.csv'):
        lines = [l for l in path.read_text(encoding='utf-8').splitlines() if not l.startswith('#')]
        header = next(csv.reader(io.StringIO(lines[0])))
        assert not {'series', 'x', 'y'} & set(header), path.name
        assert not any('<' in h for h in header), path.name


@needs_build
def test_table_view_swaps_with_the_chart(open_page):
    page = open_page()
    _settle(page, ['chart-am-bands', 'chart-ranking'])
    card = page.locator('#card-chart-am-bands')
    card.locator('[data-table-toggle]').click()
    expect(card.locator('.scard-table table')).to_be_visible()
    assert page.locator('#chart-am-bands').is_hidden()
    assert card.locator('.scard-table tbody tr').count() == 6
    card.locator('[data-table-toggle]').click()
    expect(page.locator('#chart-am-bands')).to_be_visible()
    # the ranking's Table view is the server table
    rk = page.locator('#card-chart-ranking')
    rk.locator('[data-table-toggle]').click()
    expect(rk.locator('#cfr-table')).to_be_visible()
    assert rk.locator('#cfr-table tbody tr').count() == 50


@needs_build
def test_helix_line_and_ledger_row_list_the_receptors_behind_them(open_page):
    page = open_page()
    _settle(page, ['chart-helix-pairs'])
    card = page.locator('#card-chart-helix-pairs')
    card.locator('.lrow[data-pair="TM3-TM6"]').click()
    side = card.locator('.chart-card-side')
    expect(side.locator('h4')).to_contain_text('TM3-TM6', timeout=15000)
    assert side.locator('table tbody tr').count() > 100
    href = side.locator('table tbody tr a').first.get_attribute('href')
    assert href.startswith('reports/') and href.endswith('.html')
    assert 'pair:TM3-TM6' in page.url
    # a line of the bundle opens it too
    card.locator('.chart-card-side .side-close').click()
    page.locator('#chart-helix-pairs path[data-hit]').first.click()
    expect(side.locator('h4')).to_be_visible(timeout=15000)
    # a mode change closes the panel in Magnitude
    card.locator('[data-ctl="mode"] [data-value="magnitude"]').click()
    expect(side).to_be_hidden()
    assert 'bm=magnitude' in page.url
    card.locator('[data-ctl="mode"] [data-value="grid"]').click()
    page.wait_for_timeout(300)
    assert page.locator('#chart-helix-pairs rect[data-hit]').count() >= 15
    assert _errors(page) == []


@needs_build
def test_a_small_group_shows_the_carried_by_state(open_page):
    page = open_page()
    _settle(page, ['chart-helix-pairs'])
    card = page.locator('#card-chart-helix-pairs')
    card.locator('[data-ctl="group"] button[data-value="Melatonin receptors"]').click()
    page.wait_for_timeout(300)
    assert 'carried by 2 of 2' in card.locator('[data-ledger]').inner_text()
    assert card.locator('[data-ledger] .group-chips-list button').count() == 2
    assert 'fewer than the 10 a class direction needs' in card.locator('[data-guide]').inner_text()
    assert '2 receptors (melatonin).' in card.locator('[data-scope]').inner_text()
    card.locator('[data-ledger] .group-chips-list button').first.click()
    assert 'sel=rec:' in page.url


@needs_build
@needs_plotly
def test_the_selection_box_follows_a_receptor(open_page):
    page = open_page()
    box = page.locator('#sel-input')
    box.fill('ADRB2')
    page.locator('#sel-list [role="option"]').first.wait_for()
    box.press('Enter')
    page.wait_for_timeout(300)
    assert 'sel=rec:adrb2_human' in page.url
    assert 'ADRB2' in page.locator('[data-sel-summary]').inner_text()
    assert page.locator('.sel-chip').count() == 1
    _settle(page, ['chart-receptors', 'chart-thresholds'])
    page.locator('#card-chart-receptors [data-ctl="tab"] [data-value="table"]').click()
    expect(page.locator('#card-chart-receptors .explorer-table tbody tr').first).to_be_visible()
    assert page.locator('#card-chart-receptors .explorer-table tbody tr').count() == 283
    assert page.locator('#card-chart-receptors .explorer-table tr.is-found').count() == 1
    # the table header sorts from the keyboard
    th = page.locator('#card-chart-receptors .explorer-table thead').get_by_role('button', name='Threshold', exact=True)
    th.focus()
    page.keyboard.press('Enter')
    assert page.locator('#card-chart-receptors .explorer-table th[aria-sort="descending"]').count() == 1
    # the threshold strips label the followed receptor
    assert 'ADRB2' in page.locator('#chart-thresholds').inner_text()
    page.locator('.sel-chip button').click()
    assert 'sel=' not in page.url
    assert _errors(page) == []


@needs_build
def test_a_ranking_row_opens_the_profile_and_esc_clears_it(open_page):
    page = open_page()
    _settle(page, ['chart-ranking'])
    page.locator('#chart-ranking g[data-gn="7.53x53"] rect[data-hit]').click()
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=10000)
    expect(prof.locator('.pgn')).to_contain_text('7.53x53')
    assert 'sel=pos:7.53x53' in page.url
    assert 'of 283 receptors have a CFR here' in prof.inner_text()
    page.keyboard.press('Escape')
    expect(prof).to_have_count(0)
    assert 'sel=' not in page.url
    assert _errors(page) == []


@needs_build
def test_url_selection_on_load(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48')
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=15000)
    expect(prof.locator('.pgn')).to_contain_text('6.48x48')
    assert '245 of 283' in prof.inner_text()
    page = open_page('/statistics.html?sel=pair:TM3-TM6')
    _settle(page, ['chart-helix-pairs'])
    expect(page.locator('#card-chart-helix-pairs .lrow.is-sel[data-pair="TM3-TM6"]')).to_have_count(1)
    assert 'TM3-TM6: weaker in the active model in 210 of 264' in page.locator('[data-sel-summary]').inner_text()
    page = open_page('/statistics.html?sel=bogus:1')
    _settle(page, ['chart-thresholds'])
    assert _errors(page) == []
    assert 'Nothing selected' in page.locator('[data-sel-summary]').inner_text()


@needs_build
def test_a_folded_chart_redraws_in_the_new_theme_when_opened(open_page):
    page = open_page()
    _settle(page, ['chart-histogram'])
    light = page.evaluate("document.querySelector('#chart-histogram rect[data-tip]').getAttribute('fill')")
    page.evaluate("document.getElementById('more-histogram').open = false")
    page.locator('#theme-toggle, .theme-toggle').first.click()
    page.wait_for_timeout(300)
    page.evaluate("document.getElementById('more-histogram').open = true")
    page.wait_for_timeout(500)
    dark = page.evaluate("document.querySelector('#chart-histogram rect[data-tip]').getAttribute('fill')")
    assert light != dark


@needs_build
@needs_plotly
def test_reduced_motion_runs_no_animation(open_page):
    page = open_page(reduced_motion='reduce')
    _settle(page, ['chart-thresholds', 'chart-helix-pairs', 'chart-recovery', 'chart-am-bands'])
    assert page.evaluate("document.getAnimations().filter(a => a.playState === 'running').length") == 0


@needs_build
def test_copied_caption_names_title_scope_and_source(open_page):
    page = open_page()
    _settle(page, ['chart-pathogenicity'])
    page.evaluate("""() => { window.__copied = null; navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; }""")
    card = page.locator('#card-chart-pathogenicity')
    card.locator('[data-export-toggle]').click()
    card.locator('[data-copy-caption]').click()
    page.wait_for_timeout(200)
    text = page.evaluate('window.__copied')
    assert text and text.startswith('Predicted class of the substitutions seen in people.')
    assert 'Scope: 276 receptors' in text and 'gnomAD v4.1.0' in text
    assert 'paper' not in text.lower() and 'layer' not in text.lower() and 'Supplementary' not in text
    assert 'statistics.html#card-chart-pathogenicity' in text


@needs_build
def test_without_javascript_the_server_parts_render(browser, server):
    ctx = browser.new_context(java_script_enabled=False, viewport=DESKTOP)
    page = ctx.new_page()
    page.goto(server + '/statistics.html', wait_until='load')
    assert page.locator('.glance-fact').count() == 4
    assert page.locator('.finding').count() == 5
    assert page.locator('#chart-thresholds svg path.s-dots').count() == 2
    assert page.locator('#cfr-table tbody tr').count() == 50
    assert page.locator('#cfr-pairs-table tbody tr').count() == 20
    assert page.locator('.nojs-note').count() >= 10
    assert page.locator('.foot-tools button').count() == 0
    ctx.close()


# ------------------------------------------------------------------------------------- review round 1
def _rank_gn(rank):
    cp = __import__('json').loads((BUILD_DIR / 'data' / 'stats' / 'class_positions.json').read_text(encoding='utf-8'))
    cols = cp['ranking_columns']
    return {r[cols.index('rank')]: r[cols.index('gn')] for r in cp['ranking']}[rank]


@needs_build
def test_the_pairs_tab_draws_its_bars(open_page):
    page = open_page()
    _settle(page, ['chart-partners'])
    page.locator('#card-chart-partners [data-ctl="tab"] [data-value="pairs"]').click()
    page.wait_for_timeout(400)
    text = page.locator('#chart-partners').inner_text()
    assert 'NaN' not in text and 'undefined' not in text
    widths = page.evaluate("Array.from(document.querySelectorAll('#chart-partners rect')).map(r => +r.getAttribute('width'))")
    assert len(widths) == 20 and all(w > 0 for w in widths)
    assert page.locator('#card-chart-partners [data-ctl="tab"] [data-value="pairs"]').get_attribute('aria-pressed') == 'true'
    assert _errors(page) == []


@needs_build
def test_explorer_table_on_load(open_page):
    page = open_page('/statistics.html?rx=table')
    card = page.locator('#card-chart-receptors')
    card.scroll_into_view_if_needed()
    expect(card.locator('.explorer-table tbody tr').first).to_be_visible(timeout=15000)
    assert card.locator('.explorer-table tbody tr').count() == 283
    assert card.locator('[data-view-text]').inner_text().strip() != ''
    assert card.locator('.xmenu-list [data-export="svg"]').get_attribute('hidden') is not None
    assert _errors(page) == []


@needs_build
def test_phone_png_of_the_matrix_downloads(open_page):
    page = open_page(viewport=PHONE_390)
    _settle(page, ['chart-cfr-atlas'])
    card = page.locator('#card-chart-cfr-atlas')
    card.locator('[data-export-toggle]').click()
    with page.expect_download(timeout=15000) as dl:
        card.locator('.xmenu-list [data-export="png"]').click()
    assert dl.value.suggested_filename == 'gpcompare_cfr-atlas_groups.png'
    assert _errors(page) == []


def _matrix_point(page, col, y=None):
    """Page coordinates of a column of the matrix canvas (y: CSS px from its top; default the header band)."""
    return page.evaluate("""([col, y]) => { const cv = document.querySelector('#chart-cfr-atlas canvas'); const b = cv.getBoundingClientRect();
        const W = parseFloat(cv.style.width), cw = (W - 150 - 56) / 50;
        return [b.left + 150 + cw * col + cw / 2, b.top + (y === null ? 40 : y)]; }""", [col, y])


@needs_build
def test_a_matrix_header_click_selects_while_a_profile_is_open(open_page):
    page = open_page('/statistics.html?sel=pos:3.50x50')
    expect(page.locator('.pos-profile')).to_be_visible(timeout=15000)
    _settle(page, ['chart-cfr-atlas'])
    page.locator('#chart-cfr-atlas canvas').scroll_into_view_if_needed()
    x, y = _matrix_point(page, 1)
    page.mouse.click(x, y)
    gn = _rank_gn(2)
    expect(page.locator('.pos-profile .pgn')).to_contain_text(gn, timeout=10000)
    assert 'pos:' + gn in page.url
    # hovering a cell shows its tooltip
    x, y = _matrix_point(page, 0, 120)
    page.mouse.move(x, y)
    page.wait_for_timeout(150)
    assert page.locator('.st-tip').is_visible()
    assert ' at 3.50x50' in page.locator('.st-tip').inner_text()
    assert _errors(page) == []


@needs_build
@needs_plotly
def test_a_scatter_click_keeps_the_position(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48')
    _settle(page, ['chart-receptors'])
    page.locator('#chart-receptors .scatterlayer .point').first.wait_for(timeout=15000)
    page.locator('#chart-receptors .scatterlayer .point').nth(5).click(force=True)
    page.wait_for_timeout(500)
    assert 'pos:6.48x48' in page.url
    assert '6.48x48: stronger in the active model' in page.locator('#card-chart-receptors [data-view-text]').inner_text()
    assert _errors(page) == []


@needs_build
def test_escape_in_a_control_keeps_the_position(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48')
    expect(page.locator('.pos-profile')).to_be_visible(timeout=15000)
    box = page.locator('#sel-input')
    box.fill('ccr')
    page.locator('#sel-list [role="option"]').first.wait_for()
    box.press('Escape')
    assert page.locator('#sel-list').is_hidden()
    assert 'pos:6.48x48' in page.url and page.locator('.pos-profile').count() == 1
    _settle(page, ['chart-segments'])
    card = page.locator('#card-chart-segments')
    card.locator('[data-export-toggle]').click()
    page.keyboard.press('ArrowDown')
    assert page.evaluate("document.activeElement.getAttribute('data-export')") == 'svg'
    page.keyboard.press('Escape')
    assert card.locator('.xmenu-list').is_hidden()
    assert 'pos:6.48x48' in page.url and page.locator('.pos-profile').count() == 1


@needs_build
def test_back_returns_the_selection_of_the_entry(open_page):
    page = open_page()
    page.locator('a[href="#sec-c"]:visible').first.click()
    page.wait_for_timeout(200)
    box = page.locator('#sel-input')
    box.fill('CCR5')
    page.locator('#sel-list [role="option"]').first.wait_for()
    box.press('Enter')
    page.wait_for_timeout(300)
    assert 'sel=rec:ccr5_human' in page.url
    page.go_back()
    page.wait_for_timeout(400)
    assert 'sel=' not in page.url
    assert 'Nothing selected' in page.locator('[data-sel-summary]').inner_text()


@needs_build
def test_profile_opens_in_view_takes_focus_and_gives_it_back(open_page):
    page = open_page()
    _settle(page, ['chart-ranking'])
    bar = page.locator('#card-chart-ranking [data-strip368] rect.hitcol[data-gn="%s"]' % _rank_gn(300))
    bar.scroll_into_view_if_needed()
    bar.click()
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=10000)
    page.wait_for_timeout(600)
    box = prof.bounding_box()
    vh = page.viewport_size['height']
    assert box['y'] < vh and box['y'] + box['height'] > 0, box
    page.keyboard.press('Escape')
    expect(prof).to_have_count(0)
    # keyboard: Enter on a ranking row moves focus into the profile, Escape gives it back to the row
    row = page.locator('#chart-ranking [aria-label="Open the profile of 7.53x53"]')
    row.focus()
    page.keyboard.press('Enter')
    expect(prof).to_be_visible(timeout=10000)
    page.wait_for_timeout(200)
    assert page.evaluate("document.activeElement.classList.contains('pos-profile')")
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    assert page.evaluate("document.activeElement.getAttribute('data-key')") == 'Open the profile of 7.53x53'
    # one Tab stop for the ranking chart
    stops = page.evaluate("Array.from(document.querySelectorAll('#chart-ranking [tabindex=\"0\"], #chart-ranking a:not([tabindex=\"-1\"])')).length")
    assert stops == 1, stops


@needs_build
def test_recovery_and_scaffold_name_their_ranks_and_counts(open_page):
    page = open_page('/statistics.html?sel=pos:3.51x51')
    _settle(page, ['chart-recovery', 'chart-scaffold'])
    rc = page.locator('#card-chart-recovery')
    assert 'rank among the 262 positions' in rc.locator('#chart-recovery').inner_text()
    note = rc.locator('[data-rec-note]').inner_text()
    assert '113 of the 262' in note and 'rank 117 by CFR score' in note
    tip = page.evaluate("document.querySelector('#chart-scaffold [data-gn=\"4.47x47\"]').getAttribute('data-tip')")
    assert 'CFR in 1 of 283' in tip


@needs_build
def test_small_group_grid_and_the_numbered_receptor_table(open_page):
    page = open_page()
    _settle(page, ['chart-helix-pairs'])
    card = page.locator('#card-chart-helix-pairs')
    card.locator('[data-ctl="group"] button[data-value="Melatonin receptors"]').click()
    card.locator('[data-ctl="mode"] [data-value="grid"]').click()
    page.wait_for_timeout(300)
    assert page.locator('#chart-helix-pairs rect[data-hit]').count() > 0
    assert '2/2' in page.locator('#chart-helix-pairs').inner_text()
    assert 'without a direction' in card.locator('[data-guide]').inner_text()
    assert card.locator('[data-ledger] .group-chips-list button').count() == 2
    # the per-position side table marks which receptors have a CFR there
    page = open_page('/statistics.html?sel=pos:8.48x48')
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=15000)
    prof.get_by_role('button', name='Receptors numbered here, with their variants').click()
    side = page.locator('#card-chart-cfr-variants .chart-card-side')
    expect(side.locator('table')).to_be_visible(timeout=15000)
    heads = side.locator('thead th').all_inner_texts()
    assert 'CFR' in heads
    k = heads.index('CFR')
    yes = page.evaluate("k => Array.from(document.querySelectorAll('#card-chart-cfr-variants .chart-card-side tbody tr')).filter(r => r.children[k].textContent === 'yes').length", k)
    assert 0 < yes <= 113
    assert 'have a CFR here' in side.inner_text()
