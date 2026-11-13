"""Site chrome and accessibility: brand-teal contrast, the mobile drawer, table controls, the logo.

The static checks read the source and need no build. The built-page and browser checks use
SMOKE_BUILD_DIR (the same variable as test_smoke_browser.py) and skip without it or without Playwright.
"""
import functools
import http.server
import os
import pathlib
import re
import socketserver
import threading

import pytest

BASE = pathlib.Path(__file__).resolve().parents[1]
CSS = BASE / 'static' / 'css'
_env = os.environ.get('SMOKE_BUILD_DIR')
BUILD = None
if _env:
    BUILD = pathlib.Path(_env).expanduser()
    if not BUILD.is_absolute():
        BUILD = BASE / BUILD
has_build = pytest.mark.skipif(not BUILD or not (BUILD / 'downloads.html').exists(),
                               reason='needs a built site (SMOKE_BUILD_DIR)')


def _lum(hex_):
    h = hex_.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    chans = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = map(f, chans)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = _lum(a), _lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def _tokens():
    """--brand-primary and --on-brand from the light (:root) and dark blocks of site.css."""
    css = (CSS / 'site.css').read_text(encoding='utf-8')
    light = css[css.index(':root {'):css.index('[data-color-mode="dark"] {')]
    dark = css[css.index('[data-color-mode="dark"] {'):]
    dark = dark[:dark.index('}')]
    grab = lambda blk, name: re.search(r'--%s:\s*(#[0-9A-Fa-f]{3,6})' % name, blk).group(1)
    return {m: {n: grab(blk, n) for n in ('brand-primary', 'on-brand')}
            for m, blk in (('light', light), ('dark', dark))}


# ---- A11Y-1, A11Y-2: teal contrast ----------------------------------------------------------

def test_brand_teal_text_and_fills_hold_aa_in_both_themes():
    t = _tokens()
    # light: teal as text on white, the page gray and the pale teal badge ground; white text on a teal fill
    for ground in ('#ffffff', '#F6F8FA', '#DDF4FF'):
        assert contrast(t['light']['brand-primary'], ground) >= 4.5, ground
    assert contrast(t['light']['on-brand'], t['light']['brand-primary']) >= 4.5
    # dark: the bright teal is used as a fill, so the text on it must be dark
    assert contrast(t['dark']['on-brand'], t['dark']['brand-primary']) >= 4.5
    assert contrast(t['dark']['brand-primary'], '#0d1117') >= 4.5


def test_no_stylesheet_sets_fixed_white_text_on_a_brand_fill():
    offenders = []
    # atlas.css pairs its white-on-brand rule with an explicit dark override
    for path in [p for p in CSS.glob('*.css') if p.name != 'atlas.css'] + [BASE / 'templates' / 'gpcr_report.html']:
        text = path.read_text(encoding='utf-8')
        for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', text):
            sel, body = m.group(1).strip(), m.group(2)
            fills = re.search(r'background(?:-color)?:\s*var\(--brand-primary(?:-hover)?\)', body)
            white = re.search(r'(?<![-\w])color:\s*(#fff(?:fff)?|white)\b', body)
            if fills and white and 'dark' not in sel:
                offenders.append('%s: %s' % (path.name, sel.splitlines()[-1]))
    assert not offenders, offenders


def test_chip_count_is_not_faded_below_aa():
    stats = (CSS / 'stats.css').read_text(encoding='utf-8')
    assert '.chip small { opacity: 1;' in stats


# ---- A11Y-5: logo -----------------------------------------------------------------------------

