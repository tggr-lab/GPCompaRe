"""The Statistics page in a browser: overlays, anchors and labels that must not cover each other.

Each test pins one round-3 review finding:

  * the finder's suggestion list in the desktop rail is never clipped by the rail, and stays in the window;
  * the position profile sits under the sticky topbar (desktop) and under the menu drawer (phone);
  * a card link (#card-...) lands with the card title below the topbar;
  * on a phone the folded profile never covers the end of the page;
  * the helix-pair ledger keeps its bars on small desktops, with no sideways scroll, and a click on a row brings
    the receptor panel into view;
  * a position picked on the strip of all 368 positions opens its profile above the strip;
  * an SVG that holds buttons or links is a group, not an image;
  * selection labels clear the chart labels (families on a phone, partners, conservation, recovery);
  * the phone matrix rounds its group shares once, from the counts;
  * the TM6 motif labels of the scaffold keep apart at 320 px;
  * the explorer scatter shrinks beside the receptor panel.

    SEARCH_BUILD_DIR=<build> .venv-test/bin/python -m pytest GPCompaReports_v2/tests/test_statistics_layers.py
"""
import pytest

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter. Run from the project venv.')
from playwright.sync_api import expect  # noqa: E402

from GPCompaReports_v2.tests.test_search_browser import DESKTOP, PHONE_390, browser, server  # noqa: E402,F401
from GPCompaReports_v2.tests.test_statistics_browser import (  # noqa: E402,F401
    CARDS, _errors, _no_horizontal_scroll, _settle, needs_build, needs_plotly, open_page,
)

WIDE = {'width': 1440, 'height': 900}

# text boxes of one SVG that overlap (more than 2 x 3 px)
OVERLAPS = """sel => { const svg = document.querySelector(sel); if (!svg) return ['no svg ' + sel];
  const ts = [...svg.querySelectorAll('text')].map(t => [t.textContent, t.getBoundingClientRect()]).filter(x => x[1].width > 0 && x[0].trim());
  const out = [];
  for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
    const a = ts[i][1], b = ts[j][1];
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 2 && oy > 3) out.push(ts[i][0] + ' x ' + ts[j][0]);
  }
  return out; }"""


def _top_of_topbar(page):
    return page.evaluate("document.querySelector('.topbar').getBoundingClientRect().bottom")


# ------------------------------------------------------------------------------------------- the finder
@needs_build
@pytest.mark.parametrize('vp', [WIDE, {'width': 1280, 'height': 720}])
def test_the_rail_finder_list_is_not_clipped(open_page, vp):
    page = open_page(viewport=vp)
    for y in (0, 3000):
        page.evaluate('y => window.scrollTo(0, y)', y)
        page.wait_for_timeout(300)
        page.locator('#sel-input').click()
        page.locator('#sel-input').fill('')
        page.keyboard.type('ad')
        expect(page.locator('#sel-list')).to_be_visible()
        page.wait_for_timeout(200)
        r = page.evaluate("""() => { const l = document.getElementById('sel-list'), b = l.getBoundingClientRect(),
            rail = document.querySelector('.stats-rail');
            const hit = document.elementFromPoint(b.left + 20, b.bottom - 6);
            return { top: b.top, bottom: b.bottom, vh: innerHeight, inList: !!(hit && hit.closest('#sel-list')),
                     railScrolls: rail.scrollHeight > rail.clientHeight + 1, options: l.querySelectorAll('[role=option]').length }; }""")
        assert r['options'] == 8, r
        assert r['inList'] and not r['railScrolls'], (y, r)
        assert r['top'] >= _top_of_topbar(page) - 1 and r['bottom'] <= r['vh'], (y, r)
        page.keyboard.press('Escape')
    assert _errors(page) == []


# ------------------------------------------------------------------------------------------- layers
@needs_build
def test_the_profile_scrolls_under_the_topbar(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48', viewport=WIDE)
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=15000)
    top = page.evaluate("document.querySelector('.pos-profile').getBoundingClientRect().top + scrollY")
    page.evaluate('y => window.scrollTo(0, y)', top - 40)   # the profile's top now runs under the topbar
    page.wait_for_timeout(300)
    hits = page.evaluate("""() => [[1150, 40], [1300, 40], [800, 60]].map(([x, y]) => {
        const e = document.elementFromPoint(x, y); return !!(e && e.closest('.topbar')); })""")
    assert hits == [True, True, True]


