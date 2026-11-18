"""Class-wide results of the Statistics page (analysis/class_results.py): the pinned tables of
data/class_tables_2026-11-13/ and the two band tables, the payloads built from them, and the computed finding
sentences. Pure Python; the payload tests build on the real data (skip without the batch run or the packs);
the built-file tests read FREEZE_BUILD_DIR (or SMOKE_BUILD_DIR) and skip without a build."""
import hashlib
import json
import os
import re
from pathlib import Path

import pandas as pd
import pytest

from GPCompaReports_v2.analysis import class_results as cr
from GPCompaReports_v2.analysis.manuscript_stats import TOP50_CSV, class_cfr_set

from .stats_data import real_data

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR')
BUILD = Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD.is_absolute():
    BUILD = BASE / BUILD
STATS_DIR = BUILD / 'data' / 'stats'
needs_build = pytest.mark.skipif(not (STATS_DIR / 'class_positions.json').is_file(),
                                 reason='no build with class payloads at %s' % BUILD)

#: Words and values that must never reach a payload or CSV of the page.
BANNED_WORDS = ('paper', 'manuscript', 'supplement', 'as reported', 'corrected', 'odds ratio', 'mantel',
                'confidence interval', '95%', 'auc')
RETIRED = ('2.58', '1.52', '7,445', '67.0%', '67.6%', '2.63', '2.613', '1.5418', '1.542')


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


@pytest.fixture(scope='module')
def t():
    return cr.load_class_tables()


@pytest.fixture(scope='module')
def payloads():
    return real_data()[1]['payloads']


# ------------------------------------------------------------------------------------- pins and provenance
def _provenance_pins(path):
    return dict(re.findall(r'^\| `([^`]+)` \| (?:`[^`]+` \| )?`([0-9a-f]{64})`', path.read_text(encoding='utf-8'), re.M))


def test_every_table_matches_its_pin():
    for name, pin in cr.PINS.items():
        assert _sha(cr.table_path(name)) == pin, name


def test_pins_equal_the_provenance_tables():
    cls = _provenance_pins(cr.CLASS_DIR / 'PROVENANCE.md')
    assert cls == cr.PINS
    supp = {('../supplement_2026-11-05b/' + k): v
            for k, v in re.findall(r'^\| `([^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|$',
                                   (cr.SUPP_DIR / 'PROVENANCE.md').read_text(encoding='utf-8'), re.M)}
    assert supp == {k: v for k, v in cr.PINS.items() if k.startswith('../')}


def test_checks_json_passed_and_names_every_output():
    doc = json.loads((cr.CLASS_DIR / 'checks.json').read_text(encoding='utf-8'))
    assert doc['checks'] and all(c['ok'] for c in doc['checks'].values())
    assert doc['outputs'] == cr.PINS


def test_copies_equal_their_sources_where_present():
    """The byte copies equal their sources when those exist on this machine (paths from checks.json)."""
    doc = json.loads((cr.CLASS_DIR / 'checks.json').read_text(encoding='utf-8'))
    src = {k: Path(os.path.expanduser(v['path'])) for k, v in doc['inputs'].items()}
    pairs = {'conservation_positions.tsv': 'F3a_conservation_by_generic_position.tsv',
             '../supplement_2026-11-05b/FigS4b_recurrence_bands.tsv': 'FigS4b_recurrence_bands.tsv',
             '../supplement_2026-11-05b/ed14_a_conservation_strata_plotdata.tsv':
                 'ed14_a_conservation_strata_plotdata.tsv'}
    checked = 0
    for name, key in pairs.items():
        assert doc['inputs'][key]['sha256'] == cr.PINS[name], name
        if src[key].is_file():
            assert src[key].read_bytes() == cr.table_path(name).read_bytes(), name
            checked += 1
    if not checked:
        pytest.skip('no source tables on this machine')


