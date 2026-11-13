#!/usr/bin/env python3
"""Build GPCompaReports_v2/data/class_tables_2026-11-13/: the class-wide tables of the Statistics page.

Run by hand, never by the site build (its inputs live outside the repository). The build reads the
outputs and asserts their sha256 (analysis/class_results.py PINS).

What it does, in order:

1. Recomputes the recurrence tables with the canonical rule (per receptor, contact pairs with |dRRCS| at
   or above mean + SD of |dRRCS|, at least 0.2; a residue is a CFR when it is in one such pair; positions
   that are CFRs in 3 or more receptors are recurrent; CFR score = mean of normalized receptor count and
   normalized mean |dRRCS|) and asserts that the canonical numbering (the figures_overhaul GPCRdb residue
   maps) reproduces full_cfr_positions.tsv, full_cfr_pairs.tsv and partner_diversity.tsv.
2. Reruns it with GPR4 on its own GPCRdb entry (the Studio pack; its residue map in the canonical set was
   GPR42's) and writes positions.tsv, pairs.tsv, partner_diversity.tsv and positions_below_recurrence.tsv
   (positions that are CFRs in 1 or 2 receptors) from that run.
3. Writes the activation reference (39 positions: the Zhou et al. 2019 common activation pathway plus the
   class A motifs, the e19 known set), the five named motifs, and the recovery curve of the reference down
   the corrected ranking over the e19 universe (positions numbered in at least half of the receptors).
4. Copies the segment, interface and per-position conservation tables byte for byte, and the two
   AlphaMissense band tables into data/supplement_2026-11-05b/.
5. Writes checks.json (every check with its detail, sha256 of every input and output) and PROVENANCE.md.

Nothing is written unless every check passes.

    .venv-test/bin/python -I scripts/build_class_tables.py [--dry-run] [paths...]
"""
import argparse
import ast
import glob
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats as sstats

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'GPCompaReports_v2'
OUT_DEFAULT = SITE / 'data' / 'class_tables_2026-11-13'
SUPP_DEFAULT = SITE / 'data' / 'supplement_2026-11-05b'
HOME = Path.home()
GS = HOME / 'Documents' / 'gpcr_synth'
FO = HOME / 'research' / 'tggr_gpcr_ready_for_the final_draft' / 'figures_overhaul' / '_analysis'
DLV = GS / 'NEW_manuscript' / 'GPCompaRe_Finishing_2026-10-31' / 'deliverables'
DEFAULTS = {
    'batch': GS / 'The Ultimate RRCS database project' / 'alphafold_multistate_gpcr' / 'The_batch_RRCS_analyzer'
             / 'batch_analysis_full' / 'batch_analysis_20260202_151051' / 'csv_data',
    'analysis': FO,
    'packs': GS / 'gpcompare_studio_web' / '.claude' / 'worktrees' / 'main-merge' / 'public' / 'pack',
    'zhou_ts': GS / 'gpcompare_studio_web' / '.claude' / 'worktrees' / 'main-merge' / 'src' / 'engine' / 'state'
               / 'zhou2019.ts',
    'motifs_src': GS / 'side_quests' / 'clinvar_cfr_2026-10-20' / 'novel_cfrs.py',
    'e19': GS / 'cfr_main_quest' / 'exploration' / 'e18' / 'out',
    'features': GS / 'cfr_main_quest' / 'wp0' / 'residue_features.tsv.gz',
    'supp_tables': DLV / '02_supplement' / 'source_tables',
    'panels': DLV / '02_supplement' / 'code' / 'panels',
    'f3a': DLV / '03_main_figures' / 'source_tables' / 'F3a_conservation_by_generic_position.tsv',
    'kit': HOME / 'scratch' / '2026-11-07_draft_kit' / '03_numbers' / 'evidence' / 'recurrence' / 'positions_pack_gpr4.tsv',
    'receptors_csv': HOME / 'scratch' / '2026-11-12_gpcrome_atlas' / 'release' / 'stage' / 'data' / 'stats' / 'receptors.csv',
    's3': SITE / 'data' / 'manuscript_2026-08-24' / 'S3_top50_recurrent_cfr_positions.csv',
    's5': SITE / 'data' / 'manuscript_2026-08-24' / 'S5_top20_recurrent_cfr_pairs.csv',
}