@needs_build
def test_the_phone_menu_covers_the_profile(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48', viewport=PHONE_390)
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=15000)
    prof.locator('.ppeek').click()   # unfold the sheet
    page.wait_for_timeout(300)
    page.locator('#mobile-nav-toggle').click()
    page.wait_for_timeout(500)
    covered = page.evaluate("""() => [...document.querySelectorAll('.mobile-drawer-nav a')].filter(a => {
        const r = a.getBoundingClientRect(); const e = document.elementFromPoint(r.left + 10, r.top + r.height / 2);
        return !(e && e.closest('.mobile-drawer')); }).map(a => a.textContent.trim())""")
    assert covered == []
    # the open drawer makes the page inert, so taps reach the menu either way: what the reader sees must be the
    # menu too, so the sheet paints below the drawer and its scrim
    z = page.evaluate("""() => [document.querySelector('.pos-profile'), document.querySelector('.mobile-drawer')]
        .map(n => parseInt(getComputedStyle(n).zIndex, 10))""")
    assert z[0] < z[1], z


@needs_build
@pytest.mark.parametrize('vp', [WIDE, PHONE_390])
def test_a_card_link_lands_below_the_topbar(open_page, vp):
    page = open_page('/statistics.html#card-chart-cfr-variants', viewport=vp)
    page.wait_for_timeout(3000)   # the cards above draw meanwhile
    title = page.evaluate("document.querySelector('#card-chart-cfr-variants .scard-title').getBoundingClientRect().top")
    assert _top_of_topbar(page) <= title <= _top_of_topbar(page) + 60, title


