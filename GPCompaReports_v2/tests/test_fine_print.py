"""The fine-print component, the site-wide "Data versions" line, and prose kept out of the main flow.

Three layers:
  * Jinja: the macros in templates/_partials/fine_print.html, rendered on their own (no build needed).
  * Built pages: the non-report pages of a build carry no PAR2 M159I style example text, and the
    footer carries the data-versions line (BUILD: SEARCH_BUILD_DIR, else FREEZE_BUILD_DIR, else output_v3_demo).
  * Browser: the component is small and muted, readable in light and dark, the phone layout does not
    scroll sideways, and no page logs a console error.
"""
import os
import pathlib
import re

import pytest
from jinja2 import DictLoader, Environment, FileSystemLoader

BASE = pathlib.Path(__file__).resolve().parent.parent
TEMPLATES = BASE / 'templates'

_env = os.environ.get('SEARCH_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR')
BUILD_DIR = pathlib.Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR

needs_build = pytest.mark.skipif(not (BUILD_DIR / 'index.html').is_file(), reason='no build in %s' % BUILD_DIR)

NON_REPORT_PAGES = ['index.html', 'browse/index.html', 'search/index.html', 'statistics.html',
                    'glossary.html', 'downloads.html', 'privacy.html', 'contact.html']
FORBIDDEN_EXAMPLES = ('M159I', 'Met159Ile', 'rs115885685', 'NM_005242')

REGISTRY = {
    'schema': 1,
    '_doc': 'not shown',
    'database': {'label': 'GPCompaRe database release 2026-11-05', 'build_date': '2026-11-05'},
    'sources': {
        'rrcs_batch': {'label': 'GPCompaRe RRCS batch 2026-02-02', 'date': '2026-02-02', 'note': 'Frozen.'},
        'gnomad': {'label': 'gnomAD v4.1.2', 'long_label': 'gnomAD v4.1.2 (dataset gnomad_r4)', 'fetched': '2026-10-18'},
        'clinvar': {'label': 'ClinVar 2026-10-11'},
        'conservation': {'label': 'VarSite conservation via ProtVar'},
    },
}


# ------------------------------------------------------------------------------------ Jinja

def _render(src, **ctx):
    env = Environment(loader=FileSystemLoader(str(TEMPLATES)))
    return env.from_string('{% from "_partials/fine_print.html" import fine_print, data_versions_line, data_versions_table %}' + src).render(**ctx)


def test_fine_print_macro_makes_an_aside_or_a_collapsible_details():
    a = _render('{% call fine_print() %}<p>x</p>{% endcall %}')
    assert a == '<aside class="fine-print"><p>x</p></aside>'
    d = _render('{% call fine_print(summary="About this data", page=True, id="a", cls="k") %}<p>x</p>{% endcall %}')
    assert d == '<details class="fine-print fine-print--page k" id="a"><summary>About this data</summary><p>x</p></details>'
    assert ' open' in _render('{% call fine_print(summary="s", open=True) %}x{% endcall %}')


def test_data_versions_line_lists_the_main_sources_and_links_the_full_list():
    out = _render('{{ data_versions_line(dv, "index.html#data-versions") }}', dv=REGISTRY)
    assert 'data-data-versions' in out and 'class="fine-print fine-print--versions"' in out
    for needle in ('GPCompaRe database release 2026-11-05', 'GPCompaRe RRCS batch 2026-02-02', 'gnomAD v4.1.2', 'ClinVar 2026-10-11'):
        assert needle in out, needle
    assert 'VarSite' not in out                                   # the footer names the main sources; the table has them all
    assert 'href="index.html#data-versions">Full list</a>' in out
    assert 'not shown' not in out and '—' not in out


def test_data_versions_table_shows_every_source_with_its_date_and_note():
    out = _render('{{ data_versions_table(dv) }}', dv=REGISTRY)
    for needle in ('VarSite conservation via ProtVar', 'gnomAD v4.1.2 (dataset gnomad_r4)', 'Fetched 2026-10-18', 'Frozen.'):
        assert needle in out, needle


