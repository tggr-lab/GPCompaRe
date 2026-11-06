"""Generate the landing page for GPCompaReports v2."""

import json
from pathlib import Path

from jinja2 import Environment
from ...analysis.cfr_analysis import CFR_TOP_N


def generate_landing_page(env: Environment, store, output_dir: Path):
    """Render the landing to output/index.html."""
    from ..page_generators import gpcr_report_helpers as helpers

    info_df = store.get_all_info_df()

    total_gpcrs = len(store.gpcr_ids)
    n_families = info_df['receptor_family'].nunique()

    n_contact_records = 0
    n_threshold_changes = 0
    for gid in store.gpcr_ids:
        delta_df = store.delta_data.get(gid)
        if delta_df is None or delta_df.empty:
            continue
        n_contact_records += len(delta_df)
        thr = helpers._calc_significance_threshold(delta_df)
        n_threshold_changes += int((delta_df['abs_delta'] >= thr).sum())

    n_models = 2 * len(store.gpcr_ids)
    n_excluded = len(store.metadata) - len(store.gpcr_ids)

    search_records = (
        info_df[['gpcr_id', 'uniprot_name', 'gene_name', 'receptor_family']]
        .fillna('')
        .to_dict('records')
    )

    dataset_jsonld = _dataset_jsonld(total_gpcrs, n_families, n_contact_records,
                                     n_threshold_changes, n_models)

    template = env.get_template('landing.html')
    html = template.render(
        static_prefix='',
        active_page='home',
        nav_home_url='index.html',
        nav_browse_url='browse/index.html',
        nav_stats_url='statistics.html',
        nav_downloads_url='downloads.html',
        nav_contact_url='contact.html',
        page_title='GPCompaRe database: active-inactive contact changes across human Class A GPCRs',
        page_path='',
        extra_css=['static/css/landing.css'],
        cfr_top_n=CFR_TOP_N,
        total_gpcrs=total_gpcrs,
        n_families=n_families,
        n_contact_records=n_contact_records,
        n_threshold_changes=n_threshold_changes,
        n_models=n_models,
        n_excluded=n_excluded,
        search_json=json.dumps(search_records, separators=(',', ':')),
        dataset_jsonld=dataset_jsonld,
    )

    out_path = output_dir / 'index.html'
    out_path.write_text(html, encoding='utf-8')
    print(f"  Generated: {out_path.name}")


def _dataset_jsonld(total_gpcrs, n_families, n_contact_records, n_threshold_changes, n_models):
    """schema.org Dataset description of the database, for search engines.

    States only what the landing page states. No licence, DOI or download is
    claimed: none exists yet (the Downloads page says "Coming soon"). The version
    and dateModified are the registry's (data_versions.json database.release and
    database.build_date), the same release the footer and the landing fold show.
    """
    from ..seo import SITE_URL
    from .. import data_versions
    db = data_versions.load()['database']
    data = {
        '@context': 'https://schema.org',
        '@type': 'Dataset',
        'name': 'GPCompaRe database',
        'alternateName': 'GPCompaRe',
        'description': (
            'Residue-residue contact scores (RRCS) compared between paired active and inactive '
            'GPCRdb models (%s) for %d human Class A GPCRs in %d receptor families: '
            '%s contact-pair records from %d models, %s changes above each receptor\'s own threshold, with GPCRdb '
            'generic numbering, conservation, AlphaMissense predictions and gnomAD missense variation.'
            % (data_versions.source('gpcrdb_models')['methods'], total_gpcrs, n_families, format(n_contact_records, ','),
               n_models, format(n_threshold_changes, ','))),
        'url': SITE_URL,
        'version': db['release'],
        'dateModified': db['build_date'],
        'isAccessibleForFree': True,
        'keywords': ['GPCR', 'Class A GPCR', 'residue-residue contact score', 'RRCS',
                     'receptor activation', 'AlphaFold-Multistate', 'AlphaFold2', 'GPCRdb', 'AlphaMissense', 'gnomAD'],
        'measurementTechnique': 'Residue-residue contact score (RRCS) on GPCRdb AlphaFold-Multistate and AlphaFold2 models',
        'variableMeasured': ['RRCS', 'ΔRRCS (active minus inactive)'],
        'creator': {
            '@type': 'Organization',
            'name': 'TGGR Laboratory, Genetics Institute, Tel Aviv Sourasky Medical Center',
            'url': 'https://github.com/tggr-lab',
        },
    }
    # </ inside a script element would end it early; none is expected, but be safe.
    return json.dumps(data, ensure_ascii=False, indent=1).replace('</', '<\\/')
