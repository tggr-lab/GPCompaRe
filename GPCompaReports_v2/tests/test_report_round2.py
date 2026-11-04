"""Report-page improvements, round 2 (2026-11-04).

Protein name in the header, title and meta description; ClinVar scope wording;
section menu entries for the 3D view and ClinVar; the residue drawer as a
contact tool; the opt-in residue table; the favicon; red/blue header stat
cards; phone tables; Plotly loaded when charts near the screen.

The freeze test (test_freeze.py) guards the PI-approved report sections. The
build-level checks here also assert that none of this landed inside one. The
browser checks drive a built report in headless Chromium and skip without
Playwright (run them from the project venv, see scripts/run_browser_tests.sh).

Both halves read SMOKE_BUILD_DIR / FREEZE_BUILD_DIR (default output_v3_demo)
and skip when there is no build. The unit checks at the end need none.
"""
import csv
import functools
import http.server
import io
import json
import os
import pathlib
import re
import socketserver
import threading

import pytest

from .report_files import report_pages
from GPCompaReports_v2.website import seo
from GPCompaReports_v2.website.page_generators import gpcr_report_page, report_extras

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
CONFIG_RE = re.compile(r'<script type="application/json" id="rx-config">(.*?)</script>', re.S)


def _pages():
    return report_pages(REPORTS_DIR) if REPORTS_DIR.is_dir() else []


def _html(gid):
    return (REPORTS_DIR / ('%s.html' % gid)).read_text(encoding='utf-8')


def _outside_sections(html):
    return SECTION_RE.sub('<section-removed/>', html)


def _pick(*needles, prefer='par2_human'):
    ids = sorted((p.stem for p in _pages()), key=lambda g: (g != prefer, g))
    for gid in ids:
        h = _html(gid)
        if all(n in h for n in needles):
            return gid
    return None


# --------------------------------------------------------------------------
# build-level checks
# --------------------------------------------------------------------------

@needs_build
def test_title_and_description_name_the_protein():
    names = gpcr_report_page.load_protein_names()
    checked = 0
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        title = re.search(r'<title>(.*?)</title>', html).group(1)
        assert title.endswith(' · GPCompaRe'), title
        m = re.search(r'<meta name="description" content="([^"]*)"', html)
        assert m, '%s: no meta description' % path.stem
        uid = re.search(r'report-meta-label">UniProt</span> <code>([A-Z0-9]+)</code>', html)
        if uid and uid.group(1) in names:
            protein = names[uid.group(1)]
            symbol = re.search(r'<h1 class="report-title">(.*?)</h1>', html).group(1)
            if protein.upper() != symbol.upper():
                assert title == '%s · %s · GPCompaRe' % (symbol, protein), title
                assert protein in m.group(1).replace('&#39;', "'").replace('&amp;', '&'), m.group(1)
            checked += 1
        assert 'snake plot' in m.group(1) and 'contact pairs' in m.group(1)
    assert checked, 'no report had a UniProt name to check'


@needs_build
def test_adrb2_header_title_and_name():
    if not (REPORTS_DIR / 'adrb2_human.html').is_file():
        pytest.skip('no ADRB2 in this build')
    html = _html('adrb2_human')
    assert '<title>ADRB2 · Beta-2 adrenergic receptor · GPCompaRe</title>' in html
    assert re.search(r'<meta name="description" content="ADRB2, Beta-2 adrenergic receptor', html)
    assert '<span class="report-protein-name">Beta-2 adrenergic receptor</span>' in html
    # the header is outside every frozen section
    assert 'report-protein-name' not in ''.join(SECTION_RE.findall(html))
    assert 'report-protein-name' in _outside_sections(html)


@needs_build
def test_header_stat_cards_follow_the_red_blue_convention_outside_the_frozen_sections():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        bodies = ''.join(SECTION_RE.findall(html))
        assert 'report-stat-up' not in bodies and 'report-stat-down' not in bodies
        m = re.search(r'<div class="report-stat report-stat-up"[^>]*>.*?Max Increase', html, re.S)
        n = re.search(r'<div class="report-stat report-stat-down"[^>]*>.*?Max Decrease', html, re.S)
        assert m and n, '%s: Max Increase / Max Decrease are not marked up/down' % path.stem
    css = (BASE / 'static' / 'css' / 'report-extras.css').read_text(encoding='utf-8')
    assert re.search(r'\.report-stat-up[^{]*\{[^}]*var\(--semantic-active\)', css)
    assert re.search(r'\.report-stat-down[^{]*\{[^}]*var\(--semantic-inactive\)', css)


@needs_build
def test_plotly_is_not_a_blocking_script_tag_and_the_shim_covers_every_call():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        assert not re.search(r'<script[^>]+src="https://cdn\.plot\.ly', html), (
            '%s still loads Plotly with a blocking script tag' % path.stem)
        assert html.count('cdn.plot.ly/plotly-3.3.1.min.js') == 1, 'the CDN URL appears once, in the loader'
    # every Plotly entry point the pages use is queued by the stand-in
    shim = (BASE / 'templates' / '_partials' / 'plotly-lazy.html').read_text(encoding='utf-8')
    used = set()
    for src in [(BASE / 'templates' / 'gpcr_report.html'), (BASE / 'templates' / 'statistics.html'),
                BASE / 'static' / 'js' / 'site.js', BASE / 'static' / 'js' / 'rrcs-tetris.js']:
        used |= set(re.findall(r'\bPlotly\.(?:Plots\.)?(\w+)\(', src.read_text(encoding='utf-8')))
    assert used, 'no Plotly calls found'
    for name in used:
        assert "'%s'" % name in shim, 'the Plotly stand-in does not queue %s' % name


