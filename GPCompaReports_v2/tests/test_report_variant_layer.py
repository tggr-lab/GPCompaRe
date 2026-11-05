"""The report pages' variant and annotation layer (analysis/pack_layer.py) and what it must leave alone.

Unit tests run on a synthetic pack. The data tests need the batch run and the Studio packs (skip otherwise;
batch directory as in test_search_index_v2.py).
"""
import pandas as pd
import pytest

from GPCompaReports_v2.analysis import pack_layer as pl
from GPCompaReports_v2.website.page_generators import gpcr_report_helpers as h

from .test_search_index_v2 import _batch_dir


def _am_entry(ref, scores):
    """[ref, 20 scores, 20 class codes] with the given {alt: score}."""
    vals = [scores.get(a) for a in pl.AM_ALPHABET]
    codes = ''.join('-' if s is None else ('P' if s > 0.564 else 'B' if s < 0.34 else 'A') for s in vals)
    return [ref, vals, codes]


TOY = {
    'variants': [
        [10, 'M', 'I', 'p.Met10Ile', 'c.30G>A', 1e-3, 10, 10000, 1, 'exome', ['rs1', 'rs2'], '1-100-G-A', None, False],
        [10, 'M', 'V', 'p.Met10Val', 'c.28A>G', 1e-5, 1, 100000, 0, 'genome', [], '1-98-A-G', None, False],
        [11, 'L', 'P', 'p.Leu11Pro', 'c.32T>C', 2e-5, 2, 100000, 0, 'exome', ['rs3'], '1-102-T-C', None, False],
        [20, 'A', 'T', 'p.Ala17Thr', 'c.49G>A', 3e-5, 3, 100000, 0, 'exome', [], '1-119-G-A', 17, False],
    ],
    'am': {'10': [_am_entry('M', {'I': 0.9098, 'V': 0.4982})], '20': [_am_entry('A', {'T': 0.1})]},
    'conservation': {'10': 0.96, '20': 0.5},
    'amMean': {'10': 0.6},
    'residues': [[10, 'M', 'TM3', '3.36x36', 'g'], [11, 'L', 'TM3', '3.37x37', 'g'], [20, 'A', 'ICL2', '', 'g']],
    'provenance': {'gnomad': {'transcript': 'ENST1', 'transcriptVersion': '4'}},
}
DELTA = pd.DataFrame({'res1': [10, 11, 5], 'res2': [20, 30, 6], 'delta_rrcs': [3.0, 2.99, -7.0]})


def test_selection_is_the_fixed_cutoff_and_every_allele_gets_its_own_scores():
    df = pl.variant_frame(TOY, DELTA)
    # pairs with |dRRCS| >= 3.0: (10, 20) and (5, 6); 11 is at 2.99
    assert list(df['variant_id']) == ['1-100-G-A', '1-98-A-G', '1-119-G-A']
    by = df.set_index('variant_id')
    assert by.loc['1-100-G-A', 'am_score'] == 0.9098 and by.loc['1-100-G-A', 'am_class'] == 'PATHOGENIC'
    assert by.loc['1-98-A-G', 'am_score'] == 0.4982 and by.loc['1-98-A-G', 'am_class'] == 'AMBIGUOUS'
    assert by.loc['1-98-A-G', 'conservation'] == 0.96  # the second allele at a position keeps conservation
    assert by.loc['1-100-G-A', 'het_count'] == 10 - 2
    assert by.loc['1-100-G-A', 'rsids'] == 'rs1, rs2'
    assert by.loc['1-119-G-A', 'tx_position'] == 17
    assert pl.hgvs_numbering(df, TOY['provenance']['gnomad']) == {'transcript': 'ENST1.4', 'offset': 3, 'rows': 1}


def test_report_rows_render_through_the_unchanged_helper():
    rows = h._prepare_variants_full(pl.variant_frame(TOY, DELTA), DELTA)
    assert [r['hgvsp'] for r in rows] == ['p.Met10Ile', 'p.Met10Val', 'p.Ala17Thr']
    first = rows[0]
    assert (first['am_score_display'], first['am_class'], first['am_badge']) == ('0.910', 'PATHOGENIC', 'pathogenic')
    assert first['rsids'] == 'rs1, rs2' and first['rsid_list'] == ['rs1', 'rs2']
    assert first['conservation_display'] == '0.96' and first['delta_rrcs_display'] == '3.00'


def test_annotation_rows_cover_the_selected_residues():
    ann = pl.annotation_frame(TOY, DELTA)
    assert list(ann['position']) == [10, 20]
    assert list(ann['display_number'].fillna('')) == ['3.36x36', '']
    assert list(ann['protein_segment']) == ['TM3', 'ICL2']


# ------------------------------------------------------------------------------- the real data

