"""Nothing on a report folds away for good, and the RRCS Tetris block can be found by chance.

1. The collapse trap (owner report, 2026-11-05). "Compact view" folds every report section
   to its heading with one click and is remembered in localStorage, so every reload and
   every other report opened folded too. A folded section showed only its heading and a
   12 px glyph: the heading was a mouse-only target (no button, not in the Tab order), the
   section menu and #sec=... links (search landings included) scrolled to it without
   opening it, and the way out, "Compact view: on", sat far up the page. Since the fix,
   every folded section has a Show button, the sticky section menu has "Expand all" while
   anything is folded, and a link that lands on a folded section opens it.
   The general rule is checked for every collapsible part of the page: fold it with its
   control, find a visible control to bring it back, use it, reload, and do it again.
2. Tetris: a small block next to the "ΔRRCS distribution" heading; lingering on the
   histogram or clicking a bar wiggles it once and shows a one-line hint that starts the
   game. Idle pages and phones show only the block; no motion under reduced motion.

Browser checks drive a built site in headless Chromium (SMOKE_BUILD_DIR / FREEZE_BUILD_DIR,
as tests/test_report_v3.py) and skip without Playwright or a build.
"""
import pytest

from .test_report_v3 import (BUILD_DIR, DESKTOP, PHONE, PLOTLY_JS, BLOCKED, needs_build,  # noqa: F401
                             needs_plotly, server, browser, open_report, _pick, _errors)

expect = pytest.importorskip('playwright.sync_api').expect

COMPACT_KEY = 'gpcompare-compact'


def _new_page(browser, server, gid, viewport=DESKTOP, dark=False, compact=False, hash_='',
              reduced_motion='no-preference', touch=False, plotly=True, wait=600):
    ctx = browser.new_context(viewport=viewport, color_scheme='dark' if dark else 'light',
                              reduced_motion=reduced_motion, has_touch=touch, is_mobile=touch)
    page = ctx.new_page()
    page.errors, page.requests, page.console_errors = [], [], []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and page.console_errors.append(
        (m.text, (m.location or {}).get('url', ''))))
    for pattern in BLOCKED:
        page.route(pattern, lambda route: route.abort())
    if plotly and PLOTLY_JS is not None:
        page.route('**/cdn.plot.ly/**', lambda route: route.fulfill(
            path=str(PLOTLY_JS), content_type='application/javascript'))
    else:
        page.route('**/cdn.plot.ly/**', lambda route: route.abort())
    if compact:
        page.add_init_script("try { localStorage.setItem('%s', '1'); } catch (e) {}" % COMPACT_KEY)
    page.goto('%s/reports/%s.html%s' % (server, gid, hash_), wait_until='load')
    page.wait_for_timeout(wait)
    return ctx, page


@pytest.fixture
def new_page(browser, server):
    contexts = []

    def _open(gid, **kw):
        ctx, page = _new_page(browser, server, gid, **kw)
        contexts.append(ctx)
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


FOLDED = '.report-section.v3-folded'


def _folded_ids(page):
    return page.evaluate("Array.from(document.querySelectorAll('%s')).map(s => s.id)" % FOLDED)


def _visible_body(page, sid):
    """How many of the section's own blocks (besides its heading) are on screen."""
    return page.evaluate("""(id) => Array.from(document.getElementById(id).children)
      .filter(c => !c.classList.contains('report-section-head') && c.getClientRects().length).length""", sid)


def _fold_btn(page, sid):
    return page.locator('#%s > .report-section-head .v3-fold-btn' % sid)


# ---- 1. the exact reproduction ------------------------------------------------------------