def test_segments_and_interfaces(t):
    """Recomputed with GPR4 on its own GPCRdb entry; ICL4 kept, so the endpoints close on 2 x 213,456; the builder
    checked that the canonical maps reproduce the ed1 tables."""
    seg = t['segments']
    assert list(seg['segment']) == ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8', 'ICL1', 'ICL2', 'ICL3',
                                    'ICL4', 'ECL1', 'ECL2', 'ECL3', 'N-term', 'C-term']
    assert int(seg['endpoints'].sum()) == 2 * 213456
    by = seg.set_index('segment')
    assert int(by.loc['ICL4', 'endpoints']) == 35 and round(by.loc['ICL4', 'mean_abs_delta'], 4) == 1.3432
    assert (round(by.loc['TM1', 'mean_abs_delta'], 6), int(by.loc['TM1', 'endpoints'])) == (0.745035, 35706)
    assert (round(by.loc['TM7', 'mean_abs_delta'], 6), int(by.loc['TM7', 'endpoints'])) == (1.074721, 43512)
    it = t['interfaces']
    assert len(it) == 21 and int(it['supported'].astype(str).eq('True').sum()) == 14
    doc = json.loads((cr.CLASS_DIR / 'checks.json').read_text(encoding='utf-8'))
    for name in ('canonical maps reproduce ed1_full_segments.tsv (16 segments: mean, median, endpoints)',
                 'canonical maps reproduce ed1_full_interfaces.tsv (21 pairs of TM1 to TM7)',
                 'the one segment the ed1 table leaves out is ICL4, and with it the endpoints close on 2 x pairs'):
        assert doc['checks'][name]['ok'], name


def test_a_changed_table_is_refused(tmp_path, monkeypatch):
    bad = tmp_path / 'pairs.tsv'
    bad.write_text('cfr_1\tcfr_2\n', encoding='utf-8')
    monkeypatch.setattr(cr, 'table_path', lambda name: bad)
    with pytest.raises(ValueError, match='sha256'):
        cr._read('pairs.tsv')


# ------------------------------------------------------------------------------------- the tables
def test_positions(t):
    p = t['positions']
    assert len(p) == 368
    s3 = pd.read_csv(TOP50_CSV)
    assert list(p['generic_number'].head(50)) == list(s3['generic_number'])
    r = p.set_index('generic_number')
    x = r.loc['8.48x48']
    assert (int(x.n_receptors), x.pct_receptors, round(x.mean_abs_delta, 4), round(x.cfr_score, 5),
            int(x.cfr_score_rank), int(x.recurrence_rank)) == (113, 39.9293, 5.2107, 0.46452, 36, 57)
    assert int(r.loc['3.50x50', 'n_receptors']) == 274
    assert int((p['n_receptors'] >= 213).sum()) == 8
    y = r.loc['3.19x19']
    assert (int(y.cfr_score_rank), int(y.n_receptors), round(y.mean_abs_delta, 2)) == (18, 6, 10.09)
    assert set(p['generic_number'].head(50)) == class_cfr_set()


def test_pairs(t):
    pr = t['pairs']
    assert len(pr) == 2231
    assert int(pr['both_ends_top50'].sum()) == 181
    assert (pr.iloc[0].cfr_1, pr.iloc[0].cfr_2, int(pr.iloc[0].n_receptors)) == ('3.49x49', '3.50x50', 169)
    assert bool(pr.head(20)['both_ends_top50'].all())


def test_partner_diversity(t):
    d = t['partner_diversity'].set_index('generic_number')
    assert (int(d.loc['3.50x50', 'n_distinct_partners']), d.loc['3.50x50', 'top_partner'],
            int(d.loc['3.50x50', 'top_partner_n_receptors'])) == (38, '3.49x49', 169)
    assert (int(d.loc['6.48x48', 'n_distinct_partners']), d.loc['6.48x48', 'top_partner'],
            int(d.loc['6.48x48', 'top_partner_n_receptors'])) == (23, '6.44x44', 156)
    assert int(d.loc['7.53x53', 'n_distinct_partners']) == 34
    assert len(d) == 368


def test_activation_reference_and_motifs(t):
    ref = t['activation_reference']
    assert len(ref) == 39 and ref['generic_number'].is_unique
    motif_gn = [g for m in t['activation_motifs']['motifs'] for g in m['positions']]
    assert len(motif_gn) == 16 and set(motif_gn) <= set(ref['generic_number'])
    assert [m['name'] for m in t['activation_motifs']['motifs']] == ['D2.50', 'DRY', 'PIF', 'CWxP', 'NPxxY']
    assert sum(1 for g in motif_gn if g in class_cfr_set()) == 9
    assert int(ref['zhou2019'].sum()) == 32 and int(ref['class_a_motif'].sum()) == 20


