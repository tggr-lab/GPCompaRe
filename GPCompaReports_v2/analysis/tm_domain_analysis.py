"""TM domain pattern analysis: per-domain changes, domain-domain interactions, conserved regions."""

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from scipy import stats


TM_SEGMENTS = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7']
ALL_SEGMENTS = TM_SEGMENTS + ['H8', 'ICL1', 'ICL2', 'ICL3', 'ECL1', 'ECL2', 'ECL3']


def run_tm_domain_analysis(store):
    """Run TM domain analyses and return results + figures."""
    results = {}

    domain_stats = compute_domain_stats(store)
    results['domain_stats'] = domain_stats
    results['fig_tm_bar'] = make_tm_bar(domain_stats)

    interaction_matrix = compute_domain_interactions(store)
    results['interaction_matrix'] = interaction_matrix
    results['fig_tm_heatmap'] = make_interaction_heatmap(interaction_matrix)

    cv_data = compute_generic_number_variation(store)
    results['cv_data'] = cv_data
    results['fig_conserved_variable'] = make_conserved_variable_scatter(cv_data)

    return results


def compute_domain_stats(store):
    """Per-TM-domain mean |delta| aggregated across all GPCRs."""
    domain_deltas = {seg: [] for seg in ALL_SEGMENTS}

    for gid in store.gpcr_ids:
        annot_map = store.get_annotation_map(gid)
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        if delta_df.empty or not annot_map:
            continue

        for _, row in delta_df.iterrows():
            # Assign interaction to the segment of each residue
            for res_col in ['res1', 'res2']:
                pos = int(row[res_col])
                seg = annot_map.get(pos, {}).get('protein_segment', '')
                if seg in domain_deltas:
                    domain_deltas[seg].append(abs(row['delta_rrcs']))

    stats_list = []
    for seg in ALL_SEGMENTS:
        vals = domain_deltas[seg]
        if vals:
            stats_list.append({
                'segment': seg,
                'mean_abs_delta': np.mean(vals),
                'median_abs_delta': np.median(vals),
                'total_abs_delta': np.sum(vals),
                'count': len(vals),
                'std_abs_delta': np.std(vals),
            })
        else:
            stats_list.append({
                'segment': seg, 'mean_abs_delta': 0, 'median_abs_delta': 0,
                'total_abs_delta': 0, 'count': 0, 'std_abs_delta': 0,
            })

    return pd.DataFrame(stats_list)


def make_tm_bar(domain_stats):
    """Bar chart of per-TM-domain mean |delta| (TM1-7 only)."""
    df = domain_stats[domain_stats['segment'].isin(TM_SEGMENTS)].copy()
    df = df.sort_values('mean_abs_delta', ascending=True)

    fig = go.Figure()
    fig.add_trace(go.Bar(
        x=df['mean_abs_delta'], y=df['segment'],
        orientation='h',
        marker_color='#008080',
        text=[f'{v:.2f}' for v in df['mean_abs_delta']],
        textposition='outside',
    ))
    fig.update_layout(
        title='Mean |ΔRRCS| by TM helix',
        xaxis_title='Mean |ΔRRCS|',
        yaxis_title='Segment',
        height=400,
        margin=dict(l=80, r=80),
    )
    return fig


def compute_domain_interactions(store):
    """Compute domain-domain interaction change matrix (TM1-7 only)."""
    seg_list = TM_SEGMENTS
    seg_idx = {s: i for i, s in enumerate(seg_list)}
    n = len(seg_list)
    matrix = np.zeros((n, n))
    counts = np.zeros((n, n))

    for gid in store.gpcr_ids:
        annot_map = store.get_annotation_map(gid)
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        if delta_df.empty or not annot_map:
            continue

        for _, row in delta_df.iterrows():
            seg1 = annot_map.get(int(row['res1']), {}).get('protein_segment', '')
            seg2 = annot_map.get(int(row['res2']), {}).get('protein_segment', '')
            if seg1 in seg_idx and seg2 in seg_idx:
                i, j = seg_idx[seg1], seg_idx[seg2]
                val = abs(row['delta_rrcs'])
                matrix[i, j] += val
                matrix[j, i] += val
                counts[i, j] += 1
                counts[j, i] += 1

    # Convert to mean
    with np.errstate(divide='ignore', invalid='ignore'):
        mean_matrix = np.where(counts > 0, matrix / counts, 0)

    return pd.DataFrame(mean_matrix, index=seg_list, columns=seg_list)


