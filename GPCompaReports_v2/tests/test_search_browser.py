"""Browser tests for search v2 (the /search/ page, the top-bar box, autocomplete, Browse hand-over).

Real queries from tests/search_v2/golden_queries.tsv are typed into the real page, served from a
real build, in headless Chromium. They assert what a reader sees: the "I read this as" line, the
receptor and residue on the first card, and the plain-language message.

Needs Playwright (project venv, not the system Python):

    bash scripts/run_browser_tests.sh --help      # the same venv
    SEARCH_BUILD_DIR=<build> .venv-test/bin/python -m pytest GPCompaReports_v2/tests/test_search_browser.py

The build must contain search/index.html and search2/ (a partial build is enough:
generate_site.py --only par2_human,adrb1_human,adrb2_human,lpar2_human, with the Studio packs
present so that search2/ is written). Chromium comes from CHROMIUM_PATH, else
~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome, else Playwright's own.

Third-party hosts are never contacted: GoatCounter is blocked and any other non-local request fails
the test.
"""
import functools
import http.server
import json
import os
import pathlib
import re
import socketserver
import threading
from urllib.parse import quote

import pytest

pytest.importorskip(
    'playwright.sync_api',
    reason='Playwright is not installed in this interpreter. Run from the project venv.')

from playwright.sync_api import expect, sync_playwright  # noqa: E402

BASE = pathlib.Path(__file__).resolve().parent.parent
GOLDEN = BASE / 'tests' / 'search_v2' / 'golden_queries.tsv'

_env = os.environ.get('SEARCH_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR')
BUILD_DIR = pathlib.Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR

pytestmark = pytest.mark.skipif(
    not ((BUILD_DIR / 'search' / 'index.html').is_file() and (BUILD_DIR / 'search2' / 'meta.json').is_file()),
    reason='no search page and search2/ index in %s' % BUILD_DIR)

DEFAULT_CHROMIUM = pathlib.Path.home() / '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
BLOCKED = ('**gc.zgo.at/**', '**cdn.plot.ly/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**')
DESKTOP = {'width': 1280, 'height': 900}
PHONE = {'width': 360, 'height': 780}

AA3 = {'A': 'Ala', 'R': 'Arg', 'N': 'Asn', 'D': 'Asp', 'C': 'Cys', 'Q': 'Gln', 'E': 'Glu', 'G': 'Gly',
       'H': 'His', 'I': 'Ile', 'L': 'Leu', 'K': 'Lys', 'M': 'Met', 'F': 'Phe', 'P': 'Pro', 'S': 'Ser',
       'T': 'Thr', 'W': 'Trp', 'Y': 'Tyr', 'V': 'Val'}


# ------------------------------------------------------------------------------------ data

def _golden():
    lines = GOLDEN.read_text(encoding='utf-8').replace('\r', '').split('\n')
    cols = lines[0].split('\t')
    rows = []
    for ln in lines[1:]:
        if not ln:
            continue
        vals = ln.split('\t')
        vals += [''] * (len(cols) - len(vals))
        row = dict(zip(cols, vals))
        row['query'] = row['query'].replace('\\t', '\t')
        rows.append(row)
    return rows


GOLDEN_ROWS = _golden()
BY_ID = {r['id']: r for r in GOLDEN_ROWS}


def _symbols():
    meta = json.loads((BUILD_DIR / 'search2' / 'meta.json').read_text(encoding='utf-8'))
    fields = meta['receptorFields']
    return {r[fields.index('gid')]: r[fields.index('symbol')] for r in meta['receptors']}


def _pick():
    """At least 30 golden rows covering every category: the first two of each plus named cases."""
    named = ['G001', 'G002']
    per = {}
    for r in GOLDEN_ROWS:
        per.setdefault(r['category'], []).append(r['id'])
    chosen = list(named)
    for cat, ids in per.items():
        for i in ids[:2]:
            if i not in chosen:
                chosen.append(i)
    return chosen


PICKED = _pick()


# --------------------------------------------------------------------------------- fixtures

