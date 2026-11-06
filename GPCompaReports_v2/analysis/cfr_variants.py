"""Statistics page: observed variants at the class-wide CFR positions, from the site data (not the paper).

For each of the 50 CFR positions (manuscript_stats.class_cfr_set(): the top-ranked generic positions by
CFR score), across every receptor whose residue carries that generic number, this counts the gnomAD
missense alleles, their AlphaMissense classes, the ClinVar records and the residue conservation. It is
the site's own variant layer, the source the report tables and search use:

    gnomAD v4.1.2 alleles, AlphaMissense per substitution, conservation and GPCRdb numbering fetched
    2026-10-18 from the Studio packs (analysis/pack_layer.py), and every single-gene ClinVar 2026-10-11
    record that search v2 placed on a model residue (search2/variants/<gid>.json, same build).

It is NOT the paper's AlphaMissense comparison (gnomAD v4.1.0 batch layer, 276 receptors, corrected
supplement 2026-11-05b), which manuscript_stats.load_am_comparison() reads and which never changes. The
two count different allele sets and are labeled apart: every file here says "layer": "site". Release
labels come from data_versions.json.

Counting rules
    allele          one gnomAD variant (a pack `variants` row, one genomic change); allele_count sums AC.
    substitution    one unique (receptor, model residue, ref, alt): alleles giving the same amino-acid
                    change are one substitution. The AlphaMissense composition counts substitutions.
    AlphaMissense   the class of the source table (AlphaMissense_aa_substitutions.tsv.gz, the pack's
                    class code), which applies > 0.564 likely pathogenic, 0.34 to 0.564 ambiguous,
                    < 0.34 likely benign to the unrounded score. The packs keep 4 decimals, so 7 of the
                    145,345 alleles show a score of exactly 0.564 (class pathogenic) or 0.34 (benign);
                    am_class() applies the thresholds only where a code is missing. A prediction.
    ClinVar         records search v2 placed on the residue, any classification and kind (records);
                    single-residue missense records by germline classification (missense_by_class; ""
                    is a record without a germline classification) and grouped (missense_groups, by
                    the classification before any "; "); plp_db is the database's own germline P/LP
                    missense set (the pack `clinvar` rows, the records reports and search mark).
    conservation    VarSite conservation via ProtVar, each receptor residue once. An observation about
                    the sequence family, not a prediction of effect.
    af_median       median gnomAD allele frequency over the alleles at the position.

Build hook (in the statistics page generator; search v2 is written before it):

    from ...analysis.cfr_variants import write_cfr_variants
    cfr_var = write_cfr_variants(output_dir, store.gpcr_ids)
    fig_a = fig_cfr_variants_by_position(cfr_var['summary'])     # order='sequence' for the other chip
    fig_b = fig_cfr_variant_counts(cfr_var['summary'])

Files in output_dir/data/stats/ (schema gpcompare.stats.cfr_variants/1), about 60 kB + 50 x 8 kB:

cfr_variants.json
    schema, layer "site", label (one line for the card head), not_paper (one sentence)
    sources        {gnomad, clinvar, alphamissense, conservation, gpcrdb_numbering: {label, ...},
                    pack_release: Studio pack release id, paper_layer: {label, receptors, note}}
    am_thresholds  {benign_below: 0.34, pathogenic_above: 0.564}
    coverage       {receptors, receptors_with_pack, receptors_with_alleles, receptors_with_clinvar,
                    clinvar_all_classes: bool (False without search2: then only clinvar.plp_db is filled)}
    receptors      {fields: [gid, gene, name, report_url], rows}   report_url relative to the site root
    positions      50 objects in CFR rank order:
        generic "6.48x48", cfr_rank, segment "TM6",
        order_helices / order_sequence   0-based display index (helices first is the default)
        receptors_numbered (= residues), receptors_with_alleles,
        alleles, substitutions, allele_count, af_median (null without alleles),
        am_substitutions {benign, ambiguous, pathogenic, unscored}   sums to substitutions
        am_alleles       {benign, ambiguous, pathogenic, unscored}   sums to alleles
        pathogenic_pct_decisive   pathogenic / (pathogenic + benign) substitutions x 100, null if none
        clinvar {records, missense, missense_by_class {classification: n},
                 missense_groups {plp, vus, blb, conflicting, other}, plp_db}
        conservation {median, n}   observation; n = receptor residues with a score
        links {search_q "6.48x48", search_url "search/?q=6.48x48", detail "data/stats/cfr_variants/6.48x48.json"}
    groups         the same fields pooled over position sets, for a comparison row: top50;
                   rank51_368 (rest of the submitted 368-position catalog); outside_catalog (generic-numbered
                   residues outside the 368); other_generic (rank51_368 + outside_catalog, the comparison
                   group the paper names "other generic-numbered positions", here on site data).
                   Each adds {key, label, positions (distinct generic numbers)}.
    totals_check   {alleles_in_packs, substitutions_in_packs}: every pack allele of the 283 receptors

cfr_variants/<generic>.json   one per CFR position, fetched on click: the receptors carrying it
    schema, layer, generic, cfr_rank, fields, rows
    fields [receptor (index into cfr_variants.json receptors.rows), residue, aa, alleles, substitutions,
            benign, ambiguous, pathogenic, unscored, allele_count, af_max, clinvar_missense, clinvar_plp_db,
            conservation, search_q]
    clinvar_missense null without search2; af_max null without alleles; search_q "<gene> <generic>"
    opens search at that receptor's residue (e.g. "DRD2 6.48x48").

cfr_variants.csv, cfr_variants_receptors.csv   the same tables flat, for the card's CSV button.
"""
import csv
import json
import statistics
from collections import Counter
from pathlib import Path
from urllib.parse import quote

