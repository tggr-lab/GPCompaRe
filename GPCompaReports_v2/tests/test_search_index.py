"""The Browse page's variant and position search reads a static index the
generator writes to <build>/search/. These tests check that index against the
report pages it points at: an allele found by search must carry exactly the
strings the receptor's own variant table shows, gaps included.

Like the other build-reading suites, they read FREEZE_BUILD_DIR (default
output_v3_demo) and skip when there is no build.
"""
import json
import os
import pathlib
import re

import pytest

from GPCompaReports_v2.website.page_generators.gpcr_report_helpers import _parse_rsid_list

BASE = pathlib.Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

SEARCH = BUILD_DIR / 'search'
needs_index = pytest.mark.skipif(
    not (SEARCH / 'meta.json').exists(), reason='no search index at %s' % SEARCH)


def _load(rel):
    return json.loads((SEARCH / rel).read_text(encoding='utf-8'))


def test_rsid_list_parsing():
    assert _parse_rsid_list("['rs115885685']") == ['rs115885685']
    assert _parse_rsid_list("['rs1', 'rs22']") == ['rs1', 'rs22']
    assert _parse_rsid_list('[]') == []
    assert _parse_rsid_list(float('nan')) == []


@needs_index
def test_index_covers_every_receptor():
    meta = _load('meta.json')
    assert len(meta['receptors']) == 283
    for i in meta['with_variants']:
        gid = meta['receptors'][i][0]
        assert (SEARCH / 'variants' / ('%s.json' % gid)).exists(), gid


@needs_index
def test_par2_m159i_is_indexed_as_the_report_shows_it():
    shard = _load('variants/par2_human.json')
    assert shard['res']['159'] == ['M', '3.36x36', 'TM3']
    rows = [r for r in shard['v'] if r[1] == 'p.Met159Ile']
    assert sorted(r[3] for r in rows) == ['5-76833084-G-A', '5-76833084-G-T']
    for r in rows:
        assert r[10] == ['rs115885685']
        # Each allele carries its own AlphaMissense score (the batch CSV left these
        # empty, the per-position join gap fixed by the 2026-11-05 refresh).
        assert r[7] == '0.910' and r[8] == 'PATHOGENIC' and r[9] != '-'

    report = BUILD_DIR / 'reports' / 'par2_human.html'
    if report.exists():
        html = report.read_text(encoding='utf-8')
        table = html[html.find('id="variants-table"'):]
        table = table[:table.find('</table>')]
        for r in rows:
            m = re.search(r'<tr>\s*<td class="num"><strong>159</strong></td>\s*<td>p\.Met159Ile</td>\s*'
                          r'<td class="mono">%s</td>\s*<td class="num">([^<]*)</td>' % re.escape(r[2]), table)
            assert m, r[2]
            assert m.group(1) == r[4], (r[2], m.group(1), r[4])


@needs_index
def test_rsid_and_gnomad_lookups_reach_par2():
    meta = _load('meta.json')
    par2 = [r[0] for r in meta['receptors']].index('par2_human')
    assert par2 in _load('rsid/85.json')['115885685']
    assert any(lo <= 76833084 <= hi and i == par2 for lo, hi, i in meta['gnomad_ranges']['5'])


@needs_index
def test_position_index_uses_full_gpcrdb_numbering():
    meta = _load('meta.json')
    par2 = [r[0] for r in meta['receptors']].index('par2_human')
    entries = _load('positions/6.json')['6.48x48']
    hit = [e for e in entries if e[0] == par2]
    assert hit and hit[0][1] == 300 and hit[0][2] == 'F'
    # Far more receptors than the partial annotation table could number.
    assert len(entries) > 250


def test_snapshot_matches_the_database_numbering_not_live_gpcrdb():
    """GPCRdb now serves MCHR1 as a 353-residue isoform (3.50x50 = R141). The
    database and its approved snake plot use the 422-residue numbering."""
    snap = json.loads((BASE / 'data' / 'snake_numbering.json').read_text(encoding='utf-8'))
    rows = {gn: (seq, aa) for seq, aa, gn in snap['receptors']['mchr1_human']}
    assert rows['3.50x50'] == (210, 'R')
    assert rows['6.48x48'] == (338, 'W')
    assert len(snap['receptors']) == 283
