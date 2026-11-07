"""Statistics page, section D: the corrected AlphaMissense comparison.

Section D must show the supplement's corrected analysis (Fig. S4, Fig. S5, Table S7, edition 2026-11-05b:
276 receptors, alleles on model residue numbering, four OXER1 classes corrected), read from
data/supplement_2026-11-05b/, never the retired August figure3_enrichment.json (279 receptors, OR 2.58,
adjusted 1.52, 7,445 vs 11,150). Every number on the page must equal the corrected summary rounded once.
"""
import hashlib
import json
import os
import pathlib
import re

import pytest

from GPCompaReports_v2.analysis.cfr_analysis import CFR_TOP_N
from GPCompaReports_v2.analysis.manuscript_stats import (
    AM_SUMMARY_JSON, AM_GROUP_LABELS, AM_TRACE_NAMES, load_am_comparison, load_manuscript_stats)

BASE = pathlib.Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
BUILD_DIR = (pathlib.Path(_env).expanduser() if _env else BASE / 'output_v3_demo')
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR
STATS = BUILD_DIR / 'statistics.html'
needs_build = pytest.mark.skipif(not STATS.exists(), reason='no built statistics page at %s' % STATS)

SUMMARY_SHA256 = 'd2e15f4a5da571704a8769bdc3d1cd0be10dcd0c57fed7865fef7ab5fec281bc'
SUPPLEMENT_COPY = pathlib.Path(
    '/home/yamir/Documents/gpcr_synth/NEW_manuscript/GPCompaRe_Finishing_2026-10-31/deliverables/'
    '02_supplement/source_tables/FigS4_S7_summary_modelnum_2026-11-05b.json')

INTRO = ('AlphaMissense predicted class of the missense substitutions seen in gnomAD, at the 50 CFR positions '
         'and at other generic-numbered positions. Predictions, not clinical evidence.')
RETIRED = ('2.58', '1.52', '7,445', '11,150', '6,312', '9,461', '67.0%', '44.1%', '2.42 to 2.76',
           '1.41 to 1.65', 'most recurrent', '279 receptors')


def _section_d(html):
    """Section D up to the conservation chart: the AlphaMissense part (the conservation chart below it uses the
    site's own 279-receptor variant layer and says so in its own fine print)."""
    start = html.index('id="sec-d"')
    end = html.index('</section>', start)
    cons = html.find('id="chart-conservation"', start, end)
    return html[start:cons if cons != -1 else end]


def _text(fragment):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', fragment)).strip()


# ---------------------------------------------------------------------------- the data
def test_summary_is_the_committed_supplement_copy():
    assert hashlib.sha256(AM_SUMMARY_JSON.read_bytes()).hexdigest() == SUMMARY_SHA256
    if SUPPLEMENT_COPY.is_file():   # on machines with the paper package: the copy is the supplement's file
        assert SUPPLEMENT_COPY.read_bytes() == AM_SUMMARY_JSON.read_bytes()


def test_loader_gives_the_corrected_numbers_at_full_precision():
    am = load_am_comparison()
    assert am['receptors'] == 276
    assert am['cells'] == [4117, 2038, 4085, 5284]
    top, rest = am['groups']
    assert (top['label'], rest['label']) == AM_GROUP_LABELS == ('Top 50 positions by CFR score',
                                                                'Other generic-numbered positions')
    assert (top['n'], rest['n']) == (7268, 11040)
    assert (top['decisive'], rest['decisive']) == (6155, 9369)
    assert (top['ambiguous_n'], rest['ambiguous_n']) == (1113, 1671)
    assert am['conservation_adjusted'] == pytest.approx([1.541756483, 1.424849004, 1.668256108], abs=1e-9)
    assert am['odds_ratio'] == pytest.approx([4117 * 5284 / (2038 * 4085), 2.443773459, 2.794048414], abs=1e-9)
    # stored unrounded: a stored 1.425 would display as 1.43, the CI is 1.4248
    assert am['conservation_adjusted'][1] != round(am['conservation_adjusted'][1], 3)


def test_section_d_no_longer_reads_the_retired_figure3_values():
    m = load_manuscript_stats()
    assert 'figure3' not in m and m['am_comparison'] == load_am_comparison()
    fig = m['fig_enrichment_bar']
    assert [t.name for t in fig.data] == ['Predicted pathogenic', 'Ambiguous', 'Predicted benign']
    assert list(fig.data[0].x) == ['Top 50 positions by CFR score<br>n = 7,268 scored, 6,155 decisive',
                                   'Other generic-numbered positions<br>n = 11,040 scored, 9,369 decisive']
    assert list(fig.data[1].customdata) == [1113, 1671]


# ---------------------------------------------------------------------------- the built page
@needs_build
def test_section_d_shows_the_class_counts_and_no_test_statistic():
    """Section D shows the class shares and counts of the summary, rounded once, and no odds ratio, interval
    or paper wording (owner, 2026-11-07: the page is a database, not a restatement of the paper)."""
    am = load_am_comparison()
    d = _text(_section_d(STATS.read_text(encoding='utf-8')))
    assert INTRO in d
    assert ('Among decisive calls (pathogenic or benign), %.1f%% at the top positions and %.1f%% at other '
            'generic-numbered positions are predicted pathogenic.'
            % (am['decisive_pct']['top'], am['decisive_pct']['other'])) in d
    assert '66.9% at the top positions' in d and '43.6% at other' in d
    for g in am['groups']:
        line = ('%s: %s scored substitutions, %s decisive (%s predicted pathogenic, %s predicted benign) and %s '
                'ambiguous.' % (g['label'], format(g['n'], ','), format(g['decisive'], ','),
                                format(g['pathogenic_n'], ','), format(g['benign_n'], ','),
                                format(g['ambiguous_n'], ',')))
        assert line in d, line
    low = d.lower()
    for bad in ('odds ratio', '95% ci', 'mantel', 'paper', 'supplementary', 'manuscript', 'corrected',
                'mismatched', 'site layer'):
        assert bad not in low, bad
    assert 'id="am-comparison"' not in STATS.read_text(encoding='utf-8')


@needs_build
def test_section_d_carries_no_retired_value():
    html = STATS.read_text(encoding='utf-8')
    d = _text(_section_d(html))
    for bad in RETIRED:
        assert bad not in d, 'section D still shows the retired value %r' % bad
    assert '1.43' not in d, 'double rounding: the adjusted CI starts at 1.4248, it must display as 1.42'


@needs_build
def test_the_chart_data_equal_the_summary():
    html = STATS.read_text(encoding='utf-8')
    j = re.search(r"\['chart-pathogenicity'\] = (\{.*?\});\n", html, re.S)
    assert j, 'chart-pathogenicity data not found'
    fig = json.loads(j.group(1))
    am = load_am_comparison()
    by = {t['name']: t for t in fig['data']}
    for cls, name in AM_TRACE_NAMES.items():
        assert by[name]['y'] == pytest.approx([g[cls.lower()] for g in am['groups']], abs=1e-12)
        assert by[name]['customdata'] == [g[cls.lower() + '_n'] for g in am['groups']]
    assert 'most recurrent' not in fig['layout']['title']['text']
    assert 'odds ratio' not in fig['layout']['title']['text']
