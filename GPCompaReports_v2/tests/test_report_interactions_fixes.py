"""Browser tests for report interaction fixes (2026-11-13):

- Reset filters takes min, max and dir out of the link (RD-5);
- a link or the selection bar's Plot button opens a collapsed loop or terminus so the residue shows (RD-6);
- on a phone, "Color by" shows the chosen view's colors under the menu and writes the view to the link (RD-8);
- the selection bar never docks over the 3D view's controls (RD-9);
- on a phone a tapped snake residue stays visible above the drawer and the bar (RD-10);
- the AlphaMissense snake view uses the clinical tint, not the red / blue of dRRCS (RD-11);
- on a phone the Tetris touch buttons sit right under the board, on screen (RD-14).

Playwright lives in the project venv; point at a build with SMOKE_BUILD_DIR (needs adrb2_human and
ccr5_human, hrh1_human for the loop cases; tests skip receptors the build lacks).
"""
import functools
import http.server
import os
import pathlib
import socketserver
import threading

import pytest

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter; run from the project venv')

BASE = pathlib.Path(__file__).resolve().parent.parent
_env = os.environ.get('SMOKE_BUILD_DIR')
BUILD = pathlib.Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD.is_absolute():
    BUILD = BASE / BUILD
REPORTS = BUILD / 'reports'
BLOCKED = ('**cdn.plot.ly/**', '**gc.zgo.at/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**')
PHONE = {'width': 390, 'height': 844}
DESKTOP = {'width': 1280, 'height': 900}

pytestmark = pytest.mark.skipif(not REPORTS.is_dir(), reason='no build at %s; set SMOKE_BUILD_DIR' % BUILD)


def need(gid):
    if not (REPORTS / (gid + '.html')).is_file():
        pytest.skip('%s is not in the build' % gid)


@pytest.fixture(scope='module')
def server():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(BUILD)))
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
    ctxs, errors = [], []

    def _open(gid, hash_='', viewport=DESKTOP, phone=False, theme='light'):
        need(gid)
        ctx = browser.new_context(viewport=viewport, has_touch=phone, is_mobile=phone, color_scheme=theme)
        for pat in BLOCKED:
            ctx.route(pat, lambda route: route.abort())
        ctxs.append(ctx)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('%s/reports/%s.html%s' % (server, gid, hash_), wait_until='load')
        page.wait_for_timeout(800)
        return page

    yield _open
    for c in ctxs:
        c.close()
    assert not errors, errors


def _snake_ready(page):
    page.evaluate("document.getElementById('snake-plot-container').scrollIntoView({block:'start'}); scrollBy(0,-130)")
    page.wait_for_function("document.documentElement.getAttribute('data-snake-plus') === 'on'", timeout=10000)
    page.wait_for_timeout(300)


def test_reset_filters_clears_the_link(open_report):
    page = open_report('adrb2_human')
    _snake_ready(page)
    page.evaluate("""()=>{const s=document.getElementById('snake-mag-min');s.value='4';
        s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));}""")
    page.locator('.snake-dir-btn[data-dir="active"]').first.click()
    page.wait_for_timeout(200)
    assert 'min=' in page.evaluate('location.hash') and 'dir=active' in page.evaluate('location.hash')
    page.locator('#snake-filter-reset').click()
    page.wait_for_timeout(200)
    h = page.evaluate('location.hash')
    assert 'min=' not in h and 'max=' not in h and 'dir=' not in h, h


def _circle_shown(page, res):
    return page.evaluate("""r=>{const c=document.querySelector('#snake-plot-container circle[id="'+r+'"]');
        if(!c||!c.getClientRects().length)return false;const b=c.getBoundingClientRect();
        return b.width>0&&b.top>0&&b.bottom<innerHeight}""", res)


@pytest.mark.parametrize('gid,hash_,res', [
    ('adrb2_human', '#res=390', 390),          # C-terminus
    ('hrh1_human', '#res=165', 165),           # ECL2
    ('hrh1_human', '#pair=304-409', 304),      # ICL3 to the C-terminus
])
def test_link_into_a_collapsed_loop_shows_the_residue(open_report, gid, hash_, res):
    page = open_report(gid, hash_)
    page.wait_for_timeout(1500)
    assert _circle_shown(page, res)
    page.evaluate('scrollTo(0,0)')
    page.wait_for_timeout(200)
    page.locator('.gpc-selbar-btn', has_text='Plot').first.click()
    page.wait_for_timeout(1500)
    assert _circle_shown(page, res)