N_REC = 283
#: The five named activation motifs, as structure-based numbers (class A).
NAMED_MOTIFS = {'D2.50': ['2x50'], 'DRY': ['3x49', '3x50', '3x51'], 'PIF': ['3x40', '5x50', '6x44'],
                'CWxP': ['6x47', '6x48', '6x49', '6x50'], 'NPxxY': ['7x49', '7x50', '7x51', '7x52', '7x53']}
#: Other class A motif positions of the reference set: the sodium pocket and the ionic-lock partner 6.30.
OTHER_GROUPS = {'3x39': 'sodium pocket', '7x45': 'sodium pocket', '7x46': 'sodium pocket', '6x30': '6.30'}
#: e19 cut points of the recovery curve: {first N: known positions found}.
E19_CUTS = {10: 8, 20: 14, 30: 16, 40: 18, 50: 20, 60: 21, 80: 23, 100: 27, 120: 28}

checks = {}


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def tilde(p):
    s = str(p)
    return '~' + s[len(str(HOME)):] if s.startswith(str(HOME)) else s


def check(name, ok, detail=''):
    checks[name] = {'ok': bool(ok), 'detail': detail}
    print(('PASS ' if ok else 'FAIL ') + name + (': ' + str(detail) if detail != '' else ''))


def struct_number(gn):
    """'6.37x37' -> '6x37'; '45.51x51' -> '45x51'."""
    return '%sx%s' % (gn.split('.')[0], gn.split('x')[1]) if 'x' in gn else ''


# ------------------------------------------------------------------ the canonical rule
def load_deltas(batch):
    deltas = {}
    for f in sorted(glob.glob(str(Path(batch) / '*_rrcs_delta.csv'))):
        g = os.path.basename(f).replace('_rrcs_delta.csv', '')
        d = pd.read_csv(f, usecols=['res1', 'res2', 'delta_rrcs'])
        a = d.delta_rrcs.abs()
        thr = max(a.mean() + a.std(ddof=1), 0.2)
        deltas[g] = (d[a >= thr].to_numpy(), thr, len(d))
    return deltas


def legacy_map(analysis, g):
    m, s = {}, {}
    for r in json.load(open(Path(analysis) / 'gpcrdb_residues' / ('%s.json' % g))):
        gn = (r.get('display_generic_number') or '').strip()
        if gn:
            m[int(r['sequence_number'])] = gn
            s[int(r['sequence_number'])] = (r.get('protein_segment') or '').strip()
    return m, s


def pack_map(packs, g):
    m, s = {}, {}
    for r in json.load(open(Path(packs) / ('%s.json' % g)))['residues']:
        if r[3] and r[3].strip():
            m[int(r[0])] = r[3].strip()
            s[int(r[0])] = r[2]
    return m, s


