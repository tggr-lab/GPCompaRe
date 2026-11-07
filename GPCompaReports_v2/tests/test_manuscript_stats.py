"""The statistics page must report the submitted manuscript results.

The site cannot reproduce the manuscript's cross-receptor recurrence by
recomputation. Its per-receptor annotation files number a residue only when it
took part in a high-magnitude contact, so a site recomputation gives 356
recurrent positions and 3.50x50 in 261 receptors, while the submitted analysis,
run on the full GPCRdb residue maps, gives 368 and 274. The statistics page
therefore reads the submitted tables from data/manuscript_2026-08-24/.

These tests pin the page to those tables, and pin the superseded numbers out.
Report pages are covered separately by test_freeze.py and must not change.
"""
import json
import os
import pathlib
import re

import pytest

from GPCompaReports_v2.analysis.cfr_analysis import CFR_TOP_N
from GPCompaReports_v2.analysis.manuscript_stats import (
    DATA_DIR, load_manuscript_stats)

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

SUPERSEDED_SITE_COMPUTED = 356
EXPECTED_RECURRENT = 368
EXPECTED_TOP_POSITION = ('3.50x50', 274)


# ---------------------------------------------------------------------------
# the data itself
# ---------------------------------------------------------------------------

def test_the_manuscript_tables_are_committed_not_external():
    """The build must never depend on a removable volume or a Downloads folder."""
    for name in ('S3_top50_recurrent_cfr_positions.csv',
                 'S4_all_recurrent_positions.csv',
                 'S5_top20_recurrent_cfr_pairs.csv',
                 'figure3_enrichment.json',
                 'PROVENANCE.md'):
        assert (DATA_DIR / name).is_file(), (
            '%s is missing from %s' % (name, DATA_DIR))
    assert 'GPCompaReports_v2' in str(DATA_DIR), (
        'the manuscript data must live inside the site, not outside it')


def test_the_loader_reports_the_submitted_counts():
    m = load_manuscript_stats()
    assert m['n_recurrent_positions'] == EXPECTED_RECURRENT
    assert len(m['top50']) == CFR_TOP_N
    gn, n = EXPECTED_TOP_POSITION
    first = m['top50'].iloc[0]
    assert str(first['generic_number']) == gn
    assert int(first['n_receptors']) == n


def test_no_source_path_outside_the_repo_is_read_at_build_time():
    """Provenance may name where the workbook came from; code may not read it."""
    src = (BASE / 'analysis' / 'manuscript_stats.py').read_text(encoding='utf-8')
    for bad in ('/media/', '/mnt/', 'Downloads', 'C:\\\\'):
        assert bad not in src, (
            'analysis/manuscript_stats.py references %r, so the build would '
            'depend on a location outside the repository' % bad)


# ---------------------------------------------------------------------------
# the rendered page
# ---------------------------------------------------------------------------

@needs_build
def test_the_page_states_the_submitted_recurrent_position_count():
    html = STATS.read_text(encoding='utf-8')
    assert str(EXPECTED_RECURRENT) in html, (
        'the statistics page does not state the submitted count of %d '
        'recurrent positions' % EXPECTED_RECURRENT)


@needs_build
def test_the_superseded_site_computed_count_is_gone():
    """356 is the site's own recomputation, superseded by the submitted 368."""
    for page, path in (('statistics', STATS), ('landing', LANDING)):
        html = path.read_text(encoding='utf-8')
        hits = re.findall(r'(?<![\d.,])%d(?![\d.,]*\d)' % SUPERSEDED_SITE_COMPUTED,
                          html)
        assert not hits, (
            'the %s page still shows the superseded site-computed count %d '
            '(%d occurrences)' % (page, SUPERSEDED_SITE_COMPUTED, len(hits)))


@needs_build
def test_the_top50_table_matches_the_submitted_ordering_exactly():
    html = STATS.read_text(encoding='utf-8')
    idx = html.find('Core Functional Residue Positions')
    assert idx != -1, 'ranked table heading not found'
    body = re.search(r'<tbody>(.*?)</tbody>', html[idx:], re.S).group(1)
    rendered = re.findall(
        r'<td class="num">(\d+)</td>\s*<td><strong>([^<]+)</strong></td>', body)
    submitted = load_manuscript_stats()['top50']
    assert len(rendered) == len(submitted) == CFR_TOP_N, (
        'ranked table shows %d rows, submitted table has %d'
        % (len(rendered), len(submitted)))
    for i, (rank, gn) in enumerate(rendered):
        exp_rank = int(submitted.iloc[i]['cfr_score_rank'])
        exp_gn = str(submitted.iloc[i]['generic_number'])
        assert int(rank) == exp_rank and gn == exp_gn, (
            'row %d shows rank %s %s, submitted has rank %d %s. The page must '
            'preserve the submitted ordering.'
            % (i + 1, rank, gn, exp_rank, exp_gn))