@pytest.mark.parametrize('theme', ['light', 'dark'])
def test_phone_color_by_keeps_its_key_and_link(open_report, theme):
    page = open_report('ccr5_human', viewport=PHONE, phone=True, theme=theme)
    _snake_ready(page)
    for view in ('alphamissense', 'conservation', 'cfr'):
        page.select_option('#sp-colour-by', view)
        page.wait_for_timeout(200)
        assert page.evaluate('location.hash') == '#view=' + view
        # the view's colors show under the menu (the full legend stays in "Filters and tools")
        assert page.evaluate("(()=>{const k=document.querySelector('#sec-snake .sp-viewkey');return !!k&&k.checkVisibility()&&k.getBoundingClientRect().height>10})()")
    assert page.evaluate('document.documentElement.scrollWidth') <= 390


def test_alphamissense_view_is_not_red_or_blue(open_report):
    page = open_report('adrb2_human', '#view=alphamissense')
    _snake_ready(page)
    fills = set(page.evaluate("""()=>[...document.querySelectorAll('#snake-plot-container circle.rcircle')].map(c=>c.getAttribute('fill').toUpperCase())"""))
    assert fills <= {'#B4234B', '#555C68', '#2B6E2F', '#FFFFFF', 'WHITE'}, fills
    assert '#B4234B' in fills


@pytest.mark.parametrize('viewport', [DESKTOP, PHONE], ids=['1280', '390'])
def test_selection_bar_does_not_cover_the_3d_controls(open_report, viewport):
    page = open_report('adrb2_human', viewport=viewport, phone=viewport is PHONE)
    if not page.locator('#rx-3d-toggle').count():
        pytest.skip('no 3D view in this build')
    page.locator('#rx-3d-toggle').scroll_into_view_if_needed()
    page.locator('#rx-3d-toggle').click()
    page.wait_for_timeout(500)
    for off in (-130, 0, 300):
        page.evaluate("document.getElementById('rx-3d-panel').scrollIntoView({block:'start'}); scrollBy(0,%d)" % off)
        page.wait_for_timeout(200)
        page.evaluate("document.dispatchEvent(new CustomEvent('gpc:select-residue',{detail:{gid:'adrb2_human',res:105,source:'table'}}))")
        page.wait_for_timeout(400)
        covered = page.evaluate("""()=>{const b=document.getElementById('gpc-selbar').getBoundingClientRect();
            return [...document.querySelectorAll('#rx-3d-panel .rx-3d-tools button, #rx-3d-panel .rx-3d-tools select')]
              .filter(e=>e.offsetParent).map(e=>e.getBoundingClientRect())
              .filter(r=>r.bottom>0&&r.top<innerHeight&&r.top<b.bottom&&r.bottom>b.top).length}""")
        assert covered == 0, off
        page.keyboard.press('Escape')


def test_phone_tap_keeps_the_residue_above_the_sheet(open_report):
    page = open_report('adrb2_human', viewport=PHONE, phone=True)
    _snake_ready(page)
    res = page.evaluate("""()=>{const k=document.getElementById('snake-plot-container').getBoundingClientRect();
        const cs=[...document.querySelectorAll('#snake-plot-container circle[id]')].filter(c=>{const r=c.getBoundingClientRect();
        return r.width>0&&r.left>k.left+10&&r.right<k.right-60&&r.top>k.top+10&&r.bottom<k.bottom-10});
        cs.sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top);
        return cs.length?cs[cs.length-1].id:null}""")  # the lowest residue in view: the sheet would cover it
    assert res
    box = page.locator('#snake-plot-container circle[id="%s"]' % res).bounding_box()
    page.touchscreen.tap(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.wait_for_timeout(1200)
    r = page.evaluate("""id=>{const c=document.querySelector('#snake-plot-container circle[id="'+id+'"]').getBoundingClientRect();
        const d=document.getElementById('rx-drawer');const nav=document.querySelector('.v3-secnav');
        return {hidden:d.hidden,top:c.top,bottom:c.bottom,sheet:d.getBoundingClientRect().top,chrome:nav?nav.getBoundingClientRect().bottom:0}}""", res)
    assert not r['hidden']
    assert r['top'] >= r['chrome'] and r['bottom'] <= r['sheet'], r


def test_phone_tetris_controls_are_on_screen(open_report):
    page = open_report('ccr5_human', '#sec-charts', viewport=PHONE, phone=True)
    toggle = page.locator('.rrcs-tetris-toggle').first
    if not toggle.count():
        pytest.skip('no Tetris in this build')
    toggle.scroll_into_view_if_needed()
    toggle.tap()
    page.wait_for_timeout(800)
    r = page.evaluate("""()=>{const q=s=>document.querySelector(s).getBoundingClientRect();
        return {board:q('.rrcs-tetris-board canvas').top,touch:q('.rrcs-tetris-touch').bottom,vh:innerHeight}}""")
    assert r['board'] > 0 and r['touch'] <= r['vh'], r
