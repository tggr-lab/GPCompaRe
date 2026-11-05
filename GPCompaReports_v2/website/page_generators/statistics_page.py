"""Generate the statistics page for GPCompaReports v2.

Writes output/statistics.html. Plotly figures produced by analysis/* modules
are emitted once; theme overrides are applied client-side via
Plotly.relayout() driven by the data-chart-layout-* attributes on each
chart div (see templates/statistics.html + static/js/site.js).
"""

import json

from jinja2 import Environment

from ...analysis.cfr_analysis import CFR_TOP_N
from ..plotly_theming import theme_overrides

#: Rows shown in the contact-pair table. Unrelated to CFR_TOP_N: this is how
#: many of the ranked pairs fit on the page, not where the CFR cutoff sits.
NETWORK_ROWS_SHOWN = 20



def generate_statistics_page(env: Environment, store, analysis_results, output_dir):
    cross = analysis_results.get('cross_gpcr', {})
    tm = analysis_results.get('tm_domain', {})
    cfr = analysis_results.get('cfr', {})
    manuscript = analysis_results.get('manuscript', {})
    variant = analysis_results.get('variant', {})

    chart_map = {
        'chart-ranking': cross.get('fig_ranking_bar'),
        'chart-histogram': cross.get('fig_delta_histogram'),
        'chart-box-ligand': cross.get('fig_box_ligand'),
        'chart-box-family': cross.get('fig_box_family'),
        'chart-tm-bar': tm.get('fig_tm_bar'),
        'chart-tm-heatmap': tm.get('fig_tm_heatmap'),
        'chart-cv-scatter': tm.get('fig_conserved_variable'),
        'chart-cfr-dotplot': manuscript.get('fig_recurrence_dotplot'),
        'chart-pathogenicity': manuscript.get('fig_enrichment_bar'),
        'chart-conservation': variant.get('fig_conservation_scatter'),
    }

    charts = {}
    for chart_id, fig in chart_map.items():
        if fig is not None:
            charts[chart_id] = fig.to_json()

    # The ranked table, the chart and the pair table are the submitted
    # manuscript results, not a site recomputation. Order is taken as given.
    top50 = manuscript.get('top50')
    cfr_table_data = [] if top50 is None else top50.to_dict('records')

    pairs = manuscript.get('pairs')
    cfr_network_data = ([] if pairs is None
                        else pairs.head(NETWORK_ROWS_SHOWN).to_dict('records'))

    # Section D: the corrected AlphaMissense comparison of the supplement (Fig. S4, Fig. S5, Table S7;
    # 276 receptors, alleles on model residue numbering), read from
    # data/supplement_2026-11-05b/ by manuscript_stats.load_am_comparison. The retired August
    # figure3_enrichment.json values are not shown. The site does not display its own chi-square:
    # the analysis compares the top 50 positions by CFR score against other generic-numbered
    # positions on decisive predictions only, a different table from the one the site can build.
    am = manuscript.get('am_comparison') or {}

    # There is deliberately no per-variant table here. The published
    # enrichment result (Figure 3) is an aggregate over AlphaMissense classes;
    # the submission package carries no family-wide listing of the individual
    # variants behind it. The site could list its own, but that would be the
    # site's data under a manuscript-defined position set, which is a hybrid
    # this page should not present. Per-variant evidence in the submission is
    # PAR-specific (Supplementary Tables S14 and S15), not family-wide.

    light, dark = theme_overrides()

    template = env.get_template('statistics.html')
    html = template.render(
        static_prefix='',
        active_page='statistics',
        nav_home_url='index.html',
        nav_browse_url='browse/index.html',
        nav_stats_url='statistics.html',
        nav_downloads_url='downloads.html',
        nav_contact_url='contact.html',
        page_title='Database Statistics · GPCompaRe',
        page_path='statistics.html',
        page_description='Cross-receptor statistics for %d human Class A GPCRs: contact-change rankings, transmembrane patterns, recurrent Core Functional Residue positions and variant annotations.' % len(store.gpcr_ids),
        total_gpcrs=len(store.gpcr_ids),
        charts=charts,
        cfr_table=cfr_table_data,
        cfr_network=cfr_network_data,
        am=am,
        cfr_top_n=CFR_TOP_N,
        cfr_total_positions=manuscript.get('n_recurrent_positions', 0),
        cfr_network_total=manuscript.get('n_pairs_universe', 0),
        cfr_network_shown=len(cfr_network_data),
        layout_light_json=json.dumps(light, separators=(',', ':')),
        layout_dark_json=json.dumps(dark, separators=(',', ':')),
    )

    out_path = output_dir / 'statistics.html'
    out_path.write_text(html, encoding='utf-8')
    print(f"  Generated: statistics.html")