import plotly.graph_objects as go

from . import pack_layer
from .manuscript_stats import ALL_CSV, CLINICAL_TINT, class_cfr_ranks, class_cfr_set

SCHEMA = 'gpcompare.stats.cfr_variants/1'
STATS_SUBDIR = Path('data') / 'stats'

#: AlphaMissense thresholds (Cheng et al. 2023): > 0.564 likely pathogenic, < 0.34 likely benign.
AM_PATHOGENIC_ABOVE = 0.564
AM_BENIGN_BELOW = 0.34
AM_CLASSES = ('benign', 'ambiguous', 'pathogenic')
AM_CODE = {'P': 'pathogenic', 'A': 'ambiguous', 'B': 'benign'}
AM_LABEL = {'pathogenic': 'Predicted pathogenic', 'ambiguous': 'Ambiguous', 'benign': 'Predicted benign'}

HELIX = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']
LOOPS = ['ICL1', 'ICL2', 'ICL3', 'ICL4', 'ECL1', 'ECL2', 'ECL3']
TERMINI = ['N-term', 'C-term']
ORDER_HELICES = HELIX + LOOPS + TERMINI          # static/js/segment-order.js ORDERS.helices
ORDER_SEQUENCE = ['N-term', 'TM1', 'ICL1', 'TM2', 'ECL1', 'TM3', 'ICL2', 'TM4', 'ECL2', 'TM5',
                  'ICL3', 'TM6', 'ECL3', 'TM7', 'ICL4', 'H8', 'C-term']

CLINVAR_PLP = ('Pathogenic', 'Likely pathogenic', 'Pathogenic/Likely pathogenic')
CLINVAR_BLB = ('Benign', 'Likely benign', 'Benign/Likely benign')
CLINVAR_GROUPS = ('plp', 'vus', 'blb', 'conflicting', 'other')

GROUPS = (('top50', 'Top 50 positions by CFR score'),
          ('rank51_368', 'Positions ranked 51 to 368 by CFR score'),
          ('outside_catalog', 'Generic-numbered positions outside the 368-position catalog'),
          ('other_generic', 'Other generic-numbered positions (ranked 51 to 368 and outside the catalog)'))

DETAIL_FIELDS = ['receptor', 'residue', 'aa', 'alleles', 'substitutions', 'benign', 'ambiguous', 'pathogenic',
                 'unscored', 'allele_count', 'af_max', 'clinvar_missense', 'clinvar_plp_db', 'conservation',
                 'search_q']


# ------------------------------------------------------------------------------------------- helpers

def am_class(score, code=None):
    """'pathogenic' / 'ambiguous' / 'benign' (the source class code, else the thresholds), None if unscored."""
    if score is None:
        return None
    if code in AM_CODE:
        return AM_CODE[code]
    if score > AM_PATHOGENIC_ABOVE:
        return 'pathogenic'
    if score < AM_BENIGN_BELOW:
        return 'benign'
    return 'ambiguous'