@pytest.mark.parametrize('dv', [None, {}, [], 'x'])
def test_without_a_registry_nothing_is_printed(dv):
    ctx = {} if dv is None else {'dv': dv}
    assert _render('{{ data_versions_line(dv, "u") }}{{ data_versions_table(dv) }}', **ctx).strip() == ''


def test_a_flat_registry_is_read_too():
    out = _render('{{ data_versions_line(dv, "u") }}', dv={'gnomad': 'gnomAD v9', 'clinvar': {'label': 'ClinVar X'}})
    assert 'gnomAD v9' in out and 'ClinVar X' in out


def test_footer_and_base_wire_the_component():
    base = (TEMPLATES / 'base.html').read_text(encoding='utf-8')
    footer = (TEMPLATES / '_partials' / 'footer.html').read_text(encoding='utf-8')
    assert 'static/css/fine-print.css' in base
    assert 'data_versions is defined and data_versions' in footer and 'data_versions_line' in footer


def test_component_css_is_documented_small_and_muted():
    css = (BASE / 'static' / 'css' / 'fine-print.css').read_text(encoding='utf-8')
    assert re.search(r'\.fine-print \{[^}]*font-size: var\(--fp-size\)', css, re.S)
    assert '--fp-size: 0.8125rem' in css
    assert 'color: var(--fgColor-muted)' in css
    assert '.fine-print--page' in css and '.fine-print--versions' in css


# --------------------------------------------------------------------------- examples, no favourite

def _visible_text(path):
    h = path.read_text(encoding='utf-8')
    return re.sub(r'<script\b.*?</script>|<style\b.*?</style>', ' ', h, flags=re.S | re.I)


@needs_build
@pytest.mark.parametrize('page', NON_REPORT_PAGES)
def test_no_page_outside_the_reports_uses_the_par2_m159i_examples(page):
    path = BUILD_DIR / page
    if not path.is_file():
        pytest.skip('%s not in the build' % page)
    html = path.read_text(encoding='utf-8')               # markup too: placeholders and links count
    for needle in FORBIDDEN_EXAMPLES:
        assert needle not in html, '%s in %s' % (needle, page)


@needs_build
def test_the_shared_scripts_and_the_glossary_carry_no_favourite_example():
    for rel in ('static/js/glossary-data.js', 'static/js/search-ui/render.js', 'static/js/search-ui/suggest.js',
                'static/js/search-box.js', 'static/js/landing.js'):
        path = BUILD_DIR / rel
        if not path.is_file():
            continue
        text = path.read_text(encoding='utf-8')
        # the render module quotes PAR2 only in code comments; examples shown to a reader are the HELP list and the placeholders
        if rel.endswith('render.js'):
            help_block = text[text.index('export const HELP'):text.index('export function renderHelp')]
            text = help_block
        for needle in FORBIDDEN_EXAMPLES:
            assert needle not in text, '%s in %s' % (needle, rel)


# ---------------------------------------------------------------------------------- built pages

@needs_build
@pytest.mark.parametrize('page', ['index.html', 'browse/index.html', 'search/index.html', 'glossary.html', 'statistics.html'])
def test_built_pages_load_the_component_and_carry_the_versions_line(page):
    html = (BUILD_DIR / page).read_text(encoding='utf-8')
    assert 'fine-print.css' in html
    if (BUILD_DIR / 'data_versions.json').is_file():
        assert 'data-data-versions' in html and 'Data versions:' in html
        assert 'index.html#data-versions' in html


@needs_build
def test_landing_prose_sits_in_fine_print_and_keeps_the_limitation_statement():
    html = (BUILD_DIR / 'index.html').read_text(encoding='utf-8')
    assert re.search(r'class="fine-print dataset-limitation"[^>]*>\s*<p>\s*Positions and contact pairs', html)
    assert 'model-derived structural candidates' in html
    assert 'Methods, data sources and references' in html and 'id="methods-sources"' in html
    # the long methods paragraph is no longer a section of its own
    assert 'class="methods-sources"' not in html
    if (BUILD_DIR / 'data_versions.json').is_file():
        assert 'id="data-versions"' in html and 'data-data-versions-table' in html


