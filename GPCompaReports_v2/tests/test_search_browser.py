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
PHONE_390 = {'width': 390, 'height': 844}

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

    def _open(path, viewport=DESKTOP, scheme='light', js=True, permissions=None, mobile=False):
        ctx = browser.new_context(viewport=viewport, color_scheme=scheme, java_script_enabled=js,
                                  permissions=permissions or [], is_mobile=mobile, has_touch=mobile,
                                  accept_downloads=True)
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
    assert 'not in our version tables' in page.locator('.sr-note--warn').first.inner_text()


def test_grch37_input_is_read_as_grch37(open_page):
    page = search_page(open_page, '5-76128909-G-A')
    assert 'GRCh37' in read_line(page)
    text = results_text(page)
    assert '5-76833084-G-A' in text and '5-76128909-G-A' in text


def test_card_shows_transcripts_alleles_and_alphamissense(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    page.locator('.sr-notations summary').click()  # the transcript table is folded away when nothing is mismatched
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


def test_a_clinvar_record_that_is_not_pathogenic_shows_its_gnomad_allele(open_page):
    # VCV000014312 (Conflicting) is rs1805007 = MC1R Arg151Cys: the same AF, allele count and AlphaMissense
    texts = {}
    for q in ('VCV000014312', 'rs1805007', 'MC1R Arg151Cys'):
        texts[q] = results_text(search_page(open_page, q))
    v = texts['VCV000014312']
    for needle in ('16-89919709-C-T', '0.192', 'VCV000014312'):
        assert needle in v, needle
        assert needle in texts['rs1805007'] and needle in texts['MC1R Arg151Cys'], needle
    for absent in ('not analysed here', 'This exact change is not listed', 'not available in this index'):
        assert absent not in v, absent


def test_a_two_base_change_says_why_gnomad_has_no_allele_and_gives_its_alphamissense_score(open_page):
    page = search_page(open_page, 'ADRB2 R131Q')
    text = results_text(page)
    assert 'needs two nucleotide substitutions in its codon (CGC)' in text
    assert 'AlphaMissense predicts likely pathogenic (score 0.972)' in text
    assert 'not available in this index' not in text
    # the per-substitution strip: 19 cells, Gln marked as this change, the reference residue absent
    cells = page.locator('.sr-am-strip .sr-am-cell')
    assert cells.count() == 19
    this = page.locator('.sr-am-strip .sr-am-cell.is-this')
    assert this.count() == 1 and this.get_attribute('aria-current') == 'true'
    assert this.locator('.sr-am-aa').inner_text() == 'Gln' and this.locator('.sr-am-score').inner_text() == '0.972'
    assert 'Arg' not in page.locator('.sr-am-strip').inner_text().split()
    assert '\u2014' not in text


def test_shifted_numbering_is_explained(open_page):
    page = search_page(open_page, 'LPAR2 p.Leu351Phe')
    title = page.locator('.sr-card-title').first.inner_text()
    assert 'Leu348' in title
    assert 'residue 348 in the model' in page.locator('.sr-note').first.inner_text()
    assert 'numbering differs' in results_text(page)            # the badge on the folded notations
    page.locator('.sr-notations summary').click()
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
    assert page.locator('.sr-table--multi tbody tr').count() == 25  # one page, not 283 rows
    assert 'Show all 283' in results_text(page)
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
    for ex in ('NM_000795.4:c.932C>G', '11-113283484-G-C', 'rs1801028', '6.48x48'):
        assert ex in results_text(page)


def test_did_you_mean_links_run_the_other_reading(open_page):
    page = search_page(open_page, 'M1R')
    assert 'receptor' in read_line(page)
    link = page.locator('.sr-alt-list a').first
    expect(link).to_be_visible()
    link.click()
    settle(page)
    assert 'q=' in page.url and 'Met1Arg' in page.url.replace('%20', ' ') or 'p.Met1Arg' in page.url


def _registry():
    return json.loads((BASE / 'data_versions.json').read_text(encoding='utf-8'))


def test_release_line_reads_the_registry_and_says_reports_use_the_same_release(open_page):
    page = search_page(open_page, 'F2RL1 p.Met159Ile')
    rel = page.locator('#search-releases').inner_text()
    src = _registry()['sources']
    for needle in (src['gnomad']['label'], src['clinvar']['label'], src['ensembl']['label'],
                   src['alphamissense']['label'], src['hgnc']['label'], src['uniprot']['label'], 'GRCh37', 'GRCh38'):
        assert needle in rel, needle
    # the report tables are built from the same release: no "newer data" caveat, one fine-print line instead
    assert 'newer variant data' not in rel and 'How this differs' not in rel
    note = page.locator('#search-releases .sr-releases-note')
    expect(note).to_have_count(1)
    assert 'same release as this search' in note.inner_text()
    assert src['gnomad_batch']['label'] not in rel               # the February batch release is not the search or report release
    assert '—' not in rel and '–' not in rel


def test_search_meta_releases_equal_the_registry():
    meta = json.loads((BUILD_DIR / 'search2' / 'meta.json').read_text(encoding='utf-8'))['releases']
    src = _registry()['sources']
    for key in ('gnomad', 'clinvar', 'ensembl', 'hgnc', 'uniprot', 'alphamissense'):
        assert meta[key]['label'] == src[key]['label'], key
    assert meta['reportTable']['label'] == src['gnomad']['label'] and meta['reportTable']['sameAsSearch'] is True


def _allele_with_third_decimal(gid):
    """(rsid, '0.xxx') for an allele of `gid` whose AlphaMissense score has a non-zero third decimal."""
    d = json.loads((BUILD_DIR / 'search2' / 'variants' / (gid + '.json')).read_text(encoding='utf-8'))
    for in_table in ('1', '0'):                   # an allele the report table lists first, so the two can be compared
        for am, rs, rt in zip(d['am'], d['rs'], d['rt']):
            if rt == in_table and am is not None and am % 10 and rs and len(rs) == 1 and rs[0]:
                return rs[0], '%.3f' % (am / 1000), in_table == '1'
    return None


def test_allele_alphamissense_reads_with_three_decimals_like_the_report(open_page):
    found = _allele_with_third_decimal('adrb2_human')
    if not found:
        pytest.skip('no ADRB2 allele with a rsID and a 3-decimal AlphaMissense score in this build')
    rsid, three, in_report = found
    page = search_page(open_page, 'rs%d' % rsid)
    text = results_text(page)
    assert three in text, (three, text[:400])
    # the same rule the report table uses (analysis/variant_correlation.py: fmt_decimal(digits=3))
    rep = BUILD_DIR / 'reports' / 'adrb2_human.html'
    if in_report and rep.is_file():
        rows = [r for r in re.findall(r'<tr\b.*?</tr>', rep.read_text(encoding='utf-8'), re.S) if 'rs%d<' % rsid in r]
        assert rows, 'rs%d is in the report table by the index flag but not in the report' % rsid
        assert any('<td class="num">%s</td>' % three in r for r in rows), (three, rows[0][:600])


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

@pytest.mark.parametrize('q', ['F2RL1 p.Met159Ile', 'M159I', 'LPAR2 p.Leu351Phe', 'GLP1R', '', 'MC1R ClinVar', 'W3.50', 'PAR2 p.Ala159Ile',
                               'MC4R V103I', 'ADRB2 R131Q', 'MC1R R151C', 'DRY in ADRB2'])
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


# =====================================================================================
# Round 2 of the search interface: hero search, Browse filter, comparison table, cards
# =====================================================================================

def _clipboard(page):
    return page.evaluate('navigator.clipboard.readText()')


def _luminance(css):
    r, g, b = [int(x) for x in re.findall(r'\d+', css)[:3]]
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255


# ----------------------------------------------------------------- A1: the landing hero search

def test_landing_search_placeholder_mentions_variants(open_page):
    page = open_page('/index.html')
    ph = page.locator('#search-input').get_attribute('placeholder')
    assert 'variant' in ph and 'MC1R R151C' in ph
    assert '—' not in ph


@pytest.mark.parametrize('q', ['PAR2 M159I', 'rs115885685', '3.50x50', 'NM_005242.6:c.477G>A'])
def test_landing_enter_on_a_variant_goes_to_the_search_page(open_page, q):
    page = open_page('/index.html')
    box = page.locator('#search-input')
    box.fill(q)
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q='))
    settle(page)
    assert page.locator('.sr-card, .sr-table--multi').count() >= 1
    assert page.errors == []


def test_landing_enter_on_an_exact_receptor_opens_its_report(open_page):
    page = open_page('/index.html')
    box = page.locator('#search-input')
    box.fill('PAR2')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/reports/par2_human\.html'))


def test_landing_unmatched_text_is_not_a_dead_end(open_page):
    page = open_page('/index.html')
    box = page.locator('#search-input')
    box.fill('asdfgh')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q=asdfgh'))
    settle(page)
    assert 'Could not read' in page.locator('.sr-message').inner_text()


def test_landing_uses_the_shared_autocomplete(open_page):
    page = open_page('/index.html')
    box = page.locator('#search-input')
    box.click()
    box.type('beta2')
    listbox = page.locator('.search-box .sg-list')
    expect(listbox).to_be_visible()
    assert box.get_attribute('role') == 'combobox'
    assert 'ADRB2' in listbox.locator('[role="option"]').first.inner_text()
    box.press('ArrowDown')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/reports/adrb2_human\.html'))
    assert page.errors == []


def test_landing_search_on_a_phone_in_dark_mode(open_page):
    page = open_page('/index.html', viewport=PHONE_390, scheme='dark', mobile=True)
    box = page.locator('#search-input')
    expect(box).to_be_visible()
    box.fill('PAR2 M159I')
    box.press('Enter')
    page.wait_for_url(re.compile(r'/search/\?q='))
    settle(page)
    over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert over <= 1
    assert page.errors == []


# ------------------------------------------------------------------- C7: the Browse text filter

def test_browse_filter_is_labelled_and_matches_protein_names(open_page):
    page = open_page('/browse/index.html')
    box = page.locator('#search-input')
    assert 'Filter this receptor table' in page.locator('label[for="search-input"]').inner_text()
    box.fill('beta-2 adrenergic')
    page.wait_for_function("() => document.getElementById('result-count').textContent.startsWith('1 of')", timeout=8000)
    assert 'ADRB2' in page.locator('#gpcr-table tbody').inner_text()
    box.fill('beta 2')   # punctuation-free text still finds "Beta-2"
    page.wait_for_function("() => /^[1-9]/.test(document.getElementById('result-count').textContent)")
    assert page.errors == []


def test_browse_filter_offers_the_variant_search_when_text_looks_like_a_variant(open_page):
    page = open_page('/browse/index.html')
    hint = page.locator('#receptor-search-hint')
    expect(hint).to_be_hidden()
    page.locator('#search-input').fill('M159I')
    expect(hint).to_be_visible()
    link = hint.locator('a')
    assert link.inner_text() == 'Search variants and positions for “M159I”'
    assert link.get_attribute('href').endswith('/search/?q=M159I')
    page.locator('#search-input').fill('adrenergic')
    expect(hint).to_be_hidden()
    page.locator('#search-input').fill('PAR2 M159I')
    expect(hint).to_be_visible()
    link.click()
    page.wait_for_url(re.compile(r'/search/\?q=PAR2'))
    settle(page)
    assert 'Met159' in page.locator('.sr-card-title').first.inner_text()


# ------------------------------------------------ A6 / C1: the cross-receptor comparison table

def _header_labels(page):
    return [h.strip() for h in page.locator('.sr-table--cmp thead th').all_inner_texts()]


def test_m159i_table_shows_the_data_columns(open_page):
    page = search_page(open_page, 'M159I')
    assert page.errors == []
    labels = _header_labels(page)
    for want in ('Receptor', 'Family', 'Residue', 'Generic number', 'Net ΔRRCS', 'Largest |ΔRRCS|',
                 'Contacts above threshold', 'CFR rank', 'Conservation (0 to 1)', 'gnomAD alleles', 'ClinVar records'):
        assert any(want in l for l in labels), (want, labels)
    par2 = page.locator('.sr-table--cmp tbody tr', has_text='F2RL1').first
    text = par2.inner_text()
    assert 'Met159' in text and '3.36x36' in text and 'Phe300' in text
    # the row links go to the precise query and to the report at the residue
    link = par2.locator('a[data-q]').first
    assert link.get_attribute('data-q') == 'F2RL1 p.Met159Ile'
    assert par2.locator('a.sr-reportlink').get_attribute('href') == '../reports/par2_human.html#sec=sec-snake&res=159'


def test_net_delta_uses_sign_colour_and_never_colour_alone(open_page):
    page = search_page(open_page, 'M159I')
    neg = page.locator('.sr-table--cmp .sr-c-net .sr-net--inactive').first
    pos = page.locator('.sr-table--cmp .sr-c-net .sr-net--active').first
    assert neg.inner_text().startswith('-') and pos.inner_text().startswith('+')
    # red = active-favouring, blue = inactive-favouring
    cn = [int(x) for x in re.findall(r'\d+', neg.evaluate('e => getComputedStyle(e).color'))[:3]]
    cp = [int(x) for x in re.findall(r'\d+', pos.evaluate('e => getComputedStyle(e).color'))[:3]]
    assert cn[2] > cn[0] and cp[0] > cp[2], (cn, cp)
    assert 'red' in page.locator('.sr-legend').inner_text() and 'blue' in page.locator('.sr-legend').inner_text()


def test_net_delta_colours_hold_in_dark_mode(open_page):
    page = search_page(open_page, 'M159I', scheme='dark')
    neg = page.locator('.sr-table--cmp .sr-net--inactive').first
    pos = page.locator('.sr-table--cmp .sr-net--active').first
    cn = [int(x) for x in re.findall(r'\d+', neg.evaluate('e => getComputedStyle(e).color'))[:3]]
    cp = [int(x) for x in re.findall(r'\d+', pos.evaluate('e => getComputedStyle(e).color'))[:3]]
    assert cn[2] > cn[0] and cp[0] > cp[2], (cn, cp)
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    assert _luminance(bg) < 0.25
    assert page.errors == []


def test_columns_sort_numerically_and_missing_values_go_last(open_page):
    page = search_page(open_page, 'M159I')
    nets = lambda: [float(c) for c in page.locator('.sr-table--cmp .sr-c-net').all_inner_texts() if re.match(r'^[+-]?\d', c)]
    page.locator('.sr-table--cmp th button', has_text='Net ΔRRCS').click()
    first = nets()
    assert first == sorted(first, reverse=True), first          # numbers start high to low
    assert page.locator('.sr-table--cmp thead th[aria-sort="descending"]').count() == 1
    page.locator('.sr-table--cmp th button', has_text='Net ΔRRCS').click()
    asc = nets()
    assert asc == sorted(asc), asc
    # a receptor with no contact data (none) is never first, in either direction
    assert 'none' not in page.locator('.sr-table--cmp tbody tr').first.locator('.sr-c-net').inner_text()


def test_family_filter_and_row_count(open_page):
    page = search_page(open_page, '3.50x50')
    sel = page.locator('[data-cmp-family]')
    options = sel.locator('option').all_inner_texts()
    assert options[0].startswith('All families (283)') and len(options) > 5
    sel.select_option(label=[o for o in options if o.startswith('Chemokine receptors')][0])
    n = int(re.search(r'\((\d+)\)', [o for o in options if o.startswith('Chemokine receptors')][0]).group(1))
    assert page.locator('.sr-table--cmp tbody tr').count() == min(25, n)
    assert all('Chemokine' in f for f in page.locator('.sr-table--cmp .sr-c-fam').all_inner_texts())


def test_pagination_25_per_page_and_show_all(open_page):
    page = search_page(open_page, '3.50x50')
    rows = page.locator('.sr-table--cmp tbody tr')
    assert rows.count() == 25
    assert 'Rows 1 to 25 of 283' in page.locator('.sr-pager-info').first.inner_text()
    first = rows.first.inner_text()
    page.get_by_role('button', name='Next').click()
    assert 'Rows 26 to 50 of 283' in page.locator('.sr-pager-info').first.inner_text()
    assert rows.first.inner_text() != first
    page.get_by_role('button', name='Show all 283').click()
    assert rows.count() == 283
    page.get_by_role('button', name='Show 25 per page').click()
    assert rows.count() == 25


def test_csv_download_is_the_filtered_sorted_table(open_page, tmp_path):
    page = search_page(open_page, 'M159I')
    page.locator('.sr-table--cmp th button', has_text='Net ΔRRCS').click()
    with page.expect_download() as dl:
        page.get_by_role('button', name='Download CSV').click()
    download = dl.value
    assert download.suggested_filename.endswith('.csv') and 'm159i' in download.suggested_filename
    path = tmp_path / 'm159i.csv'
    download.save_as(str(path))
    import csv as _csv
    rows = list(_csv.DictReader(path.read_text(encoding='utf-8').splitlines()))
    assert len(rows) == page.locator('.sr-table--cmp tbody tr').count() == 9
    head = rows[0].keys()
    for col in ('receptor', 'gene_symbol', 'family', 'residue', 'generic_number', 'net_delta_rrcs', 'net_direction',
                'largest_abs_delta_rrcs', 'largest_partner', 'receptor_threshold', 'contacts_above_threshold',
                'cfr_rank', 'conservation_0_to_1', 'gnomad_alleles', 'clinvar_records'):
        assert col in head, (col, list(head))
    par2 = [r for r in rows if r['gene_symbol'] == 'F2RL1'][0]
    assert par2['residue'] == 'Met159' and par2['generic_number'] == '3.36x36' and par2['largest_partner'] == 'Phe300'
    assert par2['net_direction'] == 'stronger in inactive' and float(par2['net_delta_rrcs']) < 0
    nets = [float(r['net_delta_rrcs']) for r in rows if r['net_delta_rrcs']]
    assert nets == sorted(nets, reverse=True)       # the CSV follows the sort on screen
    assert '—' not in path.read_text(encoding='utf-8')


def test_csv_of_a_filtered_table_has_only_the_filtered_rows(open_page, tmp_path):
    page = search_page(open_page, '3.50x50')
    sel = page.locator('[data-cmp-family]')
    label = [o for o in sel.locator('option').all_inner_texts() if o.startswith('Chemokine receptors')][0]
    sel.select_option(label=label)
    with page.expect_download() as dl:
        page.get_by_role('button', name='Download CSV').click()
    path = tmp_path / 'f.csv'
    dl.value.save_as(str(path))
    lines = path.read_text(encoding='utf-8').strip().splitlines()
    assert len(lines) - 1 == int(re.search(r'\((\d+)\)', label).group(1))   # all of them, not just the 25 shown
    assert all('Chemokine' in l for l in lines[1:])


def test_r350_shows_its_residue_filter_and_groups(open_page):
    page = search_page(open_page, 'R3.50')
    assert 'residue Arg at generic number 3.50x50' in read_line(page) or 'Arg' in read_line(page)
    note = page.locator('.sr-filter-note').inner_text()
    assert '269 of 283' in note and 'listed separately' in note
    groups = page.locator('.sr-seg')
    texts = groups.all_inner_texts()
    assert any('Arg at 3.50x50' in g and '269' in g for g in texts), texts
    assert any('Another residue' in g and '14' in g for g in texts), texts
    page.locator('.sr-seg', has_text='Another residue').click()
    assert page.locator('.sr-seg[aria-pressed="true"]').inner_text().startswith('Another residue')
    assert page.locator('.sr-table--cmp tbody tr').count() == 14
    # no row of the other group is an Arg
    assert 'Arg' not in ' '.join(page.locator('.sr-table--cmp .sr-c-res').all_inner_texts())


def test_motif_word_gives_a_position_table(open_page):
    page = search_page(open_page, 'DRY')
    assert page.errors == []
    assert page.locator('.sr-motif').count() == 1
    assert page.locator('.sr-table--cmp tbody tr').count() >= 10
    assert page.locator('.sr-seg').count() >= 3        # one group per motif position


def test_table_without_summary_fields_still_renders(open_page):
    # an index that predates `summary`: the page must not break (columns without values are left out)
    page = open_page('/search/?q=M159I')
    settle(page)
    n = page.evaluate("""async () => {
        const m = await import('../static/js/search-ui/render.js');
        const ans = { expect: 'targets', interpretation: { kind: 'protein', change: { ref: 'M', pos: 159, alt: 'I', kind: 'missense' } },
          results: [1, 2, 3, 4].map((i) => ({ type: 'target', light: true, gid: 'g' + i, pos: 159, ref: 'M', alt: 'I', kind: 'missense',
            receptor: { gid: 'g' + i, symbol: 'G' + i, name: 'x' }, alleles: [], clinvar: [], notes: [] })) };
        const r = m.renderAnswer(ans, 'M159I', { reports: '../reports/', studio: '../studio/' });
        return [r.html.includes('sr-table--cmp'), /undefined|NaN|\\[object/.test(r.html.replace(/data-[a-z-]+="[^"]*"/g, ''))];
    }""")
    assert n == [True, False]


# ------------------------------------------------------------------------- A9: phones

def test_phone_shows_a_sort_control_and_card_rows(open_page):
    page = search_page(open_page, '3.50x50', viewport=PHONE_390, mobile=True)
    assert page.errors == []
    sort = page.locator('[data-cmp-sortsel]')
    expect(sort).to_be_visible()
    expect(page.locator('[data-cmp-dir]')).to_be_visible()
    before = page.locator('.sr-table--cmp tbody tr').first.inner_text()
    sort.select_option('net')
    after = page.locator('.sr-table--cmp tbody tr').first.inner_text()
    assert before != after
    assert page.locator('.sr-table--cmp thead').evaluate('e => getComputedStyle(e).display') == 'none'
    # a compact card per row, not 27,000 px of page
    height = page.evaluate('document.documentElement.scrollHeight')
    assert height < 9000, height
    assert page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1
    assert page.locator('.sr-table--cmp tbody tr').count() == 25
    page.get_by_role('button', name='Next').click()
    assert page.locator('.sr-table--cmp tbody tr').count() == 25


def test_the_sort_control_is_hidden_on_desktop(open_page):
    page = search_page(open_page, '3.50x50')
    expect(page.locator('[data-cmp-sortsel]')).to_be_hidden()
    expect(page.locator('.sr-table--cmp thead')).to_be_visible()


def test_phone_never_breaks_a_notation_in_the_middle(open_page):
    page = search_page(open_page, 'LPAR2 L351F', viewport=PHONE_390, mobile=True)
    for sel in ('.sr-change-main', '.sr-lead .mono', '.sr-card .mono'):
        for ws in page.locator(sel).evaluate_all('els => els.map(e => getComputedStyle(e).whiteSpace)'):
            assert ws == 'nowrap', (sel, ws)
    heights = page.locator('.sr-change-main').evaluate_all('els => els.map(e => e.getBoundingClientRect().height)')
    assert all(h < 40 for h in heights), heights          # one line each
    assert page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1


def test_no_arrow_key_text_on_a_touch_device(open_page):
    touch = open_page('/search/', viewport=PHONE_390, mobile=True)
    touch.wait_for_selector('.sr-help')
    touch.locator('#search-howto summary').click()           # the key hints are fine print, folded by default
    assert 'arrow keys' not in touch.locator('#search-hint').inner_text()
    assert 'Tap' in touch.locator('#search-hint').inner_text()
    desktop = open_page('/search/')
    desktop.wait_for_selector('.sr-help')
    assert 'arrow keys' not in desktop.locator('.sr-help, .sr-form, .search-section > div > div > header').first.inner_text()  # not in the main flow
    desktop.locator('#search-howto summary').click()
    assert 'arrow keys' in desktop.locator('#search-hint').inner_text()


@pytest.mark.parametrize('q', ['M159I', '3.50x50', 'R3.50', 'LPAR2 L351F', 'PAR2 p.Ala159Ile', 'PAR2 M159I'])
@pytest.mark.parametrize('scheme', ['light', 'dark'])
def test_phone_360_no_sideways_scroll_light_and_dark(open_page, q, scheme):
    page = search_page(open_page, q, viewport=PHONE, scheme=scheme, mobile=True)
    assert page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1, q
    assert page.errors == []


# ------------------------------------------------------------------- B2, C5: the card

def test_card_gives_the_numbers_their_context(open_page):
    page = search_page(open_page, 'PAR2 M159I')
    facts = '\n'.join(page.locator('.sr-facts').all_inner_texts())   # the predictions and the database facts
    assert re.search(r'\|ΔRRCS\| 4\.99, with Phe300', facts), facts
    assert 'receptor threshold' not in facts                    # the threshold is fine print, below
    assert 'stronger in inactive' in facts                      # net delta, with a direction word
    assert '0.96' in facts and '0 to 1 scale' not in facts
    assert '0 variable' not in facts and '1 conserved' not in facts
    assert 'AlphaMissense, residue mean' in facts
    assert 'class-wide rank 30' in facts
    about = page.locator('.sr-about')
    about.locator('summary').click()
    assert re.search(r"this receptor's threshold is \d\.\d\d", about.inner_text())
    assert '0 to 1 scale' in about.inner_text()
    assert 'Contacts above this receptor' in facts               # kept distinct from the CFR rank
    assert 'AlphaMissense prediction' in page.locator('details[data-sec="population"] thead').first.inner_text()   # the alleles table
    net = page.locator('.sr-facts .sr-net').first
    cn = [int(x) for x in re.findall(r'\d+', net.evaluate('e => getComputedStyle(e).color'))[:3]]
    assert cn[2] > cn[0]                                          # blue: stronger in inactive


def test_card_does_not_show_a_threshold_it_does_not_have(open_page):
    page = search_page(open_page, 'PAR2 M159I')
    # strip the threshold from the result and render again: the sentence just ends after the value
    txt = page.evaluate("""async () => {
        const m = await import('../static/js/search-ui/render.js');
        const r = { type: 'target', gid: 'x', receptor: { symbol: 'X', gid: 'x', entry: 'X_HUMAN' }, pos: 5, ref: 'M', alt: null, kind: 'residue',
          residue: { pos: 5, aa: 'M', segment: 'TM1', generic: '1.20x20', dmax: 2.5, nsig: 1, cfr: false, cfrRank: 90, conservation: 0.5, amMean: 0.3 },
          alleles: [], residueAlleles: [], clinvar: [], transcriptViews: [], notes: [], genomic: {} };
        return m.renderAnswer({ expect: 'target', results: [r], interpretation: { kind: 'residue', change: { ref: 'M', pos: 5, kind: 'residue' } } }, 'X M5', { reports: '', studio: '' }).html;
    }""")
    assert 'receptor threshold' not in txt and '|ΔRRCS| 2.50' in txt


def test_lpar2_card_leads_with_what_you_typed_and_opens_the_notations(open_page):
    page = search_page(open_page, 'LPAR2 L351F')
    lead = page.locator('.sr-lead').inner_text()
    assert 'LPAR2 L351F' in lead and 'Leu348' in lead
    assert 'residue 348 in the model' in page.locator('.sr-note--warn').first.inner_text()   # the warning stays visible
    details = page.locator('.sr-notations')
    assert details.get_attribute('open') is None                # the long table is folded; the badge says why it matters
    assert details.locator('summary').inner_text().startswith('All transcript notations')
    assert 'numbering differs' in details.locator('summary').inner_text()
    details.locator('summary').click()
    table = page.locator('.sr-table--tx')
    assert 'Genomic allele' in table.inner_text() and '19-19624261-G-A' in table.inner_text()
    # the card's essentials come before the folded table
    order = page.evaluate("""() => { const c = document.querySelector('.sr-card'); const kids = [...c.children].map(e => e.className);
      return [kids.findIndex(k => k.includes('sr-lead')), kids.findIndex(k => k.includes('sr-card-fine'))]; }""")
    assert 0 <= order[0] < order[1]


def test_par2_card_folds_the_notations_and_ties_each_coding_change_to_its_allele(open_page):
    page = search_page(open_page, 'PAR2 M159I')
    assert page.locator('.sr-lead').count() == 0                # nothing to explain: typed and model residues agree
    details = page.locator('.sr-notations')
    assert details.get_attribute('open') is None
    details.locator('summary').click()
    rows = page.locator('.sr-table--tx tbody tr')
    texts = rows.all_inner_texts()
    pairs = {(re.search(r'5-76833084-G-[AT]', t).group(0), re.search(r'c\.477G>[AT]', t).group(0)) for t in texts}
    assert pairs == {('5-76833084-G-A', 'c.477G>A'), ('5-76833084-G-T', 'c.477G>T')}, pairs


def test_typed_transcript_gets_a_lead_line(open_page):
    page = search_page(open_page, 'NM_005242.4:c.477G>A')
    lead = page.locator('.sr-lead').inner_text()
    assert 'NM_005242.4:c.477G>A' in lead and 'Met159' in lead


# ------------------------------------------------------------------------------ A4

def test_variant_table_link_only_when_the_residue_can_be_in_that_table(open_page):
    page = search_page(open_page, 'PAR2 M159I')                  # largest contact change 4.99
    expect(page.get_by_role('link', name="Find in the report's variant table")).to_be_visible()
    assert page.locator('.sr-action-note').count() == 0
    page = search_page(open_page, 'ADRB2 T136I')                 # largest contact change below 3.0
    assert page.get_by_role('link', name="Find in the report's variant table").count() == 0
    note = page.locator('.sr-action-note').inner_text()
    assert 'variant table' in note and '3.0' in note and 'largest is' in note


# ------------------------------------------------------------------------------ A3

def test_reference_mismatch_keeps_what_was_typed_and_offers_the_correction(open_page):
    page = search_page(open_page, 'PAR2 p.Ala159Ile')
    card = page.locator('.sr-card').first
    assert 'p.Ala159Ile' in card.locator('.sr-change-main').inner_text()      # the typed change, not Met159Ile
    assert 'p.Met159Ile' not in card.locator('.sr-change').inner_text()
    assert 'Met' in card.locator('.sr-note--warn').inner_text() and 'not Ala' in card.locator('.sr-note--warn').inner_text()
    assert 'not listed' not in card.inner_text()                               # no claim about the typed change
    fix = card.locator('.sr-fix a.btn')
    expect(fix).to_be_visible()
    assert 'p.Met159Ile' in fix.inner_text()
    assert page.locator('.sr-read .sr-alt-list a', has_text='Met159Ile').count() == 0    # no duplicate link
    fix.click()
    settle(page)
    assert 'p.Met159Ile' in page.locator('.sr-change-main').inner_text()
    assert page.locator('.sr-card tbody tr').count() >= 2                       # its two alleles


# ------------------------------------------------------------------------------ C6

def test_evidence_summary_for_par2(open_page):
    page = search_page(open_page, 'PAR2 M159I', permissions=['clipboard-read', 'clipboard-write'])
    page.get_by_role('button', name='Copy evidence summary').click()
    page.wait_for_function("() => document.querySelector('[data-copy-evidence]').textContent === 'Copied'")
    clip = _clipboard(page)
    for needle in (
        'Query: PAR2 M159I', 'Interpretation: PAR2 (F2RL1), protein change Met159Ile',
        'Receptor: PAR2 (F2RL1, P55085)', 'Residue: Met159', '3.36x36', 'Change: p.Met159Ile (M159I)',
        'NM_005242.6 / NP_005233.4: c.477G>A, p.Met159Ile (allele 5-76833084-G-A)',
        'ENST00000296677.5', 'GRCh38: 5-76833084-G-A', 'GRCh37: 5-76128909-G-A',
        'rs115885685', 'allele count 1,553 of 1,461,886', 'AlphaMissense prediction 0.91',
        'ClinVar 2026-10-11', 'Core functional residue (class-wide): yes, rank 30',
        'receptor threshold', 'Net dRRCS:', 'stronger in inactive', 'Conservation: 0.96 on a 0 to 1 scale',
        'Data releases:', 'gnomAD v4.1.2', 'Search link:', '/search/?q=PAR2%20M159I',
    ):
        assert needle in clip, (needle, clip)
    assert '—' not in clip and 'GRCh37: not mapped' not in clip


def test_evidence_summary_for_lpar2_keeps_the_numbering_shift(open_page):
    page = search_page(open_page, 'LPAR2 L351F', permissions=['clipboard-read', 'clipboard-write'])
    page.get_by_role('button', name='Copy evidence summary').click()
    page.wait_for_function("() => document.querySelector('[data-copy-evidence]').textContent === 'Copied'")
    clip = _clipboard(page)
    for needle in ('Query: LPAR2 L351F', 'Residue: Leu348 (model numbering', 'Change: p.Leu348Phe (L348F)',
                   'p.Leu351Phe is numbered on the gnomAD/ClinVar transcript; it is residue 348 in the model.',
                   'Warning:', 'NM_001395660.1', 'c.1042C>T', 'GRCh37: 19-19735070-G-A', 'rs768831452',
                   '/search/?q=LPAR2%20L351F'):
        assert needle in clip, (needle, clip)


def test_evidence_summary_flags_an_approximate_assembly(open_page):
    page = search_page(open_page, 'chr5:76830000', permissions=['clipboard-read', 'clipboard-write'])
    page.get_by_role('button', name='Copy evidence summary').click()
    page.wait_for_function("() => document.querySelector('[data-copy-evidence]').textContent === 'Copied'")
    clip = _clipboard(page)
    assert re.search(r'GRCh37: 5:76125825 \(approximate\)', clip), clip
    assert 'GRCh38: 5:76830000' in clip and 'approximate' in clip.split('Warnings and notes:')[1]


def test_both_copy_buttons_exist_and_notations_still_copy(open_page):
    page = search_page(open_page, 'PAR2 M159I', permissions=['clipboard-read', 'clipboard-write'])
    expect(page.get_by_role('button', name='Copy all notations')).to_be_visible()
    expect(page.get_by_role('button', name='Copy evidence summary')).to_be_visible()
    page.get_by_role('button', name='Copy all notations').click()
    page.wait_for_function("() => document.querySelector('[data-copy-notations]').textContent === 'Copied'")
    assert 'NM_005242.6:c.477G>A' in _clipboard(page)


def test_card_on_a_phone_in_dark_mode_has_no_errors(open_page):
    page = search_page(open_page, 'LPAR2 L351F', viewport=PHONE_390, scheme='dark', mobile=True)
    assert page.errors == []
    assert page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1
    assert _luminance(page.evaluate("getComputedStyle(document.querySelector('.sr-card')).backgroundColor")) < 0.25


# ----------------------------------------------------- engine additions: read_on, versions, motifs

def test_older_transcript_version_is_labelled_read_on_the_current_one(open_page):
    page = search_page(open_page, 'NM_005242.5:c.477G>A')
    assert page.locator('.sr-note[data-code="version_mismatch"]').count() == 1
    details = page.locator('.sr-notations')
    assert details.get_attribute('open') is None               # folded; the version note above it stays visible
    details.locator('summary').click()
    assert 'You typed NM_005242.5; read on NM_005242.6' in details.inner_text()
    assert 'Transcript you typed' not in results_text(page)


def test_unknown_transcript_version_offers_the_known_ones(open_page):
    page = search_page(open_page, 'NM_005242.999:c.477G>A')
    link = page.locator('.sr-alt-list a').first
    assert link.get_attribute('data-q') == 'NM_005242.6:c.477G>A'
    assert 'No ClinVar record' not in results_text(page)
    link.click()
    settle(page)
    assert 'Met159' in page.locator('.sr-card-title').first.inner_text()


def test_motif_table_marks_departures_and_labels_groups(open_page):
    page = search_page(open_page, 'DRY')
    assert page.locator('.sr-motif').inner_text().startswith('DRY motif')
    assert page.locator('.sr-motif-notes li').count() == 3
    assert 'not the motif residue' in results_text(page)


# ------------------------------------------------------------ review round 2 (2026-11-04)

def test_mismatch_copies_say_the_typed_change_cannot_be_checked(open_page):
    page = search_page(open_page, 'PAR2 p.Ala159Ile', permissions=['clipboard-read', 'clipboard-write'])
    assert page.errors == []
    head = page.locator('.sr-card-title').inner_text()
    assert 'model residue' in head and 'Met159' in head
    assert page.locator('.sr-change-main').inner_text() == 'p.Ala159Ile'
    for button in ('Copy evidence summary', 'Copy all notations'):
        page.get_by_role('button', name=button).click()
        page.wait_for_function("(n) => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Copied')", arg=button)
        clip = page.evaluate('navigator.clipboard.readText()')
        assert 'p.Ala159Ile: position 159 is Met in F2RL1, so this change cannot be checked' in clip, clip
        assert 'this exact change is not listed' not in clip
        lines = [ln for ln in clip.split('\n') if 'p.Met159Ile' in ln]
        assert len(lines) == 1 and lines[0].startswith('Suggested correction'), clip
        page.wait_for_function("() => ![...document.querySelectorAll('button')].some((b) => b.textContent === 'Copied')")


@pytest.mark.parametrize('q', ['ADRB2 ClinVar', 'ADRB2'])
def test_receptor_search_lists_every_clinvar_record(open_page, q):
    page = search_page(open_page, q)
    assert page.errors == [] and page.foreign == []
    box = page.locator('.sr-cvlist-all')
    assert box.count() == 1
    if q == 'ADRB2':
        box.locator('summary').first.click()
    summary = box.locator('summary').first.inner_text()
    n = int(re.search(r'All (\d+) ClinVar records for ADRB2', summary).group(1))
    assert n >= 40
    assert re.search(r'\d+ records: 0 pathogenic or likely pathogenic, \d+ uncertain significance', box.inner_text())
    for g in box.locator('.sr-cvgroup > summary').all():
        g.click()
    assert box.locator('tbody tr').count() == n
    links = box.locator('td[data-label="Record"] a')
    assert links.first.get_attribute('href').startswith('https://www.ncbi.nlm.nih.gov/clinvar/variation/')
    assert links.first.get_attribute('rel') == 'noopener noreferrer'


def test_report_clinvar_link_lands_on_the_list():
    tpl = (BASE / 'templates' / 'gpcr_report.html').read_text(encoding='utf-8')
    assert "search/?q={{ (gene_name ~ ' ClinVar')|urlencode }}" in tpl
    drawer = (BASE / 'static' / 'js' / 'residue-drawer.js').read_text(encoding='utf-8')
    assert "searchHref(cfg.gene + ' ClinVar')" in drawer


def test_variant_table_link_only_for_changes_the_report_lists(open_page):
    # GPR3's own allele at a residue past the cutoff: a row since the 2026-11-05 refresh
    page = search_page(open_page, '1-27393820-C-T')
    href = page.get_by_role('link', name="Find in the report's variant table").get_attribute('href')
    assert href.endswith('#sec=sec-variants&vq=p.Pro8Ser')
    report = (BUILD_DIR / 'reports' / 'gpr3_human.html').read_text(encoding='utf-8')
    assert '<td>p.Pro8Ser</td>' in re.search(r'<table class="v2-table" id="variants-table">(.*?)</table>',
                                             report, re.S).group(1)
    page = search_page(open_page, 'PAR2 p.Met159Ile')
    href = page.get_by_role('link', name="Find in the report's variant table").get_attribute('href')
    assert href.endswith('#sec=sec-variants&vq=p.Met159Ile')
    report = (BUILD_DIR / 'reports' / 'par2_human.html').read_text(encoding='utf-8')
    table = re.search(r'<table class="v2-table" id="variants-table">(.*?)</table>', report, re.S).group(1)
    assert '<td>p.Met159Ile</td>' in table


def test_no_exact_residue_still_lists_the_position(open_page):
    page = search_page(open_page, 'W3.50')
    assert page.errors == []
    msg = page.locator('.sr-message').first.inner_text()
    assert 'No receptor has Trp at 3.50x50; all 283 receptors with their residue at 3.50x50 are listed below.' in msg
    assert page.locator('.sr-table--cmp tbody tr').count() == 25  # first page of 283
    assert '283' in page.locator('#search-status').inner_text()


# ------------------------------------------------------------------ the variant card for an analyst

def _report_contacts(gid, pos):
    """{(res1, res2): delta} of the report page's threshold-passing pairs (rows of its complete RRCS table marked
    significant) that involve `pos`, as the page prints them (3 decimals)."""
    rep = BUILD_DIR / 'reports' / ('%s.html' % gid)
    if not rep.is_file():
        pytest.skip('no report page for %s in this build' % gid)
    html = rep.read_text(encoding='utf-8')
    table = re.search(r'<table class="v2-table" id="rrcs-table">(.*?)</table>', html, re.S).group(1)
    out = {}
    for row in re.findall(r'<tr class="significant-row">(.*?)</tr>', table, re.S):
        cells = [re.sub(r'<[^>]+>', '', c).strip() for c in re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)]
        a, b, d = int(cells[0]), int(cells[2]), float(cells[6])
        if pos in (a, b):
            out[(a, b)] = d
    return out