def make_interaction_heatmap(interaction_matrix):
    """Heatmap of domain-domain interaction changes."""
    fig = go.Figure(data=go.Heatmap(
        z=interaction_matrix.values,
        x=interaction_matrix.columns.tolist(),
        y=interaction_matrix.index.tolist(),
        colorscale=[[0, '#F5F7FA'], [0.5, '#008080'], [1, '#E8820C']],
        text=np.round(interaction_matrix.values, 2),
        texttemplate='%{text}',
        textfont=dict(size=10),
        hovertemplate='%{y} - %{x}<br>Mean |ΔRRCS|: %{z:.2f}<extra></extra>',
    ))
    fig.update_layout(
        title='TM helix pair contact-change heatmap',
        height=500, width=550,
        xaxis_title='Segment', yaxis_title='Segment',
        yaxis_autorange='reversed',
    )
    return fig


def compute_generic_number_variation(store):
    """Coefficient of variation of delta per generic number across GPCRs."""
    gn_values = {}  # generic_number -> list of abs_delta values

    for gid in store.gpcr_ids:
        annot_map = store.get_annotation_map(gid)
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        if delta_df.empty or not annot_map:
            continue

        # Build position -> generic_number mapping
        pos_gn = {}
        for pos, info in annot_map.items():
            gn = info.get('display_number', '') or info.get('generic_number', '')
            if gn:
                pos_gn[pos] = gn

        for _, row in delta_df.iterrows():
            for res_col in ['res1', 'res2']:
                pos = int(row[res_col])
                gn = pos_gn.get(pos, '')
                if gn:
                    if gn not in gn_values:
                        gn_values[gn] = []
                    gn_values[gn].append(abs(row['delta_rrcs']))

    # Compute stats per generic number, filter to TM1-7 only
    tm_segment_ids = {'1', '2', '3', '4', '5', '6', '7'}
    rows = []
    for gn, vals in gn_values.items():
        if len(vals) >= 5:  # Need enough data points
            # Extract segment number from generic number (e.g., "3.50x50" -> "3")
            seg_id = gn.split('.')[0].replace('x', '') if '.' in gn else ''
            if seg_id not in tm_segment_ids:
                continue

            mean_val = np.mean(vals)
            std_val = np.std(vals)
            cv = std_val / mean_val if mean_val > 0 else 0
            rows.append({
                'generic_number': gn,
                'mean_abs_delta': mean_val,
                'std_abs_delta': std_val,
                'cv': cv,
                'n_observations': len(vals),
                'segment': f'TM{seg_id}',
            })

    return pd.DataFrame(rows)


def make_conserved_variable_scatter(cv_data):
    """Scatter plot: mean_delta vs CV for each generic number position (TM1-7 only)."""
    if cv_data.empty:
        return go.Figure()

    fig = px.scatter(
        cv_data, x='mean_abs_delta', y='cv',
        color='segment',
        hover_data=['generic_number', 'n_observations'],
        title='Conserved vs variable positions (mean |Δ| vs coefficient of variation)',
        labels={
            'mean_abs_delta': 'Mean |ΔRRCS|',
            'cv': 'Coefficient of Variation',
            'segment': 'TM Segment',
        },
        color_discrete_sequence=px.colors.qualitative.Set2,
    )

    # Add Spearman correlation + trendline
    r, p = stats.spearmanr(cv_data['mean_abs_delta'], cv_data['cv'])
    fig.add_annotation(
        x=0.02, y=0.98, xref='paper', yref='paper',
        text=f"Spearman r = {r:.3f}, p = {p:.2e}",
        showarrow=False, font=dict(size=11),
        xanchor='left', yanchor='top',
    )

    # Add OLS trendline
    m, b = np.polyfit(cv_data['mean_abs_delta'], cv_data['cv'], 1)
    x_range = np.linspace(cv_data['mean_abs_delta'].min(), cv_data['mean_abs_delta'].max(), 50)
    fig.add_trace(go.Scatter(
        x=x_range, y=m * x_range + b,
        mode='lines', line=dict(color='gray', dash='dash', width=1.5),
        showlegend=False, hoverinfo='skip',
    ))

    fig.update_layout(height=550)
    # Annotate quadrants
    fig.add_annotation(x=0.95, y=0.05, xref='paper', yref='paper',
                       text='High Δ, Low CV: Conserved functional', showarrow=False,
                       font=dict(size=10, color='#008080'))
    fig.add_annotation(x=0.95, y=0.95, xref='paper', yref='paper',
                       text='High Δ, High CV: Variable functional', showarrow=False,
                       font=dict(size=10, color='#E8820C'))
    return fig


# --------------------------------------------------------------------------- helix-pair atlas (site layer)
#
# The Statistics page's helix-pair atlas: for every receptor, the contact pairs at or above its own
# threshold (the report rule, mean + SD of |dRRCS|, at least 0.2), each assigned to the segments of its
# two residues by the Studio packs' GPCRdb numbering, summed per segment pair. The receptor inputs come
# from class_atlas.receptor_inputs(); the JSON schema is in class_atlas's module docstring.

