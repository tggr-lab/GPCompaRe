"""Helpers for v2 report pages (copied from the v1 gpcr_report_page.py).

Holds the pure data-prep + figure-building helpers. The v2 report generator
(gpcr_report_page.py in this folder) imports these and adds v2-only logic
(Plotly theme overrides, snake-plot view patches, CFR injection, etc.)

The `generate_all_reports` function from the v1 file is kept intact below
but is NOT called in v2 — v2 has its own generator that renders the v2
template. Kept so the module can still be used as a drop-in v1 replacement
if ever needed.
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from jinja2 import Environment

from ..format_helpers import MISSING, fmt_sci, fmt_decimal
from .. import snake_bake

# Optional ouroboros import for snake plot generation
try:
    from ouroboros import ProteinData, ProteinInfo, RenderConfig, Residue, SnakePlotRenderer
    _OUROBOROS_OK = True
except ImportError:
    _OUROBOROS_OK = False

# Import snake plot data builder from the batch analyzer
_BATCH_DIR = Path(__file__).resolve().parent.parent.parent.parent / 'The_batch_RRCS_analyzer'
if _BATCH_DIR.exists():
    sys.path.insert(0, str(_BATCH_DIR))
try:
    from snake_plot_data_builder import SnakePlotDataBuilder
    _BUILDER_OK = True
except ImportError:
    _BUILDER_OK = False


# Residue tables of the published snake plots. GPCRdb's live tables have moved
# on for 13 receptors since the reports were approved, so the build does not
# read them (scripts/extract_snake_residues.py).
_SNAKE_RESIDUES = Path(__file__).resolve().parent.parent.parent / 'data' / 'snake_residues.json'
_snake_tables = None

# Transmembrane helices (primary analysis)
TM_HELICES = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7']
# Loops and helix 8 (secondary)
LOOP_SEGMENTS = ['ICL1', 'ICL2', 'ICL3', 'ECL1', 'ECL2', 'ECL3', 'H8']
# All segments for lookup
ALL_SEGMENTS = TM_HELICES + LOOP_SEGMENTS


_RCIRCLE_TITLE_RE = re.compile(
    r"(<circle\s+[^/]*?rcircle[^/]*?)\s+title='([^']*)'([^/]*?)/>",
    re.DOTALL,
)
_RTEXT_TITLE_RE = re.compile(
    r"(<text\s+[^>]*?rtext[^>]*?)\s+title='([^']*)'([^>]*?)>",
    re.DOTALL,
)
_SVG_OPEN_TAG_RE = re.compile(r"<svg\b([^>]*)>", re.DOTALL)
_SVG_WIDTH_RE = re.compile(r"\bwidth=['\"]([\d.]+)['\"]")
_SVG_HEIGHT_RE = re.compile(r"\bheight=['\"]([\d.]+)['\"]")


def _inject_svg_tooltips(svg: str) -> str:
    """Convert ouroboros' title='...' attributes on residue elements into
    SVG <title> child elements so browsers render native tooltips on hover.

    Browsers do not show tooltips for SVG elements' title="..." attribute,
    only for a child <title>...</title> element. Ouroboros emits the
    attribute form, so we post-process the SVG to add the child form.
    The original_title='...' attribute is preserved so ouroboros' own
    JS (if any) keeps working.
    """
    svg = _RCIRCLE_TITLE_RE.sub(r"\1\3><title>\2</title></circle>", svg)
    svg = _RTEXT_TITLE_RE.sub(r"\1\3><title>\2</title>", svg)
    return svg


def _inject_svg_viewbox(svg: str) -> str:
    """Add a viewBox to the snake-plot <svg> tag if it lacks one.

    Ouroboros emits the SVG with fixed pixel width/height and no viewBox,
    which prevents the browser from scaling content responsively at narrow
    viewports (snake plot renders blank on mobile). Compute the viewBox
    from the existing width/height so the SVG keeps its intrinsic aspect
    ratio while CSS can size it freely.
    """
    m = _SVG_OPEN_TAG_RE.search(svg)
    if not m:
        return svg
    attrs = m.group(1)
    if 'viewBox' in attrs:
        return svg
    w = _SVG_WIDTH_RE.search(attrs)
    h = _SVG_HEIGHT_RE.search(attrs)
    if not (w and h):
        return svg
    new_open = f"<svg{attrs} viewBox='0 0 {w.group(1)} {h.group(1)}'>"
    return svg.replace(m.group(0), new_open, 1)


def _snake_protein(gpcr_id):
    global _snake_tables
    if _snake_tables is None:
        _snake_tables = json.loads(_SNAKE_RESIDUES.read_text(encoding='utf-8'))['receptors']
    return ProteinData(
        info=ProteinInfo(entry_name=gpcr_id, name=''),
        residues=[Residue(sequence_number=number, amino_acid=letter, protein_segment=segment,
                          display_generic_number=display)
                  for number, letter, segment, display in _snake_tables[gpcr_id]])


def _prepare_snake_plot(gpcr_id, delta_df, var_df, sig_threshold):
    """Prepare snake plot SVG and interactive view JSON for one GPCR.

    Returns (svg_str, json_str) or (None, None) on any failure.
    """
    if not (_OUROBOROS_OK and _BUILDER_OK):
        return None, None
    if delta_df.empty:
        return None, None

    try:
        protein_data = _snake_protein(gpcr_id)
        renderer = SnakePlotRenderer(config=RenderConfig())
        svg = renderer.render(protein_data)
        positions = renderer._extract_positions(svg)

        svg = _inject_svg_tooltips(svg)
        svg = _inject_svg_viewbox(svg)
        # helix labels, membrane sides, x.50 marks and the fitted viewBox (approved 2026-11-05);
        # a label that would lie on a residue raises instead of being drawn (snake_bake.SnakeBakeError)
        svg, _record = snake_bake.bake(svg)

        builder = SnakePlotDataBuilder(
            delta_matrix=delta_df,
            variants_df=var_df,
            protein_data=protein_data,
            significance_threshold=sig_threshold,
        )
        json_data = builder.to_json(positions)
        return svg, json_data
    except snake_bake.SnakeBakeError:
        raise
    except Exception as e:
        print(f"  WARNING: no snake plot for {gpcr_id}: {e}")
        return None, None


def generate_all_reports(env: Environment, store, output_dir, limit=None):
    """Generate reports/{gpcr_id}.html for all GPCRs (or first N if limit set)."""
    reports_dir = output_dir / 'reports'
    reports_dir.mkdir(parents=True, exist_ok=True)

    # Pre-compute rankings from ALL data (so ranks are accurate even with limit)
    info_df = store.get_all_info_df()
    info_df = info_df.sort_values('sum_abs_delta', ascending=False).reset_index(drop=True)
    rank_map = {row['gpcr_id']: idx + 1 for idx, row in info_df.iterrows()}

    template = env.get_template('gpcr_report.html')
    total = len(store.gpcr_ids)
    gpcr_ids = store.gpcr_ids[:limit] if limit else store.gpcr_ids

    snake_ok = _OUROBOROS_OK and _BUILDER_OK
    if snake_ok:
        print(f"  Snake plots enabled (ouroboros available)")
    else:
        print(f"  Snake plots disabled (ouroboros or builder not available)")

    gen_total = len(gpcr_ids)
    for i, gid in enumerate(gpcr_ids):
        if (i + 1) % 50 == 0 or i == 0:
            print(f"  Generating reports: {i + 1}/{gen_total}...")

        info = store.gpcr_info[gid]
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        var_df = store.variant_data.get(gid, pd.DataFrame())
        annot_map = store.get_annotation_map(gid)

        # Per-receptor significance threshold: max(mean(|Δ|) + σ, 0.2)
        sig_threshold = _calc_significance_threshold(delta_df)

        # ---- Charts (4 interactive Plotly) ----
        fig_delta_json = '{}'
        fig_scatter_json = '{}'
        fig_residue_json = '{}'
        fig_tm_json = '{}'

        has_delta_chart = False
        has_scatter_chart = False
        has_residue_chart = False
        has_tm_chart = False

        if not delta_df.empty:
            fig = _make_delta_distribution(delta_df, info['uniprot_name'])
            fig_delta_json = fig.to_json()
            has_delta_chart = True

            fig = _make_scatter_plot(delta_df, info['uniprot_name'])
            fig_scatter_json = fig.to_json()
            has_scatter_chart = True

            fig = _make_residue_changes(delta_df, annot_map, info['uniprot_name'])
            fig_residue_json = fig.to_json()
            has_residue_chart = True

            if annot_map:
                fig = _make_tm_breakdown(delta_df, annot_map, info['uniprot_name'])
                fig_tm_json = fig.to_json()
                has_tm_chart = True

        # ---- Top 100 changes with GPCRdb numbering + badges ----
        top_changes = _get_top_changes(delta_df, annot_map, sig_threshold, n=100)

        # ---- TM Domain active/inactive analysis ----
        tm_summary = _build_tm_summary(delta_df, annot_map, sig_threshold)

        # ---- Full variant table (10 cols) ----
        variants = _prepare_variants_full(var_df, delta_df)

        # ---- Complete RRCS top 1000 ----
        complete_rrcs = _get_complete_rrcs(delta_df, sig_threshold, n=1000)

        # ---- RRCS statistics ----
        rrcs_stats = _calc_rrcs_stats(delta_df, sig_threshold)

        # ---- Snake plot (optional, requires ouroboros) ----
        snake_svg, snake_json = _prepare_snake_plot(gid, delta_df, var_df, sig_threshold)
        has_snake_plot = snake_svg is not None

        # ---- Summary stats for header ----
        max_increase = float(delta_df['delta_rrcs'].max()) if not delta_df.empty else 0.0
        max_decrease = float(delta_df['delta_rrcs'].min()) if not delta_df.empty else 0.0

        html = template.render(
            static_prefix='../',
            active_page='',
            total_gpcrs=total,
            uniprot_name=info['uniprot_name'],
            gene_name=info['gene_name'],
            receptor_family=info['receptor_family'],
            ligand_type=info['ligand_type'],
            uniprot_id=info['uniprot_id'],
            gpcr_id=gid,
            rank=rank_map.get(gid, '?'),
            total_contacts=info['total_contacts'],
            significant_changes=info['significant_changes'],
            sum_abs_delta=info['sum_abs_delta'],
            variants_found=info['variants_found'],
            max_increase=max_increase,
            max_decrease=max_decrease,
            sig_threshold=sig_threshold,
            # Charts
            has_delta_chart=has_delta_chart,
            fig_delta_json=fig_delta_json,
            has_scatter_chart=has_scatter_chart,
            fig_scatter_json=fig_scatter_json,
            has_residue_chart=has_residue_chart,
            fig_residue_json=fig_residue_json,
            has_tm_chart=has_tm_chart,
            fig_tm_json=fig_tm_json,
            # Snake plot
            has_snake_plot=has_snake_plot,
            snake_plot_svg=snake_svg or '',
            snake_plot_json=snake_json or '{}',
            # Data tables
            top_changes=top_changes,
            tm_summary=tm_summary,
            variants=variants,
            total_variants=len(var_df),
            complete_rrcs=complete_rrcs,
            rrcs_stats=rrcs_stats,
        )

        out_path = reports_dir / f'{gid}.html'
        out_path.write_text(html, encoding='utf-8')

    print(f"  Generated: {gen_total} report pages")


# ---------------------------------------------------------------------------
# Significance threshold
# ---------------------------------------------------------------------------

def _calc_significance_threshold(delta_df):
    """Per-receptor significance threshold: max(mean(|Δ|) + σ, 0.2).

    The 0.2 floor follows Zhou et al. 2019 (eLife 8:e50279), the original
    RRCS noise floor (≈ one heavy-atom contact pair). The mean+σ term is
    the z=1 "above-typical" cutoff used by the frustratometer (Ferreiro &
    Wolynes) for structurally-informative residue selection from heavy-
    tailed distributions; |ΔRRCS| distributions are heavy-tailed so z=1
    corresponds to ~upper 10% of contact-pair changes per receptor.
    """
    if delta_df.empty:
        return 0.2
    abs_deltas = delta_df['delta_rrcs'].abs()
    threshold = abs_deltas.mean() + abs_deltas.std()
    return max(threshold, 0.2)


# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

def _make_delta_distribution(delta_df, name):
    """Histogram of delta_rrcs."""
    fig = go.Figure()
    fig.add_trace(go.Histogram(
        x=delta_df['delta_rrcs'].tolist(),
        nbinsx=50,
        marker_color='#008080',
        opacity=0.8,
    ))
    fig.update_layout(
        title=f'ΔRRCS Distribution: {name}',
        xaxis_title='ΔRRCS (Active − Inactive)',
        yaxis_title='Count',
        height=350,
        margin=dict(l=50, r=20, t=50, b=50),
        template='plotly_white',
    )
    return fig


def _make_scatter_plot(delta_df, name):
    """Active vs Inactive RRCS scatter with hover info."""
    hover = [
        f"{r['res1_name']}{int(r['res1'])} - {r['res2_name']}{int(r['res2'])}<br>"
        f"Active: {r['active_rrcs']:.2f} | Inactive: {r['inactive_rrcs']:.2f}<br>"
        f"ΔRRCS: {r['delta_rrcs']:+.2f}"
        for _, r in delta_df.iterrows()
    ]
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=delta_df['inactive_rrcs'].tolist(),
        y=delta_df['active_rrcs'].tolist(),
        mode='markers',
        marker=dict(
            color=delta_df['delta_rrcs'].tolist(),
            colorscale='RdBu_r',
            showscale=True,
            colorbar=dict(title='ΔRRCS'),
            size=5,
            opacity=0.7,
        ),
        text=hover,
        hovertemplate='%{text}<extra></extra>',
    ))
    mn = min(delta_df['active_rrcs'].min(), delta_df['inactive_rrcs'].min())
    mx = max(delta_df['active_rrcs'].max(), delta_df['inactive_rrcs'].max())
    fig.add_shape(type='line', x0=mn, y0=mn, x1=mx, y1=mx,
                  line=dict(color='gray', dash='dash', width=1))
    fig.update_layout(
        title=f'Active vs Inactive RRCS: {name}',
        xaxis_title='Inactive RRCS',
        yaxis_title='Active RRCS',
        height=400,
        margin=dict(l=50, r=20, t=50, b=50),
        template='plotly_white',
    )
    return fig


def _compute_residue_metrics(delta_df, annot_map):
    """Aggregate pair-level ΔRRCS into per-residue metrics.

    Single source of truth used by every residue-level surface (TM-by-TM
    table, residue-wise plot, snake plot patch, residue CSV export, dossier
    writer). One row per residue position that appears in any contact pair.

    Columns:
      position, amino_acid, protein_segment, generic_number, display_number,
      n_contact_partners,
      active_minus_inactive  -- signed sum of delta_rrcs across the residue's contacts
      max_abs_delta          -- max |delta_rrcs| at this residue
      max_signed_delta       -- the signed delta_rrcs at the |Δ|-max contact (preserves sign)
      partner_at_max         -- e.g. "F300", the partner residue at the |Δ|-max contact
    """
    if delta_df is None or delta_df.empty:
        return pd.DataFrame(columns=[
            'position', 'amino_acid', 'protein_segment', 'generic_number',
            'display_number', 'n_contact_partners', 'active_minus_inactive',
            'max_abs_delta', 'max_signed_delta', 'partner_at_max',
        ])

    annot_map = annot_map or {}
    all_res = set(delta_df['res1'].tolist()) | set(delta_df['res2'].tolist())
    rows = []
    for res in sorted(all_res):
        res_int = int(res)
        mask = (delta_df['res1'] == res_int) | (delta_df['res2'] == res_int)
        sub = delta_df.loc[mask]
        if sub.empty:
            continue

        aa_name = ''
        match = sub.loc[sub['res1'] == res_int]
        if len(match):
            aa_name = match.iloc[0]['res1_name']
        else:
            match = sub.loc[sub['res2'] == res_int]
            if len(match):
                aa_name = match.iloc[0]['res2_name']

        deltas = sub['delta_rrcs']
        idx_max = deltas.abs().idxmax()
        max_signed = float(deltas.loc[idx_max])
        max_abs = abs(max_signed)

        max_row = sub.loc[idx_max]
        partner_pos = int(max_row['res2']) if int(max_row['res1']) == res_int else int(max_row['res1'])
        partner_aa = max_row['res2_name'] if int(max_row['res1']) == res_int else max_row['res1_name']
        # Compact one-letter when possible (existing CSVs mix 3-letter and 1-letter)
        partner_at_max = f"{_aa_one_letter(partner_aa)}{partner_pos}"

        partners = set()
        for _, r in sub.iterrows():
            other = int(r['res2']) if int(r['res1']) == res_int else int(r['res1'])
            partners.add(other)

        annot = annot_map.get(res_int, {})
        rows.append({
            'position': res_int,
            'amino_acid': _aa_one_letter(aa_name),
            'protein_segment': annot.get('protein_segment', '') or '',
            'generic_number': annot.get('generic_number', '') or '',
            'display_number': annot.get('display_number', '') or '',
            'n_contact_partners': len(partners),
            'active_minus_inactive': float(deltas.sum()),
            'max_abs_delta': max_abs,
            'max_signed_delta': max_signed,
            'partner_at_max': partner_at_max,
        })

    return pd.DataFrame(rows)


_AA_3_TO_1 = {
    'ALA': 'A', 'ARG': 'R', 'ASN': 'N', 'ASP': 'D', 'CYS': 'C',
    'GLN': 'Q', 'GLU': 'E', 'GLY': 'G', 'HIS': 'H', 'ILE': 'I',
    'LEU': 'L', 'LYS': 'K', 'MET': 'M', 'PHE': 'F', 'PRO': 'P',
    'SER': 'S', 'THR': 'T', 'TRP': 'W', 'TYR': 'Y', 'VAL': 'V',
}


def _aa_one_letter(name):
    if not name:
        return ''
    s = str(name).strip().upper()
    if len(s) == 1:
        return s
    return _AA_3_TO_1.get(s, s[:1])


def _make_residue_changes(delta_df, annot_map, name):
    """Two-panel residue-wise figure: signed sum on top, max |ΔRRCS| below.

    Both panels share the residue-position x-axis. Marker colors use a
    diverging RdBu_r ramp anchored at zero so red = active-favoring and
    blue = inactive-favoring across both panels.
    """
    from plotly.subplots import make_subplots

    metrics = _compute_residue_metrics(delta_df, annot_map)
    if metrics.empty:
        return go.Figure()

    metrics = metrics.sort_values('position').reset_index(drop=True)

    def _label(row):
        lbl = f"{row['amino_acid']}{row['position']}" if row['amino_acid'] else str(row['position'])
        gpcrdb = row['generic_number'] or row['display_number']
        if gpcrdb:
            lbl += f" ({gpcrdb})"
        if row['protein_segment']:
            lbl += f" [{row['protein_segment']}]"
        return lbl

    metrics['label'] = metrics.apply(_label, axis=1)

    # Symmetric color scale around 0 for both panels (sign coloring)
    abs_max = float(max(metrics['active_minus_inactive'].abs().max(),
                        metrics['max_abs_delta'].max()))
    if abs_max == 0:
        abs_max = 1.0

    n_max = float(metrics['n_contact_partners'].max() or 1)
    sizes = (metrics['n_contact_partners'] / n_max * 14 + 4).tolist()

    hover_top = [
        f"{row['label']}<br>Signed sum: {row['active_minus_inactive']:+.2f}"
        f"<br>n contact partners: {row['n_contact_partners']}"
        for _, row in metrics.iterrows()
    ]
    hover_bot = [
        f"{row['label']}<br>Max |ΔRRCS|: {row['max_abs_delta']:.2f}"
        f"<br>Largest single Δ: {row['max_signed_delta']:+.2f} (with {row['partner_at_max']})"
        for _, row in metrics.iterrows()
    ]

    fig = make_subplots(
        rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.10,
        subplot_titles=(
            'Signed sum (active − inactive) ΔRRCS per residue',
            'Largest single contact change (max |ΔRRCS|) per residue',
        ),
    )

    fig.add_trace(go.Scatter(
        x=metrics['position'].tolist(),
        y=metrics['active_minus_inactive'].tolist(),
        mode='markers',
        marker=dict(
            size=sizes,
            color=metrics['active_minus_inactive'].tolist(),
            colorscale='RdBu_r',
            cmin=-abs_max, cmax=abs_max,
            showscale=False,
            opacity=0.8,
            line=dict(width=0.5, color='rgba(0,0,0,0.2)'),
        ),
        text=hover_top,
        hovertemplate='%{text}<extra></extra>',
        name='Signed sum',
        showlegend=False,
    ), row=1, col=1)

    fig.add_hline(y=0, line=dict(color='rgba(0,0,0,0.3)', width=1, dash='dot'), row=1, col=1)

    fig.add_trace(go.Scatter(
        x=metrics['position'].tolist(),
        y=metrics['max_abs_delta'].tolist(),
        mode='markers',
        marker=dict(
            size=sizes,
            color=metrics['max_signed_delta'].tolist(),
            colorscale='RdBu_r',
            cmin=-abs_max, cmax=abs_max,
            showscale=False,
            opacity=0.8,
            line=dict(width=0.5, color='rgba(0,0,0,0.2)'),
        ),
        text=hover_bot,
        hovertemplate='%{text}<extra></extra>',
        name='Max |ΔRRCS|',
        showlegend=False,
    ), row=2, col=1)

    fig.update_yaxes(title_text='Signed sum ΔRRCS', row=1, col=1)
    fig.update_yaxes(title_text='Max |ΔRRCS|', row=2, col=1)
    fig.update_xaxes(title_text='Residue position', row=2, col=1)

    fig.update_layout(
        title=f'Residue-wise RRCS Changes: {name}',
        height=620,
        margin=dict(l=60, r=20, t=70, b=50),
        template='plotly_white',
    )
    return fig


def _make_tm_breakdown(delta_df, annot_map, name):
    """Bar chart of mean ΔRRCS across TM1-TM7. Two traces: absolute (default) and directional (toggleable)."""
    seg_abs = {s: [] for s in TM_HELICES}
    seg_sign = {s: [] for s in TM_HELICES}

    for _, row in delta_df.iterrows():
        delta = float(row['delta_rrcs'])
        for res_col in ['res1', 'res2']:
            pos = int(row[res_col])
            seg = annot_map.get(pos, {}).get('protein_segment', '')
            if seg in seg_abs:
                seg_abs[seg].append(abs(delta))
                seg_sign[seg].append(delta)

    tm_segs = [s for s in TM_HELICES if seg_abs[s]]
    abs_means = [float(np.mean(seg_abs[s])) for s in tm_segs]
    sign_means = [float(np.mean(seg_sign[s])) for s in tm_segs]

    def _color(v, theme):
        if v > 0:
            return '#DC2626' if theme == 'light' else '#F87171'
        if v < 0:
            return '#2563EB' if theme == 'light' else '#60A5FA'
        return '#6B7280' if theme == 'light' else '#9CA3AF'

    colors_light = [_color(v, 'light') for v in sign_means]
    colors_dark = [_color(v, 'dark') for v in sign_means]
    sign_labels = [
        'net active-favoring' if v > 0 else
        'net inactive-favoring' if v < 0 else
        'balanced'
        for v in sign_means
    ]

    fig = go.Figure()
    if tm_segs:
        fig.add_trace(go.Bar(
            x=tm_segs, y=abs_means,
            marker_color='#008080',
            text=[f'{v:.2f}' for v in abs_means],
            textposition='outside',
            name='Absolute',
            hovertemplate='%{x}<br>Mean |ΔRRCS| = %{y:.2f}<extra></extra>',
            visible=True,
        ))
        fig.add_trace(go.Bar(
            x=tm_segs, y=sign_means,
            marker=dict(color=colors_light),
            text=[f'{v:+.2f}' for v in sign_means],
            textposition='outside',
            name='Directional',
            hovertemplate='%{x}<br>Mean signed ΔRRCS = %{y:+.2f}<br>%{customdata}<extra></extra>',
            customdata=sign_labels,
            meta={'colors_light': colors_light, 'colors_dark': colors_dark},
            visible=False,
        ))
    fig.update_layout(
        title=f'Mean |ΔRRCS| by TM helix: {name}',
        xaxis_title='Transmembrane helix',
        yaxis_title='Mean |ΔRRCS|',
        height=380,
        margin=dict(l=50, r=20, t=50, b=50),
        template='plotly_white',
        showlegend=False,
        yaxis=dict(zeroline=True, zerolinecolor='rgba(128,128,128,0.4)', zerolinewidth=1),
    )
    return fig


# ---------------------------------------------------------------------------
# Top 100 changes with GPCRdb numbering + magnitude badges
# ---------------------------------------------------------------------------

def _get_top_changes(delta_df, annot_map, sig_threshold, n=100):
    """Top N changes with GPCRdb numbering, segment, magnitude badge."""
    if delta_df.empty:
        return []

    top = delta_df.nlargest(n, 'abs_delta')
    rows = []
    for rank, (_, row) in enumerate(top.iterrows(), 1):
        res1 = int(row['res1'])
        res2 = int(row['res2'])
        a1 = annot_map.get(res1, {})
        a2 = annot_map.get(res2, {})
        gpcrdb1 = a1.get('generic_number', '') or a1.get('display_number', '')
        gpcrdb2 = a2.get('generic_number', '') or a2.get('display_number', '')
        seg1 = a1.get('protein_segment', '')
        seg2 = a2.get('protein_segment', '')

        delta = float(row['delta_rrcs'])
        abs_d = float(row['abs_delta'])

        if abs_d >= 5.0:
            magnitude = 'HIGH'
            badge_class = 'badge-high'
        elif abs_d >= sig_threshold:
            magnitude = 'MED'
            badge_class = 'badge-medium'
        else:
            magnitude = 'LOW'
            badge_class = 'badge-low'

        is_significant = abs_d >= sig_threshold

        rows.append({
            'rank': rank,
            'res1': res1,
            'res1_name': row['res1_name'],
            'gpcrdb1': gpcrdb1,
            'seg1': seg1,
            'res2': res2,
            'res2_name': row['res2_name'],
            'gpcrdb2': gpcrdb2,
            'seg2': seg2,
            'active_rrcs': float(row['active_rrcs']),
            'inactive_rrcs': float(row['inactive_rrcs']),
            'delta_rrcs': delta,
            'abs_delta': abs_d,
            'magnitude': magnitude,
            'badge_class': badge_class,
            'is_significant': is_significant,
        })
    return rows


# ---------------------------------------------------------------------------
# TM Domain active/inactive summary
# ---------------------------------------------------------------------------

def _build_tm_summary(delta_df, annot_map, sig_threshold):
    """Build TM domain active-favoring vs inactive-favoring analysis.

    Uses the same per-receptor significance threshold as the rest of the
    report (max(mean+σ, 0.2) — see _calc_significance_threshold).

    Returns a dict with 'tm_helices' (TM1-7) and 'loops' (ICL/ECL/H8) lists.
    """
    if delta_df.empty or not annot_map:
        return []

    metrics = _compute_residue_metrics(delta_df, annot_map)
    if metrics.empty:
        return []

    # Position -> per-residue metric record
    metric_by_pos = {int(r['position']): r for _, r in metrics.iterrows()}

    pos_to_seg = {}
    for pos, info in annot_map.items():
        seg = info.get('protein_segment', '')
        if seg:
            pos_to_seg[pos] = seg

    threshold = sig_threshold
    seg_active = {s: [] for s in ALL_SEGMENTS}
    seg_inactive = {s: [] for s in ALL_SEGMENTS}

    for pos, m in metric_by_pos.items():
        seg = pos_to_seg.get(pos, '')
        if seg not in seg_active:
            continue
        signed_sum = float(m['active_minus_inactive'])
        max_signed = float(m['max_signed_delta'])
        # Include if either metric crosses the significance threshold so
        # residues with many small same-sign contacts (large signed sum but
        # small individual Δ) still appear.
        if max(abs(signed_sum), abs(max_signed)) < threshold:
            continue
        # Bucket by the SIGN of the signed_sum (the default visible metric).
        # max_signed sign is also carried so the toggle can recolor without
        # having to re-bucket — but the bucket itself stays stable so the
        # active/inactive columns don't shuffle on toggle.
        entry = {
            'position': pos,
            'signed_sum': signed_sum,
            'max_signed_delta': max_signed,
            'max_abs_delta': float(m['max_abs_delta']),
            'partner_at_max': m['partner_at_max'],
            'n_contact_partners': int(m['n_contact_partners']),
        }
        if signed_sum > 0:
            seg_active[seg].append(entry)
        else:
            seg_inactive[seg].append(entry)

    def _build_entries(segment_list):
        results = []
        for seg in segment_list:
            active = sorted(seg_active.get(seg, []), key=lambda x: x['signed_sum'], reverse=True)
            inactive = sorted(seg_inactive.get(seg, []), key=lambda x: x['signed_sum'])
            positions_in_seg = [p for p, s in pos_to_seg.items() if s == seg]
            seg_range = f"{min(positions_in_seg)}-{max(positions_in_seg)}" if positions_in_seg else '-'
            results.append({
                'domain': seg,
                'range': seg_range,
                'active_residues': active,
                'inactive_residues': inactive,
                'total_active': len(active),
                'total_inactive': len(inactive),
            })
        return results

    return _build_entries(TM_HELICES)


# ---------------------------------------------------------------------------
# Full variant table (10 columns)
# ---------------------------------------------------------------------------

def _parse_rsid_list(raw):
    """rsIDs from the variant CSV's list literal, e.g. "['rs1', 'rs2']"."""
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return []
    return re.findall(r'rs\d+', str(raw))


