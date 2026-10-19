"""Cross-GPCR comparison: rankings, distributions, family comparisons."""

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from scipy import stats


def run_cross_gpcr_analysis(store):
    """Run all cross-GPCR analyses and return dict of results + plotly figures."""
    results = {}
    info_df = store.get_all_info_df()

    results['rankings'] = compute_rankings(info_df)
    results['fig_ranking_bar'] = make_ranking_bar(info_df)
    results['fig_delta_histogram'] = make_delta_histogram(store)
    results['fig_box_ligand'] = make_box_by_ligand(info_df)
    results['fig_box_family'] = make_box_by_family(info_df)

    return results


def compute_rankings(info_df):
    """Rank GPCRs by sum_abs_delta, mean_abs_delta, max_abs_delta."""
    rankings = {}
    for metric in ['sum_abs_delta', 'mean_abs_delta', 'max_abs_delta']:
        ranked = info_df.sort_values(metric, ascending=False).reset_index(drop=True)
        ranked['rank'] = ranked.index + 1
        rankings[metric] = ranked[['gpcr_id', 'uniprot_name', 'gene_name',
                                    'receptor_family', 'ligand_type', metric, 'rank']].to_dict('records')
    # Add rank columns to info_df for later use
    for metric in ['sum_abs_delta', 'mean_abs_delta', 'max_abs_delta']:
        rank_col = f'rank_{metric}'
        info_df[rank_col] = info_df[metric].rank(ascending=False, method='min').astype(int)
    rankings['info_df_with_ranks'] = info_df
    return rankings


def make_ranking_bar(info_df):
    """Top 30 GPCRs bar chart by sum |delta|, colored by ligand type."""
    top30 = info_df.nlargest(30, 'sum_abs_delta').sort_values('sum_abs_delta', ascending=True)

    fig = px.bar(
        top30, x='sum_abs_delta', y='uniprot_name',
        color='ligand_type', orientation='h',
        title='Top 30 GPCRs by total |ΔRRCS|',
        labels={'sum_abs_delta': 'Sum |ΔRRCS|', 'uniprot_name': 'GPCR',
                'ligand_type': 'Ligand Type'},
        color_discrete_sequence=px.colors.qualitative.Set2,
    )
    fig.update_layout(
        height=700, yaxis_tickfont_size=10,
        margin=dict(l=100, r=20, t=50, b=50),
        legend=dict(orientation='h', y=-0.15),
    )
    return fig


HISTOGRAM_NBINS = 100


def _nice_dtick(rough):
    """Plotly's linear autoTicks: round a rough step up to 1, 2 or 5 x 10^n (then 10)."""
    base = 10 ** np.floor(np.log10(rough))
    for m in (2, 5, 10):
        if rough / base <= m:
            return float(base * m)
    return float(base * 10)


def plotly_autobins(values, nbins):
    """The bins Plotly draws for go.Histogram(x=values, nbinsx=nbins) on a linear axis.

    A port of plotly.js Axes.autoBin (nice step from (max - min) / nbins, the first
    tick at or below the minimum, then autoShiftNumericBins). Returns (start, end, size).
    """
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    lo, hi = float(v.min()), float(v.max())
    size = _nice_dtick((hi - lo) / nbins)
    first_tick = np.ceil(lo / size - 1e-9) * size
    start = first_tick - size

    def near_edge(x):
        return np.mod(1 + (x - start) * 100 / size, 100) < 2

    n = len(v)
    if np.all(np.round(v) == v):
        if size < 1:
            start = lo - 0.5 * size
        else:
            start -= 0.5
            if start + size < lo:
                start += size
    elif near_edge(v + size / 2).sum() < n * 0.1:
        if near_edge(v).sum() > n * 0.3 or near_edge(np.array([lo]))[0] or near_edge(np.array([hi]))[0]:
            shift = size / 2
            start += shift if start + shift < lo else -shift
    count = 1 + int(np.floor((hi - start) / size))
    return float(start), float(start + count * size), size


def prebinned_histogram(values, nbins):
    """(centers, counts, (start, end, size)) with Plotly's own bin edges and bin rule.

    Plotly assigns a value to floor((x - start) / size + 1e-9), so the counts here
    are the ones the browser would compute from the raw values.
    """
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    start, end, size = plotly_autobins(v, nbins)
    nb = int(round((end - start) / size))
    idx = np.floor((v - start) / size + 1e-9).astype(int)
    idx = idx[(idx >= 0) & (idx < nb)]
    counts = np.bincount(idx, minlength=nb)
    centers = start + size * (np.arange(nb) + 0.5)
    return centers, counts, (start, end, size)