#: Cells where fewer receptors carry an above-threshold pair are left blank in the direction view.
HELIX_PAIR_MIN_RECEPTORS = 10


def _segment_order():
    from ..website.page_generators.report_extras import HELICES_FIRST_ORDER
    return list(HELICES_FIRST_ORDER)


def receptor_helix_pairs(inp, segments=None):
    """{(i, j): [net, gain, loss, n_pairs, n_gain, n_loss]} for one receptor, i <= j in `segments` order,
    plus the number of above-threshold pairs with a residue outside `segments` (no segment in the pack).

    gain = sum of positive dRRCS (stronger in the active model), loss = sum of negative dRRCS (a negative
    number, stronger in the inactive model), net = gain + loss. A pair within one segment counts once."""
    segments = segments or _segment_order()
    idx = {s: i for i, s in enumerate(segments)}
    cells, unmapped = {}, 0
    for r1, r2, d in zip(inp.sig_res1, inp.sig_res2, inp.sig_delta):
        s1 = inp.numbering.get(int(r1), ('', ''))[0]
        s2 = inp.numbering.get(int(r2), ('', ''))[0]
        if s1 not in idx or s2 not in idx:
            unmapped += 1
            continue
        i, j = sorted((idx[s1], idx[s2]))
        c = cells.setdefault((i, j), [0.0, 0.0, 0.0, 0, 0, 0])
        d = float(d)
        c[0] += d
        c[3] += 1
        if d > 0:
            c[1] += d
            c[4] += 1
        elif d < 0:
            c[2] += d
            c[5] += 1
    return cells, unmapped


def _cell_summary(entries, n_group):
    """Class or group summary of one cell from [(net, gain, loss, n_pairs), ...] of the receptors that
    carry at least one above-threshold pair there; n_group is the group's receptor count."""
    present = len(entries)
    net = np.array([e[0] for e in entries], dtype=float) if entries else np.zeros(0)
    mean_net = float(net.sum() / n_group) if n_group else 0.0
    sign = np.sign(mean_net)
    agree = float(((np.sign(net) == sign) & (net != 0)).sum() / present) if present and sign != 0 else None
    return {
        'n_present': present,
        'coverage': present / n_group if n_group else 0.0,
        'mean_net': mean_net,
        'mean_net_present': float(net.mean()) if present else None,
        'agree': agree,
        'n_up': int((net > 0).sum()),
        'n_down': int((net < 0).sum()),
        'mean_gain_present': float(np.mean([e[1] for e in entries])) if present else None,
        'mean_loss_present': float(np.mean([e[2] for e in entries])) if present else None,
        'n_pairs': int(sum(e[3] for e in entries)),
    }


def helix_pair_atlas(inputs, groups, segments=None, min_receptors=HELIX_PAIR_MIN_RECEPTORS):
    """The helix-pair atlas payload (class_atlas docstring, helix_pairs.json) from receptor inputs.

    groups: [(key, label, [receptor index, ...]), ...]; the first is the whole class."""
    segments = segments or _segment_order()
    per = []
    unmapped = 0
    for inp in inputs:
        cells, u = receptor_helix_pairs(inp, segments)
        # one rounding (0.001) for the summary and the drill-down, so their up/down counts agree
        for c in cells.values():
            c[0], c[1], c[2] = round(c[0], 3), round(c[1], 3), round(c[2], 3)
        per.append(cells)
        unmapped += u
    keys = sorted({k for cells in per for k in cells})
    r3 = lambda v: None if v is None else round(v, 3)

    def summarize(members):
        out = []
        for (i, j) in keys:
            entries = [per[r][(i, j)][:4] for r in members if (i, j) in per[r]]
            if not entries:
                continue
            s = _cell_summary(entries, len(members))
            out.append([i, j, s['n_present'], r3(s['coverage']), r3(s['mean_net']), r3(s['agree']),
                        s['n_up'], s['n_down'], r3(s['mean_net_present']), r3(s['mean_gain_present']),
                        r3(s['mean_loss_present']), s['n_pairs']])
        return out

    cells = []
    all_members = groups[0][2]
    for (i, j) in keys:
        rows = sorted((([r] + per[r][(i, j)][:4]) for r in all_members if (i, j) in per[r]),
                      key=lambda x: (x[1], x[0]))
        cells.append({'i': i, 'j': j, 'receptors': rows})
    return {
        'segments': segments,
        'n_helices': sum(1 for s in segments if s.startswith('TM') or s == 'H8'),
        'min_receptors': min_receptors,
        'summary_columns': ['i', 'j', 'n_present', 'coverage', 'mean_net', 'agree', 'n_up', 'n_down',
                            'mean_net_present', 'mean_gain_present', 'mean_loss_present', 'n_pairs'],
        'groups': [{'key': k, 'label': lab, 'n': len(m), 'cells': summarize(m)} for k, lab, m in groups],
        'receptor_columns': ['receptor', 'net', 'gain', 'loss', 'n_pairs'],
        'cells': cells,
        'n_pairs_mapped': int(sum(c[3] for cells_ in per for c in cells_.values())),
        'n_pairs_unmapped': unmapped,
    }


