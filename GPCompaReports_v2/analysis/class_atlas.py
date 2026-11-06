"""Class-wide summaries for the Statistics page, computed from the site data (the "site layer").

Payloads, written at build time to <site>/data/stats/ by write_stats_data() and rendered by the
Statistics page (templates/statistics.html, static/js/stats-page.js):

    overview.json          orientation tiles and the coverage table
    helix_pairs.json       helix-pair rewiring atlas, all 283 receptors (built in tm_domain_analysis)
    helix_pair_cells.json  the receptors behind each helix-pair cell (fetch on the first cell click)
    cfr_atlas.json     the 50 class-wide CFR positions x 283 receptors
    receptors.json     the receptor explorer: one row per receptor, families, pattern similarity

plus one CSV per payload (the card's table and download) and figures/fig_*.json (Plotly figure JSON from
the fig_* factories below, for Plotly.newPlot). manifest.json lists every file with its size.

Sources. Every structural number comes from the batch RRCS run (batch_analysis_20260202_151051), the
same run as the paper: per receptor, the contact pairs with |dRRCS| at or above the receptor's own
threshold (the report rule: mean + SD of |dRRCS|, at least 0.2; 23,025 pairs over 283 receptors).
Residues are placed on segments and generic positions with the Studio packs' full GPCRdb numbering
(GPCRdb API fetched 2026-10-18), not with the batch annotation files, which number only residues of
high-magnitude contacts. With the full numbering the class-wide position counts reproduce the
manuscript's: 274 receptors at 3.50x50, and 49 of the 50 positions match S3 n_receptors exactly. The
one difference is 8.48x48 (113 here, 112 in S3): the extra receptor is GPR4, which the packs number
with its own GPCRdb entry, while its batch annotation belonged to GPR42 (no 8.48x48 there). The
published S3, S4, S5 and S7 values are still shown as
submitted and are never replaced by these. The CFR set is manuscript_stats.class_cfr_set() (the 50
top-ranked positions by CFR score). Segment order is report_extras.HELICES_FIRST_ORDER (helices, then
loops including ICL4, then termini). Ligand type and family are the site's (class_A_all.csv).

Sign: dRRCS = active minus inactive. Positive = stronger in the active model (red), negative =
stronger in the inactive model (blue).

Every payload has a "meta" block:
    schema        "gpcompare-stats/<name>@1"
    layer         "site"
    label         "Computed from the site data (site layer)"
    n_receptors   283
    sources       {rrcs, numbering, cfr_set, metadata}: one plain sentence each
    sign, threshold_rule, segment_order where they apply

overview.json
    tiles     [{key, value, display, label, source: "site"|"manuscript", source_label}], in page order:
              receptors, contact_pairs, above_threshold, median_threshold, recurrent_positions, cfr_set,
              am_odds_ratio (value = [estimate, CI low, CI high], read unchanged from the supplement
              summary through manuscript_stats.load_am_comparison)
    coverage  [{view, receptors, source, note}]
    exclusions  {not_modeled: [4 names], not_modeled_note}

helix_pairs.json
    segments          17 names, helices first; the first n_helices (8: TM1 to TM7, H8) form the default grid
    min_receptors     10: direction cells with fewer receptors are blank (still listed)
    receptors         [{gid, symbol, ligand, family}] (index = receptor id in helix_pair_cells.json)
    summary_columns   ['i', 'j', 'n_present', 'coverage', 'mean_net', 'agree', 'n_up', 'n_down',
                       'mean_net_present', 'mean_gain_present', 'mean_loss_present', 'n_pairs']
    groups            [{key, label, n, cells: [[...summary_columns...], ...]}]; key "all" first, then one
                      per ligand type. i <= j index segments. mean_net = sum over the group's receptors
                      of the net dRRCS in the cell / receptors in the group (receptors without a pair
                      count 0); agree = share of receptors with a pair whose net has the sign of mean_net;
                      coverage = n_present / n; gain and loss are the separate sums (loss negative).
    n_pairs_mapped, n_pairs_unmapped   mapped + unmapped = all above-threshold pairs

helix_pair_cells.json
    receptor_columns  ['receptor', 'net', 'gain', 'loss', 'n_pairs']
    cells             [{i, j, receptors: [[receptor, net, gain, loss, n_pairs], ...]}]: every receptor
                      with an above-threshold pair in the cell, sorted by net (most negative first);
                      receptor indexes helix_pairs.json receptors

cfr_atlas.json
    positions     [{gn, segment, rank, s3_n_receptors}] in helices-first order (helix, then number);
                  rank = CFR score rank; s3_n_receptors = the submitted value (manuscript, unchanged)
    rank_order    position indexes in CFR score rank order
    receptors     [{gid, symbol, ligand, family, state, net}] in row order (ligand type by size, family,
                  symbol). state: 50-character string, "2" = the residue at that position has an
                  above-threshold contact, "1" = numbered, no above-threshold contact, "0" = the receptor
                  has no residue numbered at that position. net: 50 values, the signed sum of the
                  above-threshold dRRCS of the contacts touching the residue (null unless state is 2).
    columns       [{n_hit, n_numbered, n_up, n_down}] per position (site layer)
    groups        {ligand: [...], family: [...]}: [{key, n, hit: [50 shares of the group's receptors],
                  numbered: [50 counts]}]

receptors.json
    metrics       [{key, label, description}] for the explorer chips
    columns       the row fields, in order
    rows          283 rows, each a list in `columns` order: gid, symbol, name, family, ligand, ligand_group (8 groups: the three smallest
                  ligand types fold into Other), threshold, n_pairs, n_above, above_per_100, sum_abs,
                  sum_abs_above, share_active (share of above-threshold pairs stronger in the active
                  model), cfr_numbered, cfr_hits, report (reports/<gid>.html), rank_<metric> (1 = largest)
    similar       {gid: [[gid, cosine], ...]} top 5 by pattern similarity: cosine over the signed CFR
                  fingerprint (atlas net, 0 where not hit); receptors with fewer than 32 numbered CFR
                  positions are left out. A browsing aid, not a classification.
    families      [{family, ligand, n, plotted (n >= 4), median_<metric>}]
    kruskal       {metric: {families: {H, p, k, n}, ligand_types: {H, p, k, n}}}: families with at least
                  4 receptors, ligand types with at least 4
    ligand_groups [{key, n, color}] (light-mode hues, validated for color-vision deficiency)

Hook for the page generator (statistics_page.py):

    from ...analysis.class_atlas import stats_data_for_page
    stats = stats_data_for_page(store, analysis_results, output_dir)

It builds the payloads once (cached in analysis_results['class_atlas']), writes data/stats/ under
output_dir and returns {'payloads': {name: dict}, 'files': {relative path: bytes}, 'urls': {name:
'data/stats/<name>.json'}}.
"""
import csv
import io
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from scipy import stats as sstats