def make_delta_histogram(store):
    """Global distribution histogram of all delta_rrcs values.

    Pre-binned: the page used to ship all 213,456 raw values (about 4 MB) for
    Plotly to bin in the browser. The bins below are the ones Plotly picked for
    nbinsx=100, so the chart draws the same bars from about a hundred numbers.
    """
    all_deltas = []
    for gid in store.gpcr_ids:
        df = store.delta_data.get(gid, pd.DataFrame())
        if not df.empty:
            all_deltas.extend(df['delta_rrcs'].tolist())

    centers, counts, (start, end, size) = prebinned_histogram(all_deltas, HISTOGRAM_NBINS)
    # Two x values per bin, just inside its two edges (the count on the first,
    # 0 on the second). With a single value per bin Plotly labels the hover with
    # that value, and with values far from the edges it rounds the range label
    # to them; next to the edges it shows the bin range, as the raw data did.
    eps = size * 1e-6
    xs = np.column_stack([centers - size / 2 + eps, centers + size / 2 - eps]).ravel()
    ys = np.column_stack([counts, np.zeros_like(counts)]).ravel()
    fig = go.Figure()
    fig.add_trace(go.Histogram(
        x=xs.tolist(), y=ys.tolist(), histfunc='sum',
        xbins=dict(start=start, end=end, size=size), autobinx=False,
        marker_color='#008080', opacity=0.8,
        name='ΔRRCS'
    ))
    fig.update_layout(
        title='ΔRRCS distribution across all detected contact pairs',
        xaxis_title='ΔRRCS (Active - Inactive)',
        yaxis_title='Count',
        height=450,
    )
    return fig


def make_box_by_ligand(info_df):
    """Box plots of sum |delta| by ligand type with Kruskal-Wallis test."""
    fig = px.box(
        info_df, x='ligand_type', y='sum_abs_delta',
        color='ligand_type',
        title='ΔRRCS distribution by ligand type',
        labels={'sum_abs_delta': 'Sum |ΔRRCS|', 'ligand_type': 'Ligand Type'},
        color_discrete_sequence=px.colors.qualitative.Set2,
    )

    # Kruskal-Wallis test across ligand types
    groups = [g['sum_abs_delta'].dropna().values for _, g in info_df.groupby('ligand_type') if len(g) >= 3]
    if len(groups) >= 2:
        h_stat, p_value = stats.kruskal(*groups)
        fig.add_annotation(
            x=0.5, y=1.08, xref='paper', yref='paper',
            text=f"Kruskal-Wallis H = {h_stat:.1f}, p = {p_value:.2e}",
            showarrow=False, font=dict(size=11),
        )

    fig.update_layout(
        height=500, showlegend=False,
        xaxis_tickangle=-45,
        margin=dict(b=120, t=80),
    )
    return fig


def make_box_by_family(info_df):
    """Box plots by receptor family (top 15 by count) with Kruskal-Wallis test."""
    top_families = info_df['receptor_family'].value_counts().head(15).index.tolist()
    subset = info_df[info_df['receptor_family'].isin(top_families)]

    fig = px.box(
        subset, x='receptor_family', y='sum_abs_delta',
        color='receptor_family',
        title='ΔRRCS by receptor family (top 15)',
        labels={'sum_abs_delta': 'Sum |ΔRRCS|', 'receptor_family': 'Receptor Family'},
        color_discrete_sequence=px.colors.qualitative.Pastel,
    )

    # Kruskal-Wallis test across families
    groups = [g['sum_abs_delta'].dropna().values for _, g in subset.groupby('receptor_family') if len(g) >= 3]
    if len(groups) >= 2:
        h_stat, p_value = stats.kruskal(*groups)
        fig.add_annotation(
            x=0.5, y=1.08, xref='paper', yref='paper',
            text=f"Kruskal-Wallis H = {h_stat:.1f}, p = {p_value:.2e}",
            showarrow=False, font=dict(size=11),
        )

    fig.update_layout(
        height=550, showlegend=False,
        xaxis_tickangle=-45,
        margin=dict(b=150, t=80),
    )
    return fig
