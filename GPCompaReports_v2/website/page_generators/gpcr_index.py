"""Generate the GPCR browser page for GPCompaReports v2."""

import json

from jinja2 import Environment


def generate_gpcr_index(env: Environment, store, output_dir):
    info_df = store.get_all_info_df()
    info_df = info_df.sort_values('sum_abs_delta', ascending=False).reset_index(drop=True)
    info_df['rank'] = info_df.index + 1

    records = info_df[[
        'gpcr_id', 'uniprot_name', 'gene_name', 'receptor_family', 'ligand_type',
        'total_contacts', 'significant_changes', 'sum_abs_delta', 'mean_abs_delta',
        'max_abs_delta', 'variants_found', 'rank'
    ]].to_dict('records')

    browse_dir = output_dir / 'browse'
    browse_dir.mkdir(parents=True, exist_ok=True)

    # Also write the standalone JSON (mirrors the v1 convention so downstream
    # tooling that fetches it externally keeps working).
    data_dir = output_dir / 'data'
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / 'gpcr_index.json').write_text(json.dumps(records, separators=(',', ':')), encoding='utf-8')

    total_gpcrs = len(store.gpcr_ids)
    gpcr_json = json.dumps(records, separators=(',', ':'))

    template = env.get_template('gpcr_index.html')
    html = template.render(
        static_prefix='../',
        active_page='browse',
        nav_home_url='../index.html',
        nav_browse_url='index.html',
        nav_stats_url='../statistics.html',
        nav_downloads_url='../downloads.html',
        nav_contact_url='../contact.html',
        page_title='Browse GPCRs · GPCompaRe',
        page_path='browse/index.html',
        page_description='Search and filter the reports of %d human Class A GPCRs by name, gene, family and ligand type.' % len(store.gpcr_ids),
        extra_css=['static/css/search.css'],
        total_gpcrs=total_gpcrs,
        gpcr_json=gpcr_json,
    )

    out_path = browse_dir / 'index.html'
    out_path.write_text(html, encoding='utf-8')
    print(f"  Generated: browse/index.html")
