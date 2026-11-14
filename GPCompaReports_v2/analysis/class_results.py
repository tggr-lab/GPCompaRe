"""Class-wide results of the Statistics page: the tables of data/class_tables_2026-11-13/ and the payloads
built from them and from the batch run.

Tables (read and sha256-asserted by load_class_tables; written by scripts/build_class_tables.py, see that
folder's PROVENANCE.md):

    positions.tsv              368 recurrent positions ranked by CFR score (class_ranking())
    pairs.tsv                  2,231 distinct pairs of generic positions, both residues CFRs
    partner_diversity.tsv      per position: distinct partners, most frequent exact partner
    positions_below_recurrence.tsv  generic positions that are CFRs in 1 or 2 receptors (scaffold counts)
    activation_reference.tsv   39 known activation positions
    activation_motifs.json     the five named motifs (16 positions)
    activation_recovery.tsv    the 262 structure positions numbered in at least half of the receptors, in CFR
                               score order
    segments.tsv, interfaces.tsv, conservation_positions.tsv
    ../supplement_2026-11-05b/FigS4b_recurrence_bands.tsv, ed14_a_conservation_strata_plotdata.tsv

Payloads (data/stats/, written by class_atlas.write_stats_data with the other class payloads):

    class_scale.json           census, per-receptor thresholds, the ΔRRCS histogram
    helix_pairs.json           gains `interfaces` and `segments` (add_segments_interfaces)
    helix_receptor_cells.json  each receptor's net ΔRRCS at the 36 helix cells
    class_positions.json       ranking, bands, motifs, reference, partners, pairs, recovery, scaffold, conservation
    class_variants.json        AlphaMissense classes: the two groups, the six bands, the five fifths
    atlas_map.json             written by the GPCRome Atlas step (build_atlas_map), not here

finding_sentences(payloads) renders the five section findings and the four glance facts from the payloads;
computed_notes(payloads) the other computed guide lines. csv_tables(payloads) gives the new CSVs.

Every number is read or computed from those files; nothing here is typed.
"""
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path

import numpy as np
import pandas as pd

BASE = Path(__file__).resolve().parent.parent
CLASS_DIR = BASE / 'data' / 'class_tables_2026-11-13'
SUPP_DIR = BASE / 'data' / 'supplement_2026-11-05b'

#: sha256 of every table the build reads (the same pins as CLASS_DIR/PROVENANCE.md and
#: SUPP_DIR/PROVENANCE.md; tests/test_statistics_class_results.py checks all three agree).
PINS = {
    'positions.tsv': '0993b72f402e3c086d9c611f13074fec251d91982613c21d30c5ef9fcf058173',
    'pairs.tsv': '65632b35398a178711d2983b2d07eba8f0a6fb4636a75a60573ba4a54d7f18b2',
    'partner_diversity.tsv': 'a377a11b89831d969a2f4227b6447d2e8ed4367f01ccf23d4c3b28600f339b56',
    'positions_below_recurrence.tsv': 'faee673c66ca0c26c2891d717e5eb9f76115a7f1bc9d0c5bd1be1527caca9c1b',
    'activation_reference.tsv': 'ec18984c0588cecb820a5e29d833b8a8db8be7db9497716bc2cc452a9b7fbaa5',
    'activation_motifs.json': '4362387eca0c737accdbc3da37a28c2c982c49a137ab4f362bb78276c933bc81',
    'activation_recovery.tsv': 'f4f5e00c968f16dc7d5542b56fdc97cb11ea15de39afd467b9754f8511013715',
    'segments.tsv': 'abfa05d52739230f890b2551f8d2d73fe2a1b3a99508f36e40c868b1aa2c0f60',
    'interfaces.tsv': '1c812964181c628778c678014ca3500111027a4b26eeac21c75715c9f67d9303',
    'conservation_positions.tsv': '0061d9502a360e5cb6e3dbcbc46b89754a30783c3b0f90e963f90bc53fb3068a',
    '../supplement_2026-11-05b/FigS4b_recurrence_bands.tsv':
        '9f385757cb416e88d7553ea47ee2b07f4a666929581cc708881d629edb9651cb',
    '../supplement_2026-11-05b/ed14_a_conservation_strata_plotdata.tsv':
        '0bc8d101b4e3fdb7c9a4c607ba11c6f1d1df9706af0eb9f5967b815a6c38bedd',
}
#: The substitutions of the AlphaMissense comparison without a class in it (scripts/count_am_unclassified.py;
#: SUPP_DIR/PROVENANCE.md). Kept apart from PINS, which lists the outputs of scripts/build_class_tables.py.
AM_UNCLASSIFIED = 'am_unclassified.tsv'
AM_UNCLASSIFIED_SHA = 'c445a920a1ae604390e7f4f09b7e7775764c579503e325d7db96d4d1b6434b0e'

TOP_N = 50
#: Helix cells of the bundle: TM1 to TM7 and H8 (helix_pairs.json segments[:8]).
N_HELICES = 8
#: Ligand types need this many receptors for the median line of section 5.
LIGAND_MIN_MEDIAN = 5
#: Histogram: 1-unit bins; the chart draws [-HIST_DRAWN, +HIST_DRAWN).
HIST_DRAWN = 20
#: The ADRB2 snake layout, trimmed to this many residues before TM1 and after H8.
SCAFFOLD_GID = 'adrb2_human'
SCAFFOLD_BEFORE, SCAFFOLD_AFTER = 6, 8
SEGMENT_BLOCKS = {'bundle': 'Helices', 'outside': 'Loops and termini'}
#: Segments with fewer contact endpoints than this are kept in the payload and CSV but not drawn (ICL4: 35).
MIN_ENDPOINTS = 50
NUMBER_WORDS = {2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine',
                10: 'ten'}
MINUS = '−'


