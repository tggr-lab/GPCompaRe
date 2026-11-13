"""CFR atlas, receptor explorer and orientation summaries of the Statistics page (site layer):
50 x 283 cells, 283 explorer rows, totals equal the source, manuscript values passed through unchanged."""
import json

import numpy as np
import pandas as pd
import pytest

from GPCompaReports_v2.analysis import class_atlas as ca
from GPCompaReports_v2.analysis.class_results import class_ranking
from GPCompaReports_v2.analysis.manuscript_stats import class_cfr_set, TOP50_CSV
from GPCompaReports_v2.website.page_generators.report_extras import HELICES_FIRST_ORDER

from .spelling import british_hits
from .stats_data import real_data

N_RECEPTORS = 283


@pytest.fixture(scope='module')
def data():
    return real_data()


@pytest.fixture(scope='module')
def atlas(data):
    return data[1]['payloads']['cfr_atlas']


@pytest.fixture(scope='module')
def rec(data):
    return data[1]['payloads']['receptors']


@pytest.fixture(scope='module')
def overview(data):
    return data[1]['payloads']['overview']


# ------------------------------------------------------------------------------- CFR atlas

def test_atlas_is_50_by_283(atlas, data):
    assert len(atlas['positions']) == 50
    assert {p['gn'] for p in atlas['positions']} == class_cfr_set()
    assert len(atlas['receptors']) == N_RECEPTORS
    assert {r['gid'] for r in atlas['receptors']} == set(data[0].gpcr_ids)
    cells = sum(len(r['state']) for r in atlas['receptors'])
    assert cells == 50 * N_RECEPTORS
    for r in atlas['receptors']:
        assert len(r['net']) == 50 and set(r['state']) <= set('012')
        for s, v in zip(r['state'], r['net']):
            assert (v is not None) == (s == '2')


def test_positions_helices_first_and_rank_order(atlas):
    idx = {s: k for k, s in enumerate(HELICES_FIRST_ORDER)}
    order = [idx[p['segment']] for p in atlas['positions']]
    assert order == sorted(order)
    ranks = [atlas['positions'][k]['rank'] for k in atlas['rank_order']]
    assert ranks == sorted(ranks) and ranks[0] == 1 and ranks[-1] == 50


def test_counts_equal_the_ranking(atlas):
    """Pack numbering gives each column the receptor count of the ranking (positions.tsv) at all 50 positions,
    8.48x48 included: 113, GPR4 numbered with its own GPCRdb entry in both. S3 has 112 there."""
    table = class_ranking().set_index('generic_number')['n_receptors'].to_dict()
    s3 = pd.read_csv(TOP50_CSV).set_index('generic_number')['n_receptors'].to_dict()
    by_gn = {p['gn']: (p, c) for p, c in zip(atlas['positions'], atlas['columns'])}
    assert by_gn['3.50x50'][1]['n_hit'] == 274
    assert all(c['n_hit'] == p['table_n_receptors'] == table[g] for g, (p, c) in by_gn.items())
    assert {g: (table[g], s3[g]) for g in by_gn if table[g] != s3[g]} == {'8.48x48': (113, 112)}
    k = [p['gn'] for p in atlas['positions']].index('8.48x48')
    hits = [r['gid'] for r in atlas['receptors'] if r['state'][k] == '2']
    assert 'gpr4_human' in hits and len(hits) == 113


def test_column_and_group_totals(atlas):
    rows = atlas['receptors']
    for k, c in enumerate(atlas['columns']):
        st = [r['state'][k] for r in rows]
        assert c['n_hit'] == st.count('2')
        assert c['n_numbered'] == N_RECEPTORS - st.count('0')
        assert c['n_up'] + c['n_down'] <= c['n_hit']
    for kind in ('ligand', 'family'):
        groups = atlas['groups'][kind]
        assert sum(g['n'] for g in groups) == N_RECEPTORS
        for k, c in enumerate(atlas['columns']):
            assert round(sum(g['hit'][k] * g['n'] for g in groups)) == c['n_hit']
            assert sum(g['numbered'][k] for g in groups) == c['n_numbered']