def test_contacts_on_the_card_are_the_report_pages_threshold_passing_pairs(open_page):
    gid, pos = 'adrb2_human', 131
    want = _report_contacts(gid, pos)
    assert want, 'the report lists threshold-passing pairs at Arg131'
    page = search_page(open_page, 'ADRB2 Arg131')
    rows = page.locator('.sr-table--contacts tbody tr')
    assert rows.count() == len(want)
    seen = {}
    for i in range(rows.count()):
        link = rows.nth(i).locator('a[href*="#pair="]')
        m = re.search(r'#pair=(\d+)-(\d+)$', link.get_attribute('href'))
        a, b = int(m.group(1)), int(m.group(2))
        delta = float(rows.nth(i).locator('.sr-net').inner_text())
        seen[(a, b)] = delta
        assert link.get_attribute('href').startswith('../reports/%s.html#pair=' % gid)
    assert set(seen) == set(want)
    for k, d in want.items():
        assert abs(seen[k] - d) < 0.006, (k, seen[k], d)
    # largest |dRRCS| first; the colour class follows the sign
    deltas = [seen[k] for k in seen]
    assert [abs(d) for d in deltas] == sorted((abs(d) for d in deltas), reverse=True)
    for i in range(rows.count()):
        cls = rows.nth(i).locator('.sr-net').get_attribute('class')
        assert ('sr-net--inactive' in cls) == (deltas[i] < 0)
    # the first pair link opens the report on that pair
    first = rows.first.locator('a[href*="#pair="]')
    href = first.get_attribute('href')
    page.goto(page.url.rsplit('/search/', 1)[0] + '/' + href.replace('../', ''), wait_until='load')
    assert '#pair=' in page.url


