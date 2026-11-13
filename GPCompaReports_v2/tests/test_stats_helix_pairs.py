"""Helix-pair rewiring atlas of the Statistics page (site layer): totals equal the source, all 283
receptors, the report's own threshold rule, helices-first segment order including ICL4."""
import json
import math

import numpy as np
import pandas as pd
import pytest

from GPCompaReports_v2.analysis import class_atlas as ca
from GPCompaReports_v2.analysis import tm_domain_analysis as tm
from GPCompaReports_v2.website.page_generators.report_extras import HELICES_FIRST_ORDER

from .stats_data import real_data

N_RECEPTORS = 283
N_PAIRS = 213456
N_ABOVE = 23025


@pytest.fixture(scope='module')
def data():
    return real_data()


@pytest.fixture(scope='module')
def hp(data):
    return data[1]['payloads']['helix_pairs']


@pytest.fixture(scope='module')
def cells(data):
    return data[1]['payloads']['helix_pair_cells']


def _cell(group, a, b, hp):
    segs = hp['segments']
    i, j = sorted((segs.index(a), segs.index(b)))
    cols = hp['summary_columns']
    row = next(c for c in group['cells'] if c[0] == i and c[1] == j)
    return dict(zip(cols, row))


def test_threshold_is_the_report_rule(data):
    from GPCompaReports_v2.website.page_generators.gpcr_report_helpers import _calc_significance_threshold
    store = data[0]
    for gid in store.gpcr_ids:
        d = store.delta_data[gid]
        assert ca.receptor_threshold(d) == _calc_significance_threshold(d), gid


def test_segments_helices_first_with_icl4(hp):
    assert hp['segments'] == list(HELICES_FIRST_ORDER)
    assert 'ICL4' in hp['segments']
    assert hp['n_helices'] == 8
    assert hp['segments'][:8] == ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']


def test_all_receptors_and_groups(hp):
    assert hp['meta']['n_receptors'] == N_RECEPTORS
    assert len(hp['receptors']) == N_RECEPTORS
    assert hp['groups'][0]['key'] == 'all' and hp['groups'][0]['n'] == N_RECEPTORS
    assert sum(g['n'] for g in hp['groups'][1:]) == N_RECEPTORS
    assert 'layer' not in hp['meta']


def test_every_above_threshold_pair_is_counted_once(hp):
    assert hp['n_pairs_mapped'] + hp['n_pairs_unmapped'] == N_ABOVE
    k = hp['summary_columns'].index('n_pairs')
    for g in hp['groups']:
        if g['key'] == 'all':
            assert sum(c[k] for c in g['cells']) == hp['n_pairs_mapped']
    # the ligand groups partition the class
    assert sum(c[k] for g in hp['groups'][1:] for c in g['cells']) == hp['n_pairs_mapped']


def test_cell_counts_equal_the_sum_over_receptors(hp, cells):
    cols = hp['summary_columns']
    allg = hp['groups'][0]
    by_ij = {(c['i'], c['j']): c['receptors'] for c in cells['cells']}
    assert set(by_ij) == {(c[0], c[1]) for c in allg['cells']}
    for row in allg['cells']:
        s = dict(zip(cols, row))
        recs = by_ij[(s['i'], s['j'])]
        assert s['n_present'] == len(recs)
        assert s['n_pairs'] == sum(r[4] for r in recs)
        assert s['n_up'] == sum(1 for r in recs if r[1] > 0)
        assert s['n_down'] == sum(1 for r in recs if r[1] < 0)
        assert s['n_up'] + s['n_down'] <= s['n_present']
        assert math.isclose(s['coverage'], s['n_present'] / N_RECEPTORS, abs_tol=5e-4)
        # mean over all 283 (receptors without a pair count 0)
        assert math.isclose(s['mean_net'], sum(r[1] for r in recs) / N_RECEPTORS, abs_tol=1e-3)
        for r in recs:
            assert math.isclose(r[1], r[2] + r[3], abs_tol=0.0015)
            assert r[2] >= 0 >= r[3]
    # per-group present counts add up to the class count
    kp = cols.index('n_present')
    for row in allg['cells']:
        parts = [c[kp] for g in hp['groups'][1:] for c in g['cells'] if (c[0], c[1]) == (row[0], row[1])]
        assert sum(parts) == row[kp]


