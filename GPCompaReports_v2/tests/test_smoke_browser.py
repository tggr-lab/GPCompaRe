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


# ---------------------------------------------------------------------------
# The opt-in report additions: 3D view, ClinVar section, residue drawer
# ---------------------------------------------------------------------------
#
# These need a stage (or a build with studio/embed and models/ beside the
# reports), because the viewer and the model files are separate from the
# report page. Against a plain build they skip; against the staged release
# that deploy_pages.sh tests they always run.

HAS_VIEWER = ((BUILD_DIR / 'studio' / 'embed' / 'pair-viewer.js').is_file()
              and (BUILD_DIR / 'models' / 'active').is_dir())
needs_viewer = pytest.mark.skipif(
    not HAS_VIEWER, reason='%s has no studio/embed or models/ (a stage has both)' % BUILD_DIR)


def _pick_report(prefer, *needles):
    """A built report containing every needle, preferring `prefer`."""
    if not REPORTS_DIR.is_dir():
        return None
    ids = [p.stem for p in report_pages(REPORTS_DIR)]
    ids.sort(key=lambda g: (g != prefer, g))
    for gid in ids:
        html = (REPORTS_DIR / ('%s.html' % gid)).read_text(encoding='utf-8')
        if all(n in html for n in needles):
            return gid
    return None


def _console_errors(page):
    """Console errors that are ours: the hosts the suite blocks fail on purpose."""
    return [t for t, url in page.console_errors
            if not any(h.strip('*/') in url for h in BLOCKED)]


@pytest.fixture
def open_extra(browser, server):
    """Like open_report, and it also records console errors and every request."""
    contexts = []

    def _open(gpcr_id, hash_=''):
        ctx = browser.new_context(viewport=VIEWPORT)
        contexts.append(ctx)
        page = ctx.new_page()
        page.errors, page.console_errors, page.requests = [], [], []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and page.console_errors.append(
            (m.text, (m.location or {}).get('url', ''))))
        page.on('request', lambda r: page.requests.append(r.url))
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.goto('%s/reports/%s.html%s' % (server, gpcr_id, hash_), wait_until='load')
        page.wait_for_timeout(SETTLE_MS)
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


def _open_3d(page):
    page.locator('#rx-3d-toggle').click()
    page.wait_for_selector('#rx-3d-pane[data-state="ready"], #rx-3d-pane[data-state="error"]',
                           timeout=90000)
    assert page.get_attribute('#rx-3d-pane', 'data-state') == 'ready', (
        '3D view did not start: %s' % page.inner_text('#rx-3d-status'))


def _snake_residue(page):
    """A residue that has both a snake-plot circle and a residue-summary row."""
    return page.evaluate("""(function () {
      var rows = JSON.parse(document.getElementById('residue-summary-data').textContent);
      for (var i = 0; i < rows.length; i++) {
        var n = rows[i].position;
        var c = document.querySelector('#snake-plot-container circle[id="' + n + '"]');
        var t = document.getElementById(n + 't');
        // drawn and on screen (collapsed loops hide some residues)
        if (c && t && rows[i].n_contact_partners > 3 &&
            c.getBoundingClientRect().width > 4 && t.getBoundingClientRect().width > 2) return n;
      }
      return null;
    })()""")


def _click_snake_residue(page, n):
    """Click the residue letter, which sits on top of its circle."""
    label = page.locator('[id="%dt"]' % n)
    label.scroll_into_view_if_needed()
    label.click(force=True)


@needs_viewer
def test_3d_view_loads_nothing_until_asked_then_only_from_this_site(open_extra, server):
    gid = _pick_report('par2_human', 'id="sec-3d"')
    assert gid, 'no report with a 3D view in this build'
    page = open_extra(gid)
    assert page.locator('#rx-3d-toggle').get_attribute('aria-expanded') == 'false'
    assert page.locator('#rx-3d-panel').is_hidden()
    before = [u for u in page.requests if '/studio/' in u or '/models/' in u]
    assert before == [], '%s requested the viewer or models before being asked: %s' % (gid, before)

    n_before = len(page.requests)
    _open_3d(page)
    after = page.requests[n_before:]
    assert any(u.endswith('/studio/embed/pair-viewer.js') for u in after)
    assert any(u.endswith('/models/active/%s_active.pdb.gz' % gid) for u in after)
    assert any(u.endswith('/models/inactive/%s_inactive.pdb.gz' % gid) for u in after)
    foreign = [u for u in after if not u.startswith(server) and not u.startswith('data:')
               and not u.startswith('blob:')]
    assert foreign == [], 'the 3D view contacted other hosts: %s' % foreign
    assert page.errors == [] and _console_errors(page) == [], (
        '%s: errors with the 3D view open: %s %s' % (gid, page.errors, _console_errors(page)))


@needs_viewer
def test_3d_view_draws_a_webgl_canvas_with_the_attribution_beside_it(open_extra):
    gid = _pick_report('par2_human', 'id="sec-3d"')
    page = open_extra(gid)
    _open_3d(page)
    canvas = page.locator('#rx-3d-pane canvas')
    assert canvas.count() >= 1, 'no canvas in the 3D pane'
    box = canvas.first.bounding_box()
    assert box and box['width'] > 200 and box['height'] > 150, 'canvas has no size: %s' % box
    assert page.evaluate("""(function () {
      var c = document.querySelector('#rx-3d-pane canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      return !!gl;
    })()"""), 'the canvas has no WebGL context'
    assert 'RMSD' in page.inner_text('#rx-3d-status')
    section = page.inner_text('#sec-3d')
    for needle in ('CC BY 4.0', 'Heo L, Feig M', 'Mol*', 'AlphaFold-Multistate'):
        assert needle in section, 'attribution lacks %r' % needle
    assert page.get_attribute('#sec-3d a.btn-ghost', 'href') == '../studio/?db=%s' % gid