from . import pack_layer
from .manuscript_stats import class_cfr_ranks, class_cfr_set, load_am_comparison, TOP50_CSV
from .tm_domain_analysis import (
    DIVERGING, helix_pair_atlas,
    fig_helix_pair_coverage, fig_helix_pair_signed,
)

SCHEMA = 'gpcompare-stats/%s@1'
LAYER_LABEL = 'Computed from the site data (site layer)'
STATS_SUBDIR = Path('data') / 'stats'

THRESHOLD_FLOOR = 0.2
#: Receptors with fewer numbered CFR positions get no similarity list.
SIMILARITY_MIN_NUMBERED = 32
SIMILARITY_TOP = 5
#: Families with fewer receptors are listed in the strip's note, not plotted.
FAMILY_MIN = 4

#: The explorer's ligand-type colors (eight hues; the three smallest types fold into Other).
LIGAND_GROUP_ORDER = ['Peptide receptors', 'Orphan receptors', 'Aminergic receptors', 'Lipid receptors',
                      'Protein receptors', 'Nucleotide receptors', 'Sensory receptors', 'Other']
LIGAND_GROUP_COLORS = dict(zip(LIGAND_GROUP_ORDER, ['#0D9488', '#D97706', '#7C3AED', '#DB2777', '#2563EB',
                                                    '#65A30D', '#92400E', '#4338CA']))

EXPLORER_METRICS = [
    ('n_above', 'Above-threshold pairs',
     'Contact pairs with |ΔRRCS| at or above the receptor threshold'),
    ('above_per_100', 'Above-threshold pairs per 100 pairs',
     'Above-threshold pairs per 100 contact pairs; less tied to receptor size than the sums'),
    ('sum_abs', 'Sum |ΔRRCS|',
     'Sum of |ΔRRCS| over all contact pairs; grows with receptor size and contact count'),
    ('share_active', 'Share stronger in the active model',
     'Share of above-threshold pairs whose RRCS is higher in the active model; depends on the threshold'),
    ('cfr_hits', 'CFR positions with an above-threshold contact',
     'Of the 50 class-wide CFR positions, how many carry an above-threshold contact in this receptor'),
]


def receptor_threshold(delta_df):
    """The report's significance threshold (gpcr_report_helpers._calc_significance_threshold):
    mean + SD of |dRRCS|, at least 0.2. Kept identical; tests compare the two."""
    if delta_df is None or delta_df.empty:
        return THRESHOLD_FLOOR
    a = delta_df['delta_rrcs'].abs()
    return max(a.mean() + a.std(), THRESHOLD_FLOOR)