def test_activation_recovery(t):
    rc = t['activation_recovery']
    assert len(rc) == 262 and int(rc['known'].sum()) == 39
    at = dict(zip(rc['rank_in_universe'], rc['known_found']))
    assert {n: int(at[n]) for n in (10, 20, 30, 40, 50, 60, 80, 100, 120)} == {
        10: 8, 20: 14, 30: 16, 40: 18, 50: 20, 60: 21, 80: 23, 100: 27, 120: 28}
    ex = dict(zip(rc['rank_in_universe'], rc['expected']))
    assert (round(ex[10], 2), round(ex[50], 2)) == (1.49, 7.44)
    assert len(class_cfr_set() & set(rc['generic_number'])) == 49
    assert list(rc['known_found']) == list(rc['known'].cumsum())
    # rows are structure positions; generic_number is the best-scoring generic number of that structure position
    struct = lambda g: '%sx%s' % (g.split('.')[0], g.split('x')[1])  # noqa: E731
    assert rc['struct_number'].is_unique and all(struct(g) == s for g, s in zip(rc['generic_number'], rc['struct_number']))
    pos = t['positions']
    best = pos.assign(s=[struct(g) for g in pos['generic_number']]).sort_values('cfr_score', ascending=False) \
        .drop_duplicates('s').set_index('s')['generic_number']
    assert all(best[s] == g for s, g in zip(rc['struct_number'], rc['generic_number']))


def test_bands(t):
    b = t['FigS4b_recurrence_bands']
    assert list(b['positions']) == [36, 139, 107, 89, 23, 8] and int(b['positions'].sum()) == 402
    assert [round(x, 1) for x in b['pct_pathogenic_of_decisive']] == [18.5, 33.4, 35.7, 50.7, 69.0, 87.3]
    assert int((b['pathogenic'] + b['benign']).sum()) == 15519


def test_fifths(t):
    q = t['ed14_a_conservation_strata_plotdata']
    assert len(q) == 5 and int(q['lead_n'].sum()) == 6149 and int(q['rest_n'].sum()) == 9358
    assert int(q['lead_n'].sum() + q['rest_n'].sum()) == 15507
    assert [(round(a, 1), round(b, 1)) for a, b in zip(q['lead_pct'], q['rest_pct'])] == [
        (22.4, 13.2), (37.8, 31.2), (57.0, 49.8), (78.7, 68.1), (92.8, 87.4)]


def test_conservation(t):
    c = t['conservation_positions']
    top, oth = c[c.top50_by_cfr_score == 1], c[c.top50_by_cfr_score == 0]
    assert (len(top), len(oth)) == (50, 302)
    assert (round(top.mean_conservation.median(), 4), round(oth.mean_conservation.median(), 4)) == (0.8038, 0.6726)
    assert set(top['gn_display']) == class_cfr_set()


# ------------------------------------------------------------------------------------- payloads
def test_class_scale(payloads):
    sc = payloads['class_scale']
    c = sc['census']
    assert (c['pairs'], c['above'], c['share_above']) == (213456, 23025, 10.79)
    assert (c['threshold_min'], c['threshold_median'], c['threshold_max']) == (1.227, 2.398, 3.784)
    assert c['above_per_100_median'] == 10.84 and c['negative_pairs'] == 111035
    assert (c['receptors'], c['families'], c['ligand_types'], c['recurrent_positions']) == (283, 60, 10, 368)
    assert sum(n for _, n in sc['histogram']) == 213456 and len(sc['histogram']) < 500
    assert sc['histogram_rule']['not_drawn'] == 25
    assert len(sc['receptors']) == 283 and sc['receptor_columns'] == ['gid', 'symbol', 'threshold', 'above_per_100']
    assert len(json.dumps(sc, separators=(',', ':'))) < 20000


