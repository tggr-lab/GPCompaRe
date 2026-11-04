"""The search page is generated, linked from every page's search box, and wired to the v2 engine."""
import os
import pathlib
import re

import pytest
from jinja2 import Environment, FileSystemLoader

from GPCompaReports_v2.website.page_generators.search_page import generate_search_page
from GPCompaReports_v2.website.seo import SITE_URL

BASE = pathlib.Path(__file__).resolve().parent.parent


class _Store:
    gpcr_ids = ['par2_human', 'adrb2_human']
    gpcr_info = {
        'par2_human': {'uniprot_name': 'PAR2', 'gene_name': 'F2RL1'},
        'adrb2_human': {'uniprot_name': 'ADRB2', 'gene_name': 'ADRB2'},
    }


def _render(tmp_path):
    env = Environment(loader=FileSystemLoader(str(BASE / 'templates')))
    env.globals['site_url'] = SITE_URL
    generate_search_page(env, _Store(), tmp_path)
    return (tmp_path / 'search' / 'index.html').read_text(encoding='utf-8')


def test_search_page_is_generated_with_its_shell(tmp_path):
    html = _render(tmp_path)
    assert '<title>Search · GPCompaRe</title>' in html
    assert 'id="search-app"' in html and 'data-index="../search2/"' in html
    assert 'data-reports="../reports/"' in html and 'data-studio="../studio/"' in html
    assert '<script type="module" src="../static/js/search-ui/search-page.js">' in html
    assert 'id="search-status"' in html and 'role="status"' in html
    assert '<label for="search-input"' in html
    assert '<link rel="canonical" href="%ssearch/">' % SITE_URL in html


def test_search_page_without_javascript_lists_the_receptor_reports(tmp_path):
    html = _render(tmp_path)
    assert re.search(r'<noscript>.*href="../reports/par2_human.html">PAR2 \(F2RL1\)</a>', html, re.S)
    assert 'href="../reports/adrb2_human.html">ADRB2</a>' in html


def test_topbar_search_boxes_submit_to_the_search_page(tmp_path):
    html = _render(tmp_path)
    forms = re.findall(r'<form class="(?:topbar-search|drawer-search)" action="([^"]+)"', html)
    assert forms == ['../search/', '../search/']
    assert html.count('data-search-index="../search2/"') == 2  # top bar and drawer
    assert 'static/js/search-box.js' in html and 'static/css/search-ui.css' in html


def test_root_pages_link_the_search_page_without_a_prefix():
    topbar = (BASE / 'templates' / '_partials' / 'topbar.html').read_text(encoding='utf-8')
    assert 'action="{{ static_prefix }}search/"' in topbar
    assert 'data-search-index="{{ static_prefix }}search2/"' in topbar


def test_site_generator_calls_the_search_page_generator():
    src = (BASE / 'website' / 'site_generator.py').read_text(encoding='utf-8')
    assert 'generate_search_page(env, self.store, self.output_dir)' in src


def test_browse_page_no_longer_has_the_v1_variant_tab():
    tpl = (BASE / 'templates' / 'gpcr_index.html').read_text(encoding='utf-8')
    assert 'tab-variants' not in tpl and 'static/js/search.js' not in tpl
    assert 'action="{{ static_prefix }}search/"' in tpl


_env = os.environ.get('SEARCH_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR')
_build = pathlib.Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
_build = _build if _build.is_absolute() else BASE / _build


@pytest.mark.skipif(not (_build / 'search' / 'index.html').is_file(), reason='no built search page')
def test_built_site_links_search_from_every_page():
    for page in ['index.html', 'browse/index.html', 'glossary.html', 'statistics.html']:
        p = _build / page
        if p.is_file():
            html = p.read_text(encoding='utf-8')
            assert re.search(r'<form class="topbar-search" action="(\.\./)?search/"', html), page
    reports = sorted((_build / 'reports').glob('*_human.html'))
    if reports:
        assert 'action="../search/"' in reports[0].read_text(encoding='utf-8')


def test_no_em_dashes_in_the_search_ui_copy():
    for rel in ['templates/search.html', 'static/js/search-ui/render.js', 'static/js/search-ui/suggest.js']:
        text = (BASE / rel).read_text(encoding='utf-8')
        # code comments may use them; user-facing strings must not
        strings = re.findall(r"'[^'\n]*—[^'\n]*'|\"[^\"\n]*—[^\"\n]*\"|`[^`]*—[^`]*`", text)
        assert not strings, (rel, strings[:2])