@dataclass
class ReceptorInput:
    gid: str
    symbol: str
    name: str
    family: str
    ligand: str
    threshold: float
    n_pairs: int
    sum_abs: float
    sig_res1: np.ndarray
    sig_res2: np.ndarray
    sig_delta: np.ndarray
    numbering: dict = field(repr=False)     # {position: (segment, generic number)} from the pack
    gn2pos: dict = field(repr=False)        # {generic number: position}
    gpcrdb_fetched: str = ''


def receptor_inputs(store, folder=None):
    """One ReceptorInput per store.gpcr_ids receptor, from the batch delta table and the Studio pack."""
    folder = Path(folder) if folder else (
        store.report_layer.folder if getattr(store, 'report_layer', None) is not None else pack_layer.pack_dir())
    out, missing = [], []
    for gid in store.gpcr_ids:
        pack = pack_layer.load_pack(gid, folder)
        if pack is None:
            missing.append(gid)
            continue
        delta = store.delta_data.get(gid, pd.DataFrame())
        thr = receptor_threshold(delta)
        sig = delta[delta['delta_rrcs'].abs() >= thr] if not delta.empty else delta
        numbering = {int(r[0]): (r[2] or '', r[3] or '') for r in pack.get('residues', [])}
        gn2pos = {}
        for pos, (_seg, gn) in numbering.items():
            if gn and gn not in gn2pos:
                gn2pos[gn] = pos
        info = store.gpcr_info.get(gid, {})
        meta = pack.get('meta') or {}
        out.append(ReceptorInput(
            gid=gid,
            symbol=info.get('gene_name') or meta.get('gene') or meta.get('uniprotName') or gid,
            name=info.get('uniprot_name') or meta.get('uniprotName') or '',
            family=info.get('receptor_family') or meta.get('family') or '',
            ligand=info.get('ligand_type') or meta.get('ligandType') or '',
            threshold=float(thr),
            n_pairs=int(len(delta)),
            sum_abs=float(delta['delta_rrcs'].abs().sum()) if not delta.empty else 0.0,
            sig_res1=sig['res1'].to_numpy(dtype=int) if len(sig) else np.zeros(0, int),
            sig_res2=sig['res2'].to_numpy(dtype=int) if len(sig) else np.zeros(0, int),
            sig_delta=sig['delta_rrcs'].to_numpy(dtype=float) if len(sig) else np.zeros(0),
            numbering=numbering, gn2pos=gn2pos,
            gpcrdb_fetched=str((pack.get('provenance') or {}).get('gpcrdbFetched') or ''),
        ))
    if missing:
        raise ValueError('no Studio pack for %s in %s' % (', '.join(missing), folder))
    return out


# --------------------------------------------------------------------------- shared metadata

def _segment_order():
    from ..website.page_generators.report_extras import HELICES_FIRST_ORDER
    return list(HELICES_FIRST_ORDER)


def _ligand_order(inputs):
    counts = pd.Series([i.ligand for i in inputs]).value_counts()
    return sorted(counts.index, key=lambda k: (-counts[k], k))


def ligand_group(ligand):
    return ligand if ligand in LIGAND_GROUP_COLORS else 'Other'


def _meta(name, inputs, **extra):
    fetched = sorted({i.gpcrdb_fetched for i in inputs if i.gpcrdb_fetched})
    meta = {
        'schema': SCHEMA % name,
        'layer': 'site',
        'label': LAYER_LABEL,
        'n_receptors': len(inputs),
        'sources': {
            'rrcs': 'GPCompaRe RRCS batch 2026-02-02 (batch_analysis_20260202_151051), the run the paper uses.',
            'numbering': ('Residue segments and generic numbers from the Studio packs: the full GPCRdb '
                          'numbering (GPCRdb API fetched %s). The manuscript recurrence counts used the '
                          'full numbering too; with it, 274 receptors carry an above-threshold contact at '
                          '3.50x50, the manuscript count.' % ', '.join(fetched or ['unknown'])),
            'cfr_set': ('The class-wide CFR set: the 50 top-ranked positions by CFR score '
                        '(Supplementary Table S4 ranks).'),
            'metadata': 'Ligand type and family from class_A_all.csv, as on the browse page.',
        },
        'threshold_rule': ('Per receptor, contact pairs with |ΔRRCS| at or above mean + SD of |ΔRRCS| '
                           '(at least 0.2), the threshold each report uses.'),
        'sign': ('ΔRRCS = active minus inactive. Positive (red): stronger in the active model. '
                 'Negative (blue): stronger in the inactive model.'),
    }
    meta.update(extra)
    return meta


def _receptor_list(inputs):
    return [{'gid': i.gid, 'symbol': i.symbol, 'ligand': i.ligand, 'family': i.family} for i in inputs]


# --------------------------------------------------------------------------- helix pairs

