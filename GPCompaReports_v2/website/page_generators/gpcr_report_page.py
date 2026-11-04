"""Generate GPCR report pages (283 pages) — v2 design system.

Delegates the pure data-prep helpers (figure building, snake-plot prep,
table prep, significance threshold) to gpcr_report_helpers, and adds
v2-only logic: Plotly light/dark layout overrides, snake-plot view
patches (CFR from cross-GPCR analysis, AlphaMissense categorical buckets,
ConSurf-palette conservation with per-protein quantile binning).
"""

import csv
import gzip
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
from jinja2 import Environment

from . import gpcr_report_helpers as v1
from . import report_extras
from ..plotly_theming import theme_overrides
from ..seo import report_description, report_title


_UNIPROT_NAMES = Path(__file__).resolve().parent.parent.parent / 'search_sources' / 'uniprot' / 'uniprot_names.tsv.gz'
_protein_names_cache = None


def recommended_name(protein_names):
    """UniProt's recommended name: the text before the first ' (' of the
    protein_names field (alternative names and short names follow in brackets)."""
    return re.sub(r'\s*[(\[].*$', '', protein_names or '').strip()


def load_protein_names(path=None):
    """{UniProt accession: recommended protein name} from the search sources'
    UniProt snapshot (CC BY 4.0). Empty dict if the file is missing."""
    global _protein_names_cache
    if path is None and _protein_names_cache is not None:
        return _protein_names_cache
    src = Path(path) if path else _UNIPROT_NAMES
    names = {}
    if src.is_file():
        with gzip.open(src, 'rt', encoding='utf-8') as fh:
            for row in csv.DictReader(fh, delimiter='\t'):
                name = recommended_name(row.get('protein_names'))
                if row.get('accession') and name:
                    names[row['accession']] = name
    if path is None:
        _protein_names_cache = names
    return names


def _load_conservation_cache(gpcr_id, output_dir):
    """Load the per-GPCR conservation cache written by
    `scripts/fetch_conservation.py`, if it exists.

    Returns {position_int: conservation_score_float} for positions where a
    numeric score is available. Empty dict if no cache.
    """
    if output_dir is None:
        return {}
    cache = Path(output_dir) / 'data' / f'conservation_{gpcr_id}.json'
    if not cache.exists():
        return {}
    try:
        obj = json.loads(cache.read_text())
    except (ValueError, OSError):
        return {}
    scores = obj.get('scores', {}) or {}
    result = {}
    for k, v in scores.items():
        if v is None:
            continue
        try:
            result[int(k)] = float(v)
        except (TypeError, ValueError):
            continue
    return result


def _load_am_landscape_cache(gpcr_id, output_dir):
    """Load the per-GPCR AlphaMissense LANDSCAPE cache written by
    `scripts/fetch_alphamissense.py`, if it exists.

    Returns the MEAN AM score per position (across all 19 possible
    substitutions), which is what the snake plot uses for coloring.
    The max-of-19 is also in the cache file for reference, but not used
    here because it saturates: every TM position has at least one
    pathogenic substitution out of 19, so max ≈ 1 everywhere.

    Returns {position_int: mean_am_score_float}. Empty dict if no cache.
    """
    if output_dir is None:
        return {}
    cache = Path(output_dir) / 'data' / f'alphamissense_{gpcr_id}.json'
    if not cache.exists():
        return {}
    try:
        obj = json.loads(cache.read_text())
    except (ValueError, OSError):
        return {}
    # Prefer mean; fall back to max only if an older cache lacks the mean column
    scores = obj.get('mean_am_score') or obj.get('max_am_score') or {}
    result = {}
    for k, v in scores.items():
        if v is None:
            continue
        try:
            result[int(k)] = float(v)
        except (TypeError, ValueError):
            continue
    return result


CFR_COLOR = '#FF8F00'  # orange accent, matches ouroboros' legend swatch

# AlphaMissense classification thresholds (the values AlphaMissense ships with)
AM_PATHOGENIC_CUTOFF = 0.564
AM_BENIGN_CUTOFF = 0.34
AM_PATHOGENIC_COLOR = '#D32F2F'
AM_AMBIGUOUS_COLOR = '#F57C00'
AM_BENIGN_COLOR = '#388E3C'