def test_logo_is_served_in_sizes_that_fit_and_the_original_is_kept():
    img = BASE / 'static' / 'img'
    assert (img / 'lablogo.png').is_file()  # still the og:image
    for name, limit in (('lablogo-128.png', 20_000), ('lablogo-240.png', 40_000), ('lablogo-480.png', 90_000)):
        assert (img / name).stat().st_size < limit, name
    topbar = (BASE / 'templates' / '_partials' / 'topbar.html').read_text(encoding='utf-8')
    footer = (BASE / 'templates' / '_partials' / 'footer.html').read_text(encoding='utf-8')
    landing = (BASE / 'templates' / 'landing.html').read_text(encoding='utf-8')
    for html, name in ((topbar, 'lablogo-128.png'), (footer, 'lablogo-240.png'), (landing, 'lablogo-480.png')):
        tag = re.search(r'<img[^>]*%s[^>]*>' % name, html).group(0)
        assert 'width="' in tag and 'height="' in tag, tag
        assert 'static/img/lablogo.png' not in html
    assert 'loading="lazy"' in footer


# ---- CL-3, CL-4, A11Y-3, A11Y-4, RD-12, A11Y-8: source ---------------------------------------

def test_site_js_traps_focus_and_follows_the_breakpoint():
    js = (BASE / 'static' / 'js' / 'site.js').read_text(encoding='utf-8')
    assert "setAttribute('inert', '')" in js and 'setBackgroundInert' in js
    assert "e.key !== 'Tab'" in js
    assert "matchMedia('(min-width: 1080px)')" in js
    assert 'aria-label="Rows per page"' in js
    assert 'visibleText(c)' in js


def test_stats_scroll_respects_reduced_motion():
    js = (BASE / 'static' / 'js' / 'stats-page.js').read_text(encoding='utf-8')
    assert "behavior: 'smooth'" not in js
    assert js.count('behavior: SCROLL()') == 2
    assert "plotEl.setAttribute('role', 'img')" in js


def test_breakpoint_in_site_js_matches_the_stylesheet():
    css = (CSS / 'site.css').read_text(encoding='utf-8')
    assert '@media (max-width: 1079px) {\n  .topnav { display: none; }' in css
    assert '@media (min-width: 1080px) {\n  .mobile-drawer { display: none; }' in css


# ---- CL-6: descriptions -----------------------------------------------------------------------

@has_build
def test_downloads_and_contact_have_their_own_meta_description():
    desc = lambda name: re.search(r'<meta name="description" content="([^"]*)">',
                                  (BUILD / name).read_text(encoding='utf-8')).group(1)
    home = desc('index.html')
    seen = {home}
    for page in ('downloads.html', 'contact.html', 'glossary.html', 'privacy.html', 'statistics.html'):
        d = desc(page)
        assert d not in seen, page
        seen.add(d)
        assert '—' not in d


def test_studio_is_in_the_sitemap_pages():
    from GPCompaReports_v2.website.seo import STATIC_PAGES
    assert 'studio/' in STATIC_PAGES


# ---- browser ----------------------------------------------------------------------------------

@pytest.fixture(scope='module')
def server():
    if not BUILD:
        pytest.skip('needs a built site (SMOKE_BUILD_DIR)')

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(BUILD)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d/' % httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope='module')
def browser(playwright_session):
    b = playwright_session.chromium.launch()
    yield b
    b.close()


def _page(browser, server, path, width=390, height=800, **ctx_args):
    ctx = browser.new_context(viewport={'width': width, 'height': height}, **ctx_args)
    page = ctx.new_page()
    page.route(re.compile(r'https?://(cdn\.plot\.ly|gc\.zgo\.at|fonts\.).*'), lambda r: r.abort())
    page.goto(server + path)
    page.wait_for_timeout(500)
    return ctx, page


_WHERE = ("(()=>{const a=document.activeElement;return document.getElementById('mobile-drawer').contains(a)?"
          "'in':'out'})()")