def clinvar_group(classification):
    """plp / vus / blb / conflicting / other, from the germline classification before any '; ' qualifier."""
    c = (classification or '').split(';')[0].strip()
    if c in CLINVAR_PLP:
        return 'plp'
    if c == 'Uncertain significance':
        return 'vus'
    if c in CLINVAR_BLB:
        return 'blb'
    if c.startswith('Conflicting'):
        return 'conflicting'
    return 'other'


def _generic_key(generic):
    """(helix or loop number, position) of '6.48x48' / '45.51x51', for the order inside a segment."""
    a, _, b = generic.split('x')[0].partition('.')
    try:
        return int(a), int(b)
    except ValueError:
        return 999, 0


def display_orders(generics, segments):
    """({generic: index} helices first, {generic: index} along the sequence), BW number inside a segment."""
    def rank(order):
        def key(g):
            seg = segments.get(g)
            return (order.index(seg) if seg in order else len(order), _generic_key(g))
        return {g: i for i, g in enumerate(sorted(generics, key=key))}
    return rank(ORDER_HELICES), rank(ORDER_SEQUENCE)


def search_href(query):
    return 'search/?q=' + quote(query, safe='')


def report_href(gid):
    return 'reports/%s.html' % gid


def detail_href(generic):
    return '%s/cfr_variants/%s.json' % (STATS_SUBDIR.as_posix(), generic)


def _sources(pack_release):
    from ..website import data_versions as dv
    src = dv.load()['sources']

    def pick(key, *fields):
        s = src[key]
        return {f: s[f] for f in ('label',) + fields if f in s}
    return {
        'gnomad': pick('gnomad', 'long_label', 'release', 'fetched'),
        'clinvar': pick('clinvar', 'release', 'build'),
        'alphamissense': pick('alphamissense', 'record'),
        'conservation': pick('conservation', 'fetched'),
        'gpcrdb_numbering': pick('gpcrdb_numbering', 'fetched'),
        'pack_release': pack_release,
        'paper_layer': {
            'label': src['gnomad_batch']['label'],
            'receptors': 276,
            'note': ("The paper's AlphaMissense comparison (corrected supplement 2026-11-05b) uses the %s "
                     "batch layer of 276 receptors and is shown separately with its own numbers."
                     % src['gnomad_batch']['label']),
        },
    }


def _label(sources):
    return ("Site data: %s missense alleles, %s, AlphaMissense per substitution, %s, %s fetched %s. "
            "Not the paper's analysis." % (
                sources['gnomad']['label'], sources['clinvar']['label'], sources['conservation']['label'],
                sources['gpcrdb_numbering']['label'], sources['gpcrdb_numbering'].get('fetched', '')))


def _search2_clinvar(search2_dir, gid):
    """Every ClinVar row search v2 placed for the receptor, as dicts with the class spelled out."""
    path = Path(search2_dir) / 'variants' / ('%s.json' % gid)
    if not path.is_file():
        return None
    block = json.loads(path.read_text(encoding='utf-8')).get('clinvar') or {}
    fields, classes = block.get('fields') or [], block.get('classes') or []
    out = []
    for row in block.get('rows') or []:
        r = dict(zip(fields, row))
        if isinstance(r.get('class'), int):
            r['class'] = classes[r['class']]
        out.append(r)
    return out


# ------------------------------------------------------------------------------------------- per residue