@needs_build
def test_statistics_page_defers_plotly_too():
    stats = BUILD_DIR / 'statistics.html'
    if not stats.is_file():
        pytest.skip('no statistics page in this build')
    html = stats.read_text(encoding='utf-8')
    assert not re.search(r'<script[^>]+src="https://cdn\.plot\.ly', html)
    assert 'IntersectionObserver' in html


@needs_build
def test_favicons_are_linked_and_exist_on_every_page():
    for page in [BUILD_DIR / 'index.html', BUILD_DIR / 'statistics.html'] + _pages()[:3]:
        if not page.is_file():
            continue
        html = page.read_text(encoding='utf-8')
        hrefs = re.findall(r'<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"', html)
        assert len(hrefs) >= 3, '%s: favicon links missing' % page.name
        for href in hrefs:
            target = (page.parent / href).resolve()
            assert target.is_file(), '%s: %s does not exist in the build' % (page.name, href)
        assert 'rel="apple-touch-icon"' in html


@needs_build
def test_clinvar_section_states_its_scope_and_links_to_all_records():
    gid = _pick('id="sec-clinvar"')
    if not gid:
        pytest.skip('no ClinVar section in this build')
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        m = re.search(r'<section class="report-extra" id="sec-clinvar".*?</section>', html, re.S)
        if not m:
            continue
        block = m.group(0)
        assert 'ClinVar pathogenic or likely pathogenic missense records</h2>' in block
        assert 'data-nav-title="ClinVar"' in block
        assert re.search(r'<a [^>]*id="rx-clinvar-search" href="\.\./search/\?q=[^"&]+"', block)
        assert 'no records' not in block.lower().replace('no pathogenic', '')
        if 'clinvar-table' not in block:
            assert re.search(r'No pathogenic or likely pathogenic missense records in ClinVar \d{4}-\d{2}-\d{2}', block)
        assert 'germline' not in re.search(r'<summary>.*?</summary>', block, re.S).group(0)
        assert 'class="rx-none"' not in block or 'use the ClinVar search above' in block


@needs_build
def test_nav_entries_for_the_opt_in_blocks_are_markers_not_section_labels():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        for sid, title in (('sec-3d', '3D view'), ('sec-clinvar', 'ClinVar'), ('sec-residues', 'Residue table')):
            m = re.search(r'<section class="report-extra" id="%s"([^>]*)>' % sid, html)
            if not m:
                continue
            assert 'data-nav-title="%s"' % title in m.group(1)
            assert 'data-section-title' not in m.group(1)


@needs_build
def test_residue_table_is_closed_empty_and_outside_every_section():
    seen = 0
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        m = re.search(r'<section class="report-extra" id="sec-residues".*?</section>', html, re.S)
        if not m:
            continue
        seen += 1
        block = m.group(0)
        assert re.search(r'<details class="rx-details" id="rx-residues">', block), 'collapsed: no open attribute'
        assert re.search(r'<div id="rx-residues-mount"></div>', block), 'nothing is built before it is opened'
        assert '<table' not in block
        assert 'rx-residues' not in ''.join(SECTION_RE.findall(html))
        extra = re.search(r'<script type="application/json" id="rx-residue-extra">(.*?)</script>', html, re.S)
        data = json.loads(extra.group(1))
        summary = json.loads(re.search(r'id="residue-summary-data">(.*?)</script>', html, re.S).group(1))
        assert set(data['rows']) == {str(r['position']) for r in summary}
        assert isinstance(data['sig'], float)
        for n_above, am, cons, *flag in data['rows'].values():
            assert isinstance(n_above, int) and n_above >= 0
            assert flag in ([], [0], [1])  # 1: a top cross-receptor CFR position (older builds: no flag)
            assert am is None or 0 <= am <= 1
            assert cons is None or 0 <= cons <= 1
    assert seen, 'no report has the residue table'


@needs_build
def test_new_report_copy_has_no_em_dash():
    for name in ('residue-table.js', 'residue-drawer.js', 'v3-nav.js', 'viewer3d.js'):
        text = (BASE / 'static' / 'js' / name).read_text(encoding='utf-8')
        assert '—' not in text, name
    assert '—' not in (BASE / 'static' / 'css' / 'report-extras.css').read_text(encoding='utf-8')
    assert '—' not in (BASE / 'templates' / '_partials' / 'plotly-lazy.html').read_text(encoding='utf-8')
    for path in _pages():
        outside = _outside_sections(path.read_text(encoding='utf-8'))
        for block in re.findall(r'<section class="report-extra".*?</section>', outside, re.S):
            assert '—' not in block