@needs_build
def test_statistics_text_is_untouched_by_the_presentation_changes():
    html = (BUILD_DIR / 'statistics.html').read_text(encoding='utf-8')
    for needle in ('The box plots compare groups with a Kruskal-Wallis test.', 'What are Core Functional Residues (CFRs)?',
                   'Where these cross-receptor numbers come from.', 'This association supports the CFR score as a feature for prioritizing variants.'):
        assert needle in html, needle


# ------------------------------------------------------------------ data versions on the non-report pages

import json  # noqa: E402

REG = json.loads((BASE / 'data_versions.json').read_text(encoding='utf-8'))
SRC = REG['sources']
JS_DIR = BASE / 'static' / 'js'
BATCH_QUERY_DATE = 'accessed 2 February 2026'
_VERSIONS_TABLE = re.compile(r'<table class="fp-versions".*?</table>', re.S)


def _without_versions_table(html):
    """The "Data versions" table lists every source, including the paper's February batch query, by design."""
    return _VERSIONS_TABLE.sub('', html)


def test_no_hard_coded_data_release_in_the_non_report_sources():
    """Labels come from the registry: no template, glossary or search script spells a gnomAD or ClinVar release."""
    files = [TEMPLATES / n for n in ('landing.html', 'statistics.html', 'glossary.html', 'search.html', 'base.html')]
    files += [TEMPLATES / '_partials' / 'footer.html', BASE / 'website' / 'glossary.py']
    files += sorted((JS_DIR / 'search-ui').glob('*.js')) + [JS_DIR / 'landing.js']
    for f in files:
        text = f.read_text(encoding='utf-8')
        code = re.sub(r'/\*.*?\*/|^\s*//.*$', '', text, flags=re.S | re.M) if f.suffix == '.js' else text
        assert not re.search(r'gnomAD v\d', code), '%s spells a gnomAD release' % f.name
        assert BATCH_QUERY_DATE not in code, '%s spells the batch query date' % f.name
        assert 'ClinVar 20' not in code, '%s spells a ClinVar release' % f.name
        assert 'REPORT_TABLE_RELEASE' not in code, f.name


def test_search_script_has_no_newer_data_claim_and_reads_the_report_table_release():
    js = (JS_DIR / 'search-ui' / 'render.js').read_text(encoding='utf-8')
    assert 'newer variant data' not in js and 'sameAsSearch' in js and 'reportTable' in js


def test_glossary_gnomad_entry_reads_the_registry():
    from GPCompaReports_v2.website import glossary
    entry = next(t for t in glossary.GLOSSARY if t['id'] == 'gnomad')
    assert SRC['gnomad']['long_label'] in entry['definition']
    assert BATCH_QUERY_DATE not in entry['definition']


@needs_build
def test_the_site_carries_the_registry_for_scripts():
    assert json.loads((BUILD_DIR / 'data_versions.json').read_text(encoding='utf-8')) == REG


@needs_build
def test_landing_methods_text_and_glossary_show_the_registry_release():
    landing = (BUILD_DIR / 'index.html').read_text(encoding='utf-8')
    methods = landing[landing.index('id="methods-sources"'):]
    assert SRC['gnomad']['long_label'] in methods
    gloss = (BUILD_DIR / 'glossary.html').read_text(encoding='utf-8')
    assert SRC['gnomad']['long_label'] in gloss
    js = BUILD_DIR / 'static' / 'js' / 'glossary-data.js'
    if js.is_file():
        assert SRC['gnomad']['long_label'] in js.read_text(encoding='utf-8')


@needs_build
def test_statistics_page_labels_its_variant_layer_as_the_february_batch():
    html = (BUILD_DIR / 'statistics.html').read_text(encoding='utf-8')
    refs = re.search(r'<p class="stats-refs.*?</p>', html, re.S).group(0)
    assert SRC['gnomad_batch']['label'] in refs and 'batch layer' in refs
    assert SRC['gnomad']['label'] not in refs                   # the search and report release is a different layer


