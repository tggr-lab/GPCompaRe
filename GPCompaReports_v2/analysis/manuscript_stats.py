"""Cross-receptor recurrence statistics and the AlphaMissense class comparison of the Statistics page.

The ranked class tables (368 recurrent positions, 2,231 pairs) are read from data/class_tables_2026-11-13/
through analysis/class_results.py, which asserts their sha256 (provenance in that folder's PROVENANCE.md).
They are recomputed from the full GPCRdb residue maps of all 283 receptors, as the site's own per-receptor
annotation files number only residues of high-magnitude contacts (that gives 356 positions and 3.50x50 in 261
receptors, against 368 and 274).

This module is the one source of the class-wide CFR set the whole site marks (class_cfr_ranks,
class_cfr_set): the ranking by CFR score, cut at CFR_TOP_N. The report snake plots and residue table, the
search index and every CFR feature of search read it. Report pages otherwise keep their own
report-generation data and stay frozen against tests/fixtures/freeze_manifest.json.

The AlphaMissense comparison (section D) reads data/supplement_2026-11-05b/ (load_am_comparison).
"""
import json
import pathlib

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go

from .cfr_analysis import CFR_TOP_N
from .class_results import class_pairs, class_ranking

DATA_DIR = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'manuscript_2026-08-24'

#: The tables of the 2026-08-24 extraction. The build no longer reads them (class_results reads
#: data/class_tables_2026-11-13/); tests compare the class tables with them.
TOP50_CSV = DATA_DIR / 'S3_top50_recurrent_cfr_positions.csv'
ALL_CSV = DATA_DIR / 'S4_all_recurrent_positions.csv'
PAIRS_CSV = DATA_DIR / 'S5_top20_recurrent_cfr_pairs.csv'
FIG3_JSON = DATA_DIR / 'figure3_enrichment.json'   # retired; no longer read by the build

#: Section D (AlphaMissense comparison): the corrected supplement summary, a byte copy of
#: 02_supplement/source_tables/FigS4_S7_summary_modelnum_2026-11-05b.json (see its PROVENANCE.md).
#: Full-precision floats; the page rounds once, at display.
AM_DIR = DATA_DIR.parent / 'supplement_2026-11-05b'
AM_SUMMARY_JSON = AM_DIR / 'FigS4_S7_summary_modelnum_2026-11-05b.json'
AM_GROUP_LABELS = ('Top 50 positions by CFR score', 'Other generic-numbered positions')

#: Pathogenicity palette, the "clinical tint" (owner's choice 2026-11-05): green likely benign, neutral gray
#: ambiguous, crimson likely pathogenic. The text tokens of static/css/search-ui.css (--path-benign,
#: --path-ambiguous, --path-pathogenic, light and dark); tests/test_stats_cfr_variants.py checks they agree.
#: Figures are drawn with the light set; each trace carries meta {'path_class': ...} so the page can restyle
#: to the dark set. `neutral` is for counts that carry no class (it is not a pathogenicity color).
CLINICAL_TINT = {
    'light': {'benign': '#2B6E2F', 'ambiguous': '#555C68', 'pathogenic': '#B4234B', 'neutral': '#8C959F'},
    'dark': {'benign': '#81C784', 'ambiguous': '#B0B4BC', 'pathogenic': '#F48FB1', 'neutral': '#6E7781'},
}
#: AlphaMissense classes as the chart legend names them: a prediction, never a clinical classification.
AM_TRACE_NAMES = {'Pathogenic': 'Predicted pathogenic', 'Ambiguous': 'Ambiguous', 'Benign': 'Predicted benign'}
AM_COLORS = {cls: CLINICAL_TINT['light'][cls.lower()] for cls in AM_TRACE_NAMES}


def _require(path):
    if not path.is_file():
        raise FileNotFoundError(
            '%s is missing. The statistics page needs the manuscript tables; '
            'they are tracked in the repository so a build never depends on '
            'the source workbook. Re-extract with '
            'scripts/extract_manuscript_tables.py.' % path)
    return path


def class_cfr_ranks():
    """{generic number: CFR score rank} for every recurrent position (368), from the class tables
    (class_results.class_ranking(), data/class_tables_2026-11-13/positions.tsv).

    The class-wide CFR ranking the site shows next to a residue ("class-wide rank N"). The top 50 and their
    order equal S3; below them some ranks moved when GPR4 was numbered with its own GPCRdb entry.
    """
    table = class_ranking()
    return {str(g): int(r) for g, r in zip(table['generic_number'], table['cfr_score_rank'])}


def class_cfr_set(ranks=None):
    """The class-wide CFR positions the site marks: the CFR_TOP_N top-ranked generic positions by CFR score.

    The set of the paper's Figure 3 and of the Statistics page's ranked table (S3); one set everywhere.
    """
    ranks = class_cfr_ranks() if ranks is None else ranks
    return {g for g, r in ranks.items() if r <= CFR_TOP_N}