def build_helix_pairs(inputs):
    segments = _segment_order()
    groups = [('all', 'all receptors', list(range(len(inputs))))]
    for lig in _ligand_order(inputs):
        groups.append((lig, lig, [r for r, i in enumerate(inputs) if i.ligand == lig]))
    payload = helix_pair_atlas(inputs, groups, segments)
    payload['receptors'] = _receptor_list(inputs)
    payload['meta'] = _meta('helix_pairs', inputs, segment_order=segments)
    cells = {'meta': _meta('helix_pair_cells', inputs, segment_order=segments),
             'receptor_columns': payload.pop('receptor_columns'), 'cells': payload.pop('cells')}
    return payload, cells


# --------------------------------------------------------------------------- CFR atlas

def _gn_sort_key(gn, segment, seg_index):
    bw = gn.split('x')[0]
    try:
        num = float(bw.split('.')[1]) if '.' in bw else 0.0
    except ValueError:
        num = 0.0
    return (seg_index.get(segment, len(seg_index)), num, gn)


def cfr_positions():
    """[{gn, segment, rank, s3_n_receptors}] of the class-wide CFR set, helices first."""
    ranks = class_cfr_ranks()
    cfr = class_cfr_set(ranks)
    s3 = pd.read_csv(TOP50_CSV)
    seg = dict(zip(s3['generic_number'].astype(str), s3['segment']))
    s3n = dict(zip(s3['generic_number'].astype(str), s3['n_receptors'].astype(int)))
    seg_index = {s: k for k, s in enumerate(_segment_order())}
    rows = [{'gn': g, 'segment': seg.get(g, ''), 'rank': ranks[g], 's3_n_receptors': s3n.get(g)} for g in cfr]
    return sorted(rows, key=lambda r: _gn_sort_key(r['gn'], r['segment'], seg_index))


def receptor_cfr_profile(inp, gns):
    """(state string, net list, n_contacts list) of one receptor over the positions `gns`."""
    state, net, ncont = [], [], []
    for g in gns:
        p = inp.gn2pos.get(g)
        if p is None:
            state.append('0'); net.append(None); ncont.append(0)
            continue
        m = (inp.sig_res1 == p) | (inp.sig_res2 == p)
        k = int(m.sum())
        if k:
            state.append('2'); net.append(round(float(inp.sig_delta[m].sum()), 3)); ncont.append(k)
        else:
            state.append('1'); net.append(None); ncont.append(0)
    return ''.join(state), net, ncont


def build_cfr_atlas(inputs):
    positions = cfr_positions()
    gns = [p['gn'] for p in positions]
    lig_order = {l: k for k, l in enumerate(_ligand_order(inputs))}
    order = sorted(range(len(inputs)),
                   key=lambda r: (lig_order[inputs[r].ligand], inputs[r].family, inputs[r].symbol))
    rows = []
    for r in order:
        inp = inputs[r]
        s, net, _ = receptor_cfr_profile(inp, gns)
        rows.append({'gid': inp.gid, 'symbol': inp.symbol, 'ligand': inp.ligand, 'family': inp.family,
                     'state': s, 'net': net})
    columns = []
    for k in range(len(gns)):
        st = [row['state'][k] for row in rows]
        nets = [row['net'][k] for row in rows if row['net'][k] is not None]
        columns.append({'n_hit': st.count('2'), 'n_numbered': st.count('2') + st.count('1'),
                        'n_up': sum(1 for v in nets if v > 0), 'n_down': sum(1 for v in nets if v < 0)})

    def group_summary(attr):
        out = []
        keys = (_ligand_order(inputs) if attr == 'ligand'
                else sorted({getattr(i, attr) for i in inputs}))
        for key in keys:
            members = [row for row in rows if row[attr] == key]
            n = len(members)
            hit = [round(sum(1 for m in members if m['state'][k] == '2') / n, 3) for k in range(len(gns))]
            numbered = [sum(1 for m in members if m['state'][k] != '0') for k in range(len(gns))]
            out.append({'key': key, 'n': n, 'hit': hit, 'numbered': numbered})
        return out

    rank_order = sorted(range(len(positions)), key=lambda k: positions[k]['rank'])
    return {
        'meta': _meta('cfr_atlas', inputs, segment_order=_segment_order(),
                      states={'2': 'above-threshold contact at this residue',
                              '1': 'residue numbered at this position, no above-threshold contact',
                              '0': 'no residue numbered at this position in this receptor'},
                      net=('Signed sum of the above-threshold ΔRRCS of the contacts touching the residue; '
                           'a sum can hide opposing changes.'),
                      s3_note=('s3_n_receptors is the submitted Supplementary Table S3 value, shown as '
                               'published; columns[].n_hit is the site recomputation.')),
        'positions': positions,
        'rank_order': rank_order,
        'receptors': rows,
        'columns': columns,
        'groups': {'ligand': group_summary('ligand'), 'family': group_summary('family')},
    }