@needs_build
def test_the_pair_table_matches_the_submitted_pairs():
    html = STATS.read_text(encoding='utf-8')
    idx = html.find('CFR contact pairs')
    body = re.search(r'<tbody>(.*?)</tbody>', html[idx:], re.S).group(1)
    rendered = re.findall(
        r'<td><strong>([^<]+)</strong></td>\s*<td><strong>([^<]+)</strong></td>'
        r'\s*<td class="num">(\d+)</td>', body)
    submitted = load_manuscript_stats()['pairs']
    assert len(rendered) == len(submitted), (
        'pair table shows %d rows, submitted has %d' % (len(rendered), len(submitted)))
    for i, (a, b, n) in enumerate(rendered):
        row = submitted.iloc[i]
        assert (a, b, int(n)) == (str(row['cfr_1']), str(row['cfr_2']),
                                  int(row['n_receptors'])), (
            'pair row %d is %s-%s (%s), submitted has %s-%s (%s)'
            % (i + 1, a, b, n, row['cfr_1'], row['cfr_2'], row['n_receptors']))


@needs_build
def test_the_enrichment_values_match_the_corrected_supplement():
    """Section D reads the corrected supplement summary (data/supplement_2026-11-05b/), not the
    retired August figure3_enrichment.json. Full checks: tests/test_statistics_am_section.py."""
    from GPCompaReports_v2.analysis.manuscript_stats import load_am_comparison
    html = STATS.read_text(encoding='utf-8')
    am = load_am_comparison()
    required = [
        '%.1f%%' % am['decisive_pct']['top'],
        '%.1f%%' % am['decisive_pct']['other'],
        format(am['groups'][0]['n'], ','),
        format(am['groups'][1]['n'], ','),
    ]
    for value in required:
        assert value in html, (
            'the enrichment section does not show %s from the corrected summary' % value)


@needs_build
def test_the_superseded_enrichment_statistics_are_gone():
    """The published analysis is an odds ratio on decisive predictions. The
    site's own chi-square used a different contingency table and must not
    appear beside it.
    """
    html = STATS.read_text(encoding='utf-8')
    for bad in ('1,179.82', '1179.82', '1,228.22', '1228.22',
                '56.72', '29.72', '56.55', '29.94', '1.89-fold', '1.91-fold'):
        assert bad not in html, (
            'the statistics page still shows the superseded enrichment value %r'
            % bad)


@needs_build
def test_no_non_cfr_label_on_either_page():
    for page, path in (('statistics', STATS), ('landing', LANDING)):
        html = path.read_text(encoding='utf-8')
        hits = re.findall(r'[Nn]on-CFR', html)
        assert not hits, (
            'the %s page uses the withdrawn "non-CFR" label (%d occurrences). '
            'The published comparison group is other generic-numbered positions.'
            % (page, len(hits)))


@needs_build
def test_the_page_says_where_the_cross_receptor_numbers_come_from():
    html = STATS.read_text(encoding='utf-8')
    assert 'full GPCRdb residue maps' in html, (
        'the statistics page does not explain that cross-receptor recurrence '
        'uses the full GPCRdb residue maps')
    assert 'Individual receptor reports are unchanged' not in html   # process history, not page content


@needs_build
def test_no_hybrid_per_variant_table_is_presented():
    """The published enrichment result is an aggregate.

    A per-variant listing here could only be the site's own variant data
    filtered by a manuscript-defined position set. The submission carries no
    family-wide table of the variants behind Figure 3: its per-variant tables
    (S14, S15) are PAR-specific. So the page shows no such table rather than
    showing a mixed-provenance one with a disclaimer.
    """
    html = STATS.read_text(encoding='utf-8')
    for marker in ('High-impact pathogenic variants',
                   'highest-impact variants'):
        assert marker not in html, (
            'the statistics page presents a per-variant table (%r) that no '
            'submitted table backs' % marker)
    # The aggregate class comparison must still be there, so this cannot pass by the
    # whole variant section having been dropped; it shows counts, not a test statistic.
    assert 'chart-pathogenicity' in html and 'decisive' in html
    assert 'odds ratio' not in html.lower()


@needs_build
def test_the_methods_note_states_the_generic_numbering_limitation():
    """The scope limit has to be stated, not left to be inferred.

    Saying that mapping "needs a GPCRdb number" describes the mechanism. It
    does not tell a reader that residues without one, in loops and terminal
    regions, are absent from every number on this page.
    """
    html = STATS.read_text(encoding='utf-8')
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text)
    assert ('Cross-receptor recurrence analyses are limited to residues '
            'assigned GPCRdb generic numbers.') in text, (
        'the statistics methods note does not state that cross-receptor '
        'recurrence is limited to residues with GPCRdb generic numbers')