@needs_build
def test_the_new_scripts_request_nothing_from_studio_or_models():
    for name in ('residue-table.js', 'residue-drawer.js', 'v3-nav.js'):
        text = (BASE / 'static' / 'js' / name).read_text(encoding='utf-8')
        assert 'studio/' not in text and 'models/' not in text and 'fetch(' not in text, name


# --------------------------------------------------------------------------
# unit checks (no build needed)
# --------------------------------------------------------------------------

def test_recommended_name_takes_the_text_before_the_first_bracket():
    f = gpcr_report_page.recommended_name
    assert f('Beta-2 adrenergic receptor (Beta-2 adrenoreceptor) (Beta-2 adrenoceptor)') == 'Beta-2 adrenergic receptor'
    assert f('Rhodopsin (Opsin-2)') == 'Rhodopsin'
    assert f('Proteinase-activated receptor 2 (PAR-2) [Cleaved into: x]') == 'Proteinase-activated receptor 2'
    assert f('') == '' and f(None) == ''


def test_every_receptor_of_the_snapshot_has_a_name():
    names = gpcr_report_page.load_protein_names()
    assert len(names) >= 283
    assert names['P07550'] == 'Beta-2 adrenergic receptor'


def test_title_and_description_builders():
    info = {'uniprot_name': 'ADRB2', 'gene_name': 'ADRB2', 'receptor_family': 'Adrenoceptors'}
    assert seo.report_title(info, 'Beta-2 adrenergic receptor') == 'ADRB2 · Beta-2 adrenergic receptor · GPCompaRe'
    assert seo.report_title(info, '') == 'ADRB2 · GPCompaRe'
    assert seo.report_title(info, 'adrb2') == 'ADRB2 · GPCompaRe'
    d = seo.report_description(info, 1.97, 700, 'Beta-2 adrenergic receptor')
    assert d.startswith('ADRB2, Beta-2 adrenergic receptor (Adrenoceptors family): ')
    assert '700 contact pairs' in d and '1.97' in d and '—' not in d
    par2 = {'uniprot_name': 'PAR2', 'gene_name': 'F2RL1', 'receptor_family': 'Proteinase-activated'}
    assert seo.report_description(par2, 1.0, 5, 'Proteinase-activated receptor 2').startswith(
        'PAR2, Proteinase-activated receptor 2 (gene F2RL1, Proteinase-activated family)')


def test_residue_table_extras_counts_pairs_at_the_receptors_threshold():
    pd = pytest.importorskip('pandas')
    df = pd.DataFrame({'res1': [1, 1, 2], 'res2': [2, 3, 3], 'delta_rrcs': [2.0, -0.5, -3.0]})
    out = report_extras.residue_table_extras(df, 1.0, {1: 0.4567, 3: 0.9}, {2: 0.25}, [1, 2, 3])
    assert out['sig'] == 1.0
    assert out['rows'] == {'1': [1, 0.457, None, 0], '2': [2, None, 0.25, 0], '3': [1, 0.9, None, 0]}


# --------------------------------------------------------------------------
# browser checks
# --------------------------------------------------------------------------

sync_api = pytest.importorskip('playwright.sync_api', reason='Playwright is not installed here; use the project venv')
expect = sync_api.expect

PLOTLY_JS = None
try:
    import plotly as _plotly
    _p = pathlib.Path(_plotly.__file__).parent / 'package_data' / 'plotly.min.js'
    PLOTLY_JS = _p if _p.is_file() else None
except Exception:  # pragma: no cover
    PLOTLY_JS = None

BLOCKED = ('**gc.zgo.at/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**')
HAS_VIEWER = ((BUILD_DIR / 'studio' / 'embed' / 'pair-viewer.js').is_file()
              and (BUILD_DIR / 'models' / 'active').is_dir())
needs_viewer = pytest.mark.skipif(not HAS_VIEWER, reason='%s has no studio/embed or models/' % BUILD_DIR)
needs_plotly = pytest.mark.skipif(PLOTLY_JS is None, reason='no local plotly.min.js to stand in for the CDN')

DESKTOP = {'width': 1280, 'height': 900}
PHONE = {'width': 390, 'height': 844}


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

    def _open(gid, hash_='', viewport=DESKTOP, dark=False, plotly=True, wait=500, path=None):
        ctx = browser.new_context(viewport=viewport, color_scheme='dark' if dark else 'light',
                                  permissions=['clipboard-read', 'clipboard-write'],
                                  accept_downloads=True)
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
        url = '%s/%s' % (server, path or 'reports/%s.html' % gid)
        page.goto(url + hash_, wait_until='load')
        page.wait_for_timeout(wait)
        return page

    yield _open
    for ctx in contexts:
        ctx.close()


def _errors(page):
    ours = [t for t, url in page.console_errors if 'plot.ly' not in url and 'gc.zgo.at' not in url]
    return page.errors + ours


def _no_horizontal_overflow(page):
    return page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')


# ---- section menu --------------------------------------------------------

