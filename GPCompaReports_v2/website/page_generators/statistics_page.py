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

    # Figure 3 of the manuscript. The site no longer displays its own
    # chi-square: the published analysis compares the recurrent positions
    # against other generic-numbered positions on decisive predictions only,
    # which is a different contingency table from the one the site can build.
    fig3 = manuscript.get('figure3', {})
    panel_a = fig3.get('panel_a', {})
    fig3_groups = panel_a.get('groups', [])
    fig3_decisive = panel_a.get('decisive_pathogenic_pct', {})
    fig3_adjusted = fig3.get('conservation_adjusted', {})

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
        fig3_groups=fig3_groups,
        fig3_decisive=fig3_decisive,
        fig3_or=panel_a.get('odds_ratio'),
        fig3_ci_low=panel_a.get('ci_low'),
        fig3_ci_high=panel_a.get('ci_high'),
        fig3_adjusted=fig3_adjusted,
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