def load_am_comparison(path=None):
    """Section D numbers from the corrected supplement summary (276 receptors), unrounded.

    groups: scored substitutions (including ambiguous) with pathogenic / ambiguous / benign counts and their
    shares of all scored; decisive_pct: percent pathogenic among decisive calls; odds_ratio and
    conservation_adjusted: [estimate, CI low, CI high] (never shown); dropped: the gids left out of the 276;
    query_receptors: receptors with records in the allele query before they were left out (279).
    """
    doc = json.loads(_require(path or AM_SUMMARY_JSON).read_text(encoding='utf-8'))
    s = doc['without_gpr3_gpr4_xcr1']
    a, b, c, d = s['cells']
    groups = []
    for label, path_, amb, ben, n in ((AM_GROUP_LABELS[0], a, s['ambiguous_cfr'], b, s['n_cfr']),
                                      (AM_GROUP_LABELS[1], c, s['ambiguous_other'], d, s['n_other'])):
        if path_ + amb + ben != n:
            raise ValueError('AlphaMissense summary counts do not add up for %s' % label)
        groups.append({'label': label, 'n': n, 'decisive': path_ + ben,
                       'pathogenic_n': path_, 'ambiguous_n': amb, 'benign_n': ben,
                       'pathogenic': 100.0 * path_ / n, 'ambiguous': 100.0 * amb / n, 'benign': 100.0 * ben / n})
    return {
        'receptors': s['receptors'],
        'cells': [a, b, c, d],
        'groups': groups,
        'decisive_pct': {'top': s['pct_cfr'], 'other': s['pct_other']},
        'odds_ratio': s['or'],
        'conservation_adjusted': s['mh_conservation'],
        'dropped': sorted(doc.get('dropped_rows') or {}),
        'query_receptors': (doc.get('all_rows_incl_gpr3_gpr4_xcr1') or {}).get('receptors'),
    }


def load_manuscript_stats():
    """Everything the statistics page needs from the class tables and the AlphaMissense summary."""
    ranking = class_ranking()
    pairs = class_pairs()
    am = load_am_comparison()
    top50 = ranking.head(CFR_TOP_N).reset_index(drop=True)
    if len(top50) != CFR_TOP_N:
        raise ValueError('the ranking has %d rows, fewer than the top %d' % (len(top50), CFR_TOP_N))
    return {
        'top50': top50,
        'all_positions': ranking,
        'pairs': pairs,
        'am_comparison': am,
        'n_recurrent_positions': len(ranking),
        'n_pairs_universe': len(pairs),
        'fig_recurrence_dotplot': make_recurrence_dotplot(top50),
        'fig_enrichment_bar': make_enrichment_bar(am),
        'fig_am_composition': fig_am_composition(am),
    }


def make_recurrence_dotplot(top50):
    """The ranked recurrent positions, in the submitted order."""
    if top50.empty:
        return go.Figure()
    fig = px.scatter(
        top50, x='mean_abs_delta', y='n_receptors',
        size='cfr_score', color='segment',
        hover_data=['generic_number', 'cfr_score_rank', 'recurrence_rank',
                    'pct_receptors'],
        text='generic_number',
        title='Top %d recurrent Core Functional Residue positions' % CFR_TOP_N,
        labels={
            'mean_abs_delta': 'Mean |ΔRRCS|',
            'n_receptors': 'Receptors with an above-threshold change',
            'segment': 'Segment',
            'cfr_score': 'CFR score',
        },
        color_discrete_sequence=px.colors.qualitative.Set2,
    )
    fig.update_traces(textposition='top center', textfont_size=8)
    fig.update_layout(height=600)
    return fig


def _group_label(g, sep='<br>'):
    return '%s%sn = %s scored, %s decisive' % (g['label'], sep, format(g['n'], ','), format(g['decisive'], ','))


def make_enrichment_bar(am):
    """AlphaMissense class composition at the top 50 positions by CFR score and at other generic-numbered positions.

    Corrected supplement analysis (Fig. S4a, 276 receptors). Bars are shares of all scored substitutions;
    ambiguous predictions are drawn but excluded from the odds ratio. Clinical tint; legend says "predicted";
    each axis label gives both denominators (all scored, decisive).
    """
    groups = am['groups']
    if not groups:
        return go.Figure()
    labels = [_group_label(g) for g in groups]
    fig = go.Figure()
    for cls in ('Pathogenic', 'Ambiguous', 'Benign'):
        key = cls.lower()
        fig.add_trace(go.Bar(
            name=AM_TRACE_NAMES[cls], x=labels, y=[g[key] for g in groups],
            marker_color=AM_COLORS[cls], meta={'path_class': key},
            text=['%.1f%%' % g[key] for g in groups],
            customdata=[g[key + '_n'] for g in groups],
            hovertemplate='%{x}<br>' + AM_TRACE_NAMES[cls] + ': %{customdata:,} (%{y:.1f}%)<extra></extra>',
            textposition='inside', insidetextfont=dict(color='#ffffff'),
        ))
    fig.update_layout(
        barmode='stack',
        title=('AlphaMissense class at the top %d positions by CFR score and at '
               'other generic-numbered positions' % CFR_TOP_N),
        yaxis_title='Share of scored missense substitutions (%)',
        height=450,
    )
    return fig


