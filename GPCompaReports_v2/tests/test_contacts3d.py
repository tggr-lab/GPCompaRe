"""The contacts in the opt-in 3D view (viewer3d.js + the Studio's pair viewer).

The contacts are the rows of the page's complete RRCS table (#rrcs-table);
the highlighted rows (class significant-row) are the ones above the
receptor's ΔRRCS threshold and are what the view draws by default. These
tests drive a built report in headless Chromium (software WebGL is enough):

  * nothing from studio/ or models/ loads before "Show 3D view";
  * the number of drawn contacts equals the page's threshold-passing rows,
    and the toolbar's Top 25 / Off / stronger-in filters change it;
  * a pair chosen elsewhere (gpc:select-pair, as a table fires it) is framed
    and labelled with the table's ΔRRCS;
  * a click in 3D fires gpc:select-pair or gpc:select-residue with source '3d';
  * the cartoon is a calm grey while contacts draw; "Colour residues by net
    ΔRRCS" brings the residue colours and their caption back;
  * gpc:3d-ready fires; no console errors; no horizontal scroll at phone width.

They need a build with studio/embed and models/ (the release layout):

    SMOKE_BUILD_DIR=/path/to/stage ../.venv-test/bin/python -m pytest tests/test_contacts3d.py

and skip without one, or without Playwright.
"""
import functools
import http.server
import os
import pathlib
import re
import socketserver
import threading

import pytest

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'
REPORTS_DIR = BUILD_DIR / 'reports'

HAS_VIEWER = ((BUILD_DIR / 'studio' / 'embed' / 'pair-viewer.js').is_file()
              and (BUILD_DIR / 'models' / 'active').is_dir() and REPORTS_DIR.is_dir())
pytestmark = pytest.mark.skipif(not HAS_VIEWER, reason='%s has no reports, studio/embed or models/' % BUILD_DIR)

sync_api = pytest.importorskip('playwright.sync_api', reason='Playwright is not installed here; use the project venv')
expect = sync_api.expect

BLOCKED = ('**gc.zgo.at/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**', '**cdn.plot.ly/**')
DESKTOP = {'width': 1280, 'height': 900}
PHONE = {'width': 390, 'height': 844}
READY = 120000

# Records every gpc:* event from the start, so nothing fired before a test listens is lost.
RECORD = """
window.__gpc = [];
['gpc:select-residue', 'gpc:select-pair', 'gpc:hover-residue', 'gpc:hover-pair', 'gpc:3d-ready'].forEach(function (n) {
  document.addEventListener(n, function (e) { window.__gpc.push({ name: n, detail: e.detail }); });
});
"""


def _gids():
    """Reports with a 3D block and an RRCS table, a non-PAR receptor first."""
    out = []
    for p in sorted(REPORTS_DIR.glob('*_*.html')):
        h = p.read_text(encoding='utf-8')
        if 'id="sec-3d"' in h and 'id="rrcs-table"' in h:
            out.append(p.stem)
    return sorted(out, key=lambda g: (g.startswith('par'), g))


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

    def _open(gid, viewport=DESKTOP, dark=False):
        ctx = browser.new_context(viewport=viewport, color_scheme='dark' if dark else 'light')
        contexts.append(ctx)
        page = ctx.new_page()
        page.errors, page.requests, page.console_errors = [], [], []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and page.console_errors.append(m.text))
        page.on('request', lambda r: page.requests.append(r.url))
        page.on('requestfailed', lambda r: page.requests.append('FAILED ' + r.url))
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.add_init_script(RECORD)
        page.goto('%s/reports/%s.html' % (server, gid), wait_until='load')
        page.wait_for_timeout(300)
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


def _errors(page):
    # the blocked third-party hosts log "Failed to load resource"; anything else is ours
    blocked = [u for u in page.requests if u.startswith('FAILED ')]
    ours = [t for t in page.console_errors if not (t.startswith('Failed to load resource') and blocked)]
    failed_local = [u for u in blocked if '127.0.0.1' in u]
    return page.errors + ours + failed_local


def _open_3d(page):
    page.click('#rx-3d-toggle')
    page.wait_for_selector('#rx-3d-pane[data-state="ready"]', timeout=READY)
    page.wait_for_function("document.getElementById('rx-3d-pane').hasAttribute('data-contacts-drawn')", timeout=READY)


def _table(page):
    return page.evaluate("""() => Array.from(document.querySelectorAll('#rrcs-table tbody tr')).map(r => ({
        a: parseInt(r.cells[0].textContent, 10), b: parseInt(r.cells[2].textContent, 10),
        d: parseFloat(r.cells[6].textContent), pass: r.classList.contains('significant-row')}))""")


def _drawn(page, want):
    page.wait_for_function("document.getElementById('rx-3d-pane').getAttribute('data-contacts-drawn') === '%s'" % want,
                           timeout=15000)
    return int(page.get_attribute('#rx-3d-pane', 'data-contacts-drawn'))


