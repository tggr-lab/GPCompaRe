"""Variant correlation analysis: CFR vs pathogenicity and conservation.

The statistics page shows conservation against contact change per residue (conservation_by_residue,
make_conservation_density): each receptor residue counted once, conservation from the site's pack layer
(VarSite via ProtVar), |ΔRRCS| from the batch run. Conservation is an observation about the sequence
family, not a prediction. The older per-variant scatter (conservation_vs_delta, make_conservation_scatter)
repeats a residue once per batch variant row and reads the batch CSVs' first-allele conservation; it is
kept for the existing chart until the page moves to the per-residue view.
"""

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from scipy import stats

from .cfr_analysis import CFR_TOP_N
from ..website.format_helpers import fmt_sci, fmt_decimal


def run_variant_analysis(store, cfr_table):
    """Run variant correlation analyses against CFR positions."""
    results = {}

    cfr_positions = _get_cfr_position_map(store, cfr_table)
    results['cfr_positions'] = cfr_positions

    path_result = pathogenicity_enrichment(store, cfr_positions)
    results['pathogenicity'] = path_result
    results['fig_pathogenicity_bar'] = make_pathogenicity_bar(path_result)

    conservation_result = conservation_vs_delta(store)
    results['conservation'] = conservation_result
    results['fig_conservation_scatter'] = make_conservation_scatter(conservation_result)

    per_residue = conservation_by_residue(store)
    results['conservation_residues'] = per_residue
    results['fig_conservation_density'] = make_conservation_density(per_residue)

    high_impact = find_high_impact_variants(store, cfr_positions)
    results['high_impact_variants'] = high_impact

    return results


def _get_cfr_position_map(store, cfr_table):
    """Map each GPCR to the positions carrying a top-CFR_TOP_N generic number.

    The comparison group in the enrichment test below is therefore "positions
    outside the top CFR_TOP_N recurrent CFR positions", not "positions that
    are not CFRs". Many excluded positions are still recurrent CFR positions,
    just below the reporting cutoff.
    """
    if cfr_table.empty:
        return {}

    cfr_gns = set(cfr_table.head(CFR_TOP_N)['generic_number'].tolist())
    result = {}

    for gid in store.gpcr_ids:
        annot_map = store.get_annotation_map(gid)
        cfr_pos = set()
        for pos, info in annot_map.items():
            gn = info.get('display_number', '') or info.get('generic_number', '')
            if gn in cfr_gns:
                cfr_pos.add(pos)
        if cfr_pos:
            result[gid] = cfr_pos

    return result


def pathogenicity_enrichment(store, cfr_positions):
    """AlphaMissense pathogenicity enrichment at CFRs (chi-squared test)."""
    cfr_counts = {'pathogenic': 0, 'benign': 0, 'ambiguous': 0}
    non_cfr_counts = {'pathogenic': 0, 'benign': 0, 'ambiguous': 0}

    for gid in store.gpcr_ids:
        var_df = store.variant_data.get(gid, pd.DataFrame())
        if var_df.empty or 'am_class' not in var_df.columns:
            continue

        cfr_pos = cfr_positions.get(gid, set())
        for _, row in var_df.iterrows():
            am_class = str(row.get('am_class', '')).lower().strip()
            if am_class not in ('pathogenic', 'benign', 'ambiguous'):
                continue

            protein_pos = int(row['protein_position']) if pd.notna(row.get('protein_position')) else None
            if protein_pos is None:
                continue

            if protein_pos in cfr_pos:
                cfr_counts[am_class] += 1
            else:
                non_cfr_counts[am_class] += 1

    # Chi-squared test
    stat_result = {}
    obs = np.array([
        [cfr_counts['pathogenic'], cfr_counts['benign']],
        [non_cfr_counts['pathogenic'], non_cfr_counts['benign']],
    ])
    if obs.min() >= 0 and obs.sum() > 0:
        try:
            chi2, p_value, dof, expected = stats.chi2_contingency(obs)
            stat_result = {
                'test': 'Chi-squared',
                'chi2': float(chi2),
                'p_value': float(p_value),
                'dof': int(dof),
            }
        except ValueError:
            pass

    cfr_total = sum(cfr_counts.values())
    non_cfr_total = sum(non_cfr_counts.values())

    return {
        'cfr_counts': cfr_counts,
        'non_cfr_counts': non_cfr_counts,
        'cfr_total': cfr_total,
        'non_cfr_total': non_cfr_total,
        'cfr_pathogenic_pct': cfr_counts['pathogenic'] / cfr_total * 100 if cfr_total > 0 else 0,
        'non_cfr_pathogenic_pct': non_cfr_counts['pathogenic'] / non_cfr_total * 100 if non_cfr_total > 0 else 0,
        'stats': stat_result,
    }