# --------------------------------------------------------------------------- receptor explorer

def _cosine_top(vectors, eligible, k=SIMILARITY_TOP):
    gids = [g for g in vectors if g in eligible]
    if not gids:
        return {}
    m = np.array([vectors[g] for g in gids], dtype=float)
    norm = np.linalg.norm(m, axis=1)
    ok = norm > 0
    out = {}
    unit = np.zeros_like(m)
    unit[ok] = m[ok] / norm[ok, None]
    sim = unit @ unit.T
    for a, g in enumerate(gids):
        if not ok[a]:
            continue
        cand = [(gids[b], float(sim[a, b])) for b in range(len(gids)) if b != a and ok[b]]
        cand.sort(key=lambda x: (-x[1], x[0]))
        out[g] = [[h, round(s, 3)] for h, s in cand[:k]]
    return out


def build_receptors(inputs, atlas):
    by_gid = {row['gid']: row for row in atlas['receptors']}
    rows = []
    for inp in inputs:
        a = by_gid[inp.gid]
        n_above = int(len(inp.sig_delta))
        rows.append({
            'gid': inp.gid, 'symbol': inp.symbol, 'name': inp.name, 'family': inp.family,
            'ligand': inp.ligand, 'ligand_group': ligand_group(inp.ligand),
            'threshold': round(inp.threshold, 3), 'n_pairs': inp.n_pairs, 'n_above': n_above,
            'above_per_100': round(100.0 * n_above / inp.n_pairs, 2) if inp.n_pairs else None,
            'sum_abs': round(inp.sum_abs, 2),
            'sum_abs_above': round(float(np.abs(inp.sig_delta).sum()), 2),
            'share_active': round(float((inp.sig_delta > 0).mean()), 4) if n_above else None,
            'cfr_numbered': sum(1 for c in a['state'] if c != '0'),
            'cfr_hits': a['state'].count('2'),
            'report': 'reports/%s.html' % inp.gid,
        })
    df = pd.DataFrame(rows)
    for key, _l, _d in EXPLORER_METRICS:
        df['rank_' + key] = df[key].rank(ascending=False, method='min').astype('Int64')
    columns = list(df.columns)
    rows = [{k: (None if (v is pd.NA or (isinstance(v, float) and np.isnan(v))) else
                 (int(v) if k.startswith('rank_') else v)) for k, v in r.items()}
            for r in df.to_dict('records')]

    vectors = {row['gid']: [0.0 if v is None else v for v in row['net']] for row in atlas['receptors']}
    eligible = {r['gid'] for r in rows if r['cfr_numbered'] >= SIMILARITY_MIN_NUMBERED}
    similar = _cosine_top(vectors, eligible)

    families = []
    for fam, sub in df.groupby('family', sort=True):
        f = {'family': fam, 'ligand': sub['ligand'].mode().iat[0], 'n': int(len(sub)),
             'plotted': bool(len(sub) >= FAMILY_MIN)}
        for key, _l, _d in EXPLORER_METRICS:
            f['median_' + key] = None if sub[key].isna().all() else round(float(sub[key].median()), 4)
        families.append(f)

    kruskal = {}
    for key, _l, _d in EXPLORER_METRICS:
        kruskal[key] = {}
        for label, col in (('families', 'family'), ('ligand_types', 'ligand')):
            groups = [g[key].dropna().to_numpy() for _, g in df.groupby(col) if g[key].notna().sum() >= FAMILY_MIN]
            if len(groups) >= 2:
                h, p = sstats.kruskal(*groups)
                kruskal[key][label] = {'H': round(float(h), 3), 'p': float('%.3g' % p), 'k': len(groups),
                                       'n': int(sum(len(g) for g in groups))}
    counts = df['ligand_group'].value_counts()
    return {
        'meta': _meta('receptors', inputs,
                      similarity=('Pattern similarity: cosine over the signed 50-position CFR fingerprint '
                                  '(net ΔRRCS at each CFR position, 0 where there is no above-threshold '
                                  'contact). Receptors with fewer than %d numbered CFR positions are left out. '
                                  'A browsing aid, not a classification.' % SIMILARITY_MIN_NUMBERED),
                      kruskal_scope=('Kruskal-Wallis across families (or ligand types) with at least %d '
                                     'receptors; a test of difference in distribution, not of any single '
                                     'family.' % FAMILY_MIN)),
        'metrics': [{'key': k, 'label': l, 'description': d} for k, l, d in EXPLORER_METRICS],
        'columns': columns,
        'rows': [[r[c] for c in columns] for r in rows],
        'similar': similar,
        'families': families,
        'kruskal': kruskal,
        'ligand_groups': [{'key': k, 'n': int(counts.get(k, 0)), 'color': LIGAND_GROUP_COLORS[k]}
                          for k in LIGAND_GROUP_ORDER],
    }