@needs_build
@pytest.mark.parametrize('viewport,dark', [(DESKTOP, False), (PHONE, True)])
def test_compact_view_after_a_reload_is_not_a_trap(new_page, viewport, dark):
    gid = _pick()
    page = new_page(gid, viewport=viewport, dark=dark)
    # the default page draws none of the fold controls
    assert page.locator('.v3-fold-btn').count() == 0
    assert not page.locator('#v3-expand-all').is_visible()

    # one click (by accident) folds every section, and the choice is remembered
    page.click('#v3-compact-toggle')
    page.reload(wait_until='load')
    page.wait_for_timeout(600)
    folded = _folded_ids(page)
    assert 'sec-changes' in folded and 'sec-methods' in folded, folded

    # every folded section shows a real, named, keyboard operable Show button
    for sid in folded:
        btn = _fold_btn(page, sid)
        assert btn.count() == 1, '%s: no Show button on the folded section' % sid
        btn.scroll_into_view_if_needed()
        assert btn.is_visible(), sid
        assert btn.get_attribute('aria-expanded') == 'false'
        assert btn.inner_text().strip() == 'Show'
        assert _visible_body(page, sid) == 0, '%s: a folded section still shows its content' % sid

    # by keyboard: focus the button, Enter opens the section; Hide folds it again
    btn = _fold_btn(page, 'sec-changes')
    btn.focus()
    page.keyboard.press('Enter')
    assert 'sec-changes' not in _folded_ids(page)
    assert _visible_body(page, 'sec-changes') > 0
    expect(btn).to_have_attribute('aria-expanded', 'true')
    btn.focus()
    page.keyboard.press(' ')
    assert 'sec-changes' in _folded_ids(page)

    # "Expand all" is in the sticky section menu, on screen wherever the reader is
    page.evaluate("document.getElementById('sec-methods').scrollIntoView()")
    page.wait_for_timeout(200)
    expand = page.locator('#v3-expand-all')
    assert expand.is_visible()
    box = expand.bounding_box()
    assert 0 <= box['y'] < viewport['height'] and box['x'] + box['width'] <= viewport['width'] + 1, box
    expand.click()
    assert _folded_ids(page) == []
    assert not expand.is_visible()
    assert page.locator('.v3-fold-btn').count() == 0, 'leaving Compact view takes the buttons away'
    expect(page.locator('#v3-compact-toggle')).to_have_attribute('aria-pressed', 'false')
    assert page.evaluate("localStorage.getItem('%s')" % COMPACT_KEY) is None

    # and the next visit opens unfolded
    page.reload(wait_until='load')
    page.wait_for_timeout(500)
    assert _folded_ids(page) == []
    assert _errors(page) == []


@needs_build
@pytest.mark.parametrize('how', ['menu', 'hash', 'search-landing'])
def test_a_link_to_a_folded_section_opens_it(new_page, how):
    gid = _pick()
    if how == 'menu':
        page = new_page(gid, compact=True)
        assert 'sec-tm' in _folded_ids(page)
        page.click('.v3-secnav a[data-target="sec-tm"]')
        page.wait_for_timeout(400)
        sid = 'sec-tm'
    elif how == 'hash':
        page = new_page(gid, compact=True, hash_='#sec=sec-rrcs')
        sid = 'sec-rrcs'
    else:
        page = new_page(gid, compact=True, hash_='#sec=sec-variants&vq=p.')
        sid = 'sec-variants'
        if not page.locator('#sec-variants').count():
            pytest.skip('no variants section')
    assert sid not in _folded_ids(page), '%s stayed folded after a link to it' % sid
    assert _visible_body(page, sid) > 0
    top = page.evaluate("document.getElementById('%s').getBoundingClientRect().top" % sid)
    assert -5 < top < 400, 'the page did not land on %s (top %s)' % (sid, top)
    # the rest stays as the reader left it
    assert 'sec-methods' in _folded_ids(page)
    assert _errors(page) == []


@needs_build
@needs_plotly
def test_charts_folded_at_load_fit_their_section_when_opened(new_page):
    page = new_page(_pick('id="delta-chart"'), compact=True, wait=1500)
    # a folded Visualizations section hides its TM breakdown row too (inline display)
    assert _visible_body(page, 'sec-charts') == 0
    _fold_btn(page, 'sec-charts').click()
    page.wait_for_timeout(600)
    w = page.evaluate("""(() => { var c = document.getElementById('delta-chart');
      var s = c.querySelector('.main-svg'); return [c.getBoundingClientRect().width, s ? s.getBoundingClientRect().width : 0]; })()""")
    assert w[1] > 0 and abs(w[0] - w[1]) < 4, 'the chart kept the width it was drawn at while folded: %s' % w


# ---- 2. the general rule: every collapsible part has a control that brings it back --------

DETAILS = """(() => Array.from(document.querySelectorAll('main details, .report-page details'))
  .filter(d => d.querySelector(':scope > summary') && d.getClientRects().length)
  .map((d, i) => { d.dataset.tCollapse = String(i); return i; }))()"""