@needs_build
def test_the_folded_profile_leaves_the_end_of_the_page_reachable(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48', viewport=PHONE_390)
    expect(page.locator('.pos-profile.is-peek')).to_be_visible(timeout=15000)
    page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
    page.wait_for_timeout(400)
    r = page.evaluate("""() => { const p = document.querySelector('.pos-profile').getBoundingClientRect();
        const links = [...document.querySelectorAll('.site-footer a')].filter(a => a.getClientRects().length);
        return { sheet: p.top, last: Math.max(...links.map(a => a.getBoundingClientRect().bottom)) }; }""")
    assert r['last'] <= r['sheet'], r


# ------------------------------------------------------------------------------------------- the ledger
@needs_build
@pytest.mark.parametrize('w', [1100, 1105, 1150, 1180])
def test_the_ledger_keeps_its_bars_on_small_desktops(open_page, w):
    page = open_page(viewport={'width': w, 'height': 900})
    _settle(page, ['chart-helix-pairs'])
    widths = page.evaluate("[...document.querySelectorAll('#card-chart-helix-pairs .lrow .lbar')].map(b => b.getBoundingClientRect().width)")
    assert widths and min(widths) >= 60, widths
    assert _no_horizontal_scroll(page)


@needs_build
def test_a_ledger_click_brings_the_receptor_panel_into_view(open_page):
    page = open_page(viewport={'width': 1280, 'height': 800})
    _settle(page, ['chart-helix-pairs'])
    row = page.locator('#card-chart-helix-pairs .lrow').nth(2)
    row.evaluate("r => window.scrollTo(0, r.getBoundingClientRect().top + scrollY - innerHeight / 2)")
    page.wait_for_timeout(300)
    row.click()
    side = page.locator('#card-chart-helix-pairs .chart-card-side')
    expect(side).to_be_visible(timeout=10000)
    page.wait_for_timeout(900)
    r = side.evaluate("s => { const b = s.getBoundingClientRect(); return [b.top, b.bottom, innerHeight]; }")
    assert r[0] >= 0 and r[0] < r[2] - 100, r


# ------------------------------------------------------------------------------------------- the strip
@needs_build
def test_a_strip_column_opens_the_profile_above_the_strip(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-ranking'])
    strip = page.locator('[data-strip368] svg')
    strip.scroll_into_view_if_needed()
    page.locator('[data-strip368] rect.hitcol[data-gn="8.61x61"]').click()
    prof = page.locator('.pos-profile')
    expect(prof.locator('.pgn')).to_contain_text('8.61x61', timeout=10000)
    page.wait_for_timeout(900)
    p = prof.evaluate("p => p.getBoundingClientRect().bottom")
    s = strip.evaluate("s => s.getBoundingClientRect().top")
    assert p <= s, (p, s)
    page.locator('[data-strip368] rect.hitcol[data-gn="5.26x27"]').click()   # the last column is still there to click
    expect(prof.locator('.pgn')).to_contain_text('5.26x27', timeout=10000)
    assert 'sel=pos:5.26x27' in page.url


# ------------------------------------------------------------------------------------------- roles
@needs_build
@needs_plotly
def test_a_chart_with_controls_is_a_group_not_an_image(open_page):
    page = open_page('/statistics.html?sel=rec:hrh1_human', viewport=WIDE)
    _settle(page, CARDS)
    bad = page.evaluate("""() => [...document.querySelectorAll('.stats svg[role=img]')]
        .filter(s => s.querySelector('[role=button], a[href]')).map(s => (s.closest('.scard') || {}).id)""")
    assert bad == []
    assert page.locator('#chart-ranking svg[role=group]').count() >= 1


# ------------------------------------------------------------------------------------------- labels
@needs_build
def test_the_followed_receptor_label_clears_the_row_label_on_a_phone(open_page):
    page = open_page('/statistics.html?sel=rec:mtr1a_human&rx=families', viewport=PHONE_390)
    _settle(page, ['chart-receptors'])
    page.wait_for_timeout(400)
    assert page.evaluate(OVERLAPS, '#chart-receptors svg') == []


@needs_build
@pytest.mark.parametrize('path,vp,card', [
    ('?sel=pos:8.49x49', 'wide', 'chart-partners'),
    ('?sel=pos:3.50x50', 'phone', 'chart-position-conservation'),
    ('?sel=pos:6.28x29', 'wide', 'chart-position-conservation'),
    ('?sel=pos:6.47x47', 'phone', 'chart-recovery'),
])
def test_selection_labels_clear_the_chart_labels(open_page, path, vp, card):
    page = open_page('/statistics.html' + path, viewport=WIDE if vp == 'wide' else PHONE_390)
    _settle(page, [card])
    page.wait_for_timeout(300)
    assert page.evaluate(OVERLAPS, '#%s svg' % card) == []


@needs_build
def test_the_phone_matrix_rounds_group_shares_once(open_page):
    page = open_page(viewport=PHONE_390)
    _settle(page, ['chart-cfr-atlas'])
    tips = page.evaluate("""() => [...document.querySelectorAll('#chart-cfr-atlas rect[data-tip]')]
        .map(r => r.getAttribute('data-tip')).filter(t => t.startsWith('Orphan at 7.32x31'))""")
    assert tips == ['Orphan at 7.32x31: 38% with a CFR (30 of 78)']


@needs_build
def test_the_tm6_motif_labels_keep_apart_at_320(open_page):
    page = open_page(viewport={'width': 320, 'height': 844})
    _settle(page, ['chart-scaffold'])
    boxes = page.evaluate("""() => { const t = [...document.querySelectorAll('#chart-scaffold svg text')];
        const get = s => t.filter(x => x.textContent === s).map(x => x.getBoundingClientRect());
        const pif = get('PIF'), cw = get('CWxP')[0];
        const same = pif.filter(b => Math.abs(b.top - cw.top) < 2)[0];
        return [same.right, cw.left]; }""")
    assert boxes[1] - boxes[0] >= 5, boxes


@needs_build
@needs_plotly
def test_the_scatter_shrinks_beside_the_receptor_panel(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-receptors'])
    page.wait_for_function("() => document.querySelector('#chart-receptors .plot-container')", timeout=20000)
    page.evaluate("""() => { const g = document.querySelector('#chart-receptors .js-plotly-plot');
        g.emit('plotly_click', { points: [{ customdata: 'gpr17_human' }] }); }""")
    side = page.locator('#card-chart-receptors .chart-card-side')
    expect(side).to_be_visible(timeout=10000)
    page.wait_for_timeout(1200)
    r = page.evaluate("""() => { const p = document.querySelector('#chart-receptors .main-svg').getBoundingClientRect(),
        s = document.querySelector('#card-chart-receptors .chart-card-side').getBoundingClientRect();
        return [p.right, s.left]; }""")
    assert r[0] <= r[1] + 1, r
    assert _errors(page) == []