# --------------------------------------------------------------------------- tables
def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def table_path(name):
    return (CLASS_DIR / name).resolve() if not name.startswith('../') else (SUPP_DIR / name.split('/', 2)[2])


def _read(name, **kw):
    path = table_path(name)
    if not path.is_file():
        raise FileNotFoundError('%s is missing; it is written by scripts/build_class_tables.py' % path)
    got = _sha(path)
    if got != PINS[name]:
        raise ValueError('%s has sha256 %s, expected %s (see %s/PROVENANCE.md)' % (path, got, PINS[name],
                                                                                path.parent.name))
    if name.endswith('.json'):
        return json.loads(path.read_text(encoding='utf-8'))
    return pd.read_csv(path, sep='\t', keep_default_na=False, na_values=[''], **kw)


_TABLES = None


def load_am_unclassified():
    """SUPP_DIR/am_unclassified.tsv, sha256-asserted: gid, protein_position, ref_aa, alt_aa, generic_number, top50."""
    path = SUPP_DIR / AM_UNCLASSIFIED
    if not path.is_file():
        raise FileNotFoundError('%s is missing; it is written by scripts/count_am_unclassified.py' % path)
    got = _sha(path)
    if got != AM_UNCLASSIFIED_SHA:
        raise ValueError('%s has sha256 %s, expected %s (see %s/PROVENANCE.md)' % (path, got, AM_UNCLASSIFIED_SHA,
                                                                                SUPP_DIR.name))
    return pd.read_csv(path, sep='\t', keep_default_na=False, na_values=[''])


def load_class_tables():
    """Every table of the class folder and the two band tables, sha256-asserted (cached)."""
    global _TABLES
    if _TABLES is None:
        t = {name.split('/')[-1].rsplit('.', 1)[0]: _read(name) for name in PINS}
        t['positions'] = t['positions'].sort_values('cfr_score_rank').reset_index(drop=True)
        _TABLES = t
    return _TABLES


def motif_of():
    """{generic number: motif name} for the 16 positions of the five named motifs."""
    return {g: m['name'] for m in load_class_tables()['activation_motifs']['motifs'] for g in m['positions']}


def class_ranking():
    """positions.tsv as a DataFrame in CFR score order (the top 50 are the class CFR set), with a motif column."""
    p = load_class_tables()['positions'].copy()
    mo = motif_of()
    p['motif'] = [mo.get(g, '') for g in p['generic_number']]
    return p


def class_pairs():
    """pairs.tsv (2,231 rows), most recurrent first."""
    return load_class_tables()['pairs'].copy()


# --------------------------------------------------------------------------- small helpers
def _r(x, n):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), n)


def _s(x):
    """A table string cell: '' for an empty cell (read as NaN)."""
    return x if isinstance(x, str) else ''


def _median(values):
    return float(np.median(values)) if len(values) else None


def _int(n):
    return format(int(n), ',')


def _signed(x, n=2):
    s = '%.*f' % (n, abs(x))
    return (MINUS if x < 0 else '+') + s


def band_bounds(label):
    """'< 3' -> (0, 2); '3 to 28' -> (3, 28); '≥ 213' -> (213, None)."""
    lab = label.replace('≥', '>=').strip()
    if lab.startswith('<'):
        return 0, int(lab[1:].strip()) - 1
    if lab.startswith('>='):
        return int(lab[2:].strip()), None
    a, b = lab.split(' to ')
    return int(a), int(b)


def band_label(lo, hi):
    if lo == 0:
        return 'fewer than %d' % (hi + 1)
    if hi is None:
        return '%d or more' % lo
    return '%d to %d' % (lo, hi)


def band_index(n, bands):
    for k, b in enumerate(bands):
        if n >= b['lo'] and (b['hi'] is None or n <= b['hi']):
            return k
    return None


# --------------------------------------------------------------------------- class_scale
def build_class_scale(inputs, deltas):
    """census, receptors [gid, symbol, threshold, above_per_100] and the ΔRRCS histogram.

    inputs: class_atlas.ReceptorInput list; deltas: {gid: delta DataFrame} (store.delta_data)."""
    n_pairs = int(sum(i.n_pairs for i in inputs))
    n_above = int(sum(len(i.sig_delta) for i in inputs))
    thr = [i.threshold for i in inputs]
    per100 = [100.0 * len(i.sig_delta) / i.n_pairs for i in inputs if i.n_pairs]
    allv = np.concatenate([deltas[i.gid]['delta_rrcs'].to_numpy(dtype=float) for i in inputs])
    starts = np.floor(allv).astype(int)
    lo, hi = int(starts.min()), int(starts.max())
    counts = np.bincount(starts - lo, minlength=hi - lo + 1)
    hist = [[lo + k, int(c)] for k, c in enumerate(counts) if c]
    negative = int((allv < 0).sum())
    not_drawn = int(sum(c for s, c in hist if s < -HIST_DRAWN or s >= HIST_DRAWN))
    families = len({i.family for i in inputs})
    ligands = len({i.ligand for i in inputs})
    t = load_class_tables()
    return {
        'census': {
            'receptors': len(inputs), 'families': families, 'ligand_types': ligands,
            'pairs': n_pairs, 'above': n_above, 'share_above': _r(100.0 * n_above / n_pairs, 2),
            'threshold_min': _r(min(thr), 3), 'threshold_median': _r(_median(thr), 3),
            'threshold_max': _r(max(thr), 3), 'above_per_100_median': _r(_median(per100), 2),
            'negative_pairs': negative, 'recurrent_positions': int(len(t['positions'])), 'top_ranked': TOP_N,
        },
        'receptor_columns': ['gid', 'symbol', 'threshold', 'above_per_100'],
        'receptors': [[i.gid, i.symbol, _r(i.threshold, 3), _r(100.0 * len(i.sig_delta) / i.n_pairs, 2)]
                      for i in inputs],
        'histogram': hist,
        'histogram_rule': {'bin_width': 1, 'drawn_from': -HIST_DRAWN, 'drawn_to': HIST_DRAWN,
                           'not_drawn': not_drawn,
                           'note': 'Bin [start, start + 1) of ΔRRCS (active minus inactive), every contact pair.'},
    }