@needs_build
@pytest.mark.parametrize('page', NON_REPORT_PAGES)
def test_only_the_paper_batch_query_carries_the_february_access_date(page):
    path = BUILD_DIR / page
    if not path.is_file():
        pytest.skip('%s not in the build' % page)
    html = _without_versions_table(path.read_text(encoding='utf-8'))
    assert BATCH_QUERY_DATE not in html, page
    # the batch release label is named only where the page is about the batch layer
    if page != 'statistics.html':
        assert SRC['gnomad_batch']['label'] not in html, page


@needs_build
def test_the_versions_table_names_the_batch_query_as_the_papers_and_the_statistics_layer():
    landing = (BUILD_DIR / 'index.html').read_text(encoding='utf-8')
    table = _VERSIONS_TABLE.search(landing)
    assert table, 'no data versions table on the landing page'
    table = table.group(0)
    assert 'gnomAD, statistics and paper' in table and SRC['gnomad_batch']['long_label'] in table
    assert 'gnomAD, search and reports' in table and SRC['gnomad']['long_label'] in table


@needs_build
@pytest.mark.parametrize('page', ['index.html', 'browse/index.html', 'search/index.html', 'glossary.html', 'statistics.html'])
def test_footer_versions_line_equals_the_registry(page):
    html = (BUILD_DIR / page).read_text(encoding='utf-8')
    line = re.search(r'<aside class="fine-print fine-print--versions".*?</aside>', html, re.S)
    assert line, page
    text = re.sub(r'<[^>]+>', ' ', line.group(0))
    for key in ('rrcs_batch', 'gpcrdb_models', 'gnomad', 'clinvar', 'alphamissense', 'uniprot', 'ensembl', 'hgnc'):
        assert SRC[key]['label'] in text, (page, key)
    assert REG['database']['label'] in text


@needs_build
def test_search_page_shell_and_index_carry_the_registry_labels():
    meta = json.loads((BUILD_DIR / 'search2' / 'meta.json').read_text(encoding='utf-8'))['releases']
    for key in ('gnomad', 'clinvar', 'ensembl', 'hgnc', 'uniprot', 'alphamissense'):
        assert meta[key]['label'] == SRC[key]['label'], key
    assert meta['reportTable']['label'] == SRC['gnomad']['label'] and meta['reportTable']['sameAsSearch'] is True
    html = (BUILD_DIR / 'search/index.html').read_text(encoding='utf-8')
    assert BATCH_QUERY_DATE not in html and 'newer variant data' not in html


# the worked example on the landing page (a well-known contact in another receptor, not the PAR2 favourite)

def _adrb2_delta_csv():
    env = os.environ.get('GPCOMPARE_BATCH_DIR')
    cands = [pathlib.Path(env).expanduser()] if env else []
    cands += [BASE.parent / 'The_batch_RRCS_analyzer' / 'batch_analysis_full' / 'batch_analysis_20260202_151051']
    for c in cands:
        f = c / 'csv_data' / 'adrb2_human_rrcs_delta.csv'
        if f.is_file():
            return f
    return None


def test_landing_worked_example_is_adrb2_and_not_par2():
    html = (TEMPLATES / 'landing.html').read_text(encoding='utf-8')
    sec = html[html.index('class="worked"'):html.index('class="cfr-intro"')]
    assert 'adrb2-explainer-snake.png' in sec and 'reports/adrb2_human.html#view=delta_rrcs' in sec
    assert 'I121' in sec and 'F282' in sec and 'P-I-F' in sec
    for needle in FORBIDDEN_EXAMPLES + ('F300', 'par2-explainer', 'Rank in PAR2'):
        assert needle not in sec, needle
    assert (BASE / 'static' / 'img' / 'adrb2-explainer-snake.png').is_file()