def make_pathogenicity_bar(path_result):
    """Stacked bar: pathogenicity distribution inside vs outside the top CFRs."""
    cfr = path_result['cfr_counts']
    non_cfr = path_result['non_cfr_counts']
    cfr_total = path_result['cfr_total']
    non_cfr_total = path_result['non_cfr_total']

    if cfr_total == 0 and non_cfr_total == 0:
        return go.Figure()

    categories = ['Pathogenic', 'Ambiguous', 'Benign']
    cfr_pcts = [cfr.get(c.lower(), 0) / cfr_total * 100 if cfr_total > 0 else 0 for c in categories]
    non_cfr_pcts = [non_cfr.get(c.lower(), 0) / non_cfr_total * 100 if non_cfr_total > 0 else 0 for c in categories]

    colors = {'Pathogenic': '#E8820C', 'Ambiguous': '#F0C27A', 'Benign': '#008080'}

    fig = go.Figure()
    for i, cat in enumerate(categories):
        fig.add_trace(go.Bar(
            name=cat, x=['Top %d CFR positions' % CFR_TOP_N,
                         'Outside the top %d' % CFR_TOP_N],
            y=[cfr_pcts[i], non_cfr_pcts[i]],
            marker_color=colors[cat],
            text=[f'{cfr_pcts[i]:.1f}%', f'{non_cfr_pcts[i]:.1f}%'],
            textposition='inside',
        ))

    stat = path_result.get('stats', {})
    title = ('AlphaMissense pathogenicity tier: top %d recurrent CFR '
             'positions vs positions outside them' % CFR_TOP_N)
    if stat:
        title += f" (chi-squared p = {stat['p_value']:.2e})"

    fig.update_layout(
        barmode='stack', title=title,
        yaxis_title='Percentage of Variants',
        height=450,
    )
    return fig


def conservation_vs_delta(store):
    """Scatter plot data: conservation score vs delta_rrcs across all variants."""
    rows = []

    for gid in store.gpcr_ids:
        var_df = store.variant_data.get(gid, pd.DataFrame())
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        if var_df.empty or delta_df.empty:
            continue
        if 'conservation' not in var_df.columns:
            continue

        # Build position -> max abs_delta map
        pos_delta = {}
        for _, row in delta_df.iterrows():
            for res_col in ['res1', 'res2']:
                pos = int(row[res_col])
                val = abs(row['delta_rrcs'])
                if pos not in pos_delta or val > pos_delta[pos]:
                    pos_delta[pos] = val

        for _, row in var_df.iterrows():
            conservation = row.get('conservation')
            if pd.isna(conservation):
                continue
            try:
                conservation = float(conservation)
            except (ValueError, TypeError):
                continue

            protein_pos = int(row['protein_position']) if pd.notna(row.get('protein_position')) else None
            if protein_pos is None:
                continue

            delta = pos_delta.get(protein_pos, 0)
            rows.append({
                'conservation': conservation,
                'max_abs_delta': delta,
                'gpcr_id': gid,
            })

    return pd.DataFrame(rows) if rows else pd.DataFrame()


def make_conservation_scatter(conservation_data):
    """Scatter: conservation vs delta_rrcs with Spearman correlation."""
    if conservation_data.empty:
        return go.Figure()

    # Sample if too many points
    df = conservation_data
    if len(df) > 5000:
        df = df.sample(5000, random_state=42)

    fig = px.scatter(
        df, x='conservation', y='max_abs_delta',
        opacity=0.3,
        title='Conservation score vs |ΔRRCS|',
        labels={
            'conservation': 'Conservation Score',
            'max_abs_delta': 'Max |ΔRRCS| at Position',
        },
        color_discrete_sequence=['#008080'],
    )
    fig.update_traces(marker_size=4)

    # Add Spearman correlation + trendline
    valid = df.dropna(subset=['conservation', 'max_abs_delta'])
    if len(valid) >= 10:
        r, p = stats.spearmanr(valid['conservation'], valid['max_abs_delta'])
        fig.add_annotation(
            x=0.02, y=0.98, xref='paper', yref='paper',
            text=f"Spearman r = {r:.3f}, p = {p:.2e}",
            showarrow=False, font=dict(size=11),
            xanchor='left', yanchor='top',
        )

        # OLS trendline
        m, b = np.polyfit(valid['conservation'], valid['max_abs_delta'], 1)
        x_range = np.linspace(valid['conservation'].min(), valid['conservation'].max(), 50)
        fig.add_trace(go.Scatter(
            x=x_range, y=m * x_range + b,
            mode='lines', line=dict(color='gray', dash='dash', width=1.5),
            showlegend=False, hoverinfo='skip',
        ))

    fig.update_layout(height=500)
    return fig