@needs_build
@pytest.mark.parametrize('viewport,dark', [(DESKTOP, False), (DESKTOP, True), (PHONE, False), (PHONE, True)])
def test_every_collapsible_part_can_be_brought_back(new_page, viewport, dark):
    gid = _pick()
    page = new_page(gid, viewport=viewport, dark=dark)

    def check_all(round_):
        # (a) report sections, through Compact view and their own buttons
        if page.get_attribute('#v3-compact-toggle', 'aria-pressed') != 'true':
            page.click('#v3-compact-toggle')
        for sid in _folded_ids(page):
            btn = _fold_btn(page, sid)
            btn.scroll_into_view_if_needed()
            assert btn.is_visible(), '%s (%s): folded with no visible control' % (sid, round_)
            btn.click()
            assert _visible_body(page, sid) > 0, sid
            btn.click()
            assert sid in _folded_ids(page)
            btn.click()
        assert _folded_ids(page) == []
        page.click('#v3-compact-toggle')                     # Compact view off again

        # (b) every <details> on the page: closed, its summary is still there to reopen it
        for i in page.evaluate(DETAILS):
            d = page.locator('details[data-t-collapse="%d"]' % i)
            s = d.locator(':scope > summary')
            if not s.is_visible():
                continue                                       # inside a closed parent
            was = d.evaluate('d => d.open')
            for _ in range(2):
                s.scroll_into_view_if_needed()
                s.click()
                page.wait_for_timeout(30)
                assert s.is_visible(), 'details %d: the summary went away (%s)' % (i, round_)
            assert d.evaluate('d => d.open') == was, 'details %d did not come back' % i

        # (c) the Understanding block's own control
        head = page.locator('.collapsible-head').first
        if head.count():
            head.scroll_into_view_if_needed()
            for _ in range(2):
                head.click()
                assert head.is_visible()
            expect(head).to_have_attribute('aria-expanded', 'false')

        # (d) the 3D panel: its toggle stays on screen in both states
        t3 = page.locator('#rx-3d-toggle')
        if t3.count():
            t3.scroll_into_view_if_needed()
            t3.click()
            page.wait_for_timeout(100)
            assert t3.is_visible()
            t3.click()
            page.wait_for_timeout(100)
            assert t3.is_visible() and page.locator('#rx-3d-panel').is_hidden()

        # (e) the selection bar: hidden by the reader (its close button or Escape); the chip
        # toggles, so the same chip clears and once more selects and shows the bar
        chip = page.locator('#gpc-pairs-core .gpc-pair').first
        if chip.count():
            bar = page.locator('#gpc-selbar')
            for hide in ('close', 'escape'):
                chip.scroll_into_view_if_needed()
                chip.click()
                page.wait_for_timeout(200)
                assert bar.is_visible()
                if hide == 'close':
                    page.locator('.gpc-selbar-close').click()
                else:
                    page.keyboard.press('Escape')
                assert not bar.is_visible()
                chip.click()
                page.wait_for_timeout(150)
                chip.click()
                page.wait_for_timeout(200)
                assert bar.is_visible(), 'the selection bar could not be brought back (%s, %s)' % (hide, round_)
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')
                page.wait_for_timeout(100)
            # a chart point picked again brings a hidden bar back
            if page.locator('#residue-chart .js-plotly-plot, #residue-chart.js-plotly-plot').count():
                page.evaluate("window.GPCSelect.select(%d, 'chart')" % chip.evaluate('c => +c.dataset.gpcA'))
                page.wait_for_timeout(150)
                assert bar.is_visible()
                page.locator('.gpc-selbar-close').click()
                page.evaluate("window.GPCSelect.select(%d, 'chart')" % chip.evaluate('c => +c.dataset.gpcA'))
                page.wait_for_timeout(150)
                assert bar.is_visible(), 'a deliberate re-pick did not bring the bar back'
            # leave no selection behind (it would come back from the hash on the reload)
            page.keyboard.press('Escape')
            page.keyboard.press('Escape')
            page.wait_for_timeout(100)
            assert not bar.is_visible() and 'pair=' not in page.evaluate('location.hash')

    check_all('first visit')
    page.reload(wait_until='load')
    page.wait_for_timeout(500)
    assert _folded_ids(page) == []
    check_all('after a reload')
    # the remembered Compact view, after a reload: every section is still reopenable
    page.click('#v3-compact-toggle')
    page.reload(wait_until='load')
    page.wait_for_timeout(500)
    for sid in _folded_ids(page):
        btn = _fold_btn(page, sid)
        btn.scroll_into_view_if_needed()
        btn.click()
    assert _folded_ids(page) == []
    # (a quick build has no 3D models, so opening the 3D view may log a 404: only script errors count)
    assert page.errors == []


@needs_build
def test_snake_loops_fold_and_unfold_from_their_own_label(new_page):
    page = new_page(_pick('toggleLoop('))
    loops = page.evaluate("""(() => Array.from(new Set(Array.from(document.querySelectorAll(
      '#snake-plot-container text[onclick*="toggleLoop"]')).map(e => e.getAttribute('class').split(' ')[0]))))()""")
    assert loops
    vis = """(seg) => Array.from(document.querySelectorAll('#snake-plot-container text.' + seg + '[onclick]'))
      .filter(e => getComputedStyle(e).display !== 'none').map(e => e.classList.contains('short') ? 'short' : 'long')"""
    for seg in loops[:4]:
        first = page.evaluate(vis, seg)
        assert first, seg
        for _ in range(2):
            mode = page.evaluate(vis, seg)[0]
            page.locator('#snake-plot-container text.%s.%s[onclick]' % (seg, mode)).first.dispatch_event('click')
            page.wait_for_timeout(50)
            assert page.evaluate(vis, seg), '%s: the loop left no label to click' % seg
        assert page.evaluate(vis, seg) == first