def residue_rows(pack, clinvar_rows=None):
    """{model position: counts} for every pack residue with a generic number.

    Each value: generic, segment, aa, alleles, substitutions, allele_count, afs (list), am_subs / am_alleles
    (Counter over benign/ambiguous/pathogenic/unscored), clinvar_records, clinvar_missense (Counter by
    classification; None without search2), plp_db, conservation (float or None).
    """
    cons = pack.get('conservation') or {}
    res = {}
    for pos, aa, seg, gn, _src in pack.get('residues') or []:
        if gn:
            res[pos] = {'generic': gn, 'segment': seg, 'aa': aa, 'alleles': 0, 'subs': {}, 'allele_count': 0,
                        'afs': [], 'am_alleles': Counter(), 'clinvar_records': 0,
                        'clinvar_missense': None if clinvar_rows is None else Counter(), 'plp_db': 0,
                        'conservation': cons.get(str(pos))}
    for v in pack.get('variants') or []:
        pos, ref, alt, af, ac = v[0], v[1], v[2], v[5], v[6]
        r = res.get(pos)
        if r is None:
            continue
        score, code = pack_layer.am_of(pack, pos, ref, alt)
        cls = am_class(score, code) or 'unscored'
        r['alleles'] += 1
        r['allele_count'] += int(ac or 0)
        if af is not None:
            r['afs'].append(float(af))
        r['am_alleles'][cls] += 1
        r['subs'][(ref, alt)] = cls
    for r in res.values():
        r['substitutions'] = len(r['subs'])
        r['am_subs'] = Counter(r['subs'].values())
    for c in pack.get('clinvar') or []:
        if c[0] in res:
            res[c[0]]['plp_db'] += 1
    for c in clinvar_rows or []:
        r = res.get(c.get('pos'))
        if r is None:
            continue
        r['clinvar_records'] += 1
        if c.get('kind') == 'missense':
            r['clinvar_missense'][c.get('class') or ''] += 1
    return res


def _acc():
    return {'alleles': 0, 'substitutions': 0, 'allele_count': 0, 'af': [], 'am_substitutions': Counter(),
            'am_alleles': Counter(), 'clinvar_records': 0, 'clinvar_missense': Counter(), 'plp_db': 0,
            'conservation': [], 'residues': 0, 'receptors': set(), 'receptors_with_alleles': set(),
            'generics': set()}


def _add(acc, gid, r):
    acc['residues'] += 1
    acc['receptors'].add(gid)
    acc['generics'].add(r['generic'])
    acc['alleles'] += r['alleles']
    acc['substitutions'] += r['substitutions']
    acc['allele_count'] += r['allele_count']
    acc['af'].extend(r['afs'])
    acc['am_substitutions'].update(r['am_subs'])
    acc['am_alleles'].update(r['am_alleles'])
    acc['plp_db'] += r['plp_db']
    acc['clinvar_records'] += r['clinvar_records']
    if r['clinvar_missense'] is not None:
        acc['clinvar_missense'].update(r['clinvar_missense'])
    if r['alleles']:
        acc['receptors_with_alleles'].add(gid)
    if r['conservation'] is not None:
        acc['conservation'].append(float(r['conservation']))


def _finish(acc, with_clinvar):
    am_s = {k: acc['am_substitutions'].get(k, 0) for k in AM_CLASSES + ('unscored',)}
    am_a = {k: acc['am_alleles'].get(k, 0) for k in AM_CLASSES + ('unscored',)}
    decisive = am_s['pathogenic'] + am_s['benign']
    groups = Counter()
    for cls, n in acc['clinvar_missense'].items():
        groups[clinvar_group(cls)] += n
    return {
        'receptors_numbered': len(acc['receptors']),
        'residues': acc['residues'],
        'receptors_with_alleles': len(acc['receptors_with_alleles']),
        'alleles': acc['alleles'],
        'substitutions': acc['substitutions'],
        'allele_count': acc['allele_count'],
        'af_median': statistics.median(acc['af']) if acc['af'] else None,
        'am_substitutions': am_s,
        'am_alleles': am_a,
        'pathogenic_pct_decisive': 100.0 * am_s['pathogenic'] / decisive if decisive else None,
        'clinvar': {
            'records': acc['clinvar_records'] if with_clinvar else None,
            'missense': sum(acc['clinvar_missense'].values()) if with_clinvar else None,
            'missense_by_class': dict(sorted(acc['clinvar_missense'].items())) if with_clinvar else None,
            'missense_groups': {k: groups.get(k, 0) for k in CLINVAR_GROUPS} if with_clinvar else None,
            'plp_db': acc['plp_db'],
        },
        'conservation': {'median': statistics.median(acc['conservation']) if acc['conservation'] else None,
                         'n': len(acc['conservation'])},
    }


# ------------------------------------------------------------------------------------------- build

