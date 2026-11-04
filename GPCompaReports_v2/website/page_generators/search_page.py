"""Generate the search results page (search/index.html).

The page is a shell: the browser runs the search v2 engine (static/js/search/) against the
lazily loaded index in search2/ and renders the answer (static/js/search-ui/). Without
JavaScript it falls back to a plain list of the receptor reports.
"""

#: Receptor links for the no-JavaScript fallback: (report file stem, display name, gene).
def _fallback_rows(store):
    rows = []
    for gid in store.gpcr_ids:
        info = store.gpcr_info[gid]
        rows.append((gid, info['uniprot_name'], (info.get('gene_name') or '').strip()))
    return sorted(rows, key=lambda r: (r[2] or r[1]).upper())


def generate_search_page(env, store, output_dir):
    out_dir = output_dir / 'search'
    out_dir.mkdir(parents=True, exist_ok=True)
    html = env.get_template('search.html').render(
        static_prefix='../',
        active_page='search',
        nav_home_url='../index.html',
        nav_browse_url='../browse/index.html',
        nav_stats_url='../statistics.html',
        nav_downloads_url='../downloads.html',
        nav_contact_url='../contact.html',
        page_title='Search · GPCompaRe',
        page_path='search/',
        page_description='Find a receptor, residue or variant in any notation: protein or coding '
                         'changes on any transcript, GRCh37 or GRCh38 positions, rsIDs, ClinVar '
                         'records and generic residue numbers.',
        extra_css=[],
        total_gpcrs=len(store.gpcr_ids),
        receptors=_fallback_rows(store),
    )
    (out_dir / 'index.html').write_text(html, encoding='utf-8')
    print("  Generated: search/index.html")