def run(deltas, numbering):
    """(positions, pairs, partner diversity, rare positions) under the canonical rule; numbering(gid) -> (map,
    segments). Rare positions: generic positions that are CFRs in 1 or 2 receptors (not recurrent)."""
    pos_count, pos_d, pos_seg = Counter(), defaultdict(list), {}
    pair_rec = defaultdict(set)
    partners, pcount = defaultdict(set), defaultdict(Counter)
    for g, (sig, _thr, _n) in deltas.items():
        m, s = numbering(g)
        seen = set()
        for r1, r2, dl in sig:
            g1, g2 = m.get(int(r1), ''), m.get(int(r2), '')
            for gn, p in ((g1, int(r1)), (g2, int(r2))):
                if gn:
                    if gn not in seen:
                        seen.add(gn)
                        pos_count[gn] += 1
                        pos_seg.setdefault(gn, s.get(p, ''))
                    pos_d[gn].append(abs(dl))
            if g1 and g2 and g1 != g2:
                pair_rec[tuple(sorted((g1, g2)))].add(g)
                partners[g1].add(g2)
                partners[g2].add(g1)
                pcount[g1][g2] += 1
                pcount[g2][g1] += 1
    rows = [{'generic_number': k, 'segment': pos_seg.get(k, ''), 'n_receptors': c,
             'pct_receptors': round(c / N_REC * 100, 4), 'mean_abs_delta': float(np.mean(pos_d[k])),
             'max_abs_delta': float(np.max(pos_d[k])), 'n_contacts_pooled': len(pos_d[k])}
            for k, c in pos_count.items() if c >= 3]
    p = pd.DataFrame(rows)
    p['norm_frequency'] = p.n_receptors / p.n_receptors.max()
    p['norm_delta'] = p.mean_abs_delta / p.mean_abs_delta.max()
    p['cfr_score'] = (p.norm_frequency + p.norm_delta) / 2
    p = p.sort_values('cfr_score', ascending=False).reset_index(drop=True)
    p.insert(0, 'cfr_score_rank', p.index + 1)
    p.insert(1, 'recurrence_rank', p.sort_values(['n_receptors', 'cfr_score'], ascending=False)
             .assign(r=range(1, len(p) + 1)).sort_index().r)
    prs = pd.DataFrame([{'cfr_1': a, 'cfr_2': b, 'n_receptors': len(v), 'pct_receptors': round(len(v) / N_REC * 100, 4),
                         'receptors': ' '.join(sorted(v))} for (a, b), v in pair_rec.items()]) \
        .sort_values('n_receptors', ascending=False, kind='stable').reset_index(drop=True)
    top50 = set(p.head(50).generic_number)
    prs['both_ends_top50'] = [a in top50 and b in top50 for a, b in zip(prs.cfr_1, prs.cfr_2)]
    div = []
    for _, r in p.iterrows():
        pc = pcount[r.generic_number]
        best, bn = (pc.most_common(1)[0] if pc else ('', 0))
        div.append({'generic_number': r.generic_number, 'segment': r.segment, 'n_receptors': int(r.n_receptors),
                    'pct_receptors': float(r.pct_receptors), 'n_distinct_partners': len(partners[r.generic_number]),
                    'top_partner': best, 'top_partner_n_receptors': int(bn),
                    'top_partner_pct': round(bn / N_REC * 100, 4), 'wiring_ratio': round(bn / r.n_receptors, 4)})
    rare = pd.DataFrame([{'generic_number': k, 'segment': pos_seg.get(k, ''), 'n_receptors': c}
                         for k, c in pos_count.items() if c < 3], columns=['generic_number', 'segment', 'n_receptors'])
    rare = rare.sort_values(['n_receptors', 'generic_number'], ascending=[False, True]).reset_index(drop=True)
    return p, prs, pd.DataFrame(div), rare


# ------------------------------------------------------------------ reference set
def zhou_residues(ts_path):
    """Residues of the 34-pair common activation pathway of Zhou et al. 2019, as the Studio carries it."""
    pairs = re.findall(r"P\('(\d+x\d+):(\d+x\d+)'", Path(ts_path).read_text())
    assert len(pairs) == 34, len(pairs)
    return {r for p in pairs for r in p}


def motif_set(src_path):
    """The class A motif set of the reference code (a literal set; read, never executed)."""
    tree = ast.parse(Path(src_path).read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'MOTIFS' for t in node.targets):
            return set(ast.literal_eval(node.value))
    raise ValueError('MOTIFS not found in %s' % src_path)


def universe(features):
    """Structure-based positions numbered in at least half of the receptors (the e19 universe)."""
    with gzip.open(features, 'rt') as fh:
        feat = pd.read_csv(fh, sep='\t', usecols=['gid', 'gn_struct'], low_memory=False)
    feat = feat[feat.gn_struct.notna() & (feat.gn_struct != '')]
    cnt = feat.groupby('gn_struct').gid.nunique()
    return set(cnt[cnt >= 0.5 * N_REC].index)