@needs_build
def test_section_menu_has_3d_and_clinvar_and_they_only_scroll(open_report):
    gid = _pick('id="sec-3d"', 'id="sec-clinvar"')
    if not gid:
        pytest.skip('no report with both blocks')
    page = open_report(gid)
    labels = page.locator('.v3-secnav a').all_inner_texts()
    assert '3D view' in labels and 'ClinVar' in labels
    assert labels.index('Snake plot') < labels.index('3D view') < labels.index('Largest changes')
    assert labels.index('Variants') < labels.index('ClinVar') < labels.index('Residue table') < labels.index('RRCS results')
    n_before = len(page.requests)
    for label, sid in (('3D view', 'sec-3d'), ('ClinVar', 'sec-clinvar')):
        page.locator('.v3-secnav a', has_text=label).first.click()
        page.wait_for_timeout(500)
        top = page.evaluate('document.getElementById(%r).getBoundingClientRect().top' % sid)
        chrome = page.evaluate("Math.max.apply(null, [].map.call(document.querySelectorAll('.topbar, .v3-secnav'), e => e.getBoundingClientRect().bottom))")
        assert chrome - 2 <= top <= chrome + 110, (label, top, chrome)
        assert page.locator('.v3-secnav a.on').count() == 1
        assert page.eval_on_selector('.v3-secnav a.on', 'e => e.dataset.target') == sid, label
    # nothing was opened or loaded
    assert page.locator('#rx-3d-panel').is_hidden()
    assert page.get_attribute('#rx-3d-toggle', 'aria-expanded') == 'false'
    assert page.locator('#rx-clinvar').get_attribute('open') is None
    loaded = [u for u in page.requests[n_before:] if '/studio/' in u or '/models/' in u]
    assert loaded == []
    assert _errors(page) == []


@needs_build
def test_menu_highlight_follows_the_3d_block_not_the_snake_plot(open_report):
    gid = _pick('id="sec-3d"')
    if not gid:
        pytest.skip('no 3D block')
    page = open_report(gid)
    # put the 3D heading where a reader would be looking at it: under the sticky chrome.
    # (Sections below the fold are laid out lazily, so heights above it settle while
    # scrolling: aim again until the heading holds still.)
    for _ in range(6):
        page.evaluate("""() => {
          var h = document.getElementById('rx-3d-title');
          var chrome = document.querySelector('.v3-secnav').getBoundingClientRect().bottom;
          window.scrollBy({ top: h.getBoundingClientRect().top - chrome - 20, behavior: 'instant' });
        }""")
        page.wait_for_timeout(300)
    off = page.evaluate("document.getElementById('rx-3d-title').getBoundingClientRect().top - document.querySelector('.v3-secnav').getBoundingClientRect().bottom")
    assert 0 <= off <= 60, off
    on = page.eval_on_selector('.v3-secnav a.on', 'e => e.textContent')
    assert on == '3D view', on
    page.evaluate("window.scrollTo({ top: 0, behavior: 'instant' })")
    page.wait_for_timeout(300)
    assert page.locator('.v3-secnav a.on').count() == 0, 'nothing is lit above the first section'


# ---- ClinVar empty state and the drawer ---------------------------------------

@needs_build
def test_clinvar_empty_state_in_the_section_and_in_the_drawer(open_report):
    empty = _pick('id="sec-clinvar"', 'id="snake-plot-data"')
    for path in _pages():
        h = path.read_text(encoding='utf-8')
        if 'id="sec-clinvar"' in h and 'clinvar-table' not in h and 'id="snake-plot-data"' in h:
            empty = path.stem
            break
    else:
        pytest.skip('no receptor without ClinVar records in this build')
    page = open_report(empty)
    release = re.search(r'ClinVar (\d{4}-\d{2}-\d{2})', page.inner_text('#rx-clinvar summary')).group(1)
    sentence = 'No pathogenic or likely pathogenic missense records in ClinVar %s' % release
    assert page.inner_text('#rx-clinvar summary').strip() == sentence
    assert page.inner_text('#rx-clinvar-title').strip() == 'ClinVar pathogenic or likely pathogenic missense records'
    link = page.locator('#rx-clinvar-search')
    assert link.get_attribute('href').startswith('../search/?q=')
    assert 'Search all ClinVar records' in link.inner_text()
    # the drawer says the same, and links to the full search
    pos = page.evaluate("JSON.parse(document.getElementById('residue-summary-data').textContent)[5].position")
    page.evaluate('ReportExtras.select(%d, {source: "table"})' % pos)
    body = page.inner_text('#rx-drawer-body')
    assert sentence in body
    assert 'None' not in body.split('ClinVar')[-1][:80]
    assert page.locator('#rx-drawer-body a.rx-more-link').get_attribute('href').startswith('../search/?q=')
    assert _errors(page) == []


