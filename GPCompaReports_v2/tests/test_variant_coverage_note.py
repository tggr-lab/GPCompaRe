"""Which receptors each variant result covers, and why the others are missing.

The Statistics page has two allele sets (2026-11-13 page rewrite):

  * the AlphaMissense comparison, recurrence groups and conservation groups use the February batch query
    (276 receptors): GPR3, GPR4 and XCR1 are left out, and ACKR5 (GP182), NPY6R, P2RY8 and TAAR3 had no
    records in that query. The Methods row "What each result covers" names all seven, in two sentences;
  * the per-position variants use the report variant layer (281 receptors): NPY6R and TAAR3 have no
    protein-coding missense records (pseudogene loci), which the card guide says.

GP182 and P2RY8 appear only in the Methods row, and never as lacking gnomAD variants. The old 279-receptor
variant layer (conservation scatter) is gone from the page.
"""
import os
import pathlib
import re

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

PSEUDOGENE = ('NPY6R', 'TAAR3')
UNRESOLVED = ('GP182', 'P2RY8')

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


@needs_build
def test_the_per_position_card_names_its_281_receptors_and_the_two_without_records():
    text = _text()
    assert '281 receptors (NPY6R and TAAR3 have none)' in text


@needs_build
def test_the_methods_row_names_the_seven_receptors_in_two_sentences():
    html = STATS.read_text(encoding='utf-8')
    rows = re.findall(r'<tr>(.*?)</tr>', html[html.index('cov-table'):], re.S)
    am = [r for r in rows if 'AlphaMissense comparison' in r]
    assert len(am) == 1, 'no Methods row for the AlphaMissense comparison'
    cells = [re.sub(r'<[^>]+>', '', c).strip() for c in re.findall(r'<td[^>]*>(.*?)</td>', am[0], re.S)]
    assert cells[1] == '276'
    assert 'GPR3, GPR4 and XCR1.' in cells[3]
    assert 'ACKR5 (GP182), NPY6R, P2RY8 and TAAR3: no records in that query.' in cells[3]
    v = [r for r in rows if 'Variants at each top-ranked position' in r]
    assert len(v) == 1 and 'NPY6R and TAAR3: no protein-coding missense records' in v[0]


@needs_build
def test_gp182_and_p2ry8_appear_only_in_the_methods_row():
    html = STATS.read_text(encoding='utf-8')
    text = _text()
    for name in UNRESOLVED:
        assert text.count(name) == 1, (name, text.count(name))
    row = re.search(r'<tr><td>AlphaMissense comparison.*?</tr>', html, re.S).group(0)
    assert all(n in row for n in UNRESOLVED)


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