# --------------------------------------------------------------------------- overview

NOT_MODELED = ['GPR26', 'LGR5', 'OPSX', 'RXFP1']


def build_overview(inputs, manuscript=None, am=None):
    manuscript = manuscript or {}
    am = am if am is not None else (manuscript.get('am_comparison') or load_am_comparison())
    n_pairs = int(sum(i.n_pairs for i in inputs))
    n_above = int(sum(len(i.sig_delta) for i in inputs))
    med = float(np.median([i.threshold for i in inputs]))
    n_recurrent = manuscript.get('n_recurrent_positions') or len(class_cfr_ranks())
    n_cfr = len(class_cfr_set())
    o = am['odds_ratio']
    site = LAYER_LABEL
    ms = 'Manuscript (as submitted)'
    tiles = [
        {'key': 'receptors', 'value': len(inputs), 'display': '{:,}'.format(len(inputs)),
         'label': 'human Class A receptors with an active and an inactive model', 'source': 'site',
         'source_label': site},
        {'key': 'contact_pairs', 'value': n_pairs, 'display': '{:,}'.format(n_pairs),
         'label': 'residue contact pairs compared', 'source': 'site', 'source_label': site},
        {'key': 'above_threshold', 'value': n_above, 'display': '{:,}'.format(n_above),
         'label': 'pairs at or above their receptor threshold', 'source': 'site', 'source_label': site},
        {'key': 'median_threshold', 'value': round(med, 4), 'display': '%.2f' % med,
         'label': 'median receptor threshold on |ΔRRCS|', 'source': 'site', 'source_label': site},
        {'key': 'recurrent_positions', 'value': int(n_recurrent), 'display': '{:,}'.format(int(n_recurrent)),
         'label': 'recurrent positions (above-threshold in at least 3 receptors)', 'source': 'manuscript',
         'source_label': ms + ', Supplementary Table S4'},
        {'key': 'cfr_set', 'value': n_cfr, 'display': str(n_cfr),
         'label': 'CFR positions: the top-ranked positions by CFR score', 'source': 'manuscript',
         'source_label': ms + ', Supplementary Table S3'},
        {'key': 'am_odds_ratio', 'value': list(o), 'display': '%.2f (95%% CI %.2f to %.2f)' % tuple(o),
         'label': 'odds of a predicted pathogenic AlphaMissense call at the CFR positions',
         'source': 'manuscript', 'source_label': ms + ', supplement AlphaMissense summary (%d receptors)'
                                                     % am['receptors']},
    ]
    n_numbered_any = sum(1 for i in inputs if any(i.gn2pos.get(g) for g in class_cfr_set()))
    coverage = [
        {'view': 'Structural summaries (helix-pair atlas, receptor explorer)', 'receptors': len(inputs),
         'source': 'site', 'note': 'Every receptor with an active and an inactive model.'},
        {'view': 'CFR atlas', 'receptors': len(inputs), 'source': 'site',
         'note': '%d receptors have at least one CFR position numbered.' % n_numbered_any},
        {'view': 'AlphaMissense comparison (paper)', 'receptors': int(am['receptors']), 'source': 'manuscript',
         'note': 'The corrected supplement analysis; GPR3, GPR4 and XCR1 are left out (their batch '
                 'annotation belonged to GPR31, GPR42 and CXCR1).'},
    ]
    return {
        'meta': _meta('overview', inputs),
        'tiles': tiles,
        'coverage': coverage,
        'exclusions': {
            'not_modeled': NOT_MODELED,
            'not_modeled_note': ('class_A_all.csv lists 287 receptors; these 4 lack a complete active and '
                                 'inactive model pair and are not in the database.'),
        },
    }


# --------------------------------------------------------------------------- figures