# ---- 3. Tetris: easy to stumble on, calm when idle ----------------------------------------

def _tetris_ready(page):
    page.locator('.rrcs-tetris-toggle').scroll_into_view_if_needed()
    page.wait_for_function("document.getElementById('delta-chart').dataset.chartRendered === '1'")


@needs_build
def test_the_block_is_there_and_quiet_until_the_reader_lingers(new_page):
    page = new_page(_pick('id="delta-chart"'), plotly=False)
    btn = page.locator('.rrcs-tetris-toggle')
    assert btn.count() == 1 and btn.is_visible()
    assert btn.locator('svg.rrcs-tetris-icon rect').count() == 4
    assert float(btn.evaluate('b => getComputedStyle(b).opacity')) >= 0.6, 'the block is too faint to find'
    assert btn.get_attribute('aria-label') == 'Play RRCS Tetris'
    assert page.locator('.rrcs-tetris-hint').is_hidden()
    assert 'is-wiggle' not in (btn.get_attribute('class') or '')
    # the hint and the block are not in the approved section's built text
    assert page.locator('.rrcs-tetris-hint').count() == 1
    # keyboard: Tab reaches the block, Enter starts the game
    btn.focus()
    page.keyboard.press('Enter')
    page.wait_for_timeout(200)
    assert page.locator('.rrcs-tetris').is_visible()


@needs_build
@needs_plotly
def test_lingering_on_the_histogram_offers_the_game_once(new_page):
    page = new_page(_pick('id="delta-chart"'), wait=1200)
    _tetris_ready(page)
    hint = page.locator('.rrcs-tetris-hint')
    page.hover('#delta-chart', position={'x': 200, 'y': 160})
    page.wait_for_timeout(1100)
    assert hint.is_visible()
    assert 'is-wiggle' in page.get_attribute('.rrcs-tetris-toggle', 'class') or \
        page.evaluate("getComputedStyle(document.querySelector('.rrcs-tetris-icon')).animationName") != 'none'
    assert '—' not in hint.inner_text()
    hint.click()
    page.wait_for_timeout(300)
    assert page.locator('.rrcs-tetris').is_visible()
    assert page.locator('#delta-chart').is_hidden()
    assert hint.is_hidden()
    page.click('.rrcs-tetris [data-a="exit"]')
    assert page.locator('#delta-chart').is_visible()
    # played once in this browser: the hint stays away, the block stays
    page.reload(wait_until='load')
    page.wait_for_timeout(1200)
    _tetris_ready(page)
    page.hover('#delta-chart', position={'x': 200, 'y': 160})
    page.wait_for_timeout(1100)
    assert page.locator('.rrcs-tetris-hint').is_hidden()
    assert page.locator('.rrcs-tetris-toggle').is_visible()
    assert _errors(page) == []


@needs_build
@needs_plotly
def test_a_click_on_a_bar_offers_the_game_without_motion_under_reduced_motion(new_page):
    page = new_page(_pick('id="delta-chart"'), reduced_motion='reduce', wait=1200)
    _tetris_ready(page)
    bar = page.locator('#delta-chart .barlayer path').nth(0)
    # the tallest bar, so the click lands on it
    idx = page.evaluate("""(() => { var ps = Array.from(document.querySelectorAll('#delta-chart .barlayer path'));
      var best = 0, h = 0; ps.forEach((p, i) => { var r = p.getBoundingClientRect(); if (r.height > h) { h = r.height; best = i; } });
      return best; })()""")
    bar = page.locator('#delta-chart .barlayer path').nth(idx)
    box = bar.bounding_box()
    page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] - 4)
    page.wait_for_timeout(300)
    assert page.locator('.rrcs-tetris-hint').is_visible()
    assert page.evaluate("getComputedStyle(document.querySelector('.rrcs-tetris-icon')).animationName") == 'none'
    assert page.evaluate("getComputedStyle(document.querySelector('.rrcs-tetris-hint')).animationName") == 'none'
    assert page.locator('#delta-chart').is_visible(), 'a bar click never starts the game by itself'


@needs_build
@needs_plotly
def test_on_a_phone_the_block_shows_and_nothing_pops_up_on_its_own(new_page):
    page = new_page(_pick('id="delta-chart"'), viewport=PHONE, touch=True, dark=True, wait=1200)
    _tetris_ready(page)
    page.evaluate("window.scrollBy(0, 200)")
    page.wait_for_timeout(1000)
    assert page.locator('.rrcs-tetris-toggle').is_visible()
    assert page.locator('.rrcs-tetris-hint').is_hidden()
    # the heading row still fits the phone
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