def curve_scores(pos, elig):
    t = pos.assign(pos=[struct_number(g) for g in pos.generic_number])
    sc = t.groupby('pos').cfr_score.max()
    return sc[sc.index.isin(elig)].sort_values(ascending=False)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    for k, v in DEFAULTS.items():
        ap.add_argument('--' + k.replace('_', '-'), default=str(v))
    ap.add_argument('--out', default=str(OUT_DEFAULT))
    ap.add_argument('--supplement-out', default=str(SUPP_DEFAULT))
    ap.add_argument('--dry-run', action='store_true', help='run every check, write nothing')
    a = ap.parse_args()
    P = {k: Path(getattr(a, k)) for k in DEFAULTS}
    out, supp_out = Path(a.out), Path(a.supplement_out)
    an = P['analysis']

    deltas = load_deltas(P['batch'])
    check('283 receptors in the batch run', len(deltas) == N_REC, len(deltas))

    # 1. canonical numbering reproduces the class tables
    L_pos, L_pairs, L_div, _ = run(deltas, lambda g: legacy_map(an, g))
    canon_pos = pd.read_csv(an / 'full_cfr_positions.tsv', sep='\t')
    canon_pairs = pd.read_csv(an / 'full_cfr_pairs.tsv', sep='\t')
    canon_div = pd.read_csv(an / 'partner_diversity.tsv', sep='\t')
    check('canonical run reproduces full_cfr_positions.tsv (gn, n, cfr_score; 368 rows)',
          len(L_pos) == len(canon_pos) == 368
          and list(L_pos.generic_number) == list(canon_pos.generic_number)
          and list(L_pos.n_receptors) == list(canon_pos.n_receptors)
          and np.allclose(L_pos.cfr_score, canon_pos.cfr_score), len(L_pos))
    check('canonical run reproduces full_cfr_pairs.tsv (2,234 pairs)',
          len(L_pairs) == len(canon_pairs) == 2234, len(L_pairs))
    m = canon_div.merge(L_div, on='generic_number', suffixes=('_c', '_r'))
    check('canonical run reproduces partner_diversity.tsv',
          len(m) == 368 and (m.n_distinct_partners_c == m.n_distinct_partners_r).all()
          and (m.top_partner_n_receptors_c == m.top_partner_n_receptors_r).all(), len(m))

    # 2. GPR4 on its own GPCRdb entry
    N_pos, N_pairs, N_div, N_rare = run(deltas, lambda g: pack_map(P['packs'], g) if g == 'gpr4_human' else legacy_map(an, g))
    if P['kit'].is_file():
        kit = pd.read_csv(P['kit'], sep='\t')
        mk = kit.merge(N_pos, on='generic_number', suffixes=('_k', '_n'))
        check('GPR4-own run equals positions_pack_gpr4.tsv (n, rank, score)',
              len(mk) == 368 and (mk.n_receptors_k == mk.n_receptors_n).all()
              and (mk.cfr_score_rank_k == mk.cfr_score_rank_n).all()
              and np.allclose(mk.cfr_score_k, mk.cfr_score_n), len(mk))
    check('positions below recurrence: CFRs in 1 or 2 receptors, none of them recurrent',
          len(N_rare) > 0 and set(N_rare.n_receptors) <= {1, 2} and not set(N_rare.generic_number) & set(N_pos.generic_number),
          dict(rows=len(N_rare), one=int((N_rare.n_receptors == 1).sum()), two=int((N_rare.n_receptors == 2).sum())))
    r848 = N_pos[N_pos.generic_number == '8.48x48'].iloc[0]
    check('8.48x48 = 113 / 39.9293% / 5.2107 / 0.46452 / rank 36',
          r848.n_receptors == 113 and r848.pct_receptors == 39.9293 and round(r848.mean_abs_delta, 4) == 5.2107
          and round(r848.cfr_score, 5) == 0.46452 and r848.cfr_score_rank == 36,
          dict(n=int(r848.n_receptors), pct=float(r848.pct_receptors), mean=float(r848.mean_abs_delta),
               score=float(r848.cfr_score), rank=int(r848.cfr_score_rank)))
    n_both = int(N_pairs.both_ends_top50.sum())
    check('pair universe 2,231 with 181 both ends in the top 50', len(N_pairs) == 2231 and n_both == 181,
          dict(pairs=len(N_pairs), both_top50=n_both))
    s5 = pd.read_csv(P['s5'])
    t20 = N_pairs.head(20)
    # S5 orders the two pairs tied at 116 receptors the other way round; same pairs, same counts
    check('top 20 pairs equal S5 (pairs and receptor counts; order of ties aside)',
          sorted(zip(t20.cfr_1, t20.cfr_2, t20.n_receptors.astype(int)))
          == sorted(zip(s5.cfr_1, s5.cfr_2, s5.n_receptors.astype(int)))
          and list(t20.n_receptors) == list(s5.n_receptors) and bool(t20.both_ends_top50.all()))
    s3 = pd.read_csv(P['s3'])
    check('top 50 order equals S3', list(N_pos.head(50).generic_number) == list(s3.generic_number))

    P_pos, P_pairs, _, _ = run(deltas, lambda g: pack_map(P['packs'], g))
    check('top 50 identical under all-pack numbering',
          list(N_pos.head(50).generic_number) == list(P_pos.head(50).generic_number)
          and list(N_pos.head(50).n_receptors) == list(P_pos.head(50).n_receptors))
    mp = N_pos.merge(P_pos, on='generic_number', how='outer', suffixes=('_n', '_p'))
    diff = mp[mp.n_receptors_n != mp.n_receptors_p]
    check('positions that differ under all-pack numbering (outside the top 50)', True,
          diff[['generic_number', 'n_receptors_n', 'n_receptors_p']].fillna(0)
          .astype({'n_receptors_n': int, 'n_receptors_p': int}).to_dict('records'))

    # 3. activation reference and recovery
    e19 = json.load(open(P['e19'] / 'e19_results.json'))
    known = set(e19['top50']['recovered']) | set(e19['top50']['missed'])
    zhou, motifs = zhou_residues(P['zhou_ts']), motif_set(P['motifs_src'])
    check('39 reference positions = Zhou 2019 pathway residues + class A motifs (e19 known set)',
          len(known) == 39 and zhou | motifs == known, dict(zhou=len(zhou), motifs=len(motifs), union=len(zhou | motifs)))
    named = {sn: name for name, sns in NAMED_MOTIFS.items() for sn in sns}
    check('16 named motif positions are in the reference set', len(named) == 16 and set(named) <= motifs)
    check('the other motif positions are the sodium pocket and 6.30', motifs - set(named) == set(OTHER_GROUPS))

    elig = universe(P['features'])
    cf = json.load(open(P['e19'] / 'e19_cutoff_free.json'))['cfr_score']
    sc_legacy = curve_scores(canon_pos, elig)
    isk = sc_legacy.index.isin(sorted(known))
    check('recovery on the canonical ranking reproduces e19 (262 positions, 9 cut points)',
          len(sc_legacy) == cf['positions'] == 262
          and all(int(isk[:c['top_n']].sum()) == c['known_found'] for c in cf['curve'])
          and {c['top_n']: c['known_found'] for c in cf['curve']} == E19_CUTS, len(sc_legacy))
    sc = curve_scores(N_pos, elig)
    isk = sc.index.isin(sorted(known))
    M, K = len(sc), int(isk.sum())
    cuts = {n: int(isk[:n].sum()) for n in E19_CUTS}
    check('corrected ranking gives the same cut points', M == 262 and K == 39 and cuts == E19_CUTS, cuts)

    best = N_pos.assign(sn=[struct_number(g) for g in N_pos.generic_number]) \
        .sort_values('cfr_score', ascending=False).drop_duplicates('sn').set_index('sn')
    rank_of = dict(zip(N_pos.generic_number, N_pos.cfr_score_rank))
    found, rec_rows = 0, []
    for i, (p, v) in enumerate(sc.items(), 1):
        k = p in known
        found += k
        gn = best.generic_number[p]
        rec_rows.append({'rank_in_universe': i, 'cfr_score_rank': int(rank_of[gn]), 'struct_number': p,
                         'generic_number': gn, 'cfr_score': v, 'known': int(k), 'motif': named.get(p, ''),
                         'known_found': found, 'expected': round(i * K / M, 4)})
    recovery = pd.DataFrame(rec_rows)
    top50 = list(N_pos.head(50).generic_number)
    check('49 of the 50 top-ranked positions are in the recovery universe',
          len(set(top50) & set(recovery.generic_number)) == 49)

    gn_of = dict(zip(recovery.struct_number, recovery.generic_number))
    check('every reference position is in the universe', known <= set(gn_of), sorted(known - set(gn_of)))
    ref = pd.DataFrame([{'struct_number': p, 'generic_number': gn_of[p], 'motif': named.get(p, ''),
                         'group': named.get(p) or OTHER_GROUPS.get(p, ''),
                         'zhou2019': int(p in zhou), 'class_a_motif': int(p in motifs)} for p in known])
    ref['_k'] = [rec_rows[[r['struct_number'] for r in rec_rows].index(p)]['rank_in_universe'] for p in ref.struct_number]
    ref = ref.sort_values('_k').drop(columns='_k').reset_index(drop=True)
    motif_doc = {'motifs': [{'name': name, 'positions': [gn_of[sn] for sn in sns]} for name, sns in NAMED_MOTIFS.items()]}
    n_motif_top = sum(1 for sns in NAMED_MOTIFS.values() for sn in sns if gn_of[sn] in set(top50))
    check('9 of the 16 named motif positions are in the top 50', n_motif_top == 9, n_motif_top)

    # 4. tables copied byte for byte, and their checks
    s6 = pd.read_csv(an / 'ed1_full_segments.tsv', sep='\t')
    s6i = pd.read_csv(an / 'ed1_full_interfaces.tsv', sep='\t')
    seg = dict(zip(s6.segment, s6.mean_abs_delta))
    check('segments: TM6 1.13, H8 1.21, TM1 and TM4 0.74',
          round(seg['TM6'], 2) == 1.13 and round(seg['H8'], 2) == 1.21 and round(seg['TM1'], 2) == 0.74
          and round(seg['TM4'], 2) == 0.74, {k: round(v, 3) for k, v in seg.items()})
    sup = s6i[s6i.n_contacts >= 50].sort_values('mean_abs_delta', ascending=False)
    check('interfaces lead TM3-TM6 and TM5-TM6 1.42, TM3-TM7 1.31',
          [round(x, 2) for x in sup.mean_abs_delta.head(3)] == [1.42, 1.42, 1.31]
          and sup.head(3)[['seg_i', 'seg_j']].values.tolist() == [['TM3', 'TM6'], ['TM5', 'TM6'], ['TM3', 'TM7']],
          sup.head(3)[['seg_i', 'seg_j']].values.tolist())
    f3a = pd.read_csv(P['f3a'], sep='\t')
    top_c = f3a[f3a.top50_by_cfr_score == 1].mean_conservation
    oth_c = f3a[f3a.top50_by_cfr_score == 0].mean_conservation
    check('conservation medians 0.80 vs 0.67, n 50 vs 302',
          round(top_c.median(), 2) == 0.80 and round(oth_c.median(), 2) == 0.67 and len(top_c) == 50 and len(oth_c) == 302,
          (float(top_c.median()), float(oth_c.median())))
    check('conservation top-50 set equals the corrected top 50',
          set(f3a[f3a.top50_by_cfr_score == 1].gn_display) == set(top50))
    bands = pd.read_csv(P['supp_tables'] / 'FigS4b_recurrence_bands.tsv', sep='\t')
    fifths = pd.read_csv(P['panels'] / 'ed14_a_conservation_strata_plotdata.tsv', sep='\t')
    dec = bands.pathogenic + bands.benign
    check('bands: 6 rows, 402 positions, 15,519 decisive calls',
          len(bands) == 6 and int(bands.positions.sum()) == 402 and int(dec.sum()) == 15519)
    check('fifths: 5 rows, 6,149 + 9,358 = 15,507 decisive calls',
          len(fifths) == 5 and int(fifths.lead_n.sum()) == 6149 and int(fifths.rest_n.sum()) == 9358)

    # Kruskal-Wallis on total |dRRCS|: all ligand types; families with at least 5 receptors
    if P['receptors_csv'].is_file():
        rec = pd.read_csv(P['receptors_csv'], comment='#')
        lg = [g.sum_abs.values for _, g in rec.groupby('ligand')]
        h1, p1 = sstats.kruskal(*lg)
        fg = [g.sum_abs.values for _, g in rec.groupby('family') if len(g) >= 5]
        h2, p2 = sstats.kruskal(*fg)
        check('Kruskal-Wallis ligand types H 27.87 (k 10, n 283)', round(h1, 2) == 27.87 and len(lg) == 10,
              (float(h1), float(p1), len(lg)))
        check('Kruskal-Wallis families with at least 5 receptors H 27.36 (k 16, n 192)',
              round(h2, 2) == 27.36 and len(fg) == 16 and sum(map(len, fg)) == 192,
              (float(h2), float(p2), len(fg), int(sum(map(len, fg)))))

    failed = [k for k, c in checks.items() if not c['ok']]
    if failed:
        print('%d checks failed; nothing written' % len(failed))
        return 1
    if a.dry_run:
        print('all %d checks pass (dry run, nothing written)' % len(checks))
        return 0

    # 5. write
    out.mkdir(parents=True, exist_ok=True)
    N_pos.to_csv(out / 'positions.tsv', sep='\t', index=False)
    N_pairs.drop(columns=['receptors']).to_csv(out / 'pairs.tsv', sep='\t', index=False)
    N_div.to_csv(out / 'partner_diversity.tsv', sep='\t', index=False)
    N_rare.to_csv(out / 'positions_below_recurrence.tsv', sep='\t', index=False)
    ref.to_csv(out / 'activation_reference.tsv', sep='\t', index=False)
    (out / 'activation_motifs.json').write_text(json.dumps(motif_doc, indent=1) + '\n', encoding='utf-8')
    recovery.to_csv(out / 'activation_recovery.tsv', sep='\t', index=False)
    copies = {out / 'segments.tsv': an / 'ed1_full_segments.tsv',
              out / 'interfaces.tsv': an / 'ed1_full_interfaces.tsv',
              out / 'conservation_positions.tsv': P['f3a'],
              supp_out / 'FigS4b_recurrence_bands.tsv': P['supp_tables'] / 'FigS4b_recurrence_bands.tsv',
              supp_out / 'ed14_a_conservation_strata_plotdata.tsv':
                  P['panels'] / 'ed14_a_conservation_strata_plotdata.tsv'}
    for dst, src in copies.items():
        shutil.copyfile(src, dst)
        assert sha(dst) == sha(src), dst

    inputs = {'batch csv_data (283 *_rrcs_delta.csv)': P['batch'],
              'full_cfr_positions.tsv': an / 'full_cfr_positions.tsv',
              'full_cfr_pairs.tsv': an / 'full_cfr_pairs.tsv',
              'partner_diversity.tsv': an / 'partner_diversity.tsv',
              'gpr4_human pack': P['packs'] / 'gpr4_human.json',
              'zhou2019.ts': P['zhou_ts'], 'novel_cfrs.py (MOTIFS)': P['motifs_src'],
              'e19_results.json': P['e19'] / 'e19_results.json',
              'e19_cutoff_free.json': P['e19'] / 'e19_cutoff_free.json',
              'residue_features.tsv.gz': P['features'],
              'ed1_full_segments.tsv': an / 'ed1_full_segments.tsv',
              'ed1_full_interfaces.tsv': an / 'ed1_full_interfaces.tsv',
              'F3a_conservation_by_generic_position.tsv': P['f3a'],
              'FigS4b_recurrence_bands.tsv': P['supp_tables'] / 'FigS4b_recurrence_bands.tsv',
              'ed14_a_conservation_strata_plotdata.tsv': P['panels'] / 'ed14_a_conservation_strata_plotdata.tsv',
              'S3_top50_recurrent_cfr_positions.csv': P['s3'], 'S5_top20_recurrent_cfr_pairs.csv': P['s5']}
    if P['kit'].is_file():
        inputs['positions_pack_gpr4.tsv'] = P['kit']
    if P['receptors_csv'].is_file():
        inputs['receptors.csv (built site)'] = P['receptors_csv']
    in_sha = {k: (sha(v) if v.is_file() else None) for k, v in inputs.items()}
    outputs = ['positions.tsv', 'pairs.tsv', 'partner_diversity.tsv', 'positions_below_recurrence.tsv',
               'activation_reference.tsv',
               'activation_motifs.json', 'activation_recovery.tsv', 'segments.tsv', 'interfaces.tsv',
               'conservation_positions.tsv']
    out_sha = {n: sha(out / n) for n in outputs}
    for dst in (supp_out / 'FigS4b_recurrence_bands.tsv', supp_out / 'ed14_a_conservation_strata_plotdata.tsv'):
        out_sha['../supplement_2026-11-05b/' + dst.name] = sha(dst)
    (out / 'checks.json').write_text(json.dumps(
        {'generator': 'scripts/build_class_tables.py', 'checks': checks,
         'inputs': {k: {'path': tilde(v), 'sha256': in_sha[k]} for k, v in inputs.items()},
         'outputs': out_sha}, indent=1, default=str) + '\n', encoding='utf-8')
    write_provenance(out, out_sha, copies, len(checks))
    for n, s in out_sha.items():
        print('%s  %s' % (s, n))
    print('all %d checks pass; wrote %s' % (len(checks), out))
    return 0