# Conservation: ConSurf-inspired diverging palette, but rebalanced so each of
# the 9 grades reads as a distinct step. The canonical ConSurf scale has four
# near-whites clustered at 2-4 and 6-7, which renders as a washed-out gradient
# in a CSS legend; this palette keeps the same teal-variable / burgundy-conserved
# identity but with HSL-smoothed saturation + lightness progression.
CONSURF_GRADE_COLORS = [
    '#0E7F86',  # 1: most variable (deep teal)
    '#3DA8AE',  # 2
    '#7CC6CB',  # 3
    '#B8E0E3',  # 4
    '#F5F3F0',  # 5: neutral (warm off-white)
    '#EEBFD0',  # 6
    '#D87A9F',  # 7
    '#A83468',  # 8
    '#6B1441',  # 9: most conserved (burgundy)
]


def _consurf_grade(score):
    """Bucket a continuous conservation score [0, 1] into grades 1..9 by
    linear mapping. Kept as a fallback for the legacy variant-only path
    (when a full-residue cache isn't available). Per-protein quantile
    binning (_quantile_grades) is preferred and matches ConSurf semantics.

    Convention: score = 0 → grade 1 (variable), score = 1 → grade 9 (conserved).
    """
    try:
        s = float(score)
    except (TypeError, ValueError):
        return None
    if s != s:  # NaN
        return None
    if s <= 0.0:
        return 1
    if s >= 1.0:
        return 9
    return min(9, max(1, int(s * 9) + 1))


def _quantile_grades(scores_by_pos):
    """ConSurf-style 9-quantile binning, computed per protein.

    Splits the receptor's own conservation scores into 9 equal-sized bins
    from most-variable (grade 1) to most-conserved (grade 9). This ensures
    every receptor uses the full palette regardless of the absolute score
    range (ProtVar CONSERV scores cluster 0.25-1.0 for GPCRs, so a fixed
    [0, 1] linear scale never lights up grades 1-2).

    scores_by_pos: {position_int: float}
    Returns:       {position_int: grade_int in 1..9}
    """
    if not scores_by_pos:
        return {}
    values = np.array(list(scores_by_pos.values()), dtype=float)
    if len(values) < 9:
        return {pos: (_consurf_grade(s) or 5) for pos, s in scores_by_pos.items()}
    # 10 quantile boundaries define 9 bins. Use the 8 interior boundaries
    # with searchsorted so each score falls into exactly one bin in [0, 8].
    interior = np.quantile(values, np.linspace(0.0, 1.0, 10))[1:-1]
    grades = {}
    for pos, s in scores_by_pos.items():
        try:
            s_f = float(s)
        except (TypeError, ValueError):
            continue
        if s_f != s_f:  # NaN
            continue
        idx = int(np.searchsorted(interior, s_f, side='right'))  # 0..8
        grades[pos] = max(1, min(9, idx + 1))
    return grades


def _cfr_generic_numbers(analysis_results, top_n=30):
    """Extract the top-N CFR generic numbers (strings like '3.50') from the
    cross-GPCR analysis. Returns an empty set if unavailable."""
    cfr_block = (analysis_results or {}).get('cfr', {})
    cfr_table = cfr_block.get('cfr_table')
    if cfr_table is None or getattr(cfr_table, 'empty', True):
        return set()
    top = cfr_table.head(top_n)
    return set(str(x) for x in top['generic_number'].tolist() if x)


def _am_bucket_color(score):
    """Return the categorical AlphaMissense color for a score, or None."""
    if score is None:
        return None
    try:
        s = float(score)
    except (TypeError, ValueError):
        return None
    if s != s:  # NaN
        return None
    if s >= AM_PATHOGENIC_CUTOFF:
        return AM_PATHOGENIC_COLOR
    if s >= AM_BENIGN_CUTOFF:
        return AM_AMBIGUOUS_COLOR
    return AM_BENIGN_COLOR