def test_class_positions(payloads):
    pos = payloads['class_positions']
    rows = [dict(zip(pos['ranking_columns'], r)) for r in pos['ranking']]
    assert len(rows) == 368 and [r['rank'] for r in rows] == list(range(1, 369))
    r36 = rows[35]
    assert (r36['gn'], r36['n'], round(r36['pct'], 1), round(r36['mean_abs_delta'], 2), round(r36['cfr_score'], 3)) == (
        '8.48x48', 113, 39.9, 5.21, 0.465)
    assert rows[0]['gn'] == '3.50x50' and rows[0]['motif'] == 'DRY' and rows[0]['adrb2'] == 'R131'
    assert [b['positions'] for b in pos['bands']] == [0, 141, 107, 89, 23, 8]
    assert [b['label'] for b in pos['bands']] == ['fewer than 3', '3 to 28', '29 to 70', '71 to 141', '142 to 212',
                                                  '213 or more']
    assert pos['motif_counts'] == {'positions': 16, 'in_top': 9}
    assert len(pos['reference']) == 39 and len(pos['partners']) == 368
    p = pos['pairs']
    assert (p['n_distinct'], p['n_both_top50'], len(p['top']), p['top_all_both_top50']) == (2231, 181, 20, True)
    rec = pos['recovery']
    assert (rec['universe'], rec['known'], rec['top_in_universe'], len(rec['rows'])) == (262, 39, 49, 262)
    assert rec['columns'][:4] == ['rank_in_universe', 'cfr_score_rank', 'struct', 'gn']
    r212 = dict(zip(rec['columns'], rec['rows'][211]))
    assert (r212['struct'], r212['gn']) == ('6x46', '6.45x46')
    assert rec['cuts'] == {'10': {'known_found': 8, 'expected': 1.4885},
                           '50': {'known_found': 20, 'expected': 7.4427}}
    sc = pos['scaffold']
    assert sc['gene'] == 'ADRB2' and sc['residues']
    segs = [r[2] for r in sc['residues']]
    first, last = segs.index('TM1'), len(segs) - 1 - segs[::-1].index('H8')
    assert first == 6 and len(segs) - 1 - last == 8
    cons = pos['conservation']
    assert (cons['n_top'], cons['n_other'], cons['median_top'], cons['median_other']) == (50, 302, 0.8038, 0.6726)
    assert len(json.dumps(pos, separators=(',', ':'))) < 80000


def _keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys(v)


def test_class_variants(payloads):
    cv = payloads['class_variants']
    top, oth = cv['groups']
    assert [top[k] for k in ('predicted_pathogenic', 'predicted_benign')] + \
        [oth[k] for k in ('predicted_pathogenic', 'predicted_benign')] == [4117, 2038, 4085, 5284]
    assert (top['ambiguous'], oth['ambiguous'], top['scored'], oth['scored']) == (1113, 1671, 7268, 11040)
    assert ('%.1f' % top['pct_predicted_pathogenic_of_decisive'],
            '%.1f' % oth['pct_predicted_pathogenic_of_decisive']) == ('66.9', '43.6')
    assert [round(top['pct_of_scored'][k], 1) for k in ('predicted_pathogenic', 'ambiguous', 'predicted_benign')] == [
        56.6, 15.3, 28.0]
    assert [round(oth['pct_of_scored'][k], 1) for k in ('predicted_pathogenic', 'ambiguous', 'predicted_benign')] == [
        37.0, 15.1, 47.9]
    assert cv['receptors'] == 276
    assert cv['totals'] == {'decisive_groups': 15524, 'decisive_bands': 15519, 'decisive_fifths': 15507,
                            'positions_bands': 402}
    assert not {'or', 'odds', 'ci', 'mh', 'odds_ratio', 'conservation_adjusted', 'mh_conservation'} & set(_keys(cv))
    # substitutions of the set without an AlphaMissense class in it: counted for the method note, never in a share
    assert cv['unclassified'] == {'substitutions': 1260, 'top50': 483, 'receptors': 49}


def test_unclassified_table_is_pinned_and_outside_the_summary():
    un = cr.load_am_unclassified()
    assert _sha(cr.SUPP_DIR / cr.AM_UNCLASSIFIED) == cr.AM_UNCLASSIFIED_SHA
    assert list(un.columns) == ['gid', 'protein_position', 'ref_aa', 'alt_aa', 'generic_number', 'top50']
    assert len(un) == 1260 and int(un['top50'].sum()) == 483 and un['gid'].nunique() == 49
    assert not {'gpr3_human', 'gpr4_human', 'xcr1_human'} & set(un['gid'])
    assert un['generic_number'].notna().all()
    top = set(cr.class_ranking()['generic_number'][:50])
    assert (un['generic_number'].isin(top).astype(int) == un['top50']).all()
    assert ((un['gid'] == '5ht4r_human') & (un['protein_position'] == 117) & (un['alt_aa'] == 'G')).any()
    text = (cr.SUPP_DIR / 'PROVENANCE.md').read_text(encoding='utf-8')
    assert '`am_unclassified.tsv` | `%s`' % cr.AM_UNCLASSIFIED_SHA in text