def _prepare_variants_full(var_df, delta_df):
    """Prepare full 10-column variant table sorted by |ΔRRCS|."""
    if var_df.empty:
        return []

    df = var_df.copy()

    # Compute max |ΔRRCS| per variant position
    def get_max_delta(pos):
        try:
            pos_int = int(pos)
            changes = delta_df.loc[
                (delta_df['res1'] == pos_int) | (delta_df['res2'] == pos_int), 'delta_rrcs'
            ]
            if not changes.empty:
                return float(changes.abs().max())
        except (ValueError, TypeError):
            pass
        return 0.0

    if not delta_df.empty:
        df['max_delta_rrcs'] = df['protein_position'].apply(get_max_delta)
    else:
        df['max_delta_rrcs'] = 0.0

    # Sort by max delta descending, then by am_score descending
    df['am_score_num'] = pd.to_numeric(df.get('am_score', pd.Series(dtype=float)), errors='coerce')
    df = df.sort_values(['max_delta_rrcs', 'am_score_num'], ascending=[False, False])

    rows = []
    for _, row in df.iterrows():
        position = row.get('protein_position', '')
        try:
            position = int(position) if pd.notna(position) else ''
        except (ValueError, TypeError):
            position = str(position)

        hgvsp = str(row.get('hgvsp', '')) if pd.notna(row.get('hgvsp', None)) else MISSING
        hgvsc = str(row.get('hgvsc', '')) if pd.notna(row.get('hgvsc', None)) else MISSING

        af_display = fmt_sci(row.get('af', ''), digits=2)

        het_raw = row.get('het_count', 0)
        try:
            het = int(het_raw) if pd.notna(het_raw) else 0
        except (ValueError, TypeError):
            het = 0

        delta_rrcs_value = float(row.get('max_delta_rrcs', 0))
        delta_rrcs_display = fmt_decimal(delta_rrcs_value, digits=2)

        am_score_display = fmt_decimal(row.get('am_score', ''), digits=3)

        am_class_raw = row.get('am_class', '')
        am_class = str(am_class_raw).strip() if pd.notna(am_class_raw) else ''
        if am_class.upper() == 'PATHOGENIC':
            am_badge = 'pathogenic'
        elif am_class.upper() == 'BENIGN':
            am_badge = 'benign'
        elif am_class.upper() == 'AMBIGUOUS':
            am_badge = 'ambiguous'
        else:
            am_badge = ''
            am_class = MISSING

        conservation_display = fmt_decimal(row.get('conservation', ''), digits=2)

        rsids_raw = row.get('rsids', '')
        if pd.notna(rsids_raw) and str(rsids_raw).strip() not in ('', '[]'):
            rsids_str = str(rsids_raw).strip("[]'\" ")
            if not rsids_str:
                rsids_str = MISSING
        else:
            rsids_str = MISSING

        # Not rendered by the report template. Carried so the site search
        # index (search_index.py) can reuse these exact display strings
        # and still match an allele by its gnomAD id or any of its rsIDs.
        variant_id_raw = row.get('variant_id', '')
        variant_id = str(variant_id_raw).strip() if pd.notna(variant_id_raw) else ''

        rows.append({
            'position': position,
            'variant_id': variant_id,
            'rsid_list': _parse_rsid_list(rsids_raw),
            'hgvsp': hgvsp,
            'hgvsc': hgvsc,
            'af_display': af_display,
            'het': het,
            'delta_rrcs': delta_rrcs_value,
            'delta_rrcs_display': delta_rrcs_display,
            'am_score_display': am_score_display,
            'am_class': am_class,
            'am_badge': am_badge,
            'conservation_display': conservation_display,
            'rsids': rsids_str,
        })

    return rows