def test_landing_worked_example_numbers_come_from_the_adrb2_data():
    f = _adrb2_delta_csv()
    if f is None:
        pytest.skip('no batch directory (set GPCOMPARE_BATCH_DIR)')
    import pandas as pd
    d = pd.read_csv(f).sort_values('abs_delta', ascending=False).reset_index(drop=True)
    row = d[(d.res1 == 121) & (d.res2 == 282)]
    assert len(row) == 1
    r = row.iloc[0]
    thr = d.abs_delta.mean() + d.abs_delta.std()
    html = (TEMPLATES / 'landing.html').read_text(encoding='utf-8')
    sec = html[html.index('class="worked"'):html.index('class="cfr-intro"')]
    assert '<td>%.2f</td>' % r.active_rrcs in sec and '<td>%.2f</td>' % r.inactive_rrcs in sec
    assert '−%.2f</td>' % abs(r.delta_rrcs) in sec and r.delta_rrcs < 0
    assert '%.2f, so this contact passes' % thr in sec and r.abs_delta >= thr
    assert '%dth of %d contact pairs' % (row.index[0] + 1, len(d)) in sec


# ------------------------------------------------------------------------------------- browser

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter. Run from the project venv.')
from GPCompaReports_v2.tests.test_search_browser import (  # noqa: E402,F401  (fixtures)
    PHONE_390, browser, open_page, server,
)

PAGES = [('landing', '/index.html'), ('browse', '/browse/index.html'), ('search', '/search/'), ('statistics', '/statistics.html'),
         ('glossary', '/glossary.html'), ('downloads', '/downloads.html'), ('privacy', '/privacy.html'), ('contact', '/contact.html')]


def _lum(css):
    r, g, b = [int(x) for x in re.findall(r'[\d.]+', css)[:3]]
    f = lambda c: (c / 255 / 12.92) if c / 255 <= 0.03928 else (((c / 255 + 0.055) / 1.055) ** 2.4)  # noqa: E731
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def _contrast(fg, bg):
    a, b = _lum(fg), _lum(bg)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def _no_horizontal_scroll(page):
    return page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth') <= 1


pytestmark_browser = pytest.mark.skipif(
    not (BUILD_DIR / 'search' / 'index.html').is_file(), reason='no build in %s' % BUILD_DIR)


@pytestmark_browser
@pytest.mark.parametrize('scheme', ['light', 'dark'])
@pytest.mark.parametrize('name,path', PAGES)
def test_pages_have_no_console_errors_and_the_phone_does_not_scroll_sideways(open_page, name, path, scheme):
    page = open_page(path, scheme=scheme)
    page.wait_for_timeout(300)
    errors = [e for e in page.errors if 'plot' not in e.lower()]
    assert errors == [], errors
    phone = open_page(path, viewport=PHONE_390, scheme=scheme, mobile=True)
    phone.wait_for_timeout(300)
    assert _no_horizontal_scroll(phone), name


@pytestmark_browser
@pytest.mark.parametrize('scheme', ['light', 'dark'])
def test_fine_print_is_small_muted_and_readable(open_page, scheme):
    page = open_page('/index.html', scheme=scheme)
    fp = page.locator('.dataset-limitation')
    fp.scroll_into_view_if_needed()
    size = fp.locator('p').evaluate('e => parseFloat(getComputedStyle(e).fontSize)')
    body = page.locator('.dataset-note').first.evaluate('e => parseFloat(getComputedStyle(e).fontSize)')
    assert size <= 13.5 and size >= 12, size                 # small, but not unreadable
    colour = fp.locator('p').evaluate('e => getComputedStyle(e).color')
    bg = page.evaluate('getComputedStyle(document.body).backgroundColor')
    assert _contrast(colour, bg) >= 4.5, (colour, bg)
    heading = page.locator('.dataset-table th').first.evaluate('e => getComputedStyle(e).color')
    assert _lum(colour) != _lum(heading)                     # visibly quieter than the table it sits under
    assert body <= 14


