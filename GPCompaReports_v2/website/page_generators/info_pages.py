"""Generate the Glossary and Privacy pages, and the glossary data file the
term tooltips read (static/js/glossary-data.js)."""

from ..glossary import glossary_groups, glossary_js

_NAV = dict(
    static_prefix='',
    nav_home_url='index.html',
    nav_browse_url='browse/index.html',
    nav_stats_url='statistics.html',
    nav_downloads_url='downloads.html',
    nav_contact_url='contact.html',
)


def generate_glossary_page(env, store, output_dir):
    html = env.get_template('glossary.html').render(
        active_page='glossary',
        page_title='Glossary · GPCompaRe',
        page_description='Plain-language definitions of the terms used in the GPCompaRe database: '
                         'RRCS, ΔRRCS, thresholds, generic numbers, AlphaMissense, gnomAD and more.',
        page_path='glossary.html',
        total_gpcrs=len(store.gpcr_ids),
        groups=glossary_groups(),
        **_NAV,
    )
    (output_dir / 'glossary.html').write_text(html, encoding='utf-8')
    js_dir = output_dir / 'static' / 'js'
    js_dir.mkdir(parents=True, exist_ok=True)
    (js_dir / 'glossary-data.js').write_text(glossary_js(), encoding='utf-8')
    print("  Generated: glossary.html, static/js/glossary-data.js")


def generate_privacy_page(env, store, output_dir):
    html = env.get_template('privacy.html').render(
        active_page='privacy',
        page_title='Privacy · GPCompaRe',
        page_description='What the GPCompaRe database site loads from other services and what each receives.',
        page_path='privacy.html',
        total_gpcrs=len(store.gpcr_ids),
        **_NAV,
    )
    (output_dir / 'privacy.html').write_text(html, encoding='utf-8')
    print("  Generated: privacy.html")