@needs_viewer
def test_clicking_a_snake_residue_opens_the_drawer_and_focuses_the_3d_view(open_extra):
    gid = _pick_report('par2_human', 'id="sec-3d"', 'id="snake-plot-data"')
    page = open_extra(gid)
    assert page.locator('#rx-drawer').is_hidden(), 'the drawer must start closed'
    _open_3d(page)
    n = _snake_residue(page)
    assert n, 'no usable residue in the snake plot'

    page.locator('#rx-3d-pane').scroll_into_view_if_needed()
    before = page.locator('#rx-3d-pane').screenshot()
    _click_snake_residue(page, n)

    expect(page.locator('#rx-drawer')).to_be_visible()
    assert str(n) in page.inner_text('#rx-drawer-title')
    body = page.inner_text('#rx-drawer-body')
    for label in ('Generic number', 'Segment', 'Net', 'Largest', 'Contacts', 'ClinVar'):
        assert label in body, 'drawer lacks %r' % label
    assert page.evaluate('window.SnakeAPI.getSelectedResidue()') == n
    expect(page.locator('#rx-3d-pane')).to_have_attribute('data-focus', str(n))
    page.wait_for_timeout(1500)  # the camera move
    after = page.locator('#rx-3d-pane').screenshot()
    assert before != after, 'the 3D view did not change when a residue was selected'

    # Show in 3D from the drawer frames the same residue; Escape closes the drawer
    page.locator('#rx-show-in-3d').click()
    expect(page.locator('#rx-3d-pane')).to_have_attribute('data-focus', str(n))
    page.keyboard.press('Escape')
    expect(page.locator('#rx-drawer')).to_be_hidden()
    assert page.errors == [] and _console_errors(page) == [], (page.errors, _console_errors(page))


def test_a_table_cell_opens_the_drawer_and_a_deep_link_does_not(open_extra):
    gid = _pick_report('par2_human', 'id="variants-table"', 'id="snake-plot-data"')
    assert gid, 'no report with a variants table'
    # a landing on #res= selects the residue on the plot but leaves the drawer closed
    probe = open_extra(gid)
    n = _snake_residue(probe)
    page = open_extra(gid, '#res=%d' % n)
    assert page.evaluate('window.SnakeAPI.getSelectedResidue()') == n
    assert page.locator('#rx-drawer').is_hidden(), 'a #res= landing must not open the drawer'

    page = open_extra(gid)
    cell = page.locator('#variants-table tbody tr:not([hidden]) td:nth-child(1)').first
    pos = int(cell.inner_text().strip())
    cell.scroll_into_view_if_needed()
    cell.click()
    expect(page.locator('#rx-drawer')).to_be_visible()
    assert str(pos) in page.inner_text('#rx-drawer-title')
    assert 'Variants in this report' in page.inner_text('#rx-drawer-body')
    page.click('#rx-drawer-close')
    expect(page.locator('#rx-drawer')).to_be_hidden()
    assert page.errors == [] and _console_errors(page) == [], (page.errors, _console_errors(page))


def test_the_clinvar_section_is_collapsed_and_toggles(open_extra):
    with_records = _pick_report('opsd_human', 'id="sec-clinvar"', 'id="clinvar-table"')
    without = _pick_report('par2_human', 'id="sec-clinvar"', 'class="rx-none"')
    if not (with_records and without):
        pytest.skip('this build lacks a receptor with and one without ClinVar records')

    page = open_extra(with_records)
    details = page.locator('#rx-clinvar')
    assert details.get_attribute('open') is None, 'the ClinVar section must start collapsed'
    assert page.locator('#clinvar-table').is_hidden()
    assert re.search(r'ClinVar \d{4}-\d{2}-\d{2}: \d+ records?', page.inner_text('#rx-clinvar summary'))

    page.locator('#rx-clinvar summary').click()
    expect(page.locator('#clinvar-table')).to_be_visible()
    assert page.locator('#clinvar-table tbody tr').count() >= 1
    assert page.locator('#clinvar-table a[href^="https://www.ncbi.nlm.nih.gov/clinvar/variation/"]').count() >= 1
    page.locator('#rx-clinvar summary').click()
    expect(page.locator('#clinvar-table')).to_be_hidden()

    # a residue in the table opens the drawer with the same record
    page.locator('#rx-clinvar summary').click()
    link = page.locator('#clinvar-table .rx-res-link').first
    pos = link.get_attribute('data-rx-res')
    link.click()
    expect(page.locator('#rx-drawer')).to_be_visible()
    assert pos in page.inner_text('#rx-drawer-title')
    assert 'VCV' in page.inner_text('#rx-drawer-body')
    assert page.errors == [] and _console_errors(page) == [], (page.errors, _console_errors(page))

    page = open_extra(without)
    page.locator('#rx-clinvar summary').click()
    note = page.locator('#rx-clinvar .rx-none')
    expect(note).to_be_visible()
    assert 'No germline pathogenic or likely pathogenic missense records' in note.inner_text()