@pytestmark_browser
@pytest.mark.parametrize('scheme', ['light', 'dark'])
def test_the_footer_versions_line_is_readable_and_links_to_the_full_list(open_page, scheme):
    if not (BUILD_DIR / 'data_versions.json').is_file():
        pytest.skip('this build has no data_versions.json')
    page = open_page('/browse/index.html', scheme=scheme)
    line = page.locator('[data-data-versions]')
    assert 'Data versions:' in line.inner_text()
    colour = line.evaluate('e => getComputedStyle(e).color')
    bg = page.evaluate('getComputedStyle(document.querySelector(".site-footer")).backgroundColor')
    assert _contrast(colour, bg) >= 4.5, (colour, bg)
    line.locator('a', has_text='Full list').click()
    page.wait_for_url(re.compile(r'index\.html#data-versions'))
    assert page.locator('#data-versions').evaluate('e => e.open') is True   # the collapsed block opens on the link
    assert 'Fetched' in page.locator('#data-versions').inner_text()


@pytestmark_browser
def test_landing_keeps_the_numbers_and_folds_the_methods(open_page):
    page = open_page('/index.html')
    text = page.locator('main').inner_text()
    for n in ('283', '213,456', '23,025', '566'):
        assert n in text, n
    assert page.locator('#methods-sources').evaluate('e => e.open') is False
    assert 'Heo and Feig' not in text                          # folded away
    page.locator('#methods-sources summary').click()
    assert 'Heo and Feig' in page.locator('#methods-sources').inner_text()
    # every landing example is a link to a search that has an answer; none is PAR2 M159I
    hrefs = page.locator('.search-examples a').evaluate_all('els => els.map(e => decodeURIComponent(e.getAttribute("href")))')
    assert hrefs and not any(any(f in h for f in FORBIDDEN_EXAMPLES) for h in hrefs)


@pytestmark_browser
def test_search_page_intro_is_one_short_line_and_the_prose_is_fine_print(open_page):
    page = open_page('/search/')
    page.wait_for_selector('.sr-help')
    head = page.locator('#search-app header').inner_text()
    assert len(head) < 80, head
    assert not page.locator('#search-hint').is_visible()       # the key hints are folded fine print
    assert 'Use the arrow keys' not in page.locator('main').inner_text()
    fine = page.locator('#search-fineprint')
    assert fine.evaluate('e => e.classList.contains("fine-print--page")')
    assert page.locator('#search-howto').evaluate('e => e.open') is False
    # fine print comes after the results, above the footer
    order = page.evaluate("""() => { const r = document.getElementById('search-results'), f = document.getElementById('search-fineprint'),
      foot = document.querySelector('.site-footer');
      const lt = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); return [lt(r, f), lt(f, foot)]; }""")
    assert order == [True, True]


@pytestmark_browser
@pytest.mark.parametrize('scheme', ['light', 'dark'])
def test_the_help_examples_vary_across_receptors(open_page, scheme):
    page = open_page('/search/', scheme=scheme)
    page.wait_for_selector('.sr-help')
    chips = page.locator('.sr-help .sr-chip').all_inner_texts()
    assert len(chips) >= 20
    text = ' '.join(chips)
    assert not any(f in text for f in FORBIDDEN_EXAMPLES)
    assert sum(1 for s in ('DRD2', 'MC1R', 'ADRB2', 'OPRM1', 'CNR1') if s in text) >= 4   # no single receptor is the favourite
    assert page.errors == []


@pytestmark_browser
def test_statistics_methodology_reads_as_fine_print_without_losing_text(open_page):
    page = open_page('/statistics.html')
    sizes = page.locator('.stats-page .callout').first.locator('p').evaluate_all('els => els.map(e => parseFloat(getComputedStyle(e).fontSize))')
    assert sizes[0] > sizes[1], sizes                          # the definition leads, the method notes recede
    assert page.locator('.stats-refs').evaluate('e => e.classList.contains("fine-print")')
    assert 'Kruskal-Wallis' in page.locator('#sec-a').evaluate('e => e.closest("section").innerText')