def build_cfr_variants(gids, pack_folder=None, search2_dir=None, ranks=None):
    """(summary, details): the content of cfr_variants.json and {generic: cfr_variants/<generic>.json}.

    search2_dir None: ClinVar all-class counts are null. Raises when a receptor has no pack, when search2
    lacks a receptor, or when search2 and the packs disagree on the database P/LP set (different releases).
    """
    import pandas as pd
    folder = Path(pack_folder) if pack_folder else pack_layer.pack_dir()
    index = pack_layer.pack_index(folder)
    if index is None:
        raise FileNotFoundError('no Studio packs at %s (set STUDIO_PACK_DIR or STUDIO_ROOT)' % folder)
    ranks = class_cfr_ranks() if ranks is None else ranks
    top = class_cfr_set(ranks)
    top_order = sorted(top, key=lambda g: ranks[g])
    seg_of = {str(g): str(s) for g, s in
              pd.read_csv(ALL_CSV, usecols=['generic_number', 'segment']).itertuples(index=False)}
    with_clinvar = search2_dir is not None

    per_pos = {g: _acc() for g in top_order}
    per_group = {k: _acc() for k, _ in GROUPS}
    receptors, detail_rows = [], {g: [] for g in top_order}
    cov, totals, missing = Counter(), Counter(), []
    for gid in sorted(gids):
        pack = pack_layer.load_pack(gid, folder)
        if pack is None:
            missing.append(gid)
            continue
        cov['with_pack'] += 1
        cv = None
        if with_clinvar:
            cv = _search2_clinvar(search2_dir, gid)
            if cv is None:
                raise FileNotFoundError('search2/variants/%s.json is missing in %s' % (gid, search2_dir))
            if sorted(r['variationId'] for r in cv if r.get('packed')) != sorted(
                    c[5] for c in pack.get('clinvar') or []):
                raise ValueError('search2 and the packs disagree on the ClinVar P/LP set of %s: build search '
                                 'v2 from the same pack release' % gid)
            cov['with_clinvar'] += bool(cv)
        variants = pack.get('variants') or []
        cov['with_alleles'] += bool(variants)
        totals['alleles_in_packs'] += len(variants)
        totals['substitutions_in_packs'] += len({(v[0], v[1], v[2]) for v in variants})
        meta = pack.get('meta') or {}
        ri = len(receptors)
        gene = meta.get('gene') or ''
        receptors.append([gid, gene, meta.get('uniprotName') or gid, report_href(gid)])
        for pos, r in sorted(residue_rows(pack, cv).items()):
            g = r['generic']
            if g in top:
                keys = ('top50',)
            elif g in ranks:
                keys = ('rank51_368', 'other_generic')
            else:
                keys = ('outside_catalog', 'other_generic')
            for k in keys:
                _add(per_group[k], gid, r)
            if g not in top:
                continue
            _add(per_pos[g], gid, r)
            am = r['am_subs']
            detail_rows[g].append([
                ri, pos, r['aa'], r['alleles'], r['substitutions'],
                am.get('benign', 0), am.get('ambiguous', 0), am.get('pathogenic', 0), am.get('unscored', 0),
                r['allele_count'], max(r['afs']) if r['afs'] else None,
                sum(r['clinvar_missense'].values()) if r['clinvar_missense'] is not None else None,
                r['plp_db'], r['conservation'], ('%s %s' % (gene, g)).strip()])
    if missing:
        raise ValueError('no Studio pack for %s in %s' % (', '.join(missing), folder))

    sources = _sources((index.get('release') or {}).get('id'))
    h_ord, s_ord = display_orders(top_order, seg_of)
    positions = []
    for g in top_order:
        p = {'generic': g, 'cfr_rank': ranks[g], 'segment': seg_of.get(g),
             'order_helices': h_ord[g], 'order_sequence': s_ord[g]}
        p.update(_finish(per_pos[g], with_clinvar))
        p['links'] = {'search_q': g, 'search_url': search_href(g), 'detail': detail_href(g)}
        positions.append(p)
    groups = []
    for key, label in GROUPS:
        item = {'key': key, 'label': label, 'positions': len(per_group[key]['generics'])}
        item.update(_finish(per_group[key], with_clinvar))
        groups.append(item)
    summary = {
        'schema': SCHEMA,
        'layer': 'site',
        'label': _label(sources),
        'not_paper': sources['paper_layer']['note'],
        'sources': sources,
        'am_thresholds': {'benign_below': AM_BENIGN_BELOW, 'pathogenic_above': AM_PATHOGENIC_ABOVE},
        'coverage': {'receptors': len(receptors), 'receptors_with_pack': cov['with_pack'],
                     'receptors_with_alleles': cov['with_alleles'],
                     'receptors_with_clinvar': cov['with_clinvar'] if with_clinvar else None,
                     'clinvar_all_classes': with_clinvar},
        'receptors': {'fields': ['gid', 'gene', 'name', 'report_url'], 'rows': receptors},
        'positions': positions,
        'groups': groups,
        'totals_check': dict(totals),
    }
    details = {g: {'schema': SCHEMA, 'layer': 'site', 'generic': g, 'cfr_rank': ranks[g],
                   'fields': DETAIL_FIELDS, 'rows': detail_rows[g]} for g in top_order}
    return summary, details