@pytest.fixture(scope='session')
def server():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(BUILD_DIR)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d' % httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture(scope='session')
def browser(playwright_session):
    exe = os.environ.get('CHROMIUM_PATH') or (str(DEFAULT_CHROMIUM) if DEFAULT_CHROMIUM.exists() else None)
    p = playwright_session
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    yield b
    b.close()


@pytest.fixture(scope='session')
def symbols():
    return _symbols()


@pytest.fixture
def open_page(browser, server):
    """open(path, viewport=DESKTOP, scheme='light', js=True) -> page with error and request logs."""
    contexts = []

    def _open(path, viewport=DESKTOP, scheme='light', js=True, permissions=None):
        ctx = browser.new_context(viewport=viewport, color_scheme=scheme, java_script_enabled=js,
                                  permissions=permissions or [])
        contexts.append(ctx)
        page = ctx.new_page()
        page.errors, page.foreign = [], []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: page.errors.append(m.text)
                if m.type == 'error' and m.location.get('url', '').startswith(server) else None)
        page.on('request', lambda r: page.foreign.append(r.url)
                if not r.url.startswith((server, 'data:', 'blob:')) and 'gc.zgo.at' not in r.url else None)
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.goto(server + path, wait_until='load')
        return page

    yield _open
    for c in contexts:
        c.close()


def settle(page):
    """Wait until the results page has finished a query."""
    page.wait_for_function(
        "() => { const s = document.getElementById('search-status');"
        " const r = document.getElementById('search-results');"
        " return s && s.textContent.trim() !== '' && s.textContent.trim() !== 'Searching' && !r.hasAttribute('aria-busy'); }",
        timeout=20000)


def search_page(open_page, q, **kw):
    page = open_page('/search/?q=' + quote(q, safe=''), **kw)
    settle(page)
    return page


def read_line(page):
    return page.locator('.sr-read-line').inner_text() if page.locator('.sr-read-line').count() else ''


def results_text(page):
    return page.locator('#search-results').inner_text()


# -------------------------------------------------------------- golden queries on the page

@pytest.mark.parametrize('gid_', PICKED)
def test_golden_query_shows_the_expected_answer(open_page, symbols, gid_):
    row = BY_ID[gid_]
    if not row['query'].strip():
        # nothing typed: the page shows the "you can search like this" help, not an error
        page = open_page('/search/?q=' + quote(row['query'], safe=''))
        expect(page.locator('.sr-help')).to_be_visible()
        assert page.errors == []
        return
    page = search_page(open_page, row['query'])
    assert page.errors == [], page.errors
    assert page.foreign == [], 'third-party request: %s' % page.foreign
    exp = row['expect']
    gids = [g for g in row['gid'].split(';') if g]
    poss = [p for p in row['pos'].split(';') if p]
    text = results_text(page)

    if exp == 'unrecognised':
        expect(page.locator('.sr-message--stop')).to_be_visible()
        expect(page.locator('.sr-help')).to_be_visible()
        assert 'Could not read' in text
        return

    if exp in ('target', 'not_coding') or (exp == 'not_in_resource' and gids and poss):
        card = page.locator('.sr-card').first
        expect(card).to_be_visible()
        title = card.locator('.sr-card-title').inner_text()
        assert symbols[gids[0]] in title, (row['query'], title)
        assert poss[0] in title, (row['query'], title)
        assert read_line(page).strip(), 'no interpretation line for %r' % row['query']
        if exp == 'not_coding':
            assert 'Not a coding residue' in card.inner_text() or 'outside' in card.inner_text()
        if exp == 'not_in_resource':
            assert page.locator('.sr-note, .sr-message').count() >= 1
        return

    if exp == 'targets':
        n_rows = page.locator('.sr-table--multi tbody tr').count()
        n_cards = page.locator('.sr-card').count()
        assert n_rows >= 2 or n_cards >= 2 or (n_cards == 1 and len(gids) >= 1), row['query']
        if len(gids) <= 12:
            for g in gids:
                assert symbols[g] in text, (row['query'], symbols[g])
        assert read_line(page).strip()
        return

    if exp == 'receptor':
        assert symbols[gids[0]] in text, (row['query'], text[:200])
        return

    if exp == 'ambiguous':
        assert read_line(page).strip() or page.locator('.sr-message').count()
        if row['alternates']:
            expect(page.locator('.sr-did-you-mean')).to_be_visible()
        return

    if exp == 'not_in_resource':
        # understood but not held: a plain message, never an empty page
        assert page.locator('.sr-message, .sr-note').count() >= 1, (row['query'], text[:300])
        return

    raise AssertionError('unhandled expectation %s' % exp)