def test_atlas_net_equals_the_batch_rows(data, atlas):
    """One receptor, every position, straight from its delta CSV."""
    from GPCompaReports_v2.analysis import pack_layer
    store = data[0]
    row = next(r for r in atlas['receptors'] if r['gid'] == 'drd2_human')
    d = store.delta_data['drd2_human']
    sig = d[d['delta_rrcs'].abs() >= ca.receptor_threshold(d)]
    gn2pos = {r[3]: r[0] for r in pack_layer.load_pack('drd2_human')['residues'] if r[3]}
    for k, p in enumerate(atlas['positions']):
        pos = gn2pos.get(p['gn'])
        m = sig[(sig['res1'] == pos) | (sig['res2'] == pos)] if pos else sig.iloc[0:0]
        if row['state'][k] == '2':
            assert row['net'][k] == pytest.approx(m['delta_rrcs'].sum(), abs=1e-3)
        else:
            assert m.empty


# ------------------------------------------------------------------------------- explorer

def test_explorer_has_283_rows(rec, data):
    rows = ca.explorer_rows(rec)
    assert len(rows) == N_RECEPTORS
    assert len({r['gid'] for r in rows}) == N_RECEPTORS
    assert all(len(r) == len(rec['columns']) for r in rec['rows'])
    assert all(r['report'] == 'reports/%s.html' % r['gid'] for r in rows)


def test_explorer_totals_equal_the_source(rec, data, overview):
    store = data[0]
    rows = {r['gid']: r for r in ca.explorer_rows(rec)}
    assert sum(r['n_pairs'] for r in rows.values()) == 213456
    assert sum(r['n_above'] for r in rows.values()) == 23025
    for gid in store.gpcr_ids:
        d = store.delta_data[gid]
        r = rows[gid]
        assert r['n_pairs'] == len(d)
        assert r['sum_abs'] == pytest.approx(store.gpcr_info[gid]['sum_abs_delta'], abs=0.006)
        sig = d[d['delta_rrcs'].abs() >= ca.receptor_threshold(d)]
        assert r['n_above'] == len(sig)
        assert r['share_active'] == pytest.approx((sig['delta_rrcs'] > 0).mean(), abs=1e-4)
        assert r['family'] == store.gpcr_info[gid]['receptor_family']
        assert r['ligand'] == store.gpcr_info[gid]['ligand_type']


def test_explorer_cfr_counts_match_the_atlas(rec, atlas):
    rows = {r['gid']: r for r in ca.explorer_rows(rec)}
    for a in atlas['receptors']:
        assert rows[a['gid']]['cfr_hits'] == a['state'].count('2')
        assert rows[a['gid']]['cfr_numbered'] == 50 - a['state'].count('0')
    assert sum(r['cfr_hits'] for r in rows.values()) == sum(c['n_hit'] for c in atlas['columns'])


def test_ranks(rec):
    rows = ca.explorer_rows(rec)
    for m in rec['metrics']:
        vals = sorted((r[m['key']], r['rank_' + m['key']]) for r in rows if r[m['key']] is not None)
        assert vals[-1][1] == 1
        assert max(v[1] for v in vals) <= N_RECEPTORS


def test_ligand_groups(rec):
    groups = rec['ligand_groups']
    assert len(groups) == 8 and groups[-1]['key'] == 'Other'
    assert sum(g['n'] for g in groups) == N_RECEPTORS
    rows = ca.explorer_rows(rec)
    other = {r['ligand'] for r in rows if r['ligand_group'] == 'Other'}
    assert other == {'Alicarboxylic acid receptors', 'Melatonin receptors', 'Steroid receptors'}
    assert 'families' not in rec, 'the families list had no reader; Kruskal-Wallis is rendered on the server'
    # no ligand hue is the signed blue or red, the predicted pathogenic crimson or the old Other indigo
    colors = {g['color'].upper() for g in groups}
    assert not colors & {'#2563EB', '#1D4ED8', '#B91C1C', '#DB2777', '#B4234B', '#4338CA'}
    assert dict((g['key'], g['color']) for g in groups)['Other'] == '#6B7280'