def fig_cfr_atlas(atlas, mode='direction', order='helices'):
    """The 50 x 283 matrix. mode 'direction': net dRRCS at hit cells (red/blue), gray where the receptor has
    no residue at the position; mode 'state': the three states. order: 'helices' or 'rank'."""
    cols = list(range(len(atlas['positions']))) if order == 'helices' else atlas['rank_order']
    x = [atlas['positions'][k]['gn'] for k in cols]
    rows = atlas['receptors']
    y = ['%s (%s)' % (r['symbol'], r['family']) for r in rows]
    fig = go.Figure()
    if mode == 'state':
        z = [[int(r['state'][k]) for k in cols] for r in rows]
        fig.add_trace(go.Heatmap(
            z=z, x=x, y=y, zmin=0, zmax=2, showscale=False,
            colorscale=[[0, '#E2E8F0'], [0.333, '#E2E8F0'], [0.334, '#FFFFFF'], [0.666, '#FFFFFF'],
                        [0.667, '#0D9488'], [1, '#0D9488']],
            hovertemplate='%{y}<br>%{x}<br>state %{z}<extra></extra>'))
    else:
        missing = [[1 if r['state'][k] == '0' else None for k in cols] for r in rows]
        z = [[(r['net'][k] if r['state'][k] == '2' else (0 if r['state'][k] == '1' else None)) for k in cols]
             for r in rows]
        vals = [abs(v) for row in z for v in row if v]
        lim = float(np.percentile(vals, 95)) if vals else 1.0
        fig.add_trace(go.Heatmap(z=missing, x=x, y=y, showscale=False, hoverinfo='skip',
                                 colorscale=[[0, '#E2E8F0'], [1, '#E2E8F0']]))
        fig.add_trace(go.Heatmap(
            z=z, x=x, y=y, zmin=-lim, zmax=lim, zmid=0, colorscale=DIVERGING, hoverongaps=False,
            colorbar=dict(title=dict(text='Net ΔRRCS'), thickness=12),
            hovertemplate='%{y}<br>%{x}<br>Net ΔRRCS of above-threshold contacts: %{z:+.2f}<extra></extra>'))
    fig.update_layout(
        title='The %d CFR positions across %d receptors' % (len(x), len(rows)),
        height=max(600, 4 * len(rows)), xaxis=dict(side='top', tickangle=-90, tickfont=dict(size=9)),
        yaxis=dict(autorange='reversed', showticklabels=False), margin=dict(l=20, r=20, t=110, b=20))
    return fig


def explorer_rows(receptors):
    """receptors.json rows as dicts keyed by `columns`."""
    cols = receptors['columns']
    return [dict(zip(cols, r)) for r in receptors['rows']]


def fig_explorer_scatter(receptors, x='n_above', y='share_active', size='cfr_hits'):
    """Every receptor as a point, colored by ligand group; x on a log axis for counts and sums."""
    label = {m['key']: m['label'] for m in receptors['metrics']}
    rows = explorer_rows(receptors)
    fig = go.Figure()
    for g in receptors['ligand_groups']:
        sub = [r for r in rows if r['ligand_group'] == g['key'] and r[x] is not None
               and r[y] is not None]
        if not sub:
            continue
        sz = [r[size] or 0 for r in sub]
        fig.add_trace(go.Scatter(
            x=[r[x] for r in sub], y=[r[y] for r in sub], mode='markers', name='%s (%d)' % (g['key'], len(sub)),
            marker=dict(color=g['color'], size=[5 + 0.35 * s for s in sz], opacity=0.85,
                        line=dict(width=0.5, color='#FFFFFF')),
            text=[r['symbol'] for r in sub], customdata=[[r['family'], r['report']] for r in sub],
            hovertemplate='%{text} (%{customdata[0]})<br>' + label.get(x, x) + ': %{x}<br>'
                          + label.get(y, y) + ': %{y}<extra></extra>'))
    fig.update_layout(
        title='%s and %s, %d receptors' % (label.get(x, x), label.get(y, y).lower(), len(receptors['rows'])),
        xaxis=dict(title=label.get(x, x), type='log' if x in ('n_above', 'sum_abs', 'n_pairs') else 'linear'),
        yaxis=dict(title=label.get(y, y), tickformat='.0%' if y == 'share_active' else None),
        height=520, legend=dict(orientation='h', y=-0.2))
    return fig


def fig_family_strip(receptors, metric='n_above'):
    """One row per family with at least FAMILY_MIN receptors: each receptor a dot, a median tick."""
    label = {m['key']: m['label'] for m in receptors['metrics']}
    fams = sorted((f for f in receptors['families'] if f['plotted'] and f['median_' + metric] is not None),
                  key=lambda f: f['median_' + metric])
    names = ['%s (%d)' % (f['family'], f['n']) for f in fams]
    color = {g['key']: g['color'] for g in receptors['ligand_groups']}
    rows = explorer_rows(receptors)
    fig = go.Figure()
    for f, nm in zip(fams, names):
        sub = [r for r in rows if r['family'] == f['family'] and r[metric] is not None]
        fig.add_trace(go.Scatter(
            x=[r[metric] for r in sub], y=[nm] * len(sub), mode='markers', showlegend=False,
            marker=dict(size=7, color=color.get(ligand_group(f['ligand']), '#475569'), opacity=0.8),
            text=[r['symbol'] for r in sub], customdata=[r['report'] for r in sub],
            hovertemplate='%{text}: %{x}<extra></extra>'))
    fig.add_trace(go.Scatter(
        x=[f['median_' + metric] for f in fams], y=names, mode='markers', name='median',
        marker=dict(symbol='line-ns-open', size=16, line=dict(width=2, color='#0F172A')),
        hovertemplate='median %{x}<extra></extra>'))
    fig.update_layout(
        title='%s by family (families with at least %d receptors)' % (label.get(metric, metric), FAMILY_MIN),
        xaxis=dict(title=label.get(metric, metric), tickformat='.0%' if metric == 'share_active' else None),
        height=max(400, 22 * len(fams) + 120), margin=dict(l=220))
    return fig