def test_the_selection_covers_every_category_and_at_least_thirty_queries():
    cats = {BY_ID[i]['category'] for i in PICKED}
    assert len(PICKED) >= 30
    assert cats == {r['category'] for r in GOLDEN_ROWS}


# ------------------------------------------------------------ specific, visible wording

def test_par2_in_a_dozen_notations_lands_on_met159(open_page):
    for q in ['F2RL1 p.Met159Ile', 'PAR2 M159I', 'NM_005242.6:c.477G>A', 'NM_005242.4:c.477G>A',
              'ENST00000296677.3:c.477G>A', '5-76833084-G-A', '5-76128909-G-A', 'chr5:76833084',
              'NC_000005.10:g.76833084G>A', 'rs115885685', 'F2RL1 c.477G>A', 'F2RL1 Met159']:
        page = search_page(open_page, q)
        title = page.locator('.sr-card').first.locator('.sr-card-title').inner_text()
        assert 'F2RL1' in title and 'Met159' in title and '3.36x36' in title and 'TM3' in title, (q, title)


def test_interpretation_line_in_plain_words(open_page):
    page = search_page(open_page, 'NM_005242.4:c.477G>A')
    line = read_line(page)
    assert 'PAR2 (F2RL1)' in line and 'protein change Met159Ile' in line and 'NM_005242.4:c.477G>A' in line
    assert 'not in our tables' in page.locator('.sr-note--warn').first.inner_text()


def test_grch37_input_is_read_as_grch37(open_page):
    page = search_page(open_page, '5-76128909-G-A')
    assert 'GRCh37' in read_line(page)
    text = results_text(page)
    assert '5-76833084-G-A' in text and '5-76128909-G-A' in text