def test_cell_totals_equal_the_batch_rows(data, hp):
    """Recompute TM3 to TM6 straight from the delta CSVs and the packs."""
    store = data[0]
    from GPCompaReports_v2.analysis import pack_layer
    total, present = 0.0, 0
    for gid in store.gpcr_ids:
        d = store.delta_data[gid]
        t = ca.receptor_threshold(d)
        sig = d[d['delta_rrcs'].abs() >= t]
        seg = {int(r[0]): r[2] for r in pack_layer.load_pack(gid)['residues']}
        m = [{seg.get(int(a)), seg.get(int(b))} == {'TM3', 'TM6'} for a, b in zip(sig['res1'], sig['res2'])]
        if any(m):
            present += 1
            total += float(sig['delta_rrcs'][m].sum())
    c = _cell(hp['groups'][0], 'TM3', 'TM6', hp)
    assert c['n_present'] == present
    assert math.isclose(c['mean_net'], total / N_RECEPTORS, abs_tol=1e-3)


def test_class_direction_pins(hp):
    """The mockup's reading of the class: TM3 to TM6 loses, TM3 to TM7 gains."""
    g = hp['groups'][0]
    c36, c37 = _cell(g, 'TM3', 'TM6', hp), _cell(g, 'TM3', 'TM7', hp)
    assert c36['mean_net'] == pytest.approx(-5.90, abs=0.01) and c36['agree'] == pytest.approx(0.795, abs=1e-3)
    assert c37['mean_net'] == pytest.approx(4.667, abs=1e-3) and c37['agree'] == pytest.approx(0.937, abs=1e-3)


def test_matrix_blanks_small_cells(hp):
    segs, z, present = tm.helix_pair_matrix(hp, 'mean_net')
    assert segs == hp['segments'][:8] and len(z) == 8 and all(len(r) == 8 for r in z)
    for i in range(8):
        for j in range(8):
            assert z[i][j] == z[j][i]
            if present[i][j] < hp['min_receptors']:
                assert z[i][j] is None
    segs, z, _ = tm.helix_pair_matrix(hp, 'coverage', helices_only=False)
    assert len(segs) == len(HELICES_FIRST_ORDER)


def test_figures(hp):
    f = tm.fig_helix_pair_signed(hp)
    assert list(f.data[0].x) == hp['segments'][:8]
    assert f.data[0].zmid == 0
    assert f.data[0].colorscale[0][1] == tm.INACTIVE_BLUE and f.data[0].colorscale[-1][1] == tm.ACTIVE_RED
    f = tm.fig_helix_pair_coverage(hp, group=hp['groups'][1]['key'])
    assert 'n = %d' % hp['groups'][1]['n'] in f.layout.title.text


def test_written_files(data, tmp_path):
    files = ca.write_stats_data(data[1], tmp_path)
    root = tmp_path / 'data' / 'stats'
    for name in ('overview', 'helix_pairs', 'helix_pair_cells', 'helix_receptor_cells', 'cfr_atlas', 'receptors',
                 'class_scale', 'class_positions', 'class_variants', 'manifest'):
        assert (root / ('%s.json' % name)).is_file()
    assert not (root / 'figures').exists(), 'figures/*.json are no longer written'
    manifest = json.loads((root / 'manifest.json').read_text())
    assert {f['path'] for f in manifest['files']} | {'data/stats/manifest.json'} == set(files)
    assert not any('figures/' in p for p in files)
    for p, b in files.items():
        assert (tmp_path / p).stat().st_size == b
    csv = pd.read_csv(root / 'helix_pairs.csv')
    assert csv[csv['group'] == 'all']['above_threshold_pairs'].sum() == N_ABOVE


def test_hook_caches_and_returns_urls(data, tmp_path):
    results = {'class_atlas': data[1]}
    out = ca.stats_data_for_page(data[0], results, tmp_path)
    assert out['urls']['helix_pairs'] == 'data/stats/helix_pairs.json'
    assert out['urls']['helix_receptor_cells'] == 'data/stats/helix_receptor_cells.json'
    assert not any('figures' in u for u in out['urls'].values())
    assert out['payloads'] is data[1]['payloads']