RULES = {
    'positions.tsv': ('368 recurrent positions (CFR in 3 or more receptors), canonical rule, GPCRdb residue maps with '
                      'GPR4 on its own GPCRdb entry; sorted by CFR score', 'recomputed'),
    'pairs.tsv': ('2,231 distinct pairs of generic positions joined by an above-threshold contact (both residues '
                  'CFRs), receptors per pair, both ends in the top 50 or not; same run', 'recomputed'),
    'partner_diversity.tsv': ('per recurrent position: distinct partner positions and the most frequent exact '
                              'partner; same run', 'recomputed'),
    'positions_below_recurrence.tsv': ('generic positions that are CFRs in 1 or 2 receptors (below the recurrence '
                                       'rule); same run', 'recomputed'),
    'activation_reference.tsv': ('39 known activation positions: the Zhou et al. 2019 common activation pathway '
                                 '(34 residue pairs) plus the class A motifs (D2.50, DRY, PIF, CWxP, NPxxY, the '
                                 'sodium pocket, 6.30); ordered by rank in the recovery universe', 'derived'),
    'activation_motifs.json': ('the five named motifs and their 16 positions', 'derived'),
    'activation_recovery.tsv': ('the 262 recurrent positions numbered in at least half of the receptors, in CFR score order, '
                                'with the cumulative count of reference positions and the count expected by '
                                'chance (rank x 39 / 262)', 'derived'),
    'segments.tsv': ('mean |dRRCS| per contact endpoint by segment, all contacts with full GPCRdb residue maps',
                     'byte copy'),
    'interfaces.tsv': ('mean |dRRCS| per contact between two helices, all contacts; supported = at least 50 '
                       'contacts', 'byte copy'),
    'conservation_positions.tsv': ('mean conservation (VarSite via ProtVar) per generic position with at least 20 '
                                   'scored residues; top 50 flag', 'byte copy'),
    '../supplement_2026-11-05b/FigS4b_recurrence_bands.tsv': (
        'AlphaMissense classes of the 276-receptor allele set by recurrence band', 'byte copy'),
    '../supplement_2026-11-05b/ed14_a_conservation_strata_plotdata.tsv': (
        'AlphaMissense predicted pathogenic share of decisive calls by conservation fifth, top 50 and other '
        'positions', 'byte copy'),
}