def helix_pair_matrix(payload, metric='mean_net', group='all', helices_only=True):
    """(segments, 2-D list with None for empty or blank cells, n_present 2-D list) of one group summary.

    metric: any summary column. In the direction metrics (mean_net, agree, mean_net_present) cells with
    fewer than payload['min_receptors'] receptors are None."""
    cols = payload['summary_columns']
    segs = payload['segments'][:payload['n_helices']] if helices_only else payload['segments']
    n = len(segs)
    g = next(x for x in payload['groups'] if x['key'] == group)
    z = [[None] * n for _ in range(n)]
    present = [[0] * n for _ in range(n)]
    k, kp = cols.index(metric), cols.index('n_present')
    direction = metric in ('mean_net', 'agree', 'mean_net_present')
    for row in g['cells']:
        i, j = row[0], row[1]
        if i >= n or j >= n:
            continue
        v = row[k]
        if direction and row[kp] < payload['min_receptors']:
            v = None
        z[i][j] = z[j][i] = v
        present[i][j] = present[j][i] = row[kp]
    return segs, z, present


ACTIVE_RED = '#B91C1C'
INACTIVE_BLUE = '#1D4ED8'
DIVERGING = [[0, INACTIVE_BLUE], [0.25, '#93C5FD'], [0.5, '#FFFFFF'], [0.75, '#FCA5A5'], [1, ACTIVE_RED]]
COVERAGE_SCALE = [[0, '#F1F5F9'], [1, '#0D9488']]


def fig_helix_pair_signed(payload, group='all', helices_only=True):
    """Direction view: mean net dRRCS per receptor in each segment pair (red = stronger in the active model,
    blue = stronger in the inactive model), cell text = value and the share of receptors that agree."""
    segs, z, present = helix_pair_matrix(payload, 'mean_net', group, helices_only)
    _, agree, _ = helix_pair_matrix(payload, 'agree', group, helices_only)
    lim = max([abs(v) for row in z for v in row if v is not None] or [1.0])
    text = [['' if z[i][j] is None else '%+.1f<br>%s' % (z[i][j], '' if agree[i][j] is None
                                                          else '%d%%' % round(100 * agree[i][j]))
             for j in range(len(segs))] for i in range(len(segs))]
    g = next(x for x in payload['groups'] if x['key'] == group)
    fig = go.Figure(go.Heatmap(
        z=z, x=segs, y=segs, zmin=-lim, zmax=lim, zmid=0, colorscale=DIVERGING,
        text=text, texttemplate='%{text}', customdata=present, hoverongaps=False,
        colorbar=dict(title=dict(text='Mean net ΔRRCS'), thickness=12),
        hovertemplate='%{y} to %{x}<br>Mean net ΔRRCS per receptor: %{z:+.2f}'
                      '<br>Receptors with an above-threshold pair: %{customdata}<extra></extra>',
    ))
    fig.update_layout(
        title='Helix-pair rewiring, %s (n = %d)' % (g['label'], g['n']),
        yaxis_autorange='reversed', height=520, xaxis_side='top',
        xaxis=dict(constrain='domain'), yaxis=dict(scaleanchor='x'),
    )
    return fig


def fig_helix_pair_coverage(payload, group='all', helices_only=True):
    """Coverage view: share of receptors with at least one above-threshold pair in each segment pair."""
    segs, z, present = helix_pair_matrix(payload, 'coverage', group, helices_only)
    text = [['' if v is None else '%d%%' % round(100 * v) for v in row] for row in z]
    g = next(x for x in payload['groups'] if x['key'] == group)
    fig = go.Figure(go.Heatmap(
        z=z, x=segs, y=segs, zmin=0, zmax=1, colorscale=COVERAGE_SCALE,
        text=text, texttemplate='%{text}', customdata=present, hoverongaps=False,
        colorbar=dict(title=dict(text='Share of receptors'), tickformat='.0%', thickness=12),
        hovertemplate='%{y} to %{x}<br>%{customdata} receptors (%{z:.0%}) have an above-threshold pair'
                      '<extra></extra>',
    ))
    fig.update_layout(
        title='Helix-pair coverage, %s (n = %d)' % (g['label'], g['n']),
        yaxis_autorange='reversed', height=520, xaxis_side='top',
        xaxis=dict(constrain='domain'), yaxis=dict(scaleanchor='x'),
    )
    return fig