def test_interfaces_magnitude(hp):
    """Mean |ΔRRCS| per contact between two helices, all contacts: TM3-TM6 and TM5-TM6 1.42, TM3-TM7 1.31."""
    by = {(x['seg_i'], x['seg_j']): x for x in hp['interfaces']}
    assert len(by) == 21
    assert (by[('TM3', 'TM6')]['mean_abs_delta'], by[('TM3', 'TM6')]['n_contacts']) == (1.4184, 4921)
    assert (by[('TM5', 'TM6')]['mean_abs_delta'], by[('TM5', 'TM6')]['n_contacts']) == (1.416, 11850)
    assert (by[('TM3', 'TM7')]['mean_abs_delta'], by[('TM3', 'TM7')]['n_contacts']) == (1.3069, 2452)
    sup = [x for x in hp['interfaces'] if x['supported']]
    assert len(sup) == 14 and all(x['n_contacts'] >= 50 for x in sup)
    assert all(x['n_contacts'] < 50 for x in hp['interfaces'] if not x['supported'])
    lead = sorted(sup, key=lambda x: -x['mean_abs_delta'])[:3]
    assert [(x['seg_i'], x['seg_j'], round(x['mean_abs_delta'], 2)) for x in lead] == [
        ('TM3', 'TM6', 1.42), ('TM5', 'TM6', 1.42), ('TM3', 'TM7', 1.31)]


def test_segments_magnitude(hp):
    """Mean |ΔRRCS| per contact endpoint by segment: TM1 0.745 to H8 1.213; loops and termini 1.06 to 1.23."""
    by = {x['segment']: x for x in hp['segments_magnitude']}
    want = {'TM1': 0.745, 'TM2': 0.797, 'TM3': 0.921, 'TM4': 0.739, 'TM5': 0.979, 'TM6': 1.126, 'TM7': 1.075,
            'H8': 1.213}
    assert {k: round(by[k]['mean_abs_delta'], 3) for k in want} == want
    assert all(by[k]['block'] == 'Helices' for k in want)
    loops = [x['mean_abs_delta'] for x in hp['segments_magnitude'] if x['block'] == 'Loops and termini']
    assert len(loops) == 8 and (round(min(loops), 2), round(max(loops), 2)) == (1.06, 1.23)
    assert sum(x['endpoints'] for x in hp['segments_magnitude']) == 426877


def test_direction_pins(hp):
    """TM3-TM6 weaker in the active model (mean net −5.90, 79.5% agree), TM3-TM7 stronger (+4.667, 93.7%)."""
    allg = next(g for g in hp['groups'] if g['key'] == 'all')
    c36 = _cell(allg, 'TM3', 'TM6', hp)
    c37 = _cell(allg, 'TM3', 'TM7', hp)
    assert (round(c36['mean_net'], 2), round(100 * c36['agree'], 1), c36['n_down'], c36['n_present']) == (-5.9, 79.5, 210, 264)
    assert (round(c37['mean_net'], 3), round(100 * c37['agree'], 1), c37['n_up'], c37['n_present']) == (4.667, 93.7, 208, 222)


def test_helix_receptor_cells(data, hp, cells):
    """283 rows x 36 helix cells; each value is the receptor's net of helix_pair_cells.json."""
    hrc = data[1]['payloads']['helix_receptor_cells']
    assert len(hrc['pairs']) == 36 and all(i <= j < 8 for i, j in hrc['pairs'])
    assert len(hrc['net']) == N_RECEPTORS and all(len(r) == 36 for r in hrc['net'])
    assert hrc['receptors'] == [r['gid'] for r in hp['receptors']]
    rc = cells['receptor_columns']
    k36 = hrc['pairs'].index([2, 5])
    cell = next(c for c in cells['cells'] if (c['i'], c['j']) == (2, 5))
    by = {row[rc.index('receptor')]: row[rc.index('net')] for row in cell['receptors']}
    hrh1 = hrc['receptors'].index('hrh1_human')
    assert hrc['net'][hrh1][k36] == pytest.approx(by[hrh1], abs=1e-3)
    for r, v in enumerate(hrc['net']):
        assert (v[k36] is None) == (r not in by)