def test_card_sections_fold_and_the_most_relevant_are_open(open_page):
    page = search_page(open_page, 'MC4R V103I')
    secs = page.locator('.sr-card details.sr-sec')
    keys = [secs.nth(i).get_attribute('data-sec') for i in range(secs.count())]
    assert keys == ['ids', 'population', 'clinical', 'computational', 'structure']
    for i in range(secs.count()):
        assert secs.nth(i).evaluate('e => e.open'), keys[i]
    # the summary sits above the sections and the research note under it
    summary = page.locator('.sr-card .sr-summary-text').inner_text()
    assert summary.startswith('MC4R p.Val103Ile (V103I) is a missense change at residue Val103')
    assert 'not a clinical classification' in page.locator('.sr-card .sr-research-note').inner_text()
    # keyboard: a section heading is focusable and toggles with Enter
    page.locator('details.sr-sec[data-sec="population"] > summary').focus()
    page.keyboard.press('Enter')
    assert not page.locator('details.sr-sec[data-sec="population"]').evaluate('e => e.open')
    page.keyboard.press('Enter')
    assert page.locator('details.sr-sec[data-sec="population"]').evaluate('e => e.open')
    assert page.errors == []


def test_search_copy_names_the_gpcompare_database(open_page):
    for q in ('MC4R V103I', 'GPR26', 'XYZ9 M1V', 'NM_005242.999:c.477G>A'):
        page = search_page(open_page, q)
        text = page.locator('#search-app').inner_text()
        assert 'this database' not in text.lower(), (q, re.search(r'.{40}this database.{20}', text, re.I).group(0))
    page = search_page(open_page, 'MC4R V103I', permissions=['clipboard-read', 'clipboard-write'])
    assert 'in the gpcompare database' in results_text(page).lower()   # the heading is upper-cased by CSS
    page.get_by_role('button', name='Copy evidence summary').click()
    page.wait_for_function("() => document.querySelector('[data-copy-evidence]').textContent === 'Copied'")
    clip = page.evaluate('navigator.clipboard.readText()')
    assert 'In the GPCompaRe database:' in clip and 'this database' not in clip.lower()
    for needle in ('Evidence summary:', 'AlphaMissense, this change: 0.084 (likely benign)', 'Research use only', 'ACMG criteria are not applied',
                   'Contact list: this residue takes part in no contact above the threshold'):
        assert needle in clip, needle