def write_provenance(out, out_sha, copies, n_checks):
    src = {('../supplement_2026-11-05b/' + d.name if d.parent != out else d.name): tilde(s) for d, s in copies.items()}
    lines = [
        '# Provenance: class-wide tables of the Statistics page (2026-11-13)',
        '',
        'Written by `scripts/build_class_tables.py` (run by hand; the site build never runs it). The build reads',
        'these files through `analysis/class_results.py`, which asserts each sha256 below (`PINS`), and',
        '`tests/test_statistics_class_results.py` checks the pins, this table and, where the sources exist on the',
        'machine, that each copy equals its source byte for byte. `checks.json` holds all %d checks the script' % n_checks,
        'passed before writing, with the sha256 of every input.',
        '',
        '| File | sha256 | How | Source or rule |',
        '|---|---|---|---|',
    ]
    for name, s in out_sha.items():
        rule, how = RULES[name]
        where = src.get(name)
        lines.append('| `%s` | `%s` | %s | %s |' % (name, s, how, ('`%s`' % where) if where else rule))
    lines += [
        '',
        'Rule of the recomputed tables: per receptor, contact pairs with |dRRCS| at or above mean + SD of its',
        '|dRRCS| (at least 0.2), from the RRCS batch run 2026-02-02; a residue is a CFR when it is in one such',
        'pair; a generic position is recurrent when it is a CFR in 3 or more of the 283 receptors; CFR score =',
        '(receptors / max receptors + mean |dRRCS| / max mean |dRRCS|) / 2.',
        '',
        '## Why copied, not recomputed in the build',
        '',
        'The canonical GPCRdb residue maps (figures_overhaul `gpcrdb_residues/`) are outside the repository. The',
        'script asserts that they reproduce the class tables exactly, then changes one receptor: GPR4, whose',
        'canonical map was GPR42\'s, is numbered with its own GPCRdb entry. That moves 8.48x48 from 112 to 113',
        'receptors (39.9293%, mean |dRRCS| 5.2107, CFR score 0.46452, rank 36) and shifts some ranks outside the',
        'top 50; the top 50 and its order are unchanged. A build-time recompute on the Studio packs (every',
        'receptor on the current GPCRdb numbering) gives the same top 50 but differs from these tables at 6',
        'positions outside the top 50, by 1 or 2 receptors, so the build reads these files instead.',
        '',
        'The activation reference is the known set of the cfr_main_quest e19 analysis (Zhou et al. 2019 pathway',
        'residues, from the Studio\'s zhou2019.ts, plus the class A motif set). The recovery curve on the',
        'canonical ranking reproduces the e19 cut points (8, 14, 16, 18, 20, 21, 23, 27, 28 known positions in',
        'the first 10, 20, 30, 40, 50, 60, 80, 100, 120), and the corrected ranking gives the same cut points.',
        '',
    ]
    (out / 'PROVENANCE.md').write_text('\n'.join(lines), encoding='utf-8')


if __name__ == '__main__':
    raise SystemExit(main())