@pytest.fixture(scope='module')
def store():
    batch = _batch_dir()
    if not (batch / 'csv_data').exists():
        pytest.skip('no batch data at %s' % batch)
    if pl.pack_index() is None:
        pytest.skip('no Studio packs at %s' % pl.pack_dir())
    from GPCompaReports_v2.analysis.data_loader import GPCRDataStore
    st = GPCRDataStore(batch_dir=batch).load_all()
    st.load_report_layer(required=True)
    return st


def test_refreshed_tables(store):
    layer = store.report_layer
    counts = layer.counts()
    assert len(counts) == 283
    # the Studio's corrected table for the same model pairs (parity/DIFFERS_FROM_DATABASE.md: 28,789 rows)
    assert sum(counts.values()) == 28789
    assert sorted(g for g, n in counts.items() if not n) == ['npy6r_human', 'taar3_human']
    for g, df in layer.variants.items():
        if df.empty:
            continue
        assert df['am_score'].notna().all(), g          # every allele has its own AlphaMissense score
        assert df['variant_id'].is_unique, g
        sig = pl.significant_positions(store.delta_data[g])
        assert set(df['protein_position']) <= sig, g
    par2 = layer.variants['par2_human'].set_index('variant_id')
    for vid in ('5-76833084-G-A', '5-76833084-G-T'):
        assert par2.loc[vid, 'hgvsp'] == 'p.Met159Ile' and par2.loc[vid, 'am_score'] == 0.9098
    assert store.gpcr_info['par2_human']['variants_found'] == 105
    assert store.gpcr_info['gp182_human']['variants_found'] == counts['gp182_human'] > 0
    assert store.gpcr_info['gp182_human']['variants_found_batch'] == 0


def test_family_wide_inputs_stay_the_batch_run(store):
    """CFR ranking, TM-domain and variant statistics, the paper: they read variant_data and annotation_data,
    which the refresh must not touch."""
    assert sum(len(df) for df in store.variant_data.values()) == 29213
    assert len(store.variant_data) == 279
    gpr3 = store.get_annotation_map('gpr3_human')
    assert len(gpr3) == 39  # the batch's (GPR31) annotation, kept for the family-wide analyses
    assert len(store.get_report_annotation_map('gpr3_human')) == len(pl.significant_positions(store.delta_data['gpr3_human']))


def test_the_three_wrong_receptors_get_their_own_accession(store):
    """The report header (UniProt id, link, protein name) of GPR3, GPR4 and XCR1 used GPR31's, GPR42's and
    CXCR1's accession; the layer gives them their own. No other receptor's accession moves."""
    want = {'gpr3_human': 'P46089', 'gpr4_human': 'P46093', 'xcr1_human': 'P46094'}
    for g, info in store.gpcr_info.items():
        if g in want:
            assert info['uniprot_id'] == want[g] and info['uniprot_id_batch'] != want[g], g
        else:
            assert 'uniprot_id_batch' not in info and info['uniprot_id'] == store.report_layer.uniprot[g], g


def test_only_the_three_wrong_receptors_get_new_annotation(store):
    """The batch annotation equals the pack at every row for the other 280 receptors, so the reports keep it."""
    layer = store.report_layer
    assert set(layer.annotation) == set(pl.WRONG_RECEPTOR_ANNOTATION)
    for g in store.gpcr_ids:
        pack = pl.load_pack(g, layer.folder)
        res = {r[0]: r for r in pack['residues']}
        batch = store.get_annotation_map(g)
        report = store.get_report_annotation_map(g)
        if g in pl.WRONG_RECEPTOR_ANNOTATION:
            for pos, a in report.items():
                assert (a['amino_acid'], a['protein_segment'], a['display_number']) == tuple(
                    x or '' for x in res[pos][1:4]), (g, pos)
            continue
        assert report == batch, g
        for pos, a in batch.items():
            assert (a['amino_acid'], a['protein_segment'], a['display_number']) == tuple(
                x or '' for x in res[pos][1:4]), (g, pos)


def test_residue_layers_change_only_for_five_receptors(store):
    """Snake-plot conservation and AlphaMissense colours now read the packs. They equal the database caches
    except for GPR3, GPR4, XCR1 (wrong receptor) and LPAR2, OPN1SW (UniProt numbering 3 residues off)."""
    from GPCompaReports_v2.website.page_generators.gpcr_report_page import (
        _load_am_landscape_cache, _load_conservation_cache)
    caches = _batch_dir().parent.parent.parent / 'GPCompaReports_v2' / 'output'
    if not (caches / 'data' / 'conservation_par2_human.json').exists():
        pytest.skip('no database caches at %s' % caches)
    differ = set()
    for g in store.gpcr_ids:
        if store.report_conservation(g) != _load_conservation_cache(g, caches) or \
                store.report_am_mean(g) != _load_am_landscape_cache(g, caches):
            differ.add(g)
    assert differ == {'gpr3_human', 'gpr4_human', 'xcr1_human', 'lpar2_human', 'opsb_human'}
