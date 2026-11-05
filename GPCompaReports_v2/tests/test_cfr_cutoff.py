"""The number a reader sees and the number the statistics come from must match.

The statistics page used to carry two different ranked claims at once. The
chart and the ranked table showed the top 30 positions, while the contact
network and the variant-enrichment test were computed from the top 50. So a
table headed "Top 30" sat directly above a table built from positions ranked
as low as 50, and the published chi-squared and p-value came from a subset
the page never displayed.

That is now one constant, CFR_TOP_N, read by the chart, the ranked table, the
contact network, the enrichment analysis and the landing-page link. These
tests fail if any of them drifts away from it.

The cutoff is 50 because that is what the manuscript's variant-enrichment
analysis uses. It is a reporting threshold and not a definition: a position
ranked below it still meets the CFR criterion.
"""
import os
import pathlib
import re

import pandas as pd
import pytest

from GPCompaReports_v2.analysis.cfr_analysis import CFR_TOP_N, build_cfr_network
from GPCompaReports_v2.analysis.variant_correlation import _get_cfr_position_map

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / BUILD_DIR
else:
    BUILD_DIR = BASE / 'output_v3_demo'

STATS = BUILD_DIR / 'statistics.html'
LANDING = BUILD_DIR / 'index.html'

needs_build = pytest.mark.skipif(
    not STATS.exists(),
    reason='no built statistics page at %s; run scripts/build_demo.sh' % STATS)


def _table_after(html, heading_fragment):
    """The <tbody> of the first table whose toolbar contains the fragment."""
    idx = html.find(heading_fragment)
    assert idx != -1, 'no table heading containing %r' % heading_fragment
    body = re.search(r'<tbody>(.*?)</tbody>', html[idx:], re.S)
    assert body, 'no table body after %r' % heading_fragment
    return body.group(1)


# ---------------------------------------------------------------------------
# the analytical side
# ---------------------------------------------------------------------------

class _FakeStore:
    """Enough of a store to drive the selection logic, and nothing more."""

    def __init__(self, n_positions):
        self.gpcr_ids = ['fake_human']
        self._annot = {
            i: {'display_number': 'gn%d' % i, 'protein_segment': 'TM1'}
            for i in range(n_positions)
        }
        self.significant_data = {'fake_human': pd.DataFrame()}
        self.variant_data = {}

    def get_annotation_map(self, gid):
        return self._annot


def _ranked_table(n_rows):
    return pd.DataFrame({
        'generic_number': ['gn%d' % i for i in range(n_rows)],
        'rank': list(range(1, n_rows + 1)),
    })


def test_the_enrichment_analysis_selects_exactly_the_shared_cutoff():
    """The comparison group in the published chi-squared test is defined by
    this selection, so it is the one that must not drift.
    """
    store = _FakeStore(CFR_TOP_N + 25)
    selected = _get_cfr_position_map(store, _ranked_table(CFR_TOP_N + 25))
    assert len(selected['fake_human']) == CFR_TOP_N, (
        'the enrichment analysis selected %d positions, not CFR_TOP_N (%d)'
        % (len(selected['fake_human']), CFR_TOP_N))


def test_the_contact_network_selects_exactly_the_shared_cutoff():
    store = _FakeStore(CFR_TOP_N + 25)
    ranked = _ranked_table(CFR_TOP_N + 25)
    # An empty significant_data means no pairs, but the selection still has to
    # be built from the right subset, so assert on the ranked input instead:
    # a pair is only counted when BOTH generic numbers are in the cut.
    network = build_cfr_network(store, ranked)
    assert network.empty, 'fixture has no contacts, so no pairs should appear'
    # Guard the literal directly: this is the line that silently said 50 while
    # the page said 30.
    src = (BASE / 'analysis' / 'cfr_analysis.py').read_text(encoding='utf-8')
    assert 'cfr_table.head(CFR_TOP_N)' in src, (
        'build_cfr_network no longer truncates with the shared constant')


def test_no_hardcoded_ranked_cutoff_survives_in_the_analysis_layer():
    """A bare head(30) or head(50) on the ranked table is how these drifted
    apart the first time.
    """
    offenders = []
    for rel in ('analysis/cfr_analysis.py',
                'analysis/variant_correlation.py',
                'website/page_generators/statistics_page.py'):
        src = (BASE / rel).read_text(encoding='utf-8')
        for m in re.finditer(r'cfr_table\.head\((\d+)\)', src):
            offenders.append('%s: cfr_table.head(%s)' % (rel, m.group(1)))
    assert not offenders, (
        'ranked CFR cutoff hardcoded instead of using CFR_TOP_N: %s' % offenders)


# ---------------------------------------------------------------------------
# the displayed side
# ---------------------------------------------------------------------------

@needs_build
def test_the_ranked_table_shows_exactly_the_analytical_cutoff():
    html = STATS.read_text(encoding='utf-8')
    body = _table_after(html, 'Core Functional Residue Positions')
    rows = len(re.findall(r'<tr>', body))
    assert rows == CFR_TOP_N, (
        'the ranked CFR table displays %d positions but the analysis uses the '
        'top %d' % (rows, CFR_TOP_N))


@needs_build
def test_the_heading_states_the_analytical_cutoff():
    html = STATS.read_text(encoding='utf-8')
    assert 'Top %d Core Functional Residue Positions' % CFR_TOP_N in html, (
        'the ranked table heading does not state Top %d' % CFR_TOP_N)


@needs_build
def test_the_landing_link_states_the_same_cutoff():
    html = LANDING.read_text(encoding='utf-8')
    assert 'See the %d top-ranked class-wide CFR positions' % CFR_TOP_N in html, (
        'the landing page links to the ranked list with a different cutoff '
        'than the analysis uses (%d)' % CFR_TOP_N)


@needs_build
def test_no_stale_cutoff_number_appears_anywhere_on_the_statistics_page():
    """Catches a heading, tooltip or caption left behind at the old number."""
    html = STATS.read_text(encoding='utf-8')
    stale = re.findall(r'[Tt]op (\d+) (?:Core Functional|recurrent CFR)', html)
    wrong = sorted({n for n in stale if int(n) != CFR_TOP_N})
    assert not wrong, (
        'the statistics page still states cutoff(s) %s while the analysis '
        'uses %d' % (wrong, CFR_TOP_N))


@needs_build
def test_positions_below_the_cutoff_are_not_called_non_cfrs():
    """They are CFRs. They rank below the reporting cutoff, which is not the
    same claim, and the page must not make the stronger one.
    """
    html = STATS.read_text(encoding='utf-8')
    bad = re.findall(r'[Nn]on-CFR', html)
    assert not bad, (
        'the statistics page calls positions outside the top %d "non-CFR" '
        '(%d occurrences). Use "positions outside the top %d recurrent CFR '
        'positions".' % (CFR_TOP_N, len(bad), CFR_TOP_N))


@needs_build
def test_the_network_table_says_what_it_contains_and_how_much_it_shows():
    html = STATS.read_text(encoding='utf-8')
    assert 'both residues are among the %d highest-ranked' % CFR_TOP_N in html, (
        'the contact-pair table does not state that both residues come from '
        'the top %d' % CFR_TOP_N)
    assert re.search(r'Showing the \d+ highest-ranked pairs,\s+ranked across '
                     r'[\d,]+ unique contact pairs', html), (
        'the contact-pair table does not say how many pairs it shows, out of '
        'how large a pair universe')