def test_nothing_loads_before_the_3d_view_is_opened(open_report):
    gid = _gids()[0]
    page = open_report(gid)
    page.locator('#sec-3d').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    assert [u for u in page.requests if '/studio/' in u or '/models/' in u] == []
    assert page.locator('#rx-3d-contacts-show').count() == 0
    assert page.evaluate('window.__gpc.length') == 0
    assert _errors(page) == []


@pytest.mark.parametrize('gid', _gids() if HAS_VIEWER else [])
def test_drawn_contacts_equal_the_threshold_passing_rows(open_report, gid):
    page = open_report(gid)
    _open_3d(page)
    rows = _table(page)
    passing = [r for r in rows if r['pass']]
    assert passing, 'no highlighted rows in the RRCS table'
    assert _drawn(page, len(passing)) == len(passing)
    assert str(len(passing)) + ' contacts drawn' in page.inner_text('#rx-3d-legend')
    assert any(e['name'] == 'gpc:3d-ready' and e['detail']['gid'] == gid for e in page.evaluate('window.__gpc'))

    page.select_option('#rx-3d-contacts-show', 'top')
    assert _drawn(page, min(25, len(rows))) == min(25, len(rows))
    page.select_option('#rx-3d-contacts-show', 'off')
    assert _drawn(page, 0) == 0
    assert 'Contacts off' in page.inner_text('#rx-3d-legend')
    page.select_option('#rx-3d-contacts-show', 'passing')
    page.select_option('#rx-3d-contacts-sign', 'active')
    up = len([r for r in passing if r['d'] > 0])
    assert _drawn(page, up) == up
    page.select_option('#rx-3d-contacts-sign', 'inactive')
    down = len([r for r in passing if r['d'] < 0])
    assert _drawn(page, down) == down
    assert _errors(page) == []


def test_a_pair_chosen_in_a_table_is_framed_and_labelled(open_report):
    gid = _gids()[0]
    page = open_report(gid)
    _open_3d(page)
    row = [r for r in _table(page) if r['pass']][3]
    page.evaluate("""([gid, a, b, d]) => document.dispatchEvent(new CustomEvent('gpc:select-pair',
        {detail: {gid: gid, a: a, b: b, delta: d, source: 'table'}}))""", [gid, row['a'], row['b'], row['d']])
    expect(page.locator('#rx-3d-pane')).to_have_attribute('data-pair', '%d,%d' % (row['a'], row['b']))
    label = page.locator('.gpc-pv-label')
    expect(label).to_be_visible()
    text = label.inner_text()
    assert re.match(r'^[A-Z]%d–[A-Z]%d\s+ΔRRCS [+−]\d+\.\d\d$' % (row['a'], row['b']), text), text
    shown = float(text.rsplit(' ', 1)[1].replace('−', '-'))
    assert abs(shown - row['d']) < 0.006
    # the pair is drawn even with contacts off
    page.select_option('#rx-3d-contacts-show', 'off')
    assert _drawn(page, 1) == 1
    # "Whole receptor" leaves the pair
    page.click('#rx-3d-whole')
    expect(label).to_be_hidden()
    # events from the 3D view itself are ignored
    page.evaluate("""([gid]) => document.dispatchEvent(new CustomEvent('gpc:select-pair',
        {detail: {gid: gid, a: 1, b: 2, source: '3d'}}))""", [gid])
    page.wait_for_timeout(200)
    assert page.get_attribute('#rx-3d-pane', 'data-pair') is None
    assert _errors(page) == []


def test_a_residue_chosen_elsewhere_is_framed_with_its_contacts(open_report):
    gid = _gids()[0]
    page = open_report(gid)
    _open_3d(page)
    passing = [r for r in _table(page) if r['pass']]
    res = passing[0]['a']
    page.select_option('#rx-3d-contacts-show', 'off')
    _drawn(page, 0)
    page.select_option('#rx-3d-contacts-show', 'top')
    page.evaluate("""([gid, res]) => document.dispatchEvent(new CustomEvent('gpc:select-residue',
        {detail: {gid: gid, res: res, source: 'snake'}}))""", [gid, res])
    expect(page.locator('#rx-3d-pane')).to_have_attribute('data-focus', str(res))
    own = [r for r in passing if res in (r['a'], r['b'])]
    top = {(r['a'], r['b']) for r in _table(page)[:25]}
    extra = [r for r in own if (r['a'], r['b']) not in top]
    assert _drawn(page, 25 + len(extra)) == 25 + len(extra)
    assert _errors(page) == []