def fig_am_composition(am):
    """The same corrected comparison as two horizontal composition bars (idea 6a): one bar per group, the
    three predicted classes as shares of all scored substitutions, each group's label and both denominators
    (all scored, decisive) written above its bar so the bars keep the full width on a phone, and the
    decisive-call percentages, odds ratio and conservation-adjusted odds ratio (each rounded once) under the
    title. Every value is load_am_comparison()'s; nothing is recomputed."""
    groups = am['groups']
    if not groups:
        return go.Figure()
    keys = ['top', 'other'][::-1]                       # the top group drawn on top
    gs = groups[::-1]
    fig = go.Figure()
    for cls in ('Benign', 'Ambiguous', 'Pathogenic'):
        key = cls.lower()
        fig.add_trace(go.Bar(
            name=AM_TRACE_NAMES[cls], orientation='h', y=keys, x=[g[key] for g in gs], width=0.5,
            marker_color=AM_COLORS[cls], meta={'path_class': key},
            text=['%.1f%%' % g[key] for g in gs], textposition='inside', insidetextanchor='middle',
            insidetextfont=dict(color='#ffffff'),
            customdata=[[g[key + '_n'], g['label']] for g in gs],
            hovertemplate=('%{customdata[1]}<br>' + AM_TRACE_NAMES[cls]
                           + ': %{customdata[0]:,} (%{x:.1f}% of scored)<extra></extra>'),
        ))
    fig.update_layout(
        barmode='stack',
        title=dict(text=(
            'AlphaMissense predictions (%d receptors)<br><sub>Predicted pathogenic among decisive '
            'calls: %.1f%% vs %.1f%%</sub>' % (am['receptors'], am['decisive_pct']['top'],
                                              am['decisive_pct']['other']))),
        xaxis=dict(title='Share of scored substitutions (%)', range=[0, 100], fixedrange=True),
        yaxis=dict(showticklabels=False, fixedrange=True),
        annotations=[dict(xref='paper', x=0, xanchor='left', y=k, yanchor='bottom', yshift=17, showarrow=False,
                          align='left', text='<b>%s</b>  n = %s scored, %s decisive' % (
                              g['label'], format(g['n'], ','), format(g['decisive'], ',')))
                     for k, g in zip(keys, gs)],
        legend=dict(orientation='h', y=-0.35, x=0, xanchor='left', traceorder='normal'),
        height=360, margin=dict(t=122, l=10, r=10, b=80),
    )
    return fig


def am_comparison_payload(am=None):
    """data/stats/am_comparison.json: the class counts per group unrounded, plus the display strings
    the page prints (each rounded once from the unrounded value)."""
    from ..website import data_versions as dv
    am = am or load_am_comparison()
    top, rest = am['groups']
    return {
        'schema': 'gpcompare.stats.am_comparison/1',
        'label': ('AlphaMissense predicted class of unique missense substitutions at generic-numbered positions, '
                  '%d receptors, %s alleles on model residue numbering.' % (am['receptors'],
                                                                         dv.label('gnomad_batch'))),
        'receptors': am['receptors'],
        'cells': am['cells'],
        'cells_order': ['top pathogenic', 'top benign', 'other pathogenic', 'other benign'],
        'groups': am['groups'],
        'decisive_pct': am['decisive_pct'],
        'display': {
            'top_pct': '%.1f%%' % am['decisive_pct']['top'],
            'other_pct': '%.1f%%' % am['decisive_pct']['other'],
            'top_denominators': '%s scored, %s decisive' % (format(top['n'], ','), format(top['decisive'], ',')),
            'other_denominators': '%s scored, %s decisive' % (format(rest['n'], ','), format(rest['decisive'], ',')),
        },
        'colors': CLINICAL_TINT,
        'class_names': AM_TRACE_NAMES,
    }


def write_am_comparison(output_dir, am=None):
    """Write data/stats/am_comparison.json; return the payload. Its CSV (am_comparison.csv) is written from
    class_variants.json by class_results.csv_tables."""
    out = pathlib.Path(output_dir) / 'data' / 'stats'
    out.mkdir(parents=True, exist_ok=True)
    payload = am_comparison_payload(am)
    (out / 'am_comparison.json').write_text(json.dumps(payload, separators=(',', ':'), allow_nan=False),
                                           encoding='utf-8')
    return payload
