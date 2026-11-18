"""Which receptors each variant result covers, and why the others are missing.

The Statistics page has two allele sets (2026-11-13 page rewrite):

  * the AlphaMissense comparison, recurrence groups and conservation groups use the February batch query
    (276 receptors): GPR3, GPR4 and XCR1 are left out, and GPR182 (ACKR5), NPY6R, P2RY8 and TAAR3P had no
    records in that query. The Coverage table names all seven, grouped by reason;
  * the per-position variants use the report variant layer (281 receptors): NPY6R and TAAR3P have no
    protein-coding missense records (pseudogene loci), which the card guide says.

GPR182 and P2RY8 appear only in the Methods row, and never as lacking gnomAD variants. The old 279-receptor
variant layer (conservation scatter) is gone from the page. Receptors are named by the site's gene symbol
(TAAR3P, as in the selection box and receptors.json), with the HGNC symbol after it where that differs (GPR182).
"""
import os
import pathlib
import re
from xml.etree import ElementTree

import pytest

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

STATS = BUILD_DIR / 'statistics.html'

PSEUDOGENE = ('NPY6R', 'TAAR3P')
UNRESOLVED = ('GPR182', 'P2RY8')

needs_build = pytest.mark.skipif(
    not STATS.exists(),
    reason='no built statistics page at %s; run scripts/build_demo.sh' % STATS)


_CACHE = {}


def _text():
    """Visible page text only.

    The built page carries several megabytes of embedded Plotly JSON inside
    <script> blocks. Sentence-splitting that is both meaningless and slow
    enough to look like a hang, so the scripts come out first.
    """
    if 'text' not in _CACHE:
        html = STATS.read_text(encoding='utf-8')
        html = re.sub(r'<script\b.*?</script>', ' ', html, flags=re.S | re.I)
        html = re.sub(r'<style\b.*?</style>', ' ', html, flags=re.S | re.I)
        _CACHE['text'] = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html))
    return _CACHE['text']


def _coverage():
    html = STATS.read_text(encoding='utf-8')
    table = ElementTree.fromstring(re.search(r'<table class="v2-table cov-table".*?</table>', html, re.S)[0])
    cells = [[' '.join(td.itertext()).strip() for td in row] for row in table.findall('./tbody/tr')]
    return {row[0]: row[1:] for row in cells}


@needs_build
def test_the_per_position_row_names_its_receptors_and_exclusions():
    included, source, excluded = _coverage()['Variants per top-ranked position']
    assert included == '281 receptors' and 'gnomAD v4.1.2' in source
    assert excluded == 'NPY6R, TAAR3P No protein-coding missense records'


@needs_build
def test_the_comparison_names_the_seven_exclusions_by_reason():
    key, = [k for k in _coverage() if k.startswith('AlphaMissense comparison')]
    included, source, excluded = _coverage()[key]
    assert included == '276 receptors' and 'gnomAD v4.1.0' in source
    assert excluded.startswith('GPR3, GPR4, XCR1 ')
    assert 'No query records GPR182 (ACKR5), NPY6R, P2RY8, TAAR3P' in excluded


@needs_build
def test_gp182_and_p2ry8_appear_only_in_the_methods_row():
    text = _text()
    for name in UNRESOLVED:
        assert text.count(name) == 1, (name, text.count(name))
    key, = [k for k in _coverage() if k.startswith('AlphaMissense comparison')]
    assert all(name in _coverage()[key][-1] for name in UNRESOLVED)


@needs_build
def test_gp182_and_p2ry8_are_not_described_as_lacking_gnomad_variants():
    """gnomAD holds missense variants for both. Saying otherwise is false."""
    text = _text()
    sentences = re.split(r'(?<=\.)\s+', text)
    for s in sentences:
        if not any(g in s for g in UNRESOLVED):
            continue
        low = s.lower()
        for claim in ('no gnomad', 'lack gnomad', 'lacks gnomad', 'no variant data were available',
                      'no gnomad variant data', 'pseudogene'):
            assert claim not in low, (claim, s.strip()[:200])


@needs_build
def test_the_retired_279_receptor_layer_is_gone():
    assert '279' not in _text()


@needs_build
def test_receptors_are_named_by_the_site_symbol():
    """TAAR3P is the symbol of the selection box, the profile and receptors.json; the bare UniProt stem never
    stands for it on the page or in coverage.csv."""
    assert not re.search(r'TAAR3(?!P)', _text())
    cov = BUILD_DIR / 'data' / 'stats' / 'coverage.csv'
    if cov.is_file():
        assert not re.search(r'TAAR3(?!P)', cov.read_text(encoding='utf-8'))