def test_a_click_in_3d_fires_a_selection_event(open_report):
    gid = _gids()[0]
    page = open_report(gid)
    _open_3d(page)
    row = sorted([r for r in _table(page) if r['pass']], key=lambda r: -abs(r['d']))[0]
    # one structure, so the cylinder runs through the middle of the framed pair
    page.click('[data-rx-show="%s"]' % ('active' if row['d'] > 0 else 'inactive'))
    page.evaluate("""([gid, a, b]) => document.dispatchEvent(new CustomEvent('gpc:select-pair',
        {detail: {gid: gid, a: a, b: b, source: 'table'}}))""", [gid, row['a'], row['b']])
    page.wait_for_timeout(1500)
    page.locator('#rx-3d-pane').scroll_into_view_if_needed()
    box = page.locator('#rx-3d-pane canvas').bounding_box()
    page.evaluate('window.__gpc = []')
    cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    # sweep across the framed pair (Mol* picks on pointer moves) and click where the
    # pointer is over the contact, else over a residue
    last = "(() => { const h = window.__gpc.filter(e => e.name.startsWith('gpc:hover-')); return h.length ? h[h.length - 1] : null; })()"
    spot = None
    for dy in (0, -12, 12, -24, 24):
        for i in range(25):
            x, y = cx - 72 + 6 * i, cy + dy
            page.mouse.move(x, y, steps=2)
            page.wait_for_timeout(30)
            e = page.evaluate(last)
            if e and e['detail'].get('a') is not None:
                spot = (x, y)
                break
            if e and e['detail'].get('res') is not None and spot is None:
                spot = (x, y)
        if spot and page.evaluate(last)['detail'].get('a') is not None:
            break
    assert spot, 'the pointer found nothing to pick near the framed pair'
    page.mouse.move(*spot, steps=2)
    page.wait_for_timeout(150)
    page.mouse.click(*spot)
    page.wait_for_function("window.__gpc.some(e => (e.name === 'gpc:select-pair' || e.name === 'gpc:select-residue') && e.detail.source === '3d')",
                           timeout=10000)
    events = page.evaluate('window.__gpc')
    picks = [e for e in events if e['name'] in ('gpc:select-pair', 'gpc:select-residue') and e['detail']['source'] == '3d']
    assert all(e['detail']['gid'] == gid for e in picks)
    hovers = [e for e in events if e['name'].startswith('gpc:hover-') and e['detail']['source'] == '3d']
    assert hovers, 'no hover event from the 3D view'
    pair = [e for e in picks if e['name'] == 'gpc:select-pair']
    if pair:
        d = pair[0]['detail']
        assert (d['a'], d['b']) == (row['a'], row['b']) and abs(d['delta'] - row['d']) < 1e-9
    assert _errors(page) == []


@pytest.mark.parametrize('dark', [False, True])
def test_phone_width_controls_fit_and_contacts_draw(open_report, dark):
    gid = _gids()[0]
    page = open_report(gid, viewport=PHONE, dark=dark)
    _open_3d(page)
    passing = [r for r in _table(page) if r['pass']]
    assert _drawn(page, len(passing)) == len(passing)
    for sel in ('#rx-3d-contacts-show', '#rx-3d-contacts-sign', '#rx-3d-legend'):
        b = page.locator(sel).bounding_box()
        assert b and b['x'] >= 0 and b['x'] + b['width'] <= PHONE['width'] + 1, sel
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    assert _errors(page) == []


def test_the_cartoon_is_calm_grey_while_contacts_draw_and_the_toggle_restores_residue_colours(open_report):
    gid = _gids()[0]
    page = open_report(gid)
    _open_3d(page)
    box = page.locator('#rx-3d-residue-colour')
    caption = page.locator('#sec-3d .rx-caption')
    assert not box.is_checked()
    expect(caption).to_be_hidden()
    expect(page.locator('#rx-3d-legend')).to_be_visible()
    page.wait_for_timeout(800)
    grey = page.locator('#rx-3d-pane').screenshot()
    box.check()
    expect(caption).to_be_visible()
    page.wait_for_timeout(800)
    assert page.locator('#rx-3d-pane').screenshot() != grey, 'the residue colouring did not change the view'
    box.uncheck()
    expect(caption).to_be_hidden()
    assert _errors(page) == []


def test_with_contacts_off_the_residue_colours_come_back_until_the_reader_chooses(open_report):
    gid = _gids()[0]
    page = open_report(gid)
    _open_3d(page)
    page.select_option('#rx-3d-contacts-show', 'off')
    expect(page.locator('#rx-3d-residue-colour')).to_be_checked()
    page.select_option('#rx-3d-contacts-show', 'passing')
    expect(page.locator('#rx-3d-residue-colour')).not_to_be_checked()
    page.locator('#rx-3d-residue-colour').check()
    page.select_option('#rx-3d-contacts-show', 'top')
    expect(page.locator('#rx-3d-residue-colour')).to_be_checked()
    assert _errors(page) == []