# ------------------------------------------------------------------------------------------- figures

def _ordered(summary, order):
    key = 'order_sequence' if order == 'sequence' else 'order_helices'
    return sorted(summary['positions'], key=lambda p: p[key])


def fig_cfr_variants_by_position(summary, order='helices', theme='light'):
    """Stacked bars: AlphaMissense class of the observed gnomAD substitutions at each CFR position (% of
    scored substitutions), clinical tint. Each trace has meta {'path_class': ...} for a dark-mode restyle
    (CLINICAL_TINT['dark'])."""
    pos = _ordered(summary, order)
    x = [p['generic'] for p in pos]
    tint = CLINICAL_TINT[theme]
    fig = go.Figure()
    for cls in AM_CLASSES:
        ys, cd = [], []
        for p in pos:
            am = p['am_substitutions']
            scored = am['benign'] + am['ambiguous'] + am['pathogenic']
            ys.append(100.0 * am[cls] / scored if scored else 0.0)
            cd.append([am[cls], scored, p['receptors_with_alleles'], p['segment']])
        fig.add_trace(go.Bar(
            name=AM_LABEL[cls], x=x, y=ys, customdata=cd, marker_color=tint[cls], meta={'path_class': cls},
            hovertemplate=('%{x} (%{customdata[3]})<br>' + AM_LABEL[cls] + ': %{customdata[0]:,} of '
                           '%{customdata[1]:,} scored substitutions (%{y:.1f}%)<br>'
                           '%{customdata[2]} receptors with alleles<extra></extra>')))
    fig.update_layout(
        barmode='stack',
        title=('AlphaMissense prediction for observed gnomAD substitutions at the %d CFR positions '
               '(site data)' % len(pos)),
        yaxis=dict(title='Share of scored substitutions (%)', range=[0, 100]),
        xaxis=dict(title='CFR position (generic number)', type='category', tickangle=-60,
                   categoryorder='array', categoryarray=x),
        legend=dict(orientation='h', y=1.02, yanchor='bottom', x=0, xanchor='left', traceorder='normal'),
        height=420, margin=dict(t=80, b=90),
    )
    return fig


def fig_cfr_variant_counts(summary, order='helices', theme='light'):
    """Bars: observed gnomAD substitutions per CFR position; diamonds: the database's ClinVar P/LP missense
    records there (right axis). Conservation median in the hover as an observation."""
    pos = _ordered(summary, order)
    x = [p['generic'] for p in pos]
    tint = CLINICAL_TINT[theme]
    cd = [[p['alleles'], p['allele_count'], p['af_median'], p['conservation']['median'], p['receptors_numbered']]
          for p in pos]
    fig = go.Figure()
    fig.add_trace(go.Bar(
        name='gnomAD substitutions', x=x, y=[p['substitutions'] for p in pos], customdata=cd,
        marker_color=tint['neutral'], meta={'path_class': 'neutral'},
        hovertemplate=('%{x}: %{y:,} substitutions (%{customdata[0]:,} alleles, allele count '
                       '%{customdata[1]:,})<br>median allele frequency %{customdata[2]:.2e}<br>'
                       '%{customdata[4]} receptors numbered here; conservation median %{customdata[3]:.2f} '
                       '(observed)<extra></extra>')))
    fig.add_trace(go.Scatter(
        name='ClinVar P/LP missense (database set)', x=x, y=[p['clinvar']['plp_db'] or None for p in pos],
        yaxis='y2', mode='markers', marker=dict(symbol='diamond', size=9, color=tint['pathogenic']),
        meta={'path_class': 'pathogenic'},
        hovertemplate='%{x}: %{y} ClinVar pathogenic or likely pathogenic missense records<extra></extra>'))
    fig.update_layout(
        title='Observed gnomAD substitutions and ClinVar P/LP records per CFR position (site data)',
        yaxis=dict(title='Substitutions (gnomAD)', rangemode='tozero'),
        yaxis2=dict(title='ClinVar P/LP records', overlaying='y', side='right', rangemode='tozero',
                    showgrid=False),
        xaxis=dict(title='CFR position (generic number)', type='category', tickangle=-60,
                   categoryorder='array', categoryarray=x),
        legend=dict(orientation='h', y=1.02, yanchor='bottom', x=0, xanchor='left'),
        height=380, margin=dict(t=80, b=90),
    )
    return fig