@needs_build
def test_drawer_has_generic_link_copy_link_and_contact_partners(open_report):
    gid = _pick('id="rrcs-table"', 'id="snake-plot-data"')
    page = open_report(gid)
    # a residue with a generic number and several contacts
    pos = page.evaluate("""() => {
      var rows = JSON.parse(document.getElementById('residue-summary-data').textContent);
      var cfg = JSON.parse(document.getElementById('rx-config').textContent);
      var best = rows.filter(r => (cfg.annotation[String(r.position)] || [])[1] && r.n_contact_partners > 12)[0];
      return best.position;
    }""")
    page.evaluate('ReportExtras.select(%d, {source: "table"})' % pos)
    gn = page.evaluate("JSON.parse(document.getElementById('rx-config').textContent).annotation[%d][1]" % pos)
    link = page.locator('#rx-drawer-body a', has_text='in all receptors')
    assert link.inner_text() == '%s in all receptors' % gn
    assert link.get_attribute('href') == '../search/?q=%s' % gn

    # copy link: the report URL with #res=
    page.click('#rx-copy-link')
    expect(page.locator('.rx-copied')).to_have_text('Link copied')
    copied = page.evaluate('navigator.clipboard.readText()')
    assert copied.endswith('/reports/%s.html#res=%d' % (gid, pos)), copied

    # contact partners: values come from the page's RRCS table
    rows = page.locator('.rx-pairs tbody tr')
    assert rows.count() >= 8
    first = rows.first.locator('td').all_inner_texts()
    other = int(re.search(r'(\d+)', first[0]).group(1))
    act, inact, delta = float(first[1]), float(first[2]), float(first[3])
    assert abs((act - inact) - delta) < 0.02, first
    table_row = page.evaluate("""([a, b]) => {
      var t = document.getElementById('rrcs-table');
      for (var r of t.tBodies[0].rows) {
        var c = r.cells, x = +c[0].textContent, y = +c[2].textContent;
        if ((x === a && y === b) || (x === b && y === a)) return [c[4].textContent, c[5].textContent, c[6].textContent];
      }
    }""", [pos, other])
    assert [float(v) for v in table_row] == pytest.approx([act, inact, delta], abs=0.006)
    # sign colours: red for positive, blue for negative
    cls = page.locator('.rx-pairs tbody tr').first.locator('td').nth(3).get_attribute('class')
    assert ('is-active' in cls) == (delta >= 0) and ('is-inactive' in cls) == (delta < 0)
    # sorted by |delta|
    deltas = [abs(float(r.locator('td').nth(3).inner_text())) for r in
              [rows.nth(i) for i in range(rows.count())]]
    assert deltas == sorted(deltas, reverse=True)
    assert _errors(page) == []


@needs_build
def test_arriving_with_res_in_the_hash_opens_the_drawer_and_old_links_still_work(open_report):
    gid = _pick('id="snake-plot-data"', 'id="variants-table"')
    probe = open_report(gid)
    n = probe.evaluate("JSON.parse(document.getElementById('residue-summary-data').textContent)[10].position")
    for hash_ in ('#res=%d' % n, '#sec=sec-changes&res=%d' % n, '#res=%d&view=cfr' % n):
        page = open_report(gid, hash_)
        expect(page.locator('#rx-drawer')).to_be_visible()
        assert page.inner_text('#rx-drawer-title').endswith(str(n)), hash_
        assert _errors(page) == [], hash_
    # the snake plot still selects it (backward compatible grammar)
    assert page.evaluate('window.SnakeAPI.getSelectedResidue()') == n
    # a hash without res leaves the drawer closed; a later hashchange opens it
    page = open_report(gid, '#sec=sec-changes')
    assert page.locator('#rx-drawer').is_hidden()
    page.evaluate('location.hash = "#res=%d"' % n)
    expect(page.locator('#rx-drawer')).to_be_visible()


@needs_build
def test_table_cells_that_open_the_drawer_are_focusable_and_open_on_enter(open_report):
    gid = _pick('id="top-changes-table"', 'id="variants-table"')
    page = open_report(gid)
    for table, nth in (('top-changes-table', 2), ('variants-table', 1), ('rrcs-table', 1)):
        cell = page.locator('#%s tbody tr:not([hidden]) td:nth-child(%d)' % (table, nth)).first
        assert cell.get_attribute('tabindex') == '0', table
        cell.focus()
        text = cell.inner_text()
        page.keyboard.press('Enter')
        expect(page.locator('#rx-drawer')).to_be_visible()
        pos = re.search(r'(\d+)', text).group(1)
        assert pos in page.inner_text('#rx-drawer-title'), (table, text)
        assert page.evaluate("document.activeElement.id") == 'rx-drawer', 'focus moves to the drawer'
        page.keyboard.press('Escape')
        expect(page.locator('#rx-drawer')).to_be_hidden()
    assert _errors(page) == []


@needs_build
def test_pair_focus_says_open_3d_while_the_view_is_closed_and_loads_nothing(open_report):
    gid = _pick('id="sec-3d"', 'id="rrcs-table"')
    if not gid:
        pytest.skip('no 3D block')
    page = open_report(gid)
    pos = page.evaluate("JSON.parse(document.getElementById('residue-summary-data').textContent).filter(r => r.n_contact_partners > 6)[0].position")
    page.evaluate('ReportExtras.select(%d, {source: "table"})' % pos)
    btn = page.locator('.rx-pair-focus').first
    assert btn.inner_text() == 'Open 3D'
    assert 'Open the 3D view and focus this pair' in btn.get_attribute('aria-label')
    assert [u for u in page.requests if '/studio/' in u or '/models/' in u] == []
    assert page.locator('#rx-3d-panel').is_hidden()