def test_card_shows_transcripts_alleles_and_alphamissense(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    text = results_text(page)
    for needle in ('NM_005242.6', 'ENST00000296677.5', 'c.477G>A', 'rs115885685', 'gnomAD v4.1.2',
                   'AlphaMissense', 'GRCh38', 'GRCh37', 'CFR, rank 30'):
        assert needle in text, needle
    assert 'ClinVar 2026-10-11' in text


def test_model_conflict_card_says_the_model_differs(open_page):
    page = search_page(open_page, 'ADRB1 Arg389Gly')
    note = page.locator('.sr-note--warn').first.inner_text()
    assert 'model has Arg at 389' in note
    assert 'reference swap' not in results_text(page).lower()
    assert page.locator('.sr-card-title').first.inner_text().count('Arg389') == 1


def test_shifted_numbering_is_explained(open_page):
    page = search_page(open_page, 'LPAR2 p.Leu351Phe')
    title = page.locator('.sr-card-title').first.inner_text()
    assert 'Leu348' in title
    assert 'residue 348 in the model' in page.locator('.sr-note').first.inner_text()
    assert 'numbered differently' in results_text(page)


def test_bare_change_across_receptors_is_a_sortable_table(open_page):
    page = search_page(open_page, 'M159I')
    rows = page.locator('.sr-table--multi tbody tr')
    assert rows.count() >= 5
    first_before = rows.first.inner_text()
    btn = page.locator('.sr-table--multi th button', has_text='Receptor')
    btn.click()
    assert page.locator('.sr-table--multi th').first.get_attribute('aria-sort') == 'ascending'
    btn.click()
    assert page.locator('.sr-table--multi th').first.get_attribute('aria-sort') == 'descending'
    assert rows.first.inner_text() != first_before or rows.count() == 1


def test_generic_number_across_receptors(open_page):
    page = search_page(open_page, '3.50x50')
    assert page.locator('.sr-table--multi tbody tr').count() >= 100
    assert 'generic residue number 3.50x50' in read_line(page)


def test_rsid_with_two_alleles_lists_both(open_page):
    page = search_page(open_page, 'rs115885685')
    text = results_text(page)
    assert '5-76833084-G-A' in text and '5-76833084-G-T' in text


def test_stop_codon_resolves_to_the_residue_and_says_it_is_not_analysed(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ter')
    assert 'Nonsense' in results_text(page) and 'not analysed' in results_text(page)
    assert 'Met159' in page.locator('.sr-card-title').first.inner_text()


def test_intronic_input_gives_the_not_coding_answer(open_page):
    # c.82 is the last base of PAR2's first coding exon, so c.82+1 is intronic
    page = search_page(open_page, 'F2RL1 c.82+1G>A')
    assert 'intron' in results_text(page)
    assert 'Not a coding residue' in results_text(page)


def test_an_offset_away_from_an_exon_edge_is_refused(open_page):
    page = search_page(open_page, 'F2RL1 c.477+1G>A')
    assert 'not at an exon boundary' in results_text(page)


def test_unknown_gene_gets_a_plain_message(open_page):
    page = search_page(open_page, 'GLP1R')
    assert 'not one of the 283' in page.locator('.sr-message').inner_text()
    assert page.locator('.sr-card').count() == 0
    expect(page.locator('.sr-help')).to_be_visible()


def test_garbage_gets_a_plain_message_and_examples(open_page):
    page = search_page(open_page, 'asdfgh qwerty')
    assert 'Could not read' in page.locator('.sr-message').inner_text()
    for ex in ('NM_005242.6:c.477G>A', '5-76128909-G-A', 'rs115885685', '3.50x50'):
        assert ex in results_text(page)


def test_did_you_mean_links_run_the_other_reading(open_page):
    page = search_page(open_page, 'M1R')
    assert 'receptor' in read_line(page)
    link = page.locator('.sr-alt-list a').first
    expect(link).to_be_visible()
    link.click()
    settle(page)
    assert 'q=' in page.url and 'Met1Arg' in page.url.replace('%20', ' ') or 'p.Met1Arg' in page.url


def test_release_line_and_the_newer_data_note(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    rel = page.locator('#search-releases').inner_text()
    for needle in ('gnomAD v4.1.2', 'ClinVar 2026-10-11', 'Ensembl 116', 'GRCh37', 'GRCh38',
                   'newer variant data than the variant tables on the report pages'):
        assert needle in rel, needle
    assert '—' not in rel and '–' not in rel


def test_action_links_point_at_the_report_and_studio(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    report = page.get_by_role('link', name='Open report at this residue')
    assert report.get_attribute('href') == '../reports/par2_human.html#sec=sec-snake&res=159'
    assert page.get_by_role('link', name='Open in Studio').get_attribute('href') == '../studio/?db=par2_human'
    vt = page.get_by_role('link', name="Find in the report's variant table").get_attribute('href')
    assert vt.endswith('#sec=sec-variants&vq=p.Met159Ile')


def test_copy_all_notations(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile', permissions=['clipboard-read', 'clipboard-write'])
    page.get_by_role('button', name='Copy all notations').click()
    page.wait_for_function("() => document.querySelector('[data-copy-notations]').textContent === 'Copied'")
    clip = page.evaluate('navigator.clipboard.readText()')
    for needle in ('p.Met159Ile', 'NM_005242.6:c.477G>A', 'GRCh38: 5-76833084-G-A', 'GRCh37: 5-76128909-G-A', 'rs115885685'):
        assert needle in clip, needle


# ------------------------------------------------------------------- top bar and autocomplete

def test_topbar_search_goes_to_the_results_page(open_page):
    page = open_page('/index.html')
    box = page.locator('.topbar-search-input')
    box.fill('F2RL1 M159I')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q=F2RL1\+M159I'))
    settle(page)
    assert 'Met159' in page.locator('.sr-card-title').first.inner_text()
    assert page.errors == []


def test_topbar_search_works_from_a_report_page(open_page):
    page = open_page('/reports/par2_human.html')
    box = page.locator('.topbar-search-input')
    box.fill('rs115885685')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q=rs115885685'))
    settle(page)
    assert page.locator('.sr-card').count() == 1


def test_autocomplete_receptor_names_with_the_keyboard(open_page):
    page = open_page('/index.html')
    box = page.locator('.topbar-search-input')
    box.click()
    box.type('beta2')
    listbox = page.locator('.topbar-search .sg-list')
    expect(listbox).to_be_visible()
    assert box.get_attribute('role') == 'combobox'
    assert box.get_attribute('aria-expanded') == 'true'
    opts = listbox.locator('[role="option"]')
    assert opts.count() >= 1
    assert 'ADRB2' in opts.first.inner_text()
    box.press('ArrowDown')
    assert opts.first.get_attribute('aria-selected') == 'true'
    assert box.get_attribute('aria-activedescendant') == opts.first.get_attribute('id')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q=ADRB2'))
    settle(page)
    assert 'ADRB2' in page.locator('.sr-card-title').first.inner_text()


def test_autocomplete_escape_closes_and_generic_numbers_are_offered(open_page):
    page = open_page('/index.html')
    box = page.locator('.topbar-search-input')
    box.click()
    box.type('3.5')
    listbox = page.locator('.topbar-search .sg-list')
    expect(listbox).to_be_visible()
    assert '3.50x50' in listbox.inner_text()
    box.press('Escape')
    expect(listbox).to_be_hidden()
    assert box.get_attribute('aria-expanded') == 'false'


def test_autocomplete_on_the_search_page_and_recent_queries(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    expect(page.locator('#search-recent')).to_be_visible()
    box = page.locator('#search-input')
    box.fill('')
    box.click()
    expect(page.locator('#search-form .sg-list')).to_be_visible()
    assert 'F2RL1 p.Met159Ile' in page.locator('#search-form .sg-list').inner_text()
    box.fill('PAR')
    opts = page.locator('#search-form .sg-list [role="option"]')
    expect(opts.first).to_be_visible()
    assert any('PAR2' in o for o in opts.all_inner_texts())


def test_blocked_storage_does_not_break_search(browser, server):
    ctx = browser.new_context(viewport=DESKTOP)
    ctx.add_init_script("Object.defineProperty(window, 'localStorage', {get() { throw new Error('blocked'); }});")
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.route('**gc.zgo.at/**', lambda r: r.abort())
    page.goto(server + '/search/?q=' + quote('F2RL1 p.Met159Ile', safe=''))
    settle(page)
    assert page.locator('.sr-card').count() == 1
    assert errs == []
    ctx.close()


def test_submitting_the_search_page_form_updates_the_address(open_page):
    page = open_page('/search/')
    expect(page.locator('.sr-help')).to_be_visible()
    page.locator('#search-input').fill('PAR2 6.48')
    page.locator('#search-input').press('Enter')
    settle(page)
    assert page.url.endswith('/search/?q=PAR2+6.48') or page.url.endswith('/search/?q=PAR2%206.48')
    assert '6.48x48' in page.locator('.sr-card-title').first.inner_text()
    page.go_back()
    expect(page.locator('.sr-help')).to_be_visible()


# --------------------------------------------------------------------------- Browse hand-over

def test_old_browse_variant_link_goes_to_search(open_page):
    page = open_page('/browse/index.html?mode=variants&q=' + quote('F2RL1 M159I', safe=''))
    page.wait_for_url(re.compile(r'/search/\?q=F2RL1'))
    settle(page)
    assert 'Met159' in page.locator('.sr-card-title').first.inner_text()


def test_old_browse_link_with_a_variant_query_goes_to_search(open_page):
    page = open_page('/browse/index.html?q=rs115885685')
    page.wait_for_url(re.compile(r'/search/\?q=rs115885685'))
    settle(page)
    assert page.locator('.sr-card').count() == 1


def test_browse_receptor_filter_still_works(open_page):
    page = open_page('/browse/index.html?q=PAR2')
    page.wait_for_timeout(500)
    assert '/browse/' in page.url
    assert page.locator('#gpcr-table tbody tr').count() >= 1
    assert page.locator('#search-input').input_value() == 'PAR2'
    assert page.errors == []
    expect(page.locator('.browse-search-link')).to_be_visible()


# --------------------------------------------------------- phone, dark mode, no JavaScript

@pytest.mark.parametrize('q', ['F2RL1 p.Met159Ile', 'M159I', 'LPAR2 p.Leu351Phe', 'GLP1R', ''])
def test_phone_width_has_no_horizontal_scroll(open_page, q):
    page = open_page('/search/?q=' + quote(q, safe=''), viewport=PHONE)
    if q:
        settle(page)
    else:
        page.wait_for_selector('.sr-help')
    over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert over <= 1, 'page scrolls sideways by %dpx for %r' % (over, q)
    assert page.errors == []


def test_phone_menu_search_goes_to_results(open_page):
    page = open_page('/index.html', viewport=PHONE)
    page.locator('#mobile-nav-toggle').click()
    box = page.locator('.drawer-search input')
    box.fill('NM_005242.6:c.477G>A')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q='))
    settle(page)
    assert 'Met159' in page.locator('.sr-card-title').first.inner_text()


def test_dark_mode_results_are_dark_and_readable(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile', scheme='dark')
    assert page.evaluate("document.documentElement.getAttribute('data-color-mode')") == 'dark'

    def lum(css):
        r, g, b = [int(x) for x in re.findall(r'\d+', css)[:3]]
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

    card_bg = page.evaluate("getComputedStyle(document.querySelector('.sr-card')).backgroundColor")
    card_fg = page.evaluate("getComputedStyle(document.querySelector('.sr-card')).color")
    assert lum(card_bg) < 0.25 and lum(card_fg) > 0.6
    assert page.errors == []


def test_without_javascript_the_receptor_list_is_the_fallback(open_page):
    page = open_page('/search/?q=F2RL1', js=False)
    links = page.locator('#search-results .sr-plain-list a')
    assert links.count() >= 4
    assert page.locator('form[role="search"]').count() >= 2  # top bar and the page form still submit


def test_search_page_is_keyboard_operable(open_page):
    page = open_page('/search/')
    page.wait_for_selector('.sr-help')
    assert page.evaluate("document.activeElement.id") == 'search-input'
    page.keyboard.type('adrb1 389')
    page.keyboard.press('Enter')
    settle(page)
    assert 'ADRB1' in page.locator('.sr-card-title').first.inner_text()
    # every example chip and action is a link or button reachable by Tab
    page.keyboard.press('Tab')
    assert page.evaluate("document.activeElement.tagName") in ('BUTTON', 'A', 'INPUT')


def test_search_text_does_not_reach_the_next_page_as_its_referrer(open_page, server):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    assert 'q=' in page.url
    link = page.locator('.sr-card a[href*="reports/"]').first
    expect(link).to_be_visible()
    link.click()
    page.wait_for_load_state('load')
    assert '/reports/' in page.url
    assert page.evaluate('document.referrer') == server + '/'
    assert 'Met159' not in page.evaluate('document.referrer')


def test_every_search_box_has_a_length_cap(open_page):
    page = open_page('/search/')
    caps = page.eval_on_selector_all('input[type=search]', 'els => els.map(e => e.maxLength)')
    assert caps and all(c == 300 for c in caps), caps
    browse = open_page('/browse/')
    caps = browse.eval_on_selector_all('input[type=search]', 'els => els.map(e => e.maxLength)')
    assert caps and all(c == 300 for c in caps), caps


def test_a_very_long_query_is_cut_and_says_so(open_page):
    import time
    t0 = time.time()
    page = search_page(open_page, 'PAR2 M159I ' + 'x' * 20000)
    assert time.time() - t0 < 10
    assert 'Only the first 300 characters were read' in results_text(page)
    assert page.errors == []