# ---------------------------------------------------------------------------
# Complete RRCS top 1000
# ---------------------------------------------------------------------------

def _get_complete_rrcs(delta_df, sig_threshold, n=1000):
    """Get top N RRCS rows for the complete results table."""
    if delta_df.empty:
        return []

    top = delta_df.nlargest(n, 'abs_delta')
    rows = []
    for _, row in top.iterrows():
        delta = float(row['delta_rrcs'])
        abs_d = float(row['abs_delta'])
        rows.append({
            'res1': int(row['res1']),
            'res1_name': row['res1_name'],
            'res2': int(row['res2']),
            'res2_name': row['res2_name'],
            'active_rrcs': float(row['active_rrcs']),
            'inactive_rrcs': float(row['inactive_rrcs']),
            'delta_rrcs': delta,
            'abs_delta': abs_d,
            'is_significant': abs_d >= sig_threshold,
        })
    return rows


# ---------------------------------------------------------------------------
# RRCS statistics
# ---------------------------------------------------------------------------

def _calc_rrcs_stats(delta_df, sig_threshold):
    """Compute RRCS distribution statistics."""
    if delta_df.empty:
        return {}

    deltas = delta_df['delta_rrcs']
    abs_deltas = deltas.abs()
    high_count = int((abs_deltas >= 5.0).sum())
    med_count = int(((abs_deltas >= sig_threshold) & (abs_deltas < 5.0)).sum())
    low_count = int((abs_deltas < sig_threshold).sum())

    return {
        'mean': float(deltas.mean()),
        'std': float(deltas.std()),
        'median': float(deltas.median()),
        'high_count': high_count,
        'med_count': med_count,
        'low_count': low_count,
    }