def test_kruskal_wallis_on_total_change_only(rec):
    """One metric (total |ΔRRCS|), regrouped: every ligand type; families with at least 5 receptors."""
    assert set(rec['kruskal']) == {'sum_abs'}
    kw = rec['kruskal']['sum_abs']
    assert kw['ligand_types'] == {'H': 27.866, 'p': 0.001, 'k': 10, 'n': 283}
    assert kw['families'] == {'H': 27.36, 'p': 0.0259, 'k': 16, 'n': 192}
    fam = {}
    for r in ca.explorer_rows(rec):
        fam[r['family']] = fam.get(r['family'], 0) + 1
    assert kw['families']['n'] == sum(n for n in fam.values() if n >= ca.FAMILY_MIN_KW)


def test_protein_names_for_the_finder(rec):
    rows = {r['gid']: r for r in ca.explorer_rows(rec)}
    assert 'protein_name' in rec['columns']
    assert rows['adrb2_human']['protein_name'] == 'adrenoceptor beta 2'
    assert sum(1 for r in rows.values() if r['protein_name']) == N_RECEPTORS


def test_similarity(rec):
    rows = {r['gid']: r for r in ca.explorer_rows(rec)}
    eligible = {g for g, r in rows.items() if r['cfr_numbered'] >= ca.SIMILARITY_MIN_NUMBERED}
    assert set(rec['similar']) <= eligible
    for g, lst in rec['similar'].items():
        assert 0 < len(lst) <= ca.SIMILARITY_TOP
        assert g not in {h for h, _ in lst}
        assert all(h in eligible for h, _ in lst)
        sims = [s for _, s in lst]
        assert sims == sorted(sims, reverse=True) and all(-1 <= s <= 1 for s in sims)


# ------------------------------------------------------------------------------- overview

def test_overview_tiles(overview):
    t = {x['key']: x for x in overview['tiles']}
    assert [x['key'] for x in overview['tiles']] == ['receptors', 'contact_pairs', 'above_threshold',
                                                    'median_threshold', 'share_above', 'threshold_range',
                                                    'recurrent_positions', 'cfr_set']
    assert t['share_above']['value'] == 10.79 and t['share_above']['display'] == '10.8%'
    assert t['threshold_range']['display'] == '1.23 to 3.78'
    assert t['receptors']['value'] == 283 and t['receptors']['source'] == 'database'
    assert t['contact_pairs']['display'] == '213,456'
    assert t['above_threshold']['display'] == '23,025'
    assert t['median_threshold']['display'] == '2.40'
    assert t['recurrent_positions']['value'] == 368 and t['recurrent_positions']['source'] == 'ranking'
    assert t['cfr_set']['value'] == 50


def test_coverage(overview):
    cov = {c['view']: c for c in overview['coverage']}
    assert any(c['receptors'] == 276 and c['source'] == 'alphamissense' for c in cov.values())
    assert all(c['receptors'] == 283 for c in cov.values() if c['source'] == 'database')
    assert len(overview['exclusions']['not_modeled']) == 4


# ------------------------------------------------------------------------------- text

def test_payload_text(data):
    for name, payload in data[1]['payloads'].items():
        text = json.dumps(payload, ensure_ascii=False)
        assert '\u2014' not in text, name
        assert not british_hits(text), (name, british_hits(text)[:5])
        assert payload['meta']['label'] == ca.LAYER_LABEL
        low = text.lower()
        assert not any(w in low for w in ('paper', 'manuscript', 'supplementary', 'submitted', 'site layer')), name
        assert payload['meta']['n_receptors'] == N_RECEPTORS
