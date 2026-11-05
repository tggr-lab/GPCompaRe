"""One class-wide CFR set, one set size, everywhere (owner decision, Yamir 2026-11-05).

The site marks the CFR_TOP_N (50) top-ranked generic positions by CFR score: the set of the paper's
Figure 3 and of the Statistics page's ranked table (Supplementary Table S3; the ranks of S4, the same
as full_cfr_positions.tsv). Before this, search, the report residue table, the report snake plots and
the CFR neighbourhood used a top 30 of the site's own ranking while the Statistics and landing pages
said 50.

The size lives in one place, analysis/cfr_analysis.py CFR_TOP_N. It reaches JavaScript only as data:
search2/meta.json `cfrTop` (search) and #rx-config `cfrTop` (report pages). This file checks the
generator constant, the search meta and the page config agree, that the set is the submitted one, and
that no page or script states another size.
"""
import json
import os
import re
from pathlib import Path

import pandas as pd
import pytest

from GPCompaReports_v2.analysis.cfr_analysis import CFR_TOP_N
from GPCompaReports_v2.analysis.manuscript_stats import (ALL_CSV, TOP50_CSV, class_cfr_ranks, class_cfr_set)
from GPCompaReports_v2.website import glossary
from GPCompaReports_v2.website.page_generators import gpcr_report_page, search_index_v2

from .report_files import report_pages

BASE = Path(__file__).resolve().parent.parent

_env = os.environ.get('SEARCH_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR')
BUILD = (Path(_env).expanduser() if _env else BASE / 'output_v3_demo')
if not BUILD.is_absolute():
    BUILD = BASE / BUILD
needs_build = pytest.mark.skipif(not (BUILD / 'search2' / 'meta.json').is_file(),
                                 reason='no build with search2 at %s (set FREEZE_BUILD_DIR)' % BUILD)

#: "<n> top-ranked" and "top <n>" wherever a page or script names the CFR set
SIZE_RE = re.compile(r'\b(\d+) top-ranked\b|\b[Tt]op[ -](\d+)\b(?= (?:Core Functional|recurrent|CFR|class-wide))')


def _sizes(text):
    return {int(a or b) for a, b in SIZE_RE.findall(text)}


# ----------------------------------------------------------------------------------------- source

def test_the_set_is_the_submitted_top_by_cfr_score():
    ranks = class_cfr_ranks()
    s3 = pd.read_csv(TOP50_CSV)
    assert CFR_TOP_N == 50
    assert len(ranks) == len(pd.read_csv(ALL_CSV)) == 368
    assert class_cfr_set() == set(s3['generic_number']), 'the set is not the paper\'s Figure 3 set (S3)'
    assert all(ranks[g] == r for g, r in zip(s3['generic_number'], s3['cfr_score_rank'])), 'S3 and S4 ranks disagree'


def test_every_generator_uses_the_one_constant_and_the_one_set():
    assert search_index_v2.CFR_TOP == CFR_TOP_N, 'search index'
    assert gpcr_report_page._cfr_generic_numbers({}) == class_cfr_set(), 'report snake plots and residue table'
    src = (BASE / 'website' / 'page_generators' / 'gpcr_report_page.py').read_text(encoding='utf-8')
    assert not re.search(r'top_n\s*=\s*\d', src), 'a report-side top_n default is back'


def test_glossary_names_the_same_size():
    by_id = {t['id']: t['definition'] for t in glossary.GLOSSARY}
    assert '%d top-ranked class-wide CFR positions (by CFR score)' % CFR_TOP_N in by_id['cfr']
    assert 'receptor-level CFR' in by_id['cfr'] and 'Figure 3' in by_id['cfr']
    for k in ('cfr', 'cfr-connected', 'cfr-near'):
        assert _sizes(by_id[k]) == {CFR_TOP_N}, (k, by_id[k])


def test_no_script_or_template_types_a_set_size():
    """The number reaches JS only as data (meta.json cfrTop, rx-config cfrTop); templates use cfr_top_n."""
    bad = []
    for path in list((BASE / 'static' / 'js').rglob('*.js')) + list((BASE / 'templates').rglob('*.html')):
        text = path.read_text(encoding='utf-8')
        for n in _sizes(text):
            bad.append('%s: %d' % (path.relative_to(BASE), n))
        if re.search(r'cfrTop\s*\?\?\s*\d|CFR_TOP_N\s*=\s*\d', text):
            bad.append('%s: a typed fallback for cfrTop' % path.relative_to(BASE))
    assert not bad, bad


# ------------------------------------------------------------------------------------------ build

@needs_build
def test_search_meta_and_page_config_carry_the_generator_constant():
    meta = json.loads((BUILD / 'search2' / 'meta.json').read_text(encoding='utf-8'))
    assert meta['cfrTop'] == CFR_TOP_N
    assert {g for g, r in meta['cfrRank'].items() if r <= meta['cfrTop']} == class_cfr_set()
    pages = report_pages(BUILD / 'reports')
    assert pages
    snakes = 0
    for page in pages:
        html = page.read_text(encoding='utf-8')
        cfg = json.loads(re.search(r'<script type="application/json" id="rx-config">(.*?)</script>', html, re.S).group(1))
        assert cfg['cfrTop'] == CFR_TOP_N, page.name
        snake = re.search(r'<script[^>]*id="snake-plot-data"[^>]*>(.*?)</script>', html, re.S)
        if snake:
            desc = json.loads(snake.group(1))['views']['cfr']['description']
            assert _sizes(desc) == {CFR_TOP_N} and 'by CFR score' in desc, (page.name, desc)
            snakes += 1
    assert snakes, 'no report carries snake-plot data: the CFR view description was not checked'


@needs_build
def test_statistics_landing_and_glossary_pages_state_the_same_size():
    for name in ('statistics.html', 'index.html', 'glossary.html'):
        html = (BUILD / name).read_text(encoding='utf-8')
        assert _sizes(html) == {CFR_TOP_N}, (name, _sizes(html))
    stats = (BUILD / 'statistics.html').read_text(encoding='utf-8')
    body = stats[stats.index('Core Functional Residue Positions'):]
    shown = re.findall(r'<td class="num">\d+</td>\s*<td><strong>([^<]+)</strong></td>', body.split('</tbody>')[0])
    assert set(shown) == class_cfr_set(), 'the Statistics table and the marked set differ'