def test_identifier_copy_buttons_copy_the_notation(open_page):
    page = search_page(open_page, 'MC1R R151C', permissions=['clipboard-read', 'clipboard-write'])
    btn = page.locator('details[data-sec="ids"] .sr-ids button[data-copy="16-89919709-C-T"]')
    expect(btn).to_be_visible()
    btn.click()
    page.wait_for_function("() => document.querySelector('button[data-copy=\"16-89919709-C-T\"]').textContent === 'Copied'")
    assert page.evaluate('navigator.clipboard.readText()') == '16-89919709-C-T'
    ids = page.locator('details[data-sec="ids"]').inner_text()
    for needle in ('MC1R', 'p.Arg151Cys', 'NM_002386.4:c.451C>T', 'rs1805007', 'VCV000014312', 'GRCh37'):
        assert needle in ids, needle


def test_pathogenicity_classes_use_neutral_colours_and_direction_keeps_red_and_blue(open_page):
    page = search_page(open_page, 'ADRB2 R131Q')

    def rgb(css):
        # 'rgb(12, 34, 56)' or, after color-mix, 'color(srgb 0.77 0.78 0.78)'
        nums = [float(x) for x in re.findall(r'[\d.]+', css)[:3]]
        return [round(x * 255) if css.startswith('color(') else int(x) for x in nums]

    def neutral(c):
        r, g, b = c
        return max(r, g, b) - min(r, g, b) <= 12

    for sel in ('.sr-am-cell.sr-am--pathogenic', '.sr-am-cell.sr-am--benign', '.sr-am-cell.sr-am--ambiguous'):
        if page.locator(sel).count():
            assert neutral(rgb(page.locator(sel).first.evaluate('e => getComputedStyle(e).backgroundColor'))), sel
    blue = rgb(page.locator('.sr-table--contacts .sr-net--inactive').first.evaluate('e => getComputedStyle(e).color'))
    assert blue[2] > blue[0] + 40, blue