def conservation_by_residue(store):
    """One row per receptor residue in a contact pair: conservation (pack layer) and the largest |ΔRRCS| of
    the pairs it is in (batch run). Columns gpcr_id, position, conservation, max_abs_delta. Residues without
    a conservation score are left out (missing is not low). Empty without the pack layer."""
    frames = []
    for gid in store.gpcr_ids:
        cons = store.report_conservation(gid)
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        if not cons or delta_df.empty:
            continue
        a = delta_df['delta_rrcs'].abs()
        both = pd.concat([pd.DataFrame({'position': delta_df['res1'].astype(int), 'v': a}),
                          pd.DataFrame({'position': delta_df['res2'].astype(int), 'v': a})])
        top = both.groupby('position', sort=True)['v'].max()
        c = top.index.map(cons.get)
        df = pd.DataFrame({'gpcr_id': gid, 'position': top.index.astype(int),
                           'conservation': pd.to_numeric(pd.Series(c, index=top.index), errors='coerce').values,
                           'max_abs_delta': top.values})
        frames.append(df.dropna(subset=['conservation']))
    if not frames:
        return pd.DataFrame(columns=['gpcr_id', 'position', 'conservation', 'max_abs_delta'])
    return pd.concat(frames, ignore_index=True)


def make_conservation_density(per_residue):
    """Density of receptor residues by conservation and largest |ΔRRCS| (each residue once), single-hue
    counts, with the Spearman coefficient and n as a description, not a test of a prediction."""
    if per_residue is None or per_residue.empty:
        return go.Figure()
    df = per_residue
    # binned here (conservation in 0.04 steps, |ΔRRCS| in steps of 1), so the page carries the counts, not
    # every residue; the color is log10 of the count, as most residues have a small change
    top = float(np.ceil(df['max_abs_delta'].max()))
    z, xe, ye = np.histogram2d(df['conservation'], df['max_abs_delta'], bins=[25, int(top)],
                               range=[[0, 1], [0, top]])
    zt = z.T
    ticks = [v for v in (1, 10, 100, 1000, 10000) if v <= max(zt.max(), 1)]
    fig = go.Figure(go.Heatmap(
        x=(xe[:-1] + xe[1:]) / 2, y=(ye[:-1] + ye[1:]) / 2,
        z=np.where(zt > 0, np.log10(np.where(zt > 0, zt, 1)), np.nan).tolist(),
        customdata=np.dstack([zt, np.broadcast_to(xe[:-1], zt.shape), np.broadcast_to(xe[1:], zt.shape),
                              np.broadcast_to(ye[:-1, None], zt.shape),
                              np.broadcast_to(ye[1:, None], zt.shape)]).round(3).tolist(),
        colorscale='Greys', zmin=0,
        colorbar=dict(title='Residues', thickness=12, tickvals=[np.log10(v) for v in ticks],
                      ticktext=[format(v, ',') for v in ticks]),
        hovertemplate=('conservation %{customdata[1]} to %{customdata[2]}<br>largest |ΔRRCS| '
                       '%{customdata[3]} to %{customdata[4]}<br>%{customdata[0]:,} receptor residues'
                       '<extra></extra>')))
    rho, _p = stats.spearmanr(df['conservation'], df['max_abs_delta'])
    fig.update_layout(
        title=('Conservation and largest contact change per residue (%s residues, %d receptors)'
               % (format(len(df), ','), df['gpcr_id'].nunique())),
        xaxis_title='Conservation (VarSite via ProtVar, observed)',
        yaxis_title='Largest |ΔRRCS| of the residue\'s contacts',
        annotations=[dict(x=0.02, y=0.98, xref='paper', yref='paper', xanchor='left', yanchor='top',
                          showarrow=False, font=dict(size=11),
                          text='Spearman ρ = %.2f over %s residues' % (rho, format(len(df), ',')))],
        height=440,
    )
    return fig


def write_conservation_residues_csv(per_residue, path):
    """The per-residue table behind make_conservation_density, for the card's CSV button."""
    per_residue.to_csv(path, index=False, float_format='%.6g')
    return path


def find_high_impact_variants(store, cfr_positions):
    """Table of high-impact variants at CFR positions."""
    rows = []

    for gid in store.gpcr_ids:
        var_df = store.variant_data.get(gid, pd.DataFrame())
        if var_df.empty:
            continue

        cfr_pos = cfr_positions.get(gid, set())
        if not cfr_pos:
            continue

        for _, row in var_df.iterrows():
            protein_pos = int(row['protein_position']) if pd.notna(row.get('protein_position')) else None
            if protein_pos is None or protein_pos not in cfr_pos:
                continue

            am_class = str(row.get('am_class', '')).lower().strip()
            if am_class != 'pathogenic':
                continue

            rows.append({
                'gpcr_id': gid,
                'uniprot_name': store.name_map.get(gid, gid),
                'position': protein_pos,
                'ref_aa': row.get('ref_aa', ''),
                'alt_aa': row.get('alt_aa', ''),
                'am_score_sort': row.get('am_score', ''),
                'allele_frequency': fmt_sci(row.get('af', ''), digits=2),
                'am_score': fmt_decimal(row.get('am_score', ''), digits=3),
                'am_class': row.get('am_class', ''),
                'conservation': fmt_decimal(row.get('conservation', ''), digits=2),
            })

    df = pd.DataFrame(rows) if rows else pd.DataFrame()
    if not df.empty:
        df['am_score_sort'] = pd.to_numeric(df['am_score_sort'], errors='coerce')
        df = df.sort_values('am_score_sort', ascending=False).head(100)
        df = df.drop(columns=['am_score_sort'])
    return df