# ------------------------------------------------------------------------------------------- files

def _dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(',', ':'), ensure_ascii=False, allow_nan=False),
                    encoding='utf-8')
    return path


SUMMARY_CSV_HEAD = [
    'cfr_rank', 'generic_number', 'segment', 'positions', 'receptors_numbered', 'receptors_with_alleles',
    'alleles', 'substitutions', 'allele_count', 'af_median', 'am_benign', 'am_ambiguous', 'am_pathogenic',
    'am_unscored', 'pathogenic_pct_decisive', 'clinvar_records', 'clinvar_missense', 'clinvar_missense_plp',
    'clinvar_missense_vus', 'clinvar_missense_blb', 'clinvar_missense_conflicting', 'clinvar_missense_other',
    'clinvar_plp_db', 'conservation_median', 'conservation_n', 'search_url']


def _summary_csv_rows(summary):
    rows = []
    for p in summary['positions'] + summary['groups']:
        cv, am = p['clinvar'], p['am_substitutions']
        grp = cv['missense_groups'] or {}
        rows.append([p.get('cfr_rank', ''), p.get('generic', p.get('label')), p.get('segment', ''),
                     p.get('positions', 1), p['receptors_numbered'], p['receptors_with_alleles'], p['alleles'],
                     p['substitutions'], p['allele_count'], p['af_median'], am['benign'], am['ambiguous'],
                     am['pathogenic'], am['unscored'], p['pathogenic_pct_decisive'], cv['records'], cv['missense'],
                     grp.get('plp'), grp.get('vus'), grp.get('blb'), grp.get('conflicting'), grp.get('other'),
                     cv['plp_db'], p['conservation']['median'], p['conservation']['n'],
                     (p.get('links') or {}).get('search_url', '')])
    return rows


def _write_csv(path, head, rows, note):
    with path.open('w', newline='', encoding='utf-8') as fh:
        fh.write('# %s\n' % note)
        w = csv.writer(fh)
        w.writerow(head)
        for r in rows:
            w.writerow(['' if v is None else v for v in r])
    return path


def write_cfr_variants(output_dir, gids, pack_folder=None, search2_dir=None):
    """Write data/stats/cfr_variants.json, cfr_variants/<generic>.json and the two CSVs.

    Returns {'summary', 'details', 'paths'}. search2_dir defaults to <output_dir>/search2 (search v2 is
    written earlier in the build); without it the ClinVar all-class counts are null.
    """
    out = Path(output_dir)
    s2 = Path(search2_dir) if search2_dir else out / 'search2'
    summary, details = build_cfr_variants(gids, pack_folder, s2 if (s2 / 'variants').is_dir() else None)
    d = out / STATS_SUBDIR
    paths = {'summary': _dump(d / 'cfr_variants.json', summary)}
    for g, obj in details.items():
        _dump(out / detail_href(g), obj)
    paths['details'] = d / 'cfr_variants'
    paths['summary_csv'] = _write_csv(d / 'cfr_variants.csv', SUMMARY_CSV_HEAD, _summary_csv_rows(summary),
                                      summary['label'])
    recs = summary['receptors']['rows']
    rows = [[g, recs[r[0]][0], recs[r[0]][1]] + r[1:] + [recs[r[0]][3]]
            for g, obj in details.items() for r in obj['rows']]
    paths['detail_csv'] = _write_csv(
        d / 'cfr_variants_receptors.csv', ['generic_number', 'gid', 'gene'] + DETAIL_FIELDS[1:] + ['report_url'],
        rows, summary['label'])
    return {'summary': summary, 'details': details, 'paths': paths}