@has_build
@pytest.mark.parametrize('path', ['index.html', 'statistics.html', 'browse/index.html'])
def test_drawer_keeps_focus_inside_and_makes_the_page_inert(browser, server, path):
    ctx, page = _page(browser, server, path)
    page.focus('#mobile-nav-toggle')
    page.keyboard.press('Enter')
    page.wait_for_timeout(300)
    assert page.evaluate("document.activeElement.classList.contains('mobile-drawer-close')")
    assert page.evaluate("document.getElementById('main').hasAttribute('inert')")
    for _ in range(25):  # past the last link and round again
        page.keyboard.press('Tab')
        assert page.evaluate(_WHERE) == 'in'
    for _ in range(25):
        page.keyboard.press('Shift+Tab')
        assert page.evaluate(_WHERE) == 'in'
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    assert page.evaluate("document.activeElement.id") == 'mobile-nav-toggle'
    assert not page.evaluate("document.getElementById('main').hasAttribute('inert')")
    assert page.evaluate("document.body.style.overflow") == ''
    ctx.close()


@has_build
def test_drawer_closes_when_the_window_becomes_wide(browser, server):
    ctx, page = _page(browser, server, 'index.html')
    page.click('#mobile-nav-toggle')
    page.wait_for_timeout(300)
    page.set_viewport_size({'width': 1280, 'height': 800})
    page.wait_for_timeout(400)
    state = page.evaluate("({h: document.getElementById('mobile-drawer').getAttribute('aria-hidden'),"
                          " e: document.getElementById('mobile-nav-toggle').getAttribute('aria-expanded'),"
                          " o: document.body.style.overflow,"
                          " m: document.getElementById('main').hasAttribute('inert')})")
    assert state == {'h': 'true', 'e': 'false', 'o': '', 'm': False}
    ctx.close()


@has_build
def test_report_table_controls_are_named_and_the_tm_export_is_one_metric(browser, server, tmp_path):
    ctx, page = _page(browser, server, 'reports/adrb2_human.html', width=1280, height=900,
                      accept_downloads=True)
    names = page.evaluate("[...document.querySelectorAll('select[data-page-size]')].map(s => s.getAttribute('aria-label'))")
    assert names and all(n == 'Rows per page' for n in names)

    def export():
        with page.expect_download() as d:
            page.click('[data-table-export="tm-summary-table"]')
        return pathlib.Path(d.value.path()).read_text(encoding='utf-8').splitlines()

    signed = export()
    cell = re.findall(r'\d+ \(([+-][\d.]+)\)', signed[2])
    assert cell, signed[2]
    assert not re.search(r'\([+-][\d.]+[+-][\d.]+\)', signed[2]), signed[2]
    page.click('[data-tm-metric="max"]')
    largest = export()
    assert not re.search(r'\([+-][\d.]+[+-][\d.]+\)', largest[2]), largest[2]
    assert signed[2] != largest[2]
    ctx.close()


@has_build
def test_plotly_modebar_is_hidden_on_a_phone(browser, server):
    ctx, page = _page(browser, server, 'reports/adrb2_human.html', has_touch=True, is_mobile=True)
    modebar = page.evaluate("(() => { const s = document.createElement('div'); s.className = 'v2-chart';"
                            " s.innerHTML = '<div class=\"modebar-container\"></div>'; document.body.appendChild(s);"
                            " return getComputedStyle(s.firstChild).display; })()")
    assert modebar == 'none'
    ctx.close()


@has_build
def test_statistics_scroll_is_not_smooth_with_reduced_motion(browser, server):
    ctx, page = _page(browser, server, 'statistics.html', width=1280, height=900, reduced_motion='reduce')
    page.evaluate("window.__sc = []; const o = Element.prototype.scrollIntoView;"
                  " Element.prototype.scrollIntoView = function (a) { window.__sc.push(a && a.behavior);"
                  " return o.call(this, a); }; 0")
    btn = page.query_selector('[data-method-toggle]')
    assert btn
    btn.scroll_into_view_if_needed()
    btn.click()
    page.wait_for_timeout(300)
    assert page.evaluate("window.__sc") == ['auto']
    ctx.close()