@needs_build
@needs_viewer
def test_focus_this_pair_opens_the_view_and_highlights_the_pair(open_report):
    gid = _pick('id="sec-3d"', 'id="rrcs-table"')
    page = open_report(gid)
    pos = page.evaluate("JSON.parse(document.getElementById('residue-summary-data').textContent).filter(r => r.n_contact_partners > 6)[0].position")
    page.evaluate('ReportExtras.select(%d, {source: "table"})' % pos)
    btn = page.locator('.rx-pair-focus').first
    other = btn.get_attribute('data-b')
    btn.click()
    page.wait_for_selector('#rx-3d-pane[data-state="ready"]', timeout=90000)
    expect(page.locator('#rx-3d-pane')).to_have_attribute('data-pair', '%d,%s' % (pos, other))
    assert page.locator('.rx-pair-focus').first.inner_text() == 'Focus'
    status = page.inner_text('#rx-3d-status')
    assert 'RMSD' not in status and status.startswith('Superposed on ') and status.endswith('Cα atoms (all residues)')
    # with the view open, a second pair acts at once
    second = page.locator('.rx-pair-focus').nth(1)
    b2 = second.get_attribute('data-b')
    second.click()
    expect(page.locator('#rx-3d-pane')).to_have_attribute('data-pair', '%d,%s' % (pos, b2))
    assert _errors(page) == []


# ---- residue table ---------------------------------------------------------

@needs_build
def test_residue_table_builds_only_when_opened_and_filters_sorts_and_exports(open_report):
    gid = _pick('id="sec-residues"', 'id="snake-plot-data"')
    page = open_report(gid)
    assert page.locator('#rx-residue-table').count() == 0, 'no table before it is opened'
    assert page.locator('#rx-residues-mount').inner_html() == ''
    page.locator('#rx-residues summary').click()
    table = page.locator('#rx-residue-table')
    expect(table).to_be_visible()
    summary = page.evaluate("JSON.parse(document.getElementById('residue-summary-data').textContent)")
    assert page.locator('#rx-residue-table tbody tr').count() == len(summary)
    heads = page.locator('#rx-residue-table thead th').all_inner_texts()
    assert heads == ['Residue', 'Generic number', 'Segment', 'Net ΔRRCS', 'Largest |ΔRRCS|', 'Partner',
                     'Contacts above threshold', 'CFR position', 'AlphaMissense mean', 'Conservation']

    # a row carries the page's own numbers
    first = page.locator('#rx-residue-table tbody tr').first.locator('td').all_inner_texts()
    r0 = min(summary, key=lambda r: r['position'])
    assert first[0].endswith(str(r0['position']))
    assert float(first[3]) == pytest.approx(r0['active_minus_inactive'], abs=0.006)
    assert float(first[4]) == pytest.approx(r0['max_abs_delta'], abs=0.006)
    assert first[5] == r0['partner_at_max']

    # direction colours: red for positive, blue for negative
    for row in (page.locator('#rx-residue-table tbody tr').nth(i) for i in range(5)):
        net = row.locator('td').nth(3)
        v = float(net.inner_text())
        assert ('is-active' in net.get_attribute('class')) == (v >= 0)

    # filters
    n_active = sum(1 for r in summary if r['active_minus_inactive'] > 0)
    n_inactive = sum(1 for r in summary if r['active_minus_inactive'] < 0)
    page.click('.rx-filter-btn.rx-filter-active')
    assert page.locator('#rx-residue-table tbody tr').count() == n_active
    assert page.get_attribute('.rx-filter-btn.rx-filter-active', 'aria-pressed') == 'true'
    page.click('.rx-filter-btn.rx-filter-inactive')
    assert page.locator('#rx-residue-table tbody tr').count() == n_inactive
    page.click('.rx-filter-btn.rx-filter-inactive')
    page.click('.rx-filter-btn:has-text("TM helices only")')
    segs = {r.locator('td').nth(2).inner_text() for r in
            (page.locator('#rx-residue-table tbody tr').nth(i) for i in range(page.locator('#rx-residue-table tbody tr').count()))}
    assert segs and all(re.fullmatch(r'TM[1-7]', s) for s in segs), segs
    assert 'loops, termini' in page.inner_text('#rx-residues')
    page.click('.rx-filter-btn:has-text("TM helices only")')

    # sorting: by largest |dRRCS|, descending then ascending
    page.click('#rx-residue-table th[data-key="max"] button')
    vals = [float(page.locator('#rx-residue-table tbody tr').nth(i).locator('td').nth(4).inner_text()) for i in range(30)]
    assert vals == sorted(vals, reverse=True)
    assert page.get_attribute('#rx-residue-table th[data-key="max"]', 'aria-sort') == 'descending'
    page.click('#rx-residue-table th[data-key="max"] button')
    vals = [float(page.locator('#rx-residue-table tbody tr').nth(i).locator('td').nth(4).inner_text()) for i in range(30)]
    assert vals == sorted(vals)

    # CSV: the rows shown, in the order shown
    page.click('.rx-filter-btn.rx-filter-active')
    with page.expect_download() as dl:
        page.click('.rx-rt-csv')
    path = dl.value.path()
    assert dl.value.suggested_filename == '%s_residue_table.csv' % gid
    rows = list(csv.DictReader(io.StringIO(pathlib.Path(path).read_text(encoding='utf-8'))))
    assert list(rows[0]) == ['position', 'residue', 'generic_number', 'segment', 'net_delta_rrcs',
                             'largest_abs_delta_rrcs', 'partner_at_largest', 'contacts_above_threshold',
                             'cfr', 'alphamissense_mean', 'conservation']
    assert len(rows) == n_active
    assert all(float(r['net_delta_rrcs']) > 0 for r in rows)
    by_pos = {r['position']: r for r in summary}
    for r in rows[:25]:
        s = by_pos[int(r['position'])]
        assert float(r['net_delta_rrcs']) == pytest.approx(s['active_minus_inactive'], abs=0.0006)
        assert float(r['largest_abs_delta_rrcs']) == pytest.approx(s['max_abs_delta'], abs=0.0006)
        assert r['partner_at_largest'] == s['partner_at_max']
        assert r['cfr'] in ('yes', 'no')
    assert page.inner_text('.rx-rt-csv') == 'Download CSV (%d rows)' % n_active
    # the table's residue names open the drawer
    page.locator('#rx-residue-table .rx-res-link').first.click()
    expect(page.locator('#rx-drawer')).to_be_visible()
    assert _errors(page) == []