def test_recovery_rule_names_its_receptor_count(payloads):
    rule = payloads['class_positions']['recovery']['rule']
    assert rule.startswith('The 262 structure positions (GPCRdb structure-based numbers) numbered in at least 142 '
                           'of the 283 receptors, in CFR score order.')
    assert 'recurrent position' not in rule


def test_helix_receptor_cells_size(payloads):
    assert len(json.dumps(payloads['helix_receptor_cells'], separators=(',', ':'))) < 80000


def test_payload_text_bans(payloads):
    for name in ('class_scale', 'class_positions', 'class_variants', 'helix_receptor_cells'):
        text = json.dumps(payloads[name], ensure_ascii=False).lower()
        assert '—' not in text, name
        for w in BANNED_WORDS:
            assert w not in text, (name, w)
    text = json.dumps(payloads['class_variants'], ensure_ascii=False)
    for v in RETIRED:
        assert v not in text, v


def test_csv_tables_are_plain(payloads):
    tables = cr.csv_tables(payloads)
    assert {'thresholds.csv', 'histogram.csv', 'helix_pairs.csv', 'helix_interfaces.csv', 'segments.csv',
            'ranking_368.csv', 'activation_recovery.csv', 'partners.csv', 'pairs.csv', 'am_comparison.csv',
            'am_bands.csv', 'am_conservation_fifths.csv', 'position_conservation.csv'} <= set(tables)
    for name, text in tables.items():
        header = text.split('\n', 1)[0]
        assert not header.startswith('#') and re.fullmatch(r'[a-z0-9_,]+', header), (name, header)
        low = text.lower()
        assert '—' not in text, name
        for w in BANNED_WORDS:
            assert w not in low, (name, w)
    assert len(tables['pairs.csv'].strip().split('\n')) == 2232
    assert len(tables['ranking_368.csv'].strip().split('\n')) == 369
    for name in ('am_bands.csv', 'am_conservation_fifths.csv', 'am_comparison.csv'):
        for v in RETIRED:
            assert v not in tables[name], (name, v)


# ------------------------------------------------------------------------------------- sentences
EXPECTED_FINDINGS = {
    'sec-scale': "23,025 of 213,456 contact pairs (10.8%) pass their receptor's threshold.",
    'sec-a': 'TM3-TM6 weaker in 210 of 264, TM3-TM7 stronger in 208 of 222.',
    'sec-c': '3.50x50 (R of DRY) is a CFR in 274 of 283 receptors.',
    'sec-d': '66.9% predicted pathogenic at the 50 top-ranked positions, 43.6% at others.',
    'sec-e': 'Median total |ΔRRCS| from 619 in nucleotide to 845 in sensory receptors.',
}


def test_finding_sentences(payloads):
    fs = cr.finding_sentences(payloads)
    assert fs['findings'] == EXPECTED_FINDINGS
    g = {x['key']: x for x in fs['glance']}
    assert [x['key'] for x in fs['glance']] == ['scale', 'bundle', 'positions', 'variants']
    assert g['scale']['big'] == '10.8%'
    assert g['scale']['line'] == 'of contact pairs pass threshold'
    assert g['bundle']['big'] == 'TM3-TM6' and [c['value'] for c in g['bundle']['cells']] == ['−5.90', '+4.67']
    assert g['positions']['big'] == '274 of 283'
    assert g['variants']['big'] == '66.9% vs 43.6%'
    for text in list(fs['findings'].values()) + [x['line'] for x in fs['glance']]:
        assert '—' not in text
    # visual first: a headline of at most 12 words, a tile label of at most 6
    assert all(len(t.split()) <= 12 for t in fs['findings'].values()), fs['findings']
    assert all(len(x['line'].split()) <= 6 for x in fs['glance']), [x['line'] for x in fs['glance']]