def _lerp_hex(frac, lo_hex, hi_hex):
    """Linearly interpolate between two hex colors at fraction [0, 1]."""
    frac = max(0.0, min(1.0, float(frac)))
    def _parse(h):
        h = h.lstrip('#')
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    lr, lg, lb = _parse(lo_hex)
    hr, hg, hb = _parse(hi_hex)
    r = round(lr + (hr - lr) * frac)
    g = round(lg + (hg - lg) * frac)
    b = round(lb + (hb - lb) * frac)
    return f'#{r:02X}{g:02X}{b:02X}'


def _diverging_color(value, vmax):
    """Return a hex color on a blue-white-red ramp anchored at 0.

    value: signed float (e.g. ΔRRCS). Positive → red, negative → blue.
    vmax:  the |value| at which the ramp hits the saturated endpoint.
    """
    if vmax <= 0:
        return '#FFFFFF'
    frac = max(-1.0, min(1.0, float(value) / float(vmax)))
    if frac >= 0:
        # white -> red (#B2182B), matching the snake builder's diverging legend
        return _lerp_hex(frac, '#FFFFFF', '#B2182B')
    return _lerp_hex(-frac, '#FFFFFF', '#2166AC')


def _patch_snake_views(snake_json_str, annot_map, cfr_generic_numbers, var_df,
                       conservation_cache=None, residue_metrics=None,
                       am_landscape_cache=None):
    """Patch the snake plot JSON's view data:
      - CFR view: populate with per-GPCR residue positions (builder stubs empty)
      - AlphaMissense view: switch to categorical (benign/ambiguous/pathogenic)
      - Conservation view: swap purple gradient for white->teal
      - Variants view: remove (we don't expose it in v2)
      - Residue net Δ + Residue max Δ: inject from residue_metrics DataFrame
    """
    if not snake_json_str or snake_json_str == '{}':
        return snake_json_str
    try:
        data = json.loads(snake_json_str)
    except (ValueError, TypeError):
        return snake_json_str
    views = data.setdefault('views', {})

    # --- Residue net Δ + Residue max Δ ---
    if residue_metrics is not None and not residue_metrics.empty:
        net_vmax = float(residue_metrics['active_minus_inactive'].abs().max() or 0.0)
        max_vmax = float(residue_metrics['max_abs_delta'].max() or 0.0)
        net_colors, max_colors = {}, {}
        for _, r in residue_metrics.iterrows():
            pos_str = str(int(r['position']))
            net_colors[pos_str] = _diverging_color(float(r['active_minus_inactive']), net_vmax)
            # Sign coloring on max view per spec ("red-active / blue-inactive convention")
            max_colors[pos_str] = _diverging_color(float(r['max_signed_delta']), max_vmax)

        net_view = views.setdefault('residue_net_delta', {})
        net_view['colors'] = net_colors
        net_view['label'] = 'Residue net Δ'
        net_view['legend_type'] = 'diverging'
        net_view['legend_colors'] = ['#2166AC', '#FFFFFF', '#B2182B']
        net_view['legend_labels'] = [
            f'{-net_vmax:+.1f} (inactive)', '0', f'{net_vmax:+.1f} (active)'
        ] if net_vmax > 0 else ['Inactive-favoring', '0', 'Active-favoring']
        net_view['description'] = (
            "Signed sum of ΔRRCS across all of the residue's contacts. "
            "Red = active-favoring, Blue = inactive-favoring."
        )

        max_view = views.setdefault('residue_max_delta', {})
        max_view['colors'] = max_colors
        max_view['label'] = 'Residue max Δ'
        max_view['legend_type'] = 'diverging'
        max_view['legend_colors'] = ['#2166AC', '#FFFFFF', '#B2182B']
        max_view['legend_labels'] = [
            f'{-max_vmax:+.1f} (inactive)', '0', f'{max_vmax:+.1f} (active)'
        ] if max_vmax > 0 else ['Inactive-favoring', '0', 'Active-favoring']
        max_view['description'] = (
            "Largest |ΔRRCS| at this residue, colored by the sign of that single contact."
        )

    # --- CFR ---
    cfr_colors = {}
    if cfr_generic_numbers:
        for pos, annot in (annot_map or {}).items():
            gn = (annot.get('generic_number') or annot.get('display_number') or '').strip()
            if gn and gn in cfr_generic_numbers:
                cfr_colors[str(pos)] = CFR_COLOR
    cfr_view = views.setdefault('cfr', {})
    cfr_view['colors'] = cfr_colors
    cfr_view['label'] = 'Core Functional'
    cfr_view['legend_type'] = 'categorical'
    cfr_view['legend_items'] = [{'color': CFR_COLOR, 'label': 'CFR position'}]
    cfr_view['description'] = (
        f'Top cross-GPCR Core Functional Residues ({len(cfr_colors)} mapped to this receptor)'
        if cfr_colors else 'No top CFRs mapped to this receptor'
    )

    # --- AlphaMissense (categorical) ---
    # Prefer the LANDSCAPE cache (max AM across all 19 substitutions) so a
    # position colors pathogenic if any theoretical substitution is, not
    # just the substitutions humans happen to carry. Fall back to the
    # gnomAD-observed scores when the landscape cache hasn't been fetched.
    am_colors = {}
    am_counts = {'pathogenic': 0, 'ambiguous': 0, 'benign': 0}
    am_source = None  # 'landscape' | 'observed' | None
    if am_landscape_cache:
        am_source = 'landscape'
        for pos_int, score in am_landscape_cache.items():
            color = _am_bucket_color(score)
            if color is None:
                continue
            am_colors[str(pos_int)] = color
            if color == AM_PATHOGENIC_COLOR:
                am_counts['pathogenic'] += 1
            elif color == AM_AMBIGUOUS_COLOR:
                am_counts['ambiguous'] += 1
            else:
                am_counts['benign'] += 1
    elif var_df is not None and not var_df.empty and 'am_score' in var_df.columns:
        am_source = 'observed'
        for pos, group in var_df.groupby('protein_position'):
            scores = group['am_score'].dropna()
            if scores.empty:
                continue
            try:
                pos_int = int(pos)
            except (TypeError, ValueError):
                continue
            color = _am_bucket_color(scores.max())
            if color is None:
                continue
            am_colors[str(pos_int)] = color
            if color == AM_PATHOGENIC_COLOR:
                am_counts['pathogenic'] += 1
            elif color == AM_AMBIGUOUS_COLOR:
                am_counts['ambiguous'] += 1
            else:
                am_counts['benign'] += 1
    am_view = views.setdefault('alphamissense', {})
    am_view['colors'] = am_colors
    am_view['label'] = 'AlphaMissense'
    am_view['legend_type'] = 'categorical'
    am_view['legend_items'] = [
        {'color': AM_PATHOGENIC_COLOR, 'label': f"Pathogenic (≥ {AM_PATHOGENIC_CUTOFF})"},
        {'color': AM_AMBIGUOUS_COLOR,  'label': f"Ambiguous ({AM_BENIGN_CUTOFF}-{AM_PATHOGENIC_CUTOFF})"},
        {'color': AM_BENIGN_COLOR,     'label': f"Benign (< {AM_BENIGN_CUTOFF})"},
    ]
    if am_source == 'landscape':
        am_view['description'] = (
            f"AlphaMissense per-residue average across all 19 possible "
            f"substitutions (not just the substitutions seen in gnomAD). "
            f"Mean is used rather than max because max-of-19 saturates "
            f"(almost every position has at least one pathogenic substitution). "
            f"{am_counts['pathogenic']} pathogenic, "
            f"{am_counts['ambiguous']} ambiguous, {am_counts['benign']} benign."
        )
    elif am_source == 'observed':
        am_view['description'] = (
            f"AlphaMissense classification at GNOMAD-OBSERVED variant positions only "
            f"(max across observed substitutions). Run scripts/fetch_alphamissense.py "
            f"to enable the full theoretical landscape view. "
            f"{am_counts['pathogenic']} pathogenic, {am_counts['ambiguous']} ambiguous, "
            f"{am_counts['benign']} benign."
        )
    else:
        am_view['description'] = 'No AlphaMissense data for this receptor'

    # --- Conservation: ConSurf 9-grade diverging palette ---
    # Prefer the full-residue ProtVar cache written by scripts/fetch_conservation.py.
    # Fall back to the variant-only column we already have.
    cons_colors = {}
    cache_hit = False
    if conservation_cache:
        cache_hit = True
        # Per-protein quantile binning — matches ConSurf semantics and makes every
        # receptor span grades 1-9 regardless of absolute ProtVar range.
        grades = _quantile_grades(conservation_cache)
        for pos_int, grade in grades.items():
            cons_colors[str(pos_int)] = CONSURF_GRADE_COLORS[grade - 1]
    elif var_df is not None and not var_df.empty and 'conservation' in var_df.columns:
        for pos, group in var_df.groupby('protein_position'):
            vals = group['conservation'].dropna()
            if vals.empty:
                continue
            try:
                pos_int = int(pos)
            except (TypeError, ValueError):
                continue
            grade = _consurf_grade(float(vals.iloc[0]))
            if grade is None:
                continue
            cons_colors[str(pos_int)] = CONSURF_GRADE_COLORS[grade - 1]
    cons_view = views.setdefault('conservation', {})
    cons_view['colors'] = cons_colors
    cons_view['label'] = 'Conservation'
    cons_view['legend_type'] = 'sequential'
    cons_view['legend_colors'] = list(CONSURF_GRADE_COLORS)
    cons_view['legend_labels'] = ['1 variable', '5', '9 conserved']
    if cons_colors and cache_hit:
        cons_view['description'] = (
            f'Per-residue conservation (ProtVar CONSERV), binned into 9 grades by '
            f"this receptor's own score quantiles. "
            f'{len(cons_colors)} positions covered; grade 1 = most variable in this '
            f'receptor, grade 9 = most conserved.'
        )
    elif cons_colors:
        cons_view['description'] = (
            'Conservation shown at variant positions only; coverage is partial for this receptor.'
        )
    else:
        cons_view['description'] = 'No conservation data for this receptor'

    # --- Variants: drop entirely (button also removed from template) ---
    views.pop('variants', None)

    return json.dumps(data)