@needs_build
def test_residue_table_is_usable_on_a_phone_in_dark_mode(open_report):
    gid = _pick('id="sec-residues"')
    page = open_report(gid, viewport=PHONE, dark=True)
    page.locator('#rx-residues summary').click()
    expect(page.locator('#rx-residue-table')).to_be_visible()
    assert _no_horizontal_overflow(page)
    wrap = page.locator('#rx-residues .v2-table-scroll')
    assert wrap.evaluate('e => e.scrollWidth > e.clientWidth'), 'the table scrolls sideways inside its own box'
    # the residue column stays in view while the table scrolls
    wrap.evaluate('e => { e.scrollLeft = 400; }')
    box = page.locator('#rx-residue-table tbody tr').first.locator('td').first.bounding_box()
    wbox = wrap.bounding_box()
    assert box['x'] >= wbox['x'] - 1 and box['x'] < wbox['x'] + 120
    assert _errors(page) == []


# ---- phone tables --------------------------------------------------------

@needs_build
@pytest.mark.parametrize('dark', [False, True])
def test_phone_tables_keep_delta_rrcs_in_view_and_rsids_on_one_line(open_report, dark):
    gid = _pick('id="top-changes-table"', 'id="variants-table"')
    page = open_report(gid, viewport=PHONE, dark=dark)
    assert _no_horizontal_overflow(page)
    for table, col, label in (('top-changes-table', 6, 'ΔRRCS'), ('variants-table', 6, 'ΔRRCS')):
        scroll = page.locator('#%s' % table).locator('xpath=ancestor::div[contains(@class,"v2-table-scroll")]')
        scroll.scroll_into_view_if_needed()
        sbox = scroll.bounding_box()
        for left in (0, 150, 10000):   # start, middle, far right
            scroll.evaluate('(e, x) => { e.scrollLeft = x; }', left)
            page.wait_for_timeout(100)
            th = page.locator('#%s thead th:nth-child(%d)' % (table, col)).bounding_box()
            td = page.locator('#%s tbody tr:not([hidden]) td:nth-child(%d)' % (table, col)).first.bounding_box()
            for b in (th, td):
                assert b['x'] >= sbox['x'] - 1 and b['x'] + b['width'] <= sbox['x'] + sbox['width'] + 1, (
                    '%s: %s column is outside the visible table at scrollLeft=%s' % (table, label, left))
        assert page.locator('#%s thead th:nth-child(%d)' % (table, col)).inner_text().startswith(label)
    # rsIDs: nowrap, and no row is taller than a normal one
    heights = page.eval_on_selector_all('#variants-table tbody tr:not([hidden])', 'rows => rows.map(r => r.getBoundingClientRect().height)')
    assert heights and max(heights) < 56, max(heights)
    ws = page.eval_on_selector('#variants-table tbody tr:not([hidden]) td:last-child', 'e => getComputedStyle(e).whiteSpace')
    assert ws == 'nowrap'
    assert _errors(page) == []


# ---- header ---------------------------------------------------------------

@needs_build
@pytest.mark.parametrize('dark', [False, True])
def test_header_cards_and_protein_name_on_a_phone(open_report, dark):
    gid = 'adrb2_human' if (REPORTS_DIR / 'adrb2_human.html').is_file() else _pages()[0].stem
    page = open_report(gid, viewport=PHONE, dark=dark)
    assert _no_horizontal_overflow(page)
    assert page.locator('.report-protein-name').is_visible()
    colours = page.evaluate("""() => {
      function c(sel) { return getComputedStyle(document.querySelector(sel)).color; }
      var root = getComputedStyle(document.documentElement);
      var probe = document.createElement('span'); document.body.appendChild(probe);
      function tok(name) { probe.style.color = 'var(' + name + ')'; return getComputedStyle(probe).color; }
      return {up: c('.report-stat-up .report-stat-num'), down: c('.report-stat-down .report-stat-num'),
              active: tok('--semantic-active'), inactive: tok('--semantic-inactive')};
    }""")
    assert colours['up'] == colours['active'] and colours['down'] == colours['inactive']
    assert colours['up'] != colours['down']
    assert _errors(page) == []