def test_finding_numbers_recomputed_from_the_payloads(payloads):
    """Each number of the findings, recomputed here from its payload."""
    sc = payloads['class_scale']['census']
    assert '%s of %s' % (format(sc['above'], ','), format(sc['pairs'], ',')) in EXPECTED_FINDINGS['sec-scale']
    assert '(%.1f%%)' % (100.0 * sc['above'] / sc['pairs']) in EXPECTED_FINDINGS['sec-scale']
    hp = payloads['helix_pairs']
    cols = hp['summary_columns']
    allg = next(x for x in hp['groups'] if x['key'] == 'all')
    rows = [dict(zip(cols, c)) for c in allg['cells']
            if c[0] < 8 and c[1] < 8 and c[0] != c[1] and c[cols.index('n_present')] >= hp['min_receptors']]
    lo = min(rows, key=lambda r: r['mean_net'])
    hi = max(rows, key=lambda r: r['mean_net'])
    assert 'weaker in %d of %d' % (lo['n_down'], lo['n_present']) in EXPECTED_FINDINGS['sec-a']
    assert 'stronger in %d of %d' % (hi['n_up'], hi['n_present']) in EXPECTED_FINDINGS['sec-a']
    pos = payloads['class_positions']
    first = dict(zip(pos['ranking_columns'], pos['ranking'][0]))
    assert EXPECTED_FINDINGS['sec-c'].startswith(first['gn']) and 'in %d of 283' % first['n'] in EXPECTED_FINDINGS['sec-c']
    top, oth = payloads['class_variants']['groups']
    assert '%.1f%%' % (100.0 * top['predicted_pathogenic'] / top['decisive']) in EXPECTED_FINDINGS['sec-d']
    assert '%.1f%%' % (100.0 * oth['predicted_pathogenic'] / oth['decisive']) in EXPECTED_FINDINGS['sec-d']
    rec = payloads['receptors']
    df = pd.DataFrame(rec['rows'], columns=rec['columns'])
    g = df.groupby('ligand')['sum_abs']
    med = g.median()[g.size() >= 5]
    assert '%.0f in %s' % (med.min(), med.idxmin().lower().replace(' receptors', '')) in EXPECTED_FINDINGS['sec-e']
    assert 'to %.0f in %s' % (med.max(), med.idxmax().lower()) in EXPECTED_FINDINGS['sec-e']


def test_computed_notes(payloads):
    n = cr.computed_notes(payloads)
    assert n['histogram'] == ('Each bar counts contact pairs by ΔRRCS (active minus inactive). 111,035 of 213,456 '
                              'pairs (52.0%) are stronger in the inactive model. 25 pairs beyond ±20 are not drawn.')
    assert n['segments'] == ('Mean |ΔRRCS| per contact endpoint, over all contacts with full GPCRdb residue maps. '
                             'Highest in the bundle: H8 1.21 and TM6 1.13; lowest: TM4 0.74. Loops and termini: 1.06 '
                             'to 1.23. ICL4 (35 endpoints) is not drawn: fewer than 50.')
    assert n['ranking_outlier'] == ('3.19x19 is a CFR in only 6 receptors and ranks 18 by CFR score because its mean '
                                    '|ΔRRCS| (10.09) is the largest of the 50.')
    assert n['motifs_in_top'] == '9 of the 16 motif positions are in the top 50.'
    assert n['recovery_points'] == ['8 of the first 10 · 1.5 expected by chance',
                                    '20 of the first 50 · 7.4 expected by chance']
    assert '15,519 decisive calls' in n['am_bands_method'] and '15,524' in n['am_bands_method']
    assert n['am_fifths_method'].startswith('12 decisive calls')