# --------------------------------------------------------------------------- helix pairs
def add_segments_interfaces(helix_payload):
    """helix_pairs.json: `interfaces` (pairs of TM1 to TM7, all contacts) and `segments_magnitude` (per contact
    endpoint, TM1 to TM7, H8, loops and termini)."""
    t = load_class_tables()
    n_rec = len(helix_payload.get('receptors') or []) or None
    helix_payload['interfaces'] = [
        {'seg_i': r.seg_i, 'seg_j': r.seg_j, 'n_contacts': int(r.n_contacts),
         'mean_abs_delta': _r(r.mean_abs_delta, 6), 'supported': str(r.supported) == 'True'}
        for r in t['interfaces'].itertuples()]
    helix_payload['segments_magnitude'] = [
        {'segment': r.segment, 'block': SEGMENT_BLOCKS.get(r.block, r.block), 'mean_abs_delta': _r(r.mean_abs_delta, 6),
         'median_abs_delta': _r(r.median_abs_delta, 6), 'endpoints': int(r.endpoints)}
        for r in t['segments'].itertuples()]
    helix_payload['magnitude_rule'] = {
        'interfaces': ('Mean |ΔRRCS| per contact over all contacts between two of TM1 to TM7, %s; supported = '
                       'at least 50 contacts. Pairs with H8 are not included.' % ('all %d receptors' % n_rec if n_rec else
                                                                     'all receptors')),
        'segments': ('Mean |ΔRRCS| per contact endpoint on the segment, over all contacts with full GPCRdb '
                     'residue maps; segments with fewer than %d endpoints are listed but not drawn.' % MIN_ENDPOINTS),
        'min_contacts': 50, 'min_endpoints': MIN_ENDPOINTS}
    return helix_payload


def build_helix_receptor_cells(cells_payload, helix_payload):
    """Each receptor's net ΔRRCS at the 36 helix cells [i, j] (i <= j < 8); null = no above-threshold pair.
    Rows follow helix_pairs.json `receptors`."""
    pairs = [[i, j] for i in range(N_HELICES) for j in range(i, N_HELICES)]
    col = {(i, j): k for k, (i, j) in enumerate(pairs)}
    n = len(helix_payload['receptors'])
    net = [[None] * len(pairs) for _ in range(n)]
    rc = cells_payload['receptor_columns']
    ri, ni = rc.index('receptor'), rc.index('net')
    for c in cells_payload['cells']:
        k = col.get((c['i'], c['j']))
        if k is None:
            continue
        for row in c['receptors']:
            net[row[ri]][k] = _r(row[ni], 3)
    return {'segments': helix_payload['segments'][:N_HELICES], 'pairs': pairs,
            'receptors': [r['gid'] for r in helix_payload['receptors']], 'net': net,
            'rule': 'net = signed sum of above-threshold ΔRRCS between the two helices in that receptor '
                    '(the helix_pair_cells.json value); null = no above-threshold pair there.'}


# --------------------------------------------------------------------------- class_positions
def _scaffold(pack):
    res = pack['residues']
    xy = (pack.get('snake') or {}).get('positions') or {}
    first = next(k for k, r in enumerate(res) if r[2] == 'TM1')
    last = max(k for k, r in enumerate(res) if r[2] == 'H8')
    keep = [r for r in res[max(0, first - SCAFFOLD_BEFORE): last + SCAFFOLD_AFTER + 1] if str(r[0]) in xy]
    return [[int(r[0]), r[1], r[2], r[3] or '', _r(xy[str(r[0])][0], 1), _r(xy[str(r[0])][1], 1)] for r in keep]


