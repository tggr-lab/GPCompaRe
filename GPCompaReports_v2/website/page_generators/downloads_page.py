"""Generate the Downloads page.

Both items are presented as planned releases. This module invents no archive,
file, link, version number, DOI or release date, and the page shows no
disabled download control.
"""


def generate_downloads_page(env, store, output_dir):
    template = env.get_template('downloads.html')
    html = template.render(
        static_prefix='',
        active_page='downloads',
        nav_home_url='index.html',
        nav_browse_url='browse/index.html',
        nav_stats_url='statistics.html',
        nav_downloads_url='downloads.html',
        nav_contact_url='contact.html',
        page_title='Downloads · GPCompaRe',
        page_path='downloads.html',
        total_gpcrs=len(store.gpcr_ids),
    )
    (output_dir / 'downloads.html').write_text(html, encoding='utf-8')
    print("  Generated: downloads.html")