# ------------------------------------------------------------------------------------- the build
@needs_build
def test_built_payloads_and_csvs():
    for name in ('class_scale', 'class_positions', 'class_variants', 'helix_receptor_cells', 'helix_pairs'):
        assert (STATS_DIR / ('%s.json' % name)).is_file(), name
    hp = json.loads((STATS_DIR / 'helix_pairs.json').read_text(encoding='utf-8'))
    assert hp['interfaces'] and hp['segments_magnitude']
    assert not (STATS_DIR / 'figures').exists()
    assert not (STATS_DIR / 'conservation_by_residue.csv').exists()
    cov = (STATS_DIR / 'coverage.csv').read_text(encoding='utf-8')
    assert 'GPR3, GPR4 and XCR1. GPR182 (ACKR5), NPY6R, P2RY8 and TAAR3P: no records in that query.' in cov
    assert 'NPY6R and TAAR3P: no protein-coding missense records' in cov
    assert cov.count('GPR182') == 1 and cov.count('P2RY8') == 1
    cfr = json.loads((STATS_DIR / 'cfr_variants.json').read_text(encoding='utf-8'))
    assert cfr['coverage']['receptors_with_alleles'] == 281
    for name in ('class_variants.json', 'am_bands.csv', 'am_conservation_fifths.csv'):
        text = (STATS_DIR / name).read_text(encoding='utf-8')
        for v in RETIRED:
            assert v not in text, (name, v)
        for w in BANNED_WORDS:
            assert w not in text.lower(), (name, w)


@needs_build
def test_built_manifest_lists_every_stats_file():
    man = json.loads((STATS_DIR / 'manifest.json').read_text(encoding='utf-8'))
    listed = {f['path']: f['bytes'] for f in man['files']}
    on_disk = {str(p.relative_to(BUILD)): p.stat().st_size for p in STATS_DIR.rglob('*')
               if p.is_file() and p.name != 'manifest.json'}
    assert listed == on_disk
    assert 'data/stats/gpcompare_statistics_tables.zip' in listed and 'data/stats/coverage.csv' in listed
    assert not (STATS_DIR / 'overview.json').exists()


@needs_build
def test_built_cfr_atlas_groups_carry_counts():
    atlas = json.loads((STATS_DIR / 'cfr_atlas.json').read_text(encoding='utf-8'))
    orphan = [g for g in atlas['groups']['ligand'] if g['key'].startswith('Orphan')][0]
    k = [p['gn'] for p in atlas['positions']].index('7.32x31')
    assert (orphan['cfr'][k], orphan['n'], orphan['hit'][k]) == (30, 78, 0.385)
    assert round(100 * orphan['cfr'][k] / orphan['n']) == 38


@needs_build
def test_built_am_method_note_counts_the_unclassified():
    html = (BUILD / 'statistics.html').read_text(encoding='utf-8')
    note = re.search(r'<li id="note-chart-pathogenicity">(.*?)</li>', html, re.S).group(1)
    assert '1,260 unclassified substitutions across 49 receptors (483 at top 50)' in note



@needs_build
def test_built_atlas_map():
    path = STATS_DIR / 'atlas_map.json'
    if not path.is_file():
        pytest.skip('the build ran without the Atlas step')
    m = json.loads(path.read_text(encoding='utf-8'))
    assert len(m['rows']) == 283 and m['columns'] == ['gid', 'x', 'y', 'group']
    assert {r[3] for r in m['rows']} <= set(range(len(m['ligand_groups'])))
    assert path.stat().st_size < 12000


@needs_build
def test_chart_payloads_preserve_the_section_findings():
    html = (BUILD / 'statistics.html').read_text(encoding='utf-8')
    urls = json.loads(re.search(r'<script[^>]+id="stats-config"[^>]*>(.*?)</script>', html, re.S)[1])['urls']
    names = ('class_scale', 'helix_pairs', 'class_positions', 'class_variants', 'receptors')
    payloads = {name: json.loads((BUILD / urls[name]).read_text(encoding='utf-8')) for name in names}
    assert cr.finding_sentences(payloads)['findings'] == EXPECTED_FINDINGS
    for anchor in EXPECTED_FINDINGS:
        assert f'id="{anchor}"' in html


# ------------------------------------------------------------------------------------- review round 1 (numbers)
def test_scaffold_counts_every_generic_position(payloads, t):
    """A scaffold residue at a non-recurrent position carries its true count (4.47x47, 4.51x51, 4.55x55: a CFR in 1
    receptor each), not 0."""
    sc = payloads['class_positions']['scaffold']
    assert sc['columns'][-1] == 'n'
    by = {r[3]: r[6] for r in sc['residues'] if r[3]}
    assert by['4.47x47'] == by['4.51x51'] == by['4.55x55'] == 1
    rare = dict(zip(t['positions_below_recurrence'].generic_number, t['positions_below_recurrence'].n_receptors))
    rank = dict(zip(t['positions'].generic_number, t['positions'].n_receptors))
    for gn, n in by.items():
        assert n == rank.get(gn, rare.get(gn, 0)), gn
    assert all(r[6] is None for r in sc['residues'] if not r[3])