def build_class_positions(adrb2_pack=None, n_receptors=None):
    """ranking (368), bands, motifs, reference (39), partners (368), pairs (top 20 + totals), recovery (262),
    scaffold (ADRB2 snake, trimmed, with the receptor count of each residue's generic position) and
    conservation (352). n_receptors: the receptor count of the class tables (the build passes its own)."""
    t = load_class_tables()
    rank = class_ranking()
    n_rec = int(n_receptors) if n_receptors else int(round(float(
        (rank['n_receptors'] / rank['pct_receptors'] * 100.0).median())))
    count = {g: int(n) for g, n in zip(t['positions_below_recurrence']['generic_number'],
                                       t['positions_below_recurrence']['n_receptors'])}
    count.update({g: int(n) for g, n in zip(rank['generic_number'], rank['n_receptors'])})
    scaffold = [r + [count.get(r[3], 0) if r[3] else None] for r in _scaffold(adrb2_pack)] if adrb2_pack else []
    adrb2 = {}
    for num, aa, _seg, gn, _x, _y, _n in scaffold:
        if gn and gn not in adrb2:
            adrb2[gn] = '%s%d' % (aa, num)
    ref = t['activation_reference']
    known = set(ref['generic_number'])

    bands = []
    for b in t['FigS4b_recurrence_bands'].itertuples():
        lo, hi = band_bounds(b.band_receptors)
        bands.append({'lo': lo, 'hi': hi, 'label': band_label(lo, hi)})
    idx = [band_index(int(n), bands) for n in rank['n_receptors']]
    for k, b in enumerate(bands):
        b['positions'] = idx.count(k)

    ranking_cols = ['rank', 'recurrence_rank', 'gn', 'segment', 'n', 'pct', 'mean_abs_delta', 'cfr_score',
                    'motif', 'known', 'adrb2']
    ranking = [[int(r.cfr_score_rank), int(r.recurrence_rank), r.generic_number, r.segment, int(r.n_receptors),
                _r(r.pct_receptors, 4), _r(r.mean_abs_delta, 6), _r(r.cfr_score, 5), r.motif,
                int(r.generic_number in known), adrb2.get(r.generic_number, '')] for r in rank.itertuples()]

    top = set(rank['generic_number'].head(TOP_N))
    motifs = [{'name': m['name'], 'positions': m['positions'],
               'ranks': [int(rank.loc[rank.generic_number == g, 'cfr_score_rank'].iat[0]) for g in m['positions']]}
              for m in t['activation_motifs']['motifs']]
    n_motif = sum(len(m['positions']) for m in motifs)
    n_motif_top = sum(1 for m in motifs for g in m['positions'] if g in top)

    div = t['partner_diversity'].merge(rank[['generic_number', 'recurrence_rank']], on='generic_number')
    div = div.sort_values('recurrence_rank')
    partners = [[r.generic_number, int(r.recurrence_rank), int(r.n_receptors), int(r.n_distinct_partners),
                 _s(r.top_partner), int(r.top_partner_n_receptors)] for r in div.itertuples()]

    pr = class_pairs()
    pairs_top = [[r.cfr_1, r.cfr_2, int(r.n_receptors), _r(r.pct_receptors, 4), bool(r.both_ends_top50)]
                 for r in pr.head(20).itertuples()]

    rc = t['activation_recovery']
    M, K = len(rc), int(rc['known'].sum())
    recovery_rows = [[int(r.rank_in_universe), int(r.cfr_score_rank), r.struct_number, r.generic_number,
                      int(r.known), _s(r.motif), int(r.known_found), _r(r.expected, 4)]
                     for r in rc.itertuples()]
    cuts = {}
    for n in (10, 50):
        row = rc.iloc[n - 1]
        cuts[str(n)] = {'known_found': int(row.known_found), 'expected': _r(row.expected, 4)}

    cons = t['conservation_positions']
    cons_rows = [[r.gn_display, _r(r.mean_conservation, 4), int(r.n_residues), int(r.top50_by_cfr_score)]
                 for r in cons.itertuples()]
    ct = cons[cons.top50_by_cfr_score == 1].mean_conservation
    co = cons[cons.top50_by_cfr_score == 0].mean_conservation

    return {
        'n_receptors': n_rec,
        'ranking_columns': ranking_cols,
        'ranking': ranking,
        'top_n': TOP_N,
        'bands': bands,
        'band_rule': ('Receptors (of %d) in which the generic position is a CFR; positions = how many of the %d '
                      'recurrent positions fall in the band.' % (n_rec, len(rank))),
        'motifs': motifs,
        'motif_counts': {'positions': n_motif, 'in_top': n_motif_top},
        'reference_columns': ['gn', 'struct_number', 'motif', 'group', 'zhou2019', 'class_a_motif'],
        'reference': [[r.generic_number, r.struct_number, _s(r.motif), _s(r.group), int(r.zhou2019),
                       int(r.class_a_motif)]
                      for r in ref.itertuples()],
        'reference_source': ('Zhou et al. 2019 common activation pathway, plus D2.50, DRY, PIF, CWxP, NPxxY, the '
                             'sodium pocket and 6.30'),
        'partner_columns': ['gn', 'recurrence_rank', 'n', 'distinct_partners', 'top_partner', 'top_partner_n'],
        'partners': partners,
        'pairs': {'columns': ['cfr_1', 'cfr_2', 'n', 'pct', 'both_ends_top50'], 'top': pairs_top,
                  'n_distinct': int(len(pr)), 'n_both_top50': int(pr['both_ends_top50'].sum()),
                  'top_all_both_top50': bool(pr.head(20)['both_ends_top50'].all())},
        'recovery': {'universe': M, 'known': K,
                     'top_in_universe': int(len(top & set(rc['generic_number']))),
                     'columns': ['rank_in_universe', 'cfr_score_rank', 'struct', 'gn', 'known', 'motif',
                                 'known_found', 'expected'],
                     'rows': recovery_rows, 'cuts': cuts,
                     'rule': ('The %d structure positions (GPCRdb structure-based numbers) numbered in at least %d '
                              'of the %d receptors, in CFR score order. A structure position takes the highest CFR '
                              'score among its generic numbers (gn = that one); expected = rank x known / universe.'
                              % (M, -(-n_rec // 2), n_rec))},
        'scaffold': {'gid': SCAFFOLD_GID, 'gene': (adrb2_pack or {}).get('meta', {}).get('gene', ''),
                     'columns': ['num', 'aa', 'segment', 'gn', 'x', 'y', 'n'], 'residues': scaffold,
                     'n_rule': ('n: receptors with a CFR at the generic position (null: no generic number), from the '
                                '368 recurrent positions and the positions that are a CFR in 1 or 2 receptors.'),
                     'source': 'ADRB2 snake plot layout from GPCRdb'},
        'conservation': {'columns': ['gn', 'mean', 'n_residues', 'top50'], 'rows': cons_rows,
                         'median_top': _r(ct.median(), 4), 'median_other': _r(co.median(), 4),
                         'n_top': int(len(ct)), 'n_other': int(len(co)), 'min_residues': 20},
    }


# --------------------------------------------------------------------------- class_variants
def build_class_variants(am_summary=None):
    """AlphaMissense classes of the 276-receptor allele set: the two groups (decisive shares), the six recurrence
    bands and the five conservation fifths. Counts only: no odds ratio, interval or test."""
    from .manuscript_stats import load_am_comparison
    am = am_summary or load_am_comparison()
    t = load_class_tables()
    groups = []
    for key, g, pct in zip(('top50', 'other'), am['groups'], (am['decisive_pct']['top'], am['decisive_pct']['other'])):
        groups.append({'key': key, 'label': g['label'], 'scored': g['n'], 'decisive': g['decisive'],
                       'predicted_pathogenic': g['pathogenic_n'], 'ambiguous': g['ambiguous_n'],
                       'predicted_benign': g['benign_n'],
                       'pct_predicted_pathogenic_of_decisive': pct,
                       'pct_of_scored': {'predicted_pathogenic': 100.0 * g['pathogenic_n'] / g['n'],
                                         'ambiguous': 100.0 * g['ambiguous_n'] / g['n'],
                                         'predicted_benign': 100.0 * g['benign_n'] / g['n']}})
    bands = []
    for b in t['FigS4b_recurrence_bands'].itertuples():
        lo, hi = band_bounds(b.band_receptors)
        bands.append({'lo': lo, 'hi': hi, 'label': band_label(lo, hi), 'positions': int(b.positions),
                      'substitutions': int(b.substitutions), 'predicted_pathogenic': int(b.pathogenic),
                      'ambiguous': int(b.ambiguous), 'predicted_benign': int(b.benign),
                      'decisive': int(b.pathogenic + b.benign),
                      'pct_predicted_pathogenic_of_decisive': float(b.pct_pathogenic_of_decisive)})
    fifths = []
    for q in t['ed14_a_conservation_strata_plotdata'].itertuples():
        fifths.append({'fifth': int(q.quintile), 'conservation_from': float(q.cons_lo), 'conservation_to': float(q.cons_hi),
                       'top50_predicted_pathogenic': int(q.lead_path), 'top50_decisive': int(q.lead_n),
                       'top50_pct': float(q.lead_pct),
                       'other_predicted_pathogenic': int(q.rest_path), 'other_decisive': int(q.rest_n),
                       'other_pct': float(q.rest_pct)})
    un = load_am_unclassified()
    unclassified = {'substitutions': int(len(un)), 'top50': int(un['top50'].sum()),
                    'receptors': int(un['gid'].nunique())}
    totals = {'decisive_groups': sum(g['decisive'] for g in groups),
              'decisive_bands': sum(b['decisive'] for b in bands),
              'decisive_fifths': sum(f['top50_decisive'] + f['other_decisive'] for f in fifths),
              'positions_bands': sum(b['positions'] for b in bands)}
    return {
        'receptors': am['receptors'],
        'groups': groups,
        'bands': bands,
        'fifths': fifths,
        'totals': totals,
        'unclassified': unclassified,
        'notes': {
            'groups': 'Unique missense substitutions with an AlphaMissense call at generic-numbered positions; '
                      'decisive = predicted pathogenic or predicted benign.',
            'bands': 'Positions grouped by the number of receptors in which they are a CFR; residues with a '
                     'modeled contact.',
            'fifths': 'Decisive calls on residues with a conservation score and a modeled contact, split into five '
                      'groups by conservation, lowest first.'},
    }


# --------------------------------------------------------------------------- atlas map
def build_atlas_map(index):
    """atlas_map.json from atlas/index.json: [gid, x, y, ligand group index] per receptor."""
    from .class_atlas import ligand_group
    groups = [g['key'] for g in index['ligand_groups']]
    gi = {g: k for k, g in enumerate(groups)}
    rows = [[r['gid'], _r(r['sim_xy'][0], 3), _r(r['sim_xy'][1], 3), gi[ligand_group(r['ligand'])]]
            for r in index['receptors']]
    return {'schema': 'gpcompare-stats/atlas_map@1', 'columns': ['gid', 'x', 'y', 'group'], 'rows': rows,
            'ligand_groups': index['ligand_groups'],
            'note': 'Receptors placed by the similarity of their contact-change patterns (the GPCRome Atlas map). '
                    'A browsing aid, not a classification.'}


def write_atlas_map(index, out_dir):
    path = Path(out_dir) / 'data' / 'stats' / 'atlas_map.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(build_atlas_map(index), separators=(',', ':'), allow_nan=False), encoding='utf-8')
    if (path.parent / 'manifest.json').is_file():   # a site build: the manifest lists the new file too
        from .class_atlas import write_manifest
        write_manifest(out_dir)
    return path


# --------------------------------------------------------------------------- HGNC names
def _hgnc_records():
    sdir = Path(os.environ.get('SEARCH_SOURCES', BASE / 'search_sources'))
    path = sdir / 'hgnc' / 'hgnc_records.json.gz'
    if not path.is_file():
        return {}
    with gzip.open(path, 'rt', encoding='utf-8') as fh:
        return json.load(fh)


def hgnc_names(gids):
    """{gid: HGNC approved name} from the search sources (search_sources/hgnc), or {} when absent."""
    recs = _hgnc_records()
    return {g: (recs.get(g) or {}).get('name') or None for g in gids} if recs else {}


def receptor_labels(gids, symbols=None):
    """{gid: label}: the site's gene symbol (symbols, else the UniProt entry stem), followed by the HGNC symbol
    when that differs other than by a pseudogene 'P' ('GPR182 (ACKR5)'; 'TAAR3P' and 'NPY6R' as on the site)."""
    recs = _hgnc_records()
    symbols = symbols or {}
    out = {}
    for g in gids:
        stem = g.split('_')[0].upper()
        site = symbols.get(g) or stem
        sym = (recs.get(g) or {}).get('symbol') or site
        same = {site, site + 'P', stem, stem + 'P'}
        out[g] = site if sym in same else '%s (%s)' % (site, sym)
    return out


def names_list(labels):
    """'A', 'A and B', 'A, B and C'."""
    labels = list(labels)
    return labels[0] if len(labels) == 1 else ', '.join(labels[:-1]) + ' and ' + labels[-1]


# --------------------------------------------------------------------------- sentences
def _helix_extremes(hp):
    segs = hp['segments']
    cols = hp['summary_columns']
    allg = next(g for g in hp['groups'] if g['key'] == 'all')
    rows = [dict(zip(cols, c)) for c in allg['cells']]
    rows = [r for r in rows if r['i'] < N_HELICES and r['j'] < N_HELICES and r['i'] != r['j']
            and r['n_present'] >= hp['min_receptors']]
    neg = min(rows, key=lambda r: r['mean_net'])
    pos = max(rows, key=lambda r: r['mean_net'])
    name = lambda r: '%s-%s' % (segs[r['i']], segs[r['j']])  # noqa: E731
    return ({'pair': name(neg), 'a': segs[neg['i']], 'b': segs[neg['j']], 'mean_net': neg['mean_net'],
             'n': neg['n_down'], 'of': neg['n_present']},
            {'pair': name(pos), 'a': segs[pos['i']], 'b': segs[pos['j']], 'mean_net': pos['mean_net'],
             'n': pos['n_up'], 'of': pos['n_present']})


def _motif_letter(gn):
    """'the R of the DRY motif' for a position of a motif whose name spells its positions, else ''."""
    for m in load_class_tables()['activation_motifs']['motifs']:
        if gn in m['positions'] and len(m['name']) == len(m['positions']):
            letter = m['name'][m['positions'].index(gn)]
            if letter.isalpha() and letter.isupper():
                return 'the %s of the %s motif' % (letter, m['name'])
    return ''


def _motif_short(gn):
    """'R of DRY' for a position of a motif whose name spells its positions, else ''."""
    m = re.match(r'the (\w) of the (\S+) motif$', _motif_letter(gn))
    return '%s of %s' % m.groups() if m else ''


def _ligand_medians(receptors_payload):
    cols = receptors_payload['columns']
    df = pd.DataFrame(receptors_payload['rows'], columns=cols)
    g = df.groupby('ligand')['sum_abs']
    med = g.median()[g.size() >= LIGAND_MIN_MEDIAN]
    lo, hi = med.idxmin(), med.idxmax()
    return {'low': lo, 'low_median': float(med[lo]), 'high': hi, 'high_median': float(med[hi]),
            'min_receptors': LIGAND_MIN_MEDIAN}


def finding_values(payloads):
    """The values the findings and glance facts print, from the payloads (tests recompute them)."""
    sc = payloads['class_scale']['census']
    pos = payloads['class_positions']
    cv = payloads['class_variants']
    neg, posi = _helix_extremes(payloads['helix_pairs'])
    first = dict(zip(pos['ranking_columns'], pos['ranking'][0]))
    top_band = pos['bands'][-1]
    n_top_band = top_band['positions']
    g_top, g_oth = cv['groups']
    return {
        'scale': {'above': sc['above'], 'pairs': sc['pairs'], 'share': sc['share_above'],
                  'thr_min': sc['threshold_min'], 'thr_max': sc['threshold_max']},
        'bundle': {'down': neg, 'up': posi},
        'positions': {'gn': first['gn'], 'n': first['n'], 'of': pos['n_receptors'], 'motif': _motif_letter(first['gn']),
                      'motif_short': _motif_short(first['gn']),
                      'n_top_band': n_top_band, 'top_band_lo': top_band['lo']},
        'variants': {'top': g_top['pct_predicted_pathogenic_of_decisive'],
                     'other': g_oth['pct_predicted_pathogenic_of_decisive']},
        'receptors': _ligand_medians(payloads['receptors']),
    }


def finding_sentences(payloads):
    """The five section findings ({anchor: text}) and the four glance facts, as plain strings."""
    v = finding_values(payloads)
    s, b, p, va, r = v['scale'], v['bundle'], v['positions'], v['variants'], v['receptors']
    d, u = b['down'], b['up']
    lig = lambda name: name.lower()  # noqa: E731
    low_lig = lig(r['low'])
    if low_lig.endswith(' receptors') and lig(r['high']).endswith(' receptors'):
        low_lig = low_lig[:-len(' receptors')]
    # section headlines: at most 12 words, the numbers carry them
    findings = {
        'sec-scale': '%s of %s contact pairs (%.1f%%) pass their receptor\'s threshold.'
                     % (_int(s['above']), _int(s['pairs']), s['share']),
        'sec-a': ('%s weaker in %d of %d, %s stronger in %d of %d.'
                  % (d['pair'], d['n'], d['of'], u['pair'], u['n'], u['of'])),
        'sec-c': ('%s%s is a CFR in %d of %d receptors.'
                  % (p['gn'], (' (%s)' % p['motif_short']) if p['motif_short'] else '', p['n'], p['of'])),
        'sec-d': ('%.1f%% predicted pathogenic at the %d top-ranked positions, %.1f%% at others.'
                  % (va['top'], TOP_N, va['other'])),
        'sec-e': ('Median total |ΔRRCS| from %.0f in %s to %.0f in %s.'
                  % (r['low_median'], low_lig, r['high_median'], lig(r['high']))),
    }
    # glance tiles: a big number and a label of at most six words
    glance = [
        {'key': 'scale', 'href': '#sec-scale', 'big': '%.1f%%' % s['share'], 'line': 'of contact pairs pass threshold',
         'bar': round(s['share'] / 100.0, 4)},
        {'key': 'bundle', 'href': '#sec-a', 'big': d['pair'], 'line': 'weaker in the active model',
         'cells': [{'pair': d['pair'], 'mean_net': d['mean_net'], 'value': _signed(d['mean_net'])},
                   {'pair': u['pair'], 'mean_net': u['mean_net'], 'value': _signed(u['mean_net'])}]},
        {'key': 'positions', 'href': '#sec-c', 'big': '%d of %d' % (p['n'], p['of']), 'line': 'have a CFR at %s' % p['gn'],
         'bar': round(p['n'] / float(p['of']), 4)},
        {'key': 'variants', 'href': '#sec-d', 'big': '%.1f%% vs %.1f%%' % (va['top'], va['other']),
         'line': 'predicted pathogenic, top-ranked vs other',
         'bars': [round(va['top'] / 100.0, 4), round(va['other'] / 100.0, 4)]},
    ]
    return {'findings': findings, 'glance': glance}


def computed_notes(payloads):
    """The other computed guide lines of the spec (histogram, segments, ranking, recovery, variants)."""
    sc = payloads['class_scale']
    c = sc['census']
    hp = payloads['helix_pairs']
    pos = payloads['class_positions']
    cv = payloads['class_variants']
    floor = hp.get('magnitude_rule', {}).get('min_endpoints', MIN_ENDPOINTS)
    seg = [s for s in hp['segments_magnitude'] if s['endpoints'] >= floor]
    few = [s for s in hp['segments_magnitude'] if s['endpoints'] < floor]
    helices = [s for s in seg if s['block'] == 'Helices']
    loops = [s for s in seg if s['block'] != 'Helices']
    hs = sorted(helices, key=lambda s: -s['mean_abs_delta'])
    low = round(min(s['mean_abs_delta'] for s in helices), 2)
    lows = [s['segment'] for s in helices if round(s['mean_abs_delta'], 2) == low]
    rk = [dict(zip(pos['ranking_columns'], r)) for r in pos['ranking'][:TOP_N]]
    outlier = max(rk, key=lambda r: r['mean_abs_delta'])
    rec = pos['recovery']
    t = cv['totals']
    out = {
        'histogram': ('Each bar counts contact pairs by ΔRRCS (active minus inactive). %s of %s pairs (%.1f%%) are '
                      'stronger in the inactive model. %d pairs beyond ±%d are not drawn.'
                      % (_int(c['negative_pairs']), _int(c['pairs']), 100.0 * c['negative_pairs'] / c['pairs'],
                         sc['histogram_rule']['not_drawn'], HIST_DRAWN)),
        'segments': ('Mean |ΔRRCS| per contact endpoint, over all contacts with full GPCRdb residue maps. Highest '
                     'in the bundle: %s %.2f and %s %.2f; lowest: %s %.2f. Loops and termini: %.2f to %.2f.'
                     % (hs[0]['segment'], hs[0]['mean_abs_delta'], hs[1]['segment'], hs[1]['mean_abs_delta'],
                        ' and '.join(lows), low, min(s['mean_abs_delta'] for s in loops),
                        max(s['mean_abs_delta'] for s in loops))
                     + ''.join(' %s (%s endpoints) is not drawn: fewer than %d.' % (s['segment'], _int(s['endpoints']),
                                                                                    floor) for s in few)),
        'ranking_outlier': ('%s is a CFR in only %d receptors and ranks %d by CFR score because its mean |ΔRRCS| '
                            '(%.2f) is the largest of the %d.' % (outlier['gn'], outlier['n'], outlier['rank'],
                                                                  outlier['mean_abs_delta'], TOP_N)),
        'motifs_in_top': '%d of the %d motif positions are in the top %d.' % (
            pos['motif_counts']['in_top'], pos['motif_counts']['positions'], TOP_N),
        'recovery_points': ['%d of the first %s · %.1f expected by chance' % (v['known_found'], n, v['expected'])
                            for n, v in rec['cuts'].items()],
        'am_bands_method': ('Same substitutions as above, on residues with a modeled contact. The six groups hold '
                            '%s decisive calls; the comparison above counts %s, because %d calls sit on '
                            'generic-numbered residues without a modeled contact.'
                            % (_int(t['decisive_bands']), _int(t['decisive_groups']),
                               t['decisive_groups'] - t['decisive_bands'])),
        'am_fifths_guide_count': '%s decisive calls on residues with a conservation score and a modeled contact.'
                                 % _int(t['decisive_fifths']),
        'am_fifths_method': ('%d decisive calls without a conservation score fall outside the five groups '
                             '(%s %s %s).' % (t['decisive_bands'] - t['decisive_fifths'], _int(t['decisive_bands']),
                                              MINUS, _int(t['decisive_fifths']))),
    }
    return out


# --------------------------------------------------------------------------- coverage rows (Methods)
def coverage_rows(total, rrcs_label, numbering_label, recovery, conservation, am_receptors, am_dropped,
                  am_no_records, batch_gnomad, site_gnomad, clinvar, alphamissense, conservation_label,
                  variants_receptors, variants_none, maps_label=None, maps_exception=None):
    """The "What each result covers" rows; coverage.csv is written from the same rows. Name lists are labels
    (receptor_labels), in gid order. numbering_label: the per-receptor GPCRdb numbering (packs); maps_label: the
    GPCRdb residue maps of the class tables, maps_exception the receptor numbered otherwise in the ranked ones."""
    names = names_list
    maps = maps_label or numbering_label
    ranked_maps = '%s (%s)' % (maps, maps_exception) if maps_exception else maps
    return [
        {'results': 'Scale, helix bundle, every receptor at the top-ranked positions, receptor explorer',
         'receptors': str(total), 'data': '%s; %s' % (rrcs_label, numbering_label), 'not_included': ''},
        {'results': 'Ranked positions, scaffold, partners and pairs', 'receptors': str(total),
         'data': '%s; %s' % (rrcs_label, ranked_maps), 'not_included': ''},
        {'results': 'Change per contact by segment and helix pair (Magnitude)', 'receptors': str(total),
         'data': '%s; %s' % (rrcs_label, ranked_maps), 'not_included': ''},
        {'results': 'Known activation positions',
         'receptors': '%d structure positions numbered in at least half of the receptors; %d known'
                      % (recovery['universe'], recovery['known']),
         'data': 'as the ranked positions', 'not_included': ''},
        {'results': 'Conservation at top-ranked and other positions',
         'receptors': '%d positions with at least %d scored residues'
                      % (conservation['n_top'] + conservation['n_other'], conservation['min_residues']),
         'data': ('%s; generic numbers from its own residue mapping (a position can count one residue more or '
                  'fewer)' % conservation_label),
         'not_included': 'positions with fewer scored residues'},
        {'results': 'AlphaMissense comparison, recurrence groups, conservation groups', 'receptors': str(am_receptors),
         'data': '%s, %s' % (batch_gnomad, alphamissense),
         'not_included': '%s. %s: no records in that query.' % (names(am_dropped), names(am_no_records))},
        {'results': 'Variants at each top-ranked position', 'receptors': str(variants_receptors),
         'data': '%s, %s, %s' % (site_gnomad, clinvar, alphamissense),
         'not_included': ('%s: no protein-coding missense records' % names(variants_none)) if variants_none else ''},
    ]


# --------------------------------------------------------------------------- CSVs
def _csv(header, rows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def csv_tables(payloads):
    """{filename: CSV text} of the class payloads, plain column names, no preamble."""
    sc = payloads['class_scale']
    hp = payloads['helix_pairs']
    pos = payloads['class_positions']
    cv = payloads['class_variants']
    segs = hp['segments']
    cols = hp['summary_columns']
    hp_rows = []
    for g in hp['groups']:
        for c in g['cells']:
            d = dict(zip(cols, c))
            hp_rows.append([g['key'], segs[d['i']], segs[d['j']], d['n_present'], d['coverage'], d['mean_net'],
                            _r(100.0 * d['agree'], 1) if d['agree'] is not None else '', d['n_up'], d['n_down'],
                            d['n_pairs']])
    rank = [dict(zip(pos['ranking_columns'], r)) for r in pos['ranking']]
    t = load_class_tables()
    pr = class_pairs()
    rc = t['activation_recovery']
    return {
        'thresholds.csv': _csv(['gid', 'symbol', 'threshold', 'above_per_100'], sc['receptors']),
        'histogram.csv': _csv(['bin_start', 'bin_end', 'pairs'], [[s, s + 1, n] for s, n in sc['histogram']]),
        'helix_pairs.csv': _csv(['group', 'segment_a', 'segment_b', 'receptors_carrying', 'coverage',
                                 'mean_net_drrcs', 'pct_agree', 'n_stronger_active', 'n_stronger_inactive',
                                 'above_threshold_pairs'], hp_rows),
        'helix_interfaces.csv': _csv(['helix_a', 'helix_b', 'contacts', 'mean_abs_drrcs', 'at_least_50_contacts'],
                                     [[x['seg_i'], x['seg_j'], x['n_contacts'], x['mean_abs_delta'],
                                       'yes' if x['supported'] else 'no'] for x in hp['interfaces']]),
        'segments.csv': _csv(['segment', 'block', 'mean_abs_drrcs', 'median_abs_drrcs', 'endpoints'],
                             [[x['segment'], x['block'], x['mean_abs_delta'], x['median_abs_delta'], x['endpoints']]
                              for x in hp['segments_magnitude']]),
        'ranking_368.csv': _csv(['cfr_score_rank', 'recurrence_rank', 'generic_number', 'segment', 'receptors',
                                 'pct_receptors', 'mean_abs_drrcs', 'cfr_score', 'motif'],
                                [[r['rank'], r['recurrence_rank'], r['gn'], r['segment'], r['n'], r['pct'],
                                  r['mean_abs_delta'], r['cfr_score'], r['motif']] for r in rank]),
        'activation_recovery.csv': _csv(list(rc.columns),
                                        [[('' if (isinstance(v, float) and math.isnan(v)) else v) for v in row]
                                         for row in rc.itertuples(index=False)]),
        'partners.csv': _csv(['generic_number', 'recurrence_rank', 'receptors', 'distinct_partners', 'top_partner',
                              'top_partner_receptors'], pos['partners']),
        'pairs.csv': _csv(['cfr_1', 'cfr_2', 'receptors', 'pct', 'both_ends_top50'],
                          [[r.cfr_1, r.cfr_2, int(r.n_receptors), r.pct_receptors,
                            'yes' if bool(r.both_ends_top50) else 'no'] for r in pr.itertuples()]),
        'am_comparison.csv': _csv(['group', 'scored', 'decisive', 'predicted_pathogenic', 'ambiguous',
                                   'predicted_benign', 'pct_predicted_pathogenic_of_decisive'],
                                  [[g['label'], g['scored'], g['decisive'], g['predicted_pathogenic'], g['ambiguous'],
                                    g['predicted_benign'], _r(g['pct_predicted_pathogenic_of_decisive'], 4)]
                                   for g in cv['groups']]),
        'am_bands.csv': _csv(['band', 'positions', 'substitutions', 'predicted_pathogenic', 'ambiguous',
                              'predicted_benign', 'pct_predicted_pathogenic_of_decisive'],
                             [[b['label'], b['positions'], b['substitutions'], b['predicted_pathogenic'], b['ambiguous'],
                               b['predicted_benign'], _r(b['pct_predicted_pathogenic_of_decisive'], 4)]
                              for b in cv['bands']]),
        'am_conservation_fifths.csv': _csv(
            ['fifth', 'conservation_from', 'conservation_to', 'top50_predicted_pathogenic', 'top50_decisive',
             'top50_pct', 'other_predicted_pathogenic', 'other_decisive', 'other_pct'],
            [[f['fifth'], f['conservation_from'], f['conservation_to'], f['top50_predicted_pathogenic'],
              f['top50_decisive'], _r(f['top50_pct'], 4), f['other_predicted_pathogenic'], f['other_decisive'],
              _r(f['other_pct'], 4)] for f in cv['fifths']]),
        'position_conservation.csv': _csv(['generic_number', 'mean_conservation', 'scored_residues', 'top50'],
                                          [[g, m, n, 'yes' if tp else 'no']
                                           for g, m, n, tp in pos['conservation']['rows']]),
    }


def coverage_csv(rows):
    return _csv(['results', 'receptors', 'data', 'not_included'],
                [[r['results'], r['receptors'], r['data'], r['not_included']] for r in rows])