# ---- Plotly loaded on demand -------------------------------------------------

@needs_build
@needs_plotly
def test_plotly_is_requested_only_when_charts_near_the_screen_and_charts_render(open_report):
    gid = _pick('id="sec-charts"', 'id="tm-breakdown-chart"')
    page = open_report(gid, viewport=PHONE, wait=800)
    assert [u for u in page.requests if 'plot.ly' in u] == [], 'Plotly must not be requested at load'
    assert page.evaluate("typeof Plotly === 'object' && !Plotly.version"), 'the stand-in is in place'
    assert page.evaluate("[].every.call(document.querySelectorAll('.v2-chart'), e => !e.dataset.chartRendered)")
    page.evaluate("document.getElementById('sec-charts').scrollIntoView()")
    page.wait_for_function("[].every.call(document.querySelectorAll('.v2-chart'), e => e.dataset.chartRendered)", timeout=30000)
    assert len([u for u in page.requests if 'plot.ly' in u]) == 1
    assert page.evaluate('!!Plotly.version')
    sig = page.evaluate("""[].map.call(document.querySelectorAll('.v2-chart'), e => [e.id, !!e.data, e.querySelectorAll('.trace').length > 0])""")
    assert [s[0] for s in sig] == ['delta-chart', 'scatter-chart', 'residue-chart', 'tm-breakdown-chart']
    assert all(s[1] and s[2] for s in sig), sig
    # the figure is the one the page carries: same data, theme override applied
    n = page.evaluate("""() => {
      var d = window.CHART_DATA['delta-chart'];
      var el = document.getElementById('delta-chart');
      return [d.data.length, el.data.length, el.layout.paper_bgcolor];
    }""")
    assert n[0] == n[1] and n[2] == '#ffffff'
    assert _errors(page) == []


@needs_build
@needs_plotly
def test_a_theme_switch_and_the_tm_toggle_work_after_the_deferred_load(open_report):
    gid = _pick('id="sec-charts"', 'id="tm-breakdown-chart"')
    page = open_report(gid, wait=600)
    # press "Directional" BEFORE the chart exists: it must be applied once it is drawn
    page.evaluate("document.getElementById('sec-charts').scrollIntoView()")
    page.click('.tm-breakdown-toggle [data-tm-view="directional"]')
    page.wait_for_function("document.getElementById('tm-breakdown-chart').dataset.chartRendered", timeout=30000)
    page.wait_for_function("""document.getElementById('tm-breakdown-chart').layout &&
      document.getElementById('tm-breakdown-chart').layout.yaxis.title.text === 'Mean signed ΔRRCS'""", timeout=10000)
    # theme switch recolours drawn charts
    page.click('#theme-toggle')
    page.wait_for_function("document.documentElement.getAttribute('data-color-mode') === 'dark'")
    page.wait_for_function("document.getElementById('delta-chart').layout.paper_bgcolor !== '#ffffff'", timeout=10000)
    assert _errors(page) == []


@needs_build
def test_with_plotly_blocked_the_page_behaves_as_before_and_raises_no_errors(open_report):
    gid = _pick('id="sec-charts"')
    page = open_report(gid, plotly=False, wait=300)
    page.evaluate("document.getElementById('sec-charts').scrollIntoView()")
    page.wait_for_timeout(1500)
    assert page.evaluate("typeof Plotly === 'undefined'"), 'the stand-in removes itself when the library cannot load'
    assert page.errors == [], page.errors
    page.evaluate("document.querySelector('.tm-breakdown-toggle [data-tm-view=\"directional\"]') && document.querySelector('.tm-breakdown-toggle [data-tm-view=\"directional\"]').click()")
    page.wait_for_timeout(500)
    assert page.errors == []


@needs_build
@needs_plotly
def test_statistics_page_charts_still_render(open_report):
    if not (BUILD_DIR / 'statistics.html').is_file():
        pytest.skip('no statistics page in this build')
    page = open_report(None, path='statistics.html', wait=300)
    page.wait_for_function("[].some.call(document.querySelectorAll('.v2-chart'), e => e.dataset.chartRendered)", timeout=30000)
    assert page.errors == []


# ---- nothing leaks before the click ---------------------------------------------

@needs_build
def test_nothing_from_studio_or_models_loads_before_the_3d_click(open_report):
    gid = _pick('id="sec-3d"')
    if not gid:
        pytest.skip('no 3D block')
    for viewport, dark in ((DESKTOP, False), (PHONE, True)):
        page = open_report(gid, viewport=viewport, dark=dark)
        page.locator('.v3-secnav a', has_text='3D view').click()
        page.locator('#rx-clinvar summary').scroll_into_view_if_needed() if page.locator('#rx-clinvar').count() else None
        page.locator('#rx-residues summary').click() if page.locator('#rx-residues').count() else None
        page.wait_for_timeout(300)
        assert [u for u in page.requests if '/studio/' in u or '/models/' in u] == []
        assert _errors(page) == []