def generate_all_reports(env: Environment, store, output_dir, analysis_results=None, only=None):
    reports_dir = output_dir / 'reports'
    reports_dir.mkdir(parents=True, exist_ok=True)

    info_df = store.get_all_info_df()
    info_df = info_df.sort_values('sum_abs_delta', ascending=False).reset_index(drop=True)
    rank_map = {row['gpcr_id']: idx + 1 for idx, row in info_df.iterrows()}

    template = env.get_template('gpcr_report.html')
    total = len(store.gpcr_ids)
    gpcr_ids = only if only is not None else store.gpcr_ids

    light, dark = theme_overrides()
    layout_light_json = json.dumps(light, separators=(',', ':'))
    layout_dark_json = json.dumps(dark, separators=(',', ':'))

    protein_names = load_protein_names()
    cfr_generics = _cfr_generic_numbers(analysis_results)
    models_root = report_extras.models_dir()

    gen_total = len(gpcr_ids)
    for i, gid in enumerate(gpcr_ids):
        if (i + 1) % 50 == 0 or i == 0:
            print(f"  Generating reports: {i + 1}/{gen_total}...")

        info = store.gpcr_info[gid]
        delta_df = store.delta_data.get(gid, pd.DataFrame())
        var_df = store.variant_data.get(gid, pd.DataFrame())
        annot_map = store.get_annotation_map(gid)

        sig_threshold = v1._calc_significance_threshold(delta_df)

        fig_delta_json = '{}'
        fig_scatter_json = '{}'
        fig_residue_json = '{}'
        fig_tm_json = '{}'
        has_delta_chart = has_scatter_chart = has_residue_chart = has_tm_chart = False

        if not delta_df.empty:
            fig = v1._make_delta_distribution(delta_df, info['uniprot_name'])
            fig_delta_json = fig.to_json()
            has_delta_chart = True

            fig = v1._make_scatter_plot(delta_df, info['uniprot_name'])
            fig_scatter_json = fig.to_json()
            has_scatter_chart = True

            fig = v1._make_residue_changes(delta_df, annot_map, info['uniprot_name'])
            fig_residue_json = fig.to_json()
            has_residue_chart = True

            if annot_map:
                fig = v1._make_tm_breakdown(delta_df, annot_map, info['uniprot_name'])
                fig_tm_json = fig.to_json()
                has_tm_chart = True

        top_changes = v1._get_top_changes(delta_df, annot_map, sig_threshold, n=100)
        tm_summary = v1._build_tm_summary(delta_df, annot_map, sig_threshold)
        variants = v1._prepare_variants_full(var_df, delta_df)
        complete_rrcs = v1._get_complete_rrcs(delta_df, sig_threshold, n=1000)
        rrcs_stats = v1._calc_rrcs_stats(delta_df, sig_threshold)

        # Per-residue metrics — single source for snake-plot views and CSV export
        residue_metrics = v1._compute_residue_metrics(delta_df, annot_map)
        if residue_metrics.empty:
            residue_summary_json = ''
        else:
            residue_summary_json = residue_metrics.to_json(orient='records')

        snake_svg, snake_json = v1._prepare_snake_plot(gid, delta_df, var_df, sig_threshold)
        has_snake_plot = snake_svg is not None
        if has_snake_plot:
            cons_cache = _load_conservation_cache(gid, output_dir)
            am_cache = _load_am_landscape_cache(gid, output_dir)
            snake_json = _patch_snake_views(
                snake_json, annot_map, cfr_generics, var_df,
                conservation_cache=cons_cache,
                residue_metrics=residue_metrics,
                am_landscape_cache=am_cache,
            )

        rx = report_extras.build_extras(gid, annot_map, residue_metrics, models_root,
                                        gene_name=info.get('gene_name') or '')
        if residue_metrics.empty:
            rx_residue_json = ''
        else:
            rx_residue_json = report_extras.json_for_script(report_extras.residue_table_extras(
                delta_df, sig_threshold,
                _load_am_landscape_cache(gid, output_dir),
                _load_conservation_cache(gid, output_dir),
                residue_metrics['position'].tolist()))

        max_increase = float(delta_df['delta_rrcs'].max()) if not delta_df.empty else 0.0
        max_decrease = float(delta_df['delta_rrcs'].min()) if not delta_df.empty else 0.0

        protein_name = protein_names.get(info.get('uniprot_id') or '', '')

        html = template.render(
            static_prefix='../',
            active_page='report',
            nav_home_url='../index.html',
            nav_browse_url='../browse/index.html',
            nav_stats_url='../statistics.html',
            nav_downloads_url='../downloads.html',
            nav_contact_url='../contact.html',
            page_title=report_title(info, protein_name),
            page_path=f'reports/{gid}.html',
            page_description=report_description(info, sig_threshold, len(delta_df), protein_name),
            protein_name=protein_name,
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
            has_delta_chart=has_delta_chart,
            fig_delta_json=fig_delta_json,
            has_scatter_chart=has_scatter_chart,
            fig_scatter_json=fig_scatter_json,
            has_residue_chart=has_residue_chart,
            fig_residue_json=fig_residue_json,
            has_tm_chart=has_tm_chart,
            fig_tm_json=fig_tm_json,
            has_snake_plot=has_snake_plot,
            snake_plot_svg=snake_svg or '',
            snake_plot_json=snake_json or '{}',
            top_changes=top_changes,
            tm_summary=tm_summary,
            variants=variants,
            total_variants=len(var_df),
            complete_rrcs=complete_rrcs,
            # Total modelled contact pairs for this receptor, so the
            # section can say how many of them the table shows.
            rrcs_total_pairs=int(len(delta_df)),
            rrcs_stats=rrcs_stats,
            residue_summary_json=residue_summary_json,
            rx=rx,
            rx_residue_json=rx_residue_json,
            rx_clinvar_label=report_extras.clinvar_label(rx['clinvar']),
            rx_clinvar_scope=report_extras.CLINVAR_SCOPE,
            layout_light_json=layout_light_json,
            layout_dark_json=layout_dark_json,
        )

        out_path = reports_dir / f'{gid}.html'
        out_path.write_text(html, encoding='utf-8')

    print(f"  Generated: {gen_total} report pages")