def test_mean_change_rounds_once(payloads, t):
    """The ranking ships mean |ΔRRCS| at 6 decimals, so the page's 2-decimal values equal the table's."""
    cols = payloads['class_positions']['ranking_columns']
    k = cols.index('mean_abs_delta')
    true = dict(zip(t['positions'].generic_number, t['positions'].mean_abs_delta))
    for r in payloads['class_positions']['ranking']:
        assert '%.2f' % r[k] == '%.2f' % true[r[cols.index('gn')]], r[cols.index('gn')]
    row = {r[cols.index('gn')]: r for r in payloads['class_positions']['ranking']}['8.50x50']
    assert '%.2f' % row[k] == '4.61'


def test_atlas_signs_add_up(payloads):
    """n_up + n_down = n_hit wherever no receptor's net is exactly zero (7.53x53: SSR4's net +0.00024 counts as up)."""
    a = payloads['cfr_atlas']
    for k, (p, c) in enumerate(zip(a['positions'], a['columns'])):
        zero = sum(1 for r in a['receptors'] if r['state'][k] == '2' and r['net'][k] == 0)
        assert c['n_up'] + c['n_down'] + zero == c['n_hit'], p['gn']
    k = [p['gn'] for p in a['positions']].index('7.53x53')
    assert (a['columns'][k]['n_hit'], a['columns'][k]['n_up'], a['columns'][k]['n_down']) == (254, 155, 99)


def test_release_labels_of_the_class_tables(payloads):
    """The ranked tables name the residue maps they were computed on; no dangling numbering sentence."""
    num = payloads['class_positions']['meta']['sources']['numbering']
    assert 'GPCRdb residue maps' in num and '2026-08-12' in num and 'GPR4' in num
    mag = payloads['helix_pairs']['meta']['sources']['numbering_magnitude']
    assert '2026-08-12' in mag and 'GPR4' in mag
    for name, p in payloads.items():
        src = (p.get('meta') or {}).get('sources') or {}
        assert 'With it' not in src.get('numbering', ''), name
        assert 'class_A_all' not in json.dumps(p.get('meta') or {}), name
        assert 'class-wide CFR set' not in json.dumps(p.get('meta') or {}), name
    rec = payloads['class_positions']['recovery']
    assert rec['rule'].startswith('The %d structure positions (GPCRdb structure-based numbers) numbered in at least '
                                  '142 of the 283' % rec['universe'])
    assert 'H8 are not included' in payloads['helix_pairs']['magnitude_rule']['interfaces']


@needs_build
def test_built_scaffold_csv_and_coverage():
    rows = list(csv_rows(STATS_DIR / 'scaffold.csv'))
    by = {r['generic_number']: r for r in rows if r['generic_number']}
    assert by['4.47x47']['receptors_with_cfr'] == '1' and by['4.47x47']['band'] == 'fewer than 3'
    cov = list(csv_rows(STATS_DIR / 'coverage.csv'))
    ranked = [r for r in cov if r['results'].startswith('Ranked positions')][0]
    assert 'GPCRdb residue maps, fetched 2026-08-12' in ranked['data'] and 'GPR4' in ranked['data']
    first = cov[0]
    assert 'GPCRdb generic numbering, fetched 2026-10-18' in first['data'] and 'positions' not in first['results'].split(',')[0]
    known = [r for r in cov if r['results'] == 'Known activation positions'][0]
    assert known['receptors'].startswith('262 structure positions')
    mag = [r for r in cov if r['results'].startswith('Change per contact by segment')][0]
    assert 'GPR4' in mag['data']   # the segment and interface tables carry the same GPR4 exception
    html = (BUILD / 'statistics.html').read_text(encoding='utf-8')
    assert 'class_A_all' not in html
    assert '287 human Class A receptors' in html
    assert 'Incomplete pairs: GPR26, LGR5, OPSX and RXFP1' in html


def csv_rows(path):
    import csv as _csv
    with open(path, newline='', encoding='utf-8') as fh:
        yield from _csv.DictReader(fh)