# --------------------------------------------------------------------------- CSV tables

def _csv(rows, header):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def csv_tables(payloads):
    """{filename: CSV text} for the cards' table views and downloads."""
    hp, atlas, rec, ov = (payloads[k] for k in ('helix_pairs', 'cfr_atlas', 'receptors', 'overview'))
    segs = hp['segments']
    cols = hp['summary_columns']
    hp_rows = [[g['key'], g['n'], segs[c[0]], segs[c[1]]] + c[2:] for g in hp['groups'] for c in g['cells']]
    pos = atlas['positions']
    at_rows = [[r['gid'], r['symbol'], r['ligand'], r['family'], p['gn'], p['segment'], p['rank'],
                int(r['state'][k]), r['net'][k]] for r in atlas['receptors'] for k, p in enumerate(pos)]
    rc = rec['columns']
    return {
        'helix_pairs.csv': _csv(hp_rows, ['group', 'group_n', 'segment_a', 'segment_b'] + cols[2:]),
        'cfr_atlas.csv': _csv(at_rows, ['gid', 'symbol', 'ligand_type', 'family', 'generic_number',
                                        'segment', 'cfr_score_rank', 'state', 'net_delta_rrcs']),
        'receptors.csv': _csv(rec['rows'], rc),
        'coverage.csv': _csv([[c['view'], c['receptors'], c['source'], c['note']] for c in ov['coverage']],
                             ['view', 'receptors', 'source', 'note']),
    }


# --------------------------------------------------------------------------- build + hook

def build_class_atlas(store, manuscript=None, folder=None):
    """All four payloads and the figure factories' default figures."""
    inputs = receptor_inputs(store, folder)
    payloads = {}
    payloads['helix_pairs'], payloads['helix_pair_cells'] = build_helix_pairs(inputs)
    payloads['cfr_atlas'] = build_cfr_atlas(inputs)
    payloads['receptors'] = build_receptors(inputs, payloads['cfr_atlas'])
    payloads['overview'] = build_overview(inputs, manuscript)
    figures = {
        'fig_helix_pair_signed': fig_helix_pair_signed(payloads['helix_pairs']),
        'fig_helix_pair_coverage': fig_helix_pair_coverage(payloads['helix_pairs']),
        'fig_cfr_atlas': fig_cfr_atlas(payloads['cfr_atlas']),
        'fig_explorer_scatter': fig_explorer_scatter(payloads['receptors']),
        'fig_family_strip': fig_family_strip(payloads['receptors']),
    }
    return {'payloads': payloads, 'figures': figures, 'n_receptors': len(inputs)}


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def write_stats_data(atlas, output_dir):
    """Write data/stats/{name}.json, the CSVs, figures/fig_*.json and manifest.json under output_dir.
    Returns {relative path: bytes}."""
    root = Path(output_dir) / STATS_SUBDIR
    (root / 'figures').mkdir(parents=True, exist_ok=True)
    files = {}

    def put(rel, text):
        data = text.encode('utf-8')
        (root / rel).write_bytes(data)
        files[str(STATS_SUBDIR / rel)] = len(data)

    for name, payload in atlas['payloads'].items():
        put('%s.json' % name, _dump(payload))
    for fname, text in csv_tables(atlas['payloads']).items():
        put(fname, text)
    for name, fig in atlas['figures'].items():
        put('figures/%s.json' % name, fig.to_json())
    manifest = {'schema': SCHEMA % 'manifest', 'layer': 'site', 'label': LAYER_LABEL,
                'files': [{'path': p, 'bytes': b} for p, b in sorted(files.items())]}
    put('manifest.json', _dump(manifest))
    return files


def stats_data_for_page(store, analysis_results, output_dir):
    """The Statistics page hook: build once (cached in analysis_results['class_atlas']), write the files,
    return {'payloads', 'figures', 'files', 'urls'}; urls are relative to the site root."""
    atlas = analysis_results.get('class_atlas')
    if atlas is None:
        atlas = build_class_atlas(store, analysis_results.get('manuscript'))
        analysis_results['class_atlas'] = atlas
    files = write_stats_data(atlas, output_dir)
    urls = {name: str(STATS_SUBDIR / ('%s.json' % name)) for name in atlas['payloads']}
    urls.update({name: str(STATS_SUBDIR / 'figures' / ('%s.json' % name)) for name in atlas['figures']})
    return {'payloads': atlas['payloads'], 'figures': atlas['figures'], 'files': files, 'urls': urls}
