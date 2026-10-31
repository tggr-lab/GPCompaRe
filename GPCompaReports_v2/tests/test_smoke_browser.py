"""Browser smoke tests for the two report-page V3 modules.

v3-nav.js and v3-deeplink.js are the only JavaScript this branch adds to a
report page, and neither can be tested meaningfully in isolation. The
Compact-view defect that reached a built page was not a wrong function
return: applyCompact() set the right class on the right elements, and the
plot stayed on screen anyway because `#snake-plot-container` is an id
selector and out-specified the fold rule. Only a real browser, with the real
CSS and the real generated markup, would have caught it. So these tests drive
a built report in headless Chromium.

Deliberately small. Eight behaviours, one representative report per distinct
page structure, not 283 pages.

Running them
------------
These need Playwright, which is not in the system Python (PEP 668 marks it
externally managed). It lives in a project venv instead, so the ordinary
suite is untouched:

    python3 -m pytest                      # existing tests; these skip
    ../.venv-test/bin/python -m pytest tests/test_smoke_browser.py

Point them at a different build with SMOKE_BUILD_DIR, the same way
test_freeze.py takes FREEZE_BUILD_DIR:

    SMOKE_BUILD_DIR=output ../.venv-test/bin/python -m pytest tests/test_smoke_browser.py

Why an HTTP server rather than file://
--------------------------------------
The GoatCounter tag is protocol-relative (//gc.zgo.at/count.js). Opened from
disk that resolves to the invalid URL file://gc.zgo.at/count.js and Chromium
logs a console error on every page, which would drown a genuine one. Served
over http:// the page is clean. It is also closer to how the site is really
delivered.

Third-party hosts are blocked outright so the suite never depends on the
network. That costs no coverage here: the snake plot draws its own SVG and
does not use Plotly.
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

pytest.importorskip(
    'playwright.sync_api',
    reason='Playwright is not installed in this interpreter. These tests '
           'run from the project venv instead: '
           'bash scripts/run_browser_tests.sh')

from playwright.sync_api import expect, sync_playwright  # noqa: E402

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('SMOKE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / BUILD_DIR
else:
    BUILD_DIR = BASE / 'output_v3_demo'

REPORTS_DIR = BUILD_DIR / 'reports'

# Hosts the built page references but that the test must never depend on.
BLOCKED = ('**cdn.plot.ly/**', '**gc.zgo.at/**',
           '**fonts.googleapis.com/**', '**fonts.gstatic.com/**')

VIEWPORT = {'width': 1280, 'height': 900}

# Long enough for IntersectionObserver to settle on a slow machine, short
# enough not to stall the suite. Assertions that can retry use expect()
# instead of sleeping.
SETTLE_MS = 400


def _structural_signature(html):
    """What makes one report page structurally different from another.

    Reports are generated from one template, so almost all of them are
    identical in shape. The exception is the four receptors with no gnomAD
    data, which render one section fewer. Picking one representative per
    signature tests the real variation without testing 283 near-copies.
    """
    return (len(re.findall(r'data-section-title=', html)),
            len(re.findall(r'report-section-head', html)),
            # Truncated reports carry an extra line under the RRCS heading.
            # It is not a section, so the counts above cannot see it, and the
            # suite would never open one of the 7 in a browser.
            bool(re.search(r'rrcs-truncation-note', html)))


def _representatives():
    """One receptor id per distinct page structure present in the build."""
    if not REPORTS_DIR.is_dir():
        return []
    seen = {}
    for path in report_pages(REPORTS_DIR):
        sig = _structural_signature(path.read_text(encoding='utf-8'))
        seen.setdefault(sig, path.stem)
    return sorted(seen.values())


REPRESENTATIVES = _representatives()

pytestmark = pytest.mark.skipif(
    not REPRESENTATIVES,
    reason='no built reports at %s; run scripts/build_demo.sh or set '
           'SMOKE_BUILD_DIR' % REPORTS_DIR)


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

@pytest.fixture(scope='session')
def server():
    """Serve the build on an ephemeral port for the session."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(BUILD_DIR))
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d' % httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope='session')
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def open_report(browser, server):
    """Open a report and collect anything the browser complains about.

    A fresh context per test, because Compact view persists in localStorage
    and would otherwise leak state between tests and make them order
    dependent.
    """
    contexts = []

    def _open(gpcr_id, hash_=''):
        ctx = browser.new_context(viewport=VIEWPORT)
        contexts.append(ctx)
        page = ctx.new_page()
        errors, failed = [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('requestfailed',
                lambda r: failed.append((r.url, r.failure)))
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.goto('%s/reports/%s.html%s' % (server, gpcr_id, hash_),
                  wait_until='load')
        page.wait_for_timeout(SETTLE_MS)
        page.errors = errors
        page.failed_requests = failed
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


def _sticky_chrome_bottom(page):
    """Lowest edge of the chrome that stays pinned to the top of the viewport.

    The topbar and the section nav are both sticky and the nav tucks under
    the topbar, so the obstruction is the furthest-down edge of the two, not
    either one alone.
    """
    return page.evaluate("""(function () {
      var bottom = 0;
      document.querySelectorAll('.topbar, .v3-secnav').forEach(function (el) {
        if (getComputedStyle(el).position !== 'sticky') return;
        var r = el.getBoundingClientRect();
        if (r.top <= 1 + parseFloat(getComputedStyle(el).top || 0) &&
            r.bottom > bottom) bottom = r.bottom;
      });
      return Math.round(bottom);
    })()""")


def _first_party_failures(page, server):
    """Failed requests that are ours, not the third-party hosts we blocked."""
    return [url for url, _ in page.failed_requests if url.startswith(server)]


# --------------------------------------------------------------------------
# 1. the page loads without JavaScript errors
# --------------------------------------------------------------------------

@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_report_loads_without_javascript_errors(open_report, server, gpcr_id):
    page = open_report(gpcr_id)
    assert page.errors == [], (
        '%s raised JavaScript errors on load: %s' % (gpcr_id, page.errors))
    assert _first_party_failures(page, server) == [], (
        '%s failed to load one of its own assets: %s'
        % (gpcr_id, _first_party_failures(page, server)))
    # Both modules must actually have run, or every test below would pass
    # vacuously against a page that simply never loaded them.
    assert page.evaluate('!!window.V3Nav'), (
        '%s: v3-nav.js did not run' % gpcr_id)
    assert page.locator('#v3-compact-toggle').count() == 1, (
        '%s: v3-nav.js ran but built no Compact view toggle' % gpcr_id)


# --------------------------------------------------------------------------
# 2. the sticky section navigation reaches and identifies the right section
# --------------------------------------------------------------------------

@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_section_nav_reaches_and_marks_the_correct_section(
        open_report, gpcr_id):
    page = open_report(gpcr_id)
    links = page.locator('.v3-secnav a')
    count = links.count()
    assert count >= 2, (
        '%s: expected a section nav with at least 2 links, got %d'
        % (gpcr_id, count))

    for i in range(count):
        link = links.nth(i)
        href = link.get_attribute('href')
        target_id = href.lstrip('#')
        assert page.evaluate('!!document.getElementById(%r)' % target_id), (
            '%s: nav link %s points at a section that does not exist'
            % (gpcr_id, href))

        link.click()
        page.wait_for_timeout(SETTLE_MS)

        top = page.evaluate(
            'Math.round(document.getElementById(%r)'
            '.getBoundingClientRect().top)' % target_id)
        at_bottom = page.evaluate(
            'Math.round(window.scrollY + window.innerHeight) >= '
            'document.body.scrollHeight - 2')

        if at_bottom:
            # The last section is short enough that the page runs out of
            # scroll before it can reach the sticky offset. It must still be
            # on screen, and the active marker legitimately stays on whichever
            # section owns the top of the viewport.
            assert 0 < top < VIEWPORT['height'], (
                '%s: %s is off screen at the bottom of the page (top=%d)'
                % (gpcr_id, href, top))
        else:
            # Measured from the rendered page, not read back from the same
            # CSS property the offset is set with. Asserting
            # `top == scrollMarginTop` would move both sides together and
            # could never fail, which is how a broken offset would slip
            # through. What actually matters is that the section heading
            # is not hidden underneath the sticky chrome.
            chrome = _sticky_chrome_bottom(page)
            assert top >= chrome, (
                '%s: clicking %s landed the section at %dpx, underneath the '
                'sticky chrome which ends at %dpx, so its heading is hidden'
                % (gpcr_id, href, top, chrome))
            assert top <= chrome + 100, (
                '%s: clicking %s landed the section %dpx below the sticky '
                'chrome (%dpx), far further than the layout intends'
                % (gpcr_id, href, top - chrome, chrome))
            expect(page.locator('.v3-secnav a.on')).to_have_count(1)
            assert page.eval_on_selector(
                '.v3-secnav a.on', 'e => e.dataset.target') == target_id, (
                '%s: clicked %s but the nav marks a different section as '
                'active' % (gpcr_id, href))


# --------------------------------------------------------------------------
# 3. a valid deep link opens the intended section
# --------------------------------------------------------------------------

@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_valid_deep_link_opens_the_intended_section(open_report, gpcr_id):
    probe = open_report(gpcr_id)
    ids = probe.eval_on_selector_all(
        '.report-section[data-section-title]', 'els => els.map(e => e.id)')
    assert len(ids) >= 3, '%s: too few sections to deep link' % gpcr_id

    # A section in the middle, so success means real scrolling rather than
    # the page happening to already be at the top or pinned at the bottom.
    target = ids[len(ids) // 2]
    page = open_report(gpcr_id, '#sec=' + target)

    assert page.errors == [], (
        '%s: deep link #sec=%s raised %s' % (gpcr_id, target, page.errors))
    assert page.evaluate('window.scrollY') > 0, (
        '%s: deep link #sec=%s did not scroll anywhere' % (gpcr_id, target))
    top = page.evaluate(
        'Math.round(document.getElementById(%r).getBoundingClientRect().top)'
        % target)
    assert 0 <= top < VIEWPORT['height'], (
        '%s: deep link #sec=%s left the section off screen (top=%d)'
        % (gpcr_id, target, top))


# --------------------------------------------------------------------------
# 4. an invalid or missing deep link fails safely
# --------------------------------------------------------------------------

BAD_HASHES = [
    '',                      # no hash at all
    '#',                     # empty hash
    '#sec=',                 # the key with no value
    '#sec=no-such-section',  # a section that does not exist
    '#view=not-a-real-view',  # a snake view that does not exist
    '#min=abc&max=xyz',      # numbers that are not numbers
    '#garbage',              # not the grammar at all
]


@pytest.mark.parametrize('bad', BAD_HASHES)
def test_invalid_deep_link_fails_safely(open_report, bad):
    """Failing safely means the page still works, not that nothing happened."""
    gpcr_id = REPRESENTATIVES[0]
    page = open_report(gpcr_id, bad)

    assert page.errors == [], (
        'hash %r raised JavaScript errors: %s' % (bad, page.errors))
    assert page.locator('.report-section').count() > 0, (
        'hash %r left the page without its report sections' % bad)
    assert page.locator('#v3-compact-toggle').count() == 1, (
        'hash %r stopped the toolbar being built' % bad)
    if bad in ('', '#', '#sec=', '#sec=no-such-section'):
        assert page.evaluate('window.scrollY') == 0, (
            'hash %r scrolled somewhere it should not have' % bad)


# --------------------------------------------------------------------------
# 5, 6, 7. Compact view: layout, the snake plot pairing, and going back
# --------------------------------------------------------------------------

@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_compact_view_folds_the_sections(open_report, gpcr_id):
    page = open_report(gpcr_id)
    toggle = page.locator('#v3-compact-toggle')

    assert page.locator('.report-section.v3-folded').count() == 0, (
        '%s: sections were folded before Compact view was switched on'
        % gpcr_id)

    toggle.click()
    expect(toggle).to_have_attribute('aria-pressed', 'true')

    foldable = page.locator(
        '.report-section[data-section-title]:has(.report-section-head)').count()
    folded = page.locator('.report-section.v3-folded').count()
    assert folded == foldable, (
        '%s: Compact view folded %d sections, expected %d'
        % (gpcr_id, folded, foldable))

    # A section with no head has no control to reopen it, so folding it would
    # hide it permanently. It must be left alone.
    stranded = page.locator(
        '.report-section.v3-folded:not(:has(.report-section-head))').count()
    assert stranded == 0, (
        '%s: Compact view folded %d section(s) that have no head to reopen '
        'them with' % (gpcr_id, stranded))


@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_snake_plot_and_legend_are_never_shown_without_each_other(
        open_report, gpcr_id):
    """The exact defect that shipped: the plot stayed visible in Compact view
    while its legend did not, because #snake-plot-container is an id selector
    and out-specified the fold rule. Whatever state the page is in, these two
    move together.
    """
    page = open_report(gpcr_id)
    plot = page.locator('#snake-plot-container')
    legend = page.locator('#snake-legend')
    if plot.count() == 0 or legend.count() == 0:
        pytest.skip('%s has no snake plot and legend pair' % gpcr_id)

    assert plot.is_visible() and legend.is_visible(), (
        '%s: the snake plot and legend should both be visible in the normal '
        'view (plot=%s legend=%s)'
        % (gpcr_id, plot.is_visible(), legend.is_visible()))

    page.locator('#v3-compact-toggle').click()
    expect(page.locator('#v3-compact-toggle')).to_have_attribute(
        'aria-pressed', 'true')

    section_folded = page.evaluate(
        '(function () {'
        '  var c = document.getElementById("snake-plot-container");'
        '  var s = c && c.closest(".report-section");'
        '  return !!(s && s.classList.contains("v3-folded"));'
        '})()')
    assert section_folded, (
        '%s: Compact view did not fold the section holding the snake plot'
        % gpcr_id)
    assert not plot.is_visible() and not legend.is_visible(), (
        '%s: the folded snake section still shows plot=%s legend=%s. They '
        'must hide together.'
        % (gpcr_id, plot.is_visible(), legend.is_visible()))


@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_leaving_compact_view_restores_the_page(open_report, gpcr_id):
    page = open_report(gpcr_id)
    toggle = page.locator('#v3-compact-toggle')
    before = page.locator('.report-section.v3-folded').count()

    toggle.click()
    expect(toggle).to_have_attribute('aria-pressed', 'true')
    assert page.locator('.report-section.v3-folded').count() > before

    toggle.click()
    expect(toggle).to_have_attribute('aria-pressed', 'false')

    assert page.locator('.report-section.v3-folded').count() == before, (
        '%s: leaving Compact view left sections folded' % gpcr_id)
    assert page.evaluate('localStorage.getItem("gpcompare-compact")') is None, (
        '%s: leaving Compact view did not clear its stored preference'
        % gpcr_id)
    plot = page.locator('#snake-plot-container')
    if plot.count():
        assert plot.is_visible(), (
            '%s: the snake plot did not come back' % gpcr_id)


# --------------------------------------------------------------------------
# 8. the controls are keyboard operable and expose their state
# --------------------------------------------------------------------------

@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_compact_toggle_is_keyboard_operable_and_exposes_its_state(
        open_report, gpcr_id):
    page = open_report(gpcr_id)
    toggle = page.locator('#v3-compact-toggle')

    # Reachable and named through the accessibility tree, not just the DOM.
    assert page.get_by_role('button', name='Compact view').count() == 1, (
        '%s: the Compact view control is not exposed as a named button'
        % gpcr_id)
    expect(toggle).to_have_attribute('aria-pressed', 'false')

    toggle.focus()
    assert page.evaluate('document.activeElement.id') == 'v3-compact-toggle', (
        '%s: the Compact view toggle cannot take keyboard focus' % gpcr_id)

    page.keyboard.press('Enter')
    expect(toggle).to_have_attribute('aria-pressed', 'true')
    assert page.locator('.report-section.v3-folded').count() > 0, (
        '%s: Enter set aria-pressed but folded nothing' % gpcr_id)

    page.keyboard.press('Enter')
    expect(toggle).to_have_attribute('aria-pressed', 'false')

    # Space is the other key a real button must answer to.
    page.keyboard.press('Space')
    expect(toggle).to_have_attribute('aria-pressed', 'true')

    assert page.errors == [], (
        '%s: keyboard operation raised %s' % (gpcr_id, page.errors))


@pytest.mark.parametrize('gpcr_id', REPRESENTATIVES)
def test_section_nav_is_reachable_by_keyboard(open_report, gpcr_id):
    page = open_report(gpcr_id)
    nav = page.locator('.v3-secnav')
    expect(nav).to_have_attribute('aria-label', 'Report sections')

    first = page.locator('.v3-secnav a').first
    first.focus()
    assert page.evaluate(
        'document.activeElement.closest(".v3-secnav") !== null'), (
        '%s: section nav links cannot take keyboard focus' % gpcr_id)

    target = first.get_attribute('href').lstrip('#')
    page.keyboard.press('Enter')
    page.wait_for_timeout(SETTLE_MS)
    assert page.evaluate('location.hash') == '#' + target, (
        '%s: Enter on a focused nav link did not navigate' % gpcr_id)


# ---------------------------------------------------------------------------
# Contact form: a real submission, intercepted before it leaves the machine
# ---------------------------------------------------------------------------

FORMSPREE_ENDPOINT = 'https://formspree.io/f/mljrqazl'


def test_submitting_the_contact_form_posts_the_expected_fields(browser, server):
    """Fill the required fields, submit, and capture the request.

    The route handler aborts the request, so nothing reaches Formspree and no
    email is sent. What is asserted is the destination, the method, and the
    body the browser actually built from the form.
    """
    ctx = browser.new_context(viewport=VIEWPORT)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    for pattern in BLOCKED:
        page.route(pattern, lambda route: route.abort())

    captured = {}

    def intercept(route, request):
        captured['url'] = request.url
        captured['method'] = request.method
        captured['post'] = request.post_data
        route.abort()

    page.route('https://formspree.io/**', intercept)
    page.goto('%s/contact.html' % server, wait_until='load')

    page.fill('#contact-name', 'Ada Lovelace')
    page.fill('#contact-email', 'ada@example.org')
    page.fill('#contact-institution', 'Example University')
    page.select_option('#contact-enquiry-type', 'Website problem')
    page.fill('#contact-message', 'Test message, not sent anywhere.')
    page.click('.contact-form button[type="submit"]')
    page.wait_for_timeout(1200)

    assert captured, (
        'submitting the form produced no request to formspree.io; the form is '
        'not wired up')
    assert captured['url'] == FORMSPREE_ENDPOINT, (
        'form posted to %s, expected %s' % (captured['url'], FORMSPREE_ENDPOINT))
    assert captured['method'] == 'POST', (
        'form used %s, expected POST' % captured['method'])

    body = captured['post'] or ''
    for key, value in [('name', 'Ada+Lovelace'), ('email', 'ada%40example.org'),
                       ('institution', 'Example+University'),
                       ('enquiry_type', 'Website+problem'),
                       ('_subject', 'GPCompaRe+website+enquiry')]:
        assert '%s=%s' % (key, value) in body, (
            'submitted body is missing %s=%s; body was %r' % (key, value, body[:400]))
    assert 'message=Test' in body, 'the message field was not submitted'
    # The honeypot must be submitted empty by a real user.
    assert '_gotcha=&' in body or body.rstrip().endswith('_gotcha='), (
        'the honeypot was not submitted empty: %r' % body[:400])
    assert errors == [], 'submitting raised JavaScript errors: %s' % errors
    ctx.close()


def test_the_honeypot_is_not_reachable_by_keyboard(browser, server):
    ctx = browser.new_context(viewport=VIEWPORT)
    page = ctx.new_page()
    for pattern in BLOCKED:
        page.route(pattern, lambda route: route.abort())
    page.goto('%s/contact.html' % server, wait_until='load')

    box = page.locator('#contact-gotcha').bounding_box()
    assert box is None or box['x'] < -1000, (
        'the honeypot is positioned on screen: %s' % box)

    page.focus('#contact-name')
    reached = []
    for _ in range(12):
        page.keyboard.press('Tab')
        reached.append(page.evaluate('document.activeElement.id'))
    assert 'contact-gotcha' not in reached, (
        'tabbing through the form reaches the honeypot: %s' % reached)
    ctx.close()
