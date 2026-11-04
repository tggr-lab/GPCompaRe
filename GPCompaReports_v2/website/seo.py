"""Discoverability files: robots.txt, sitemap.xml and gene-symbol redirect stubs.

SITE_URL is where the site is served (the repository was renamed to GPCompaRe
on 2026-10-18; the old /gpcompreports/ address is served by forwarding pages in
the tggr-lab.github.io repository). Crawlers read robots.txt only at a host's
root, so the copy written here takes effect only if the host root forwards to
it; the sitemap works on its own once submitted to a search console.
"""

from html import escape

SITE_URL = 'https://tggr-lab.github.io/GPCompaRe/'

#: Site pages other than the receptor reports, in sitemap order.
STATIC_PAGES = ['', 'browse/index.html', 'statistics.html', 'glossary.html',
                'downloads.html', 'contact.html', 'privacy.html']


def report_title(info, protein_name=''):
    """<title> of a report: 'ADRB2 · Beta-2 adrenergic receptor · GPCompaRe'."""
    name = info['uniprot_name']
    if protein_name and protein_name.strip().upper() != name.upper():
        return '%s · %s · GPCompaRe' % (name, protein_name.strip())
    return '%s · GPCompaRe' % name


def report_description(info, sig_threshold, n_pairs, protein_name=''):
    """Per-receptor meta description: symbol, protein name, family, what the
    page shows, pair count and threshold."""
    name = info['uniprot_name']
    gene = (info.get('gene_name') or '').strip()
    family = (info.get('receptor_family') or '').strip()
    protein = (protein_name or '').strip()
    head = name
    if protein and protein.upper() != name.upper():
        head += ', ' + protein
    bits = []
    if gene and gene.upper() != name.upper():
        bits.append('gene ' + gene)
    if family:
        bits.append(family + ' family')
    if bits:
        head += ' (%s)' % ', '.join(bits)
    return ('%s: residue contacts that change between the active and inactive AlphaFold-Multistate '
            'models of this human Class A GPCR, with a snake plot, 3D view and variants. '
            '%s contact pairs; receptor threshold |ΔRRCS| ≥ %.2f.'
            % (head, format(n_pairs, ','), sig_threshold))


def write_robots(output_dir):
    text = 'User-agent: *\nAllow: /\n\nSitemap: %ssitemap.xml\n' % SITE_URL
    (output_dir / 'robots.txt').write_text(text, encoding='utf-8')


def write_sitemap(output_dir, gpcr_ids):
    paths = list(STATIC_PAGES) + ['reports/%s.html' % gid for gid in gpcr_ids]
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    lines += ['  <url><loc>%s</loc></url>' % escape(SITE_URL + p) for p in paths]
    lines.append('</urlset>')
    (output_dir / 'sitemap.xml').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return len(paths)


_STUB = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{name} · GPCompaRe</title>
<link rel="canonical" href="{site}reports/{target}">
<meta http-equiv="refresh" content="0; url={target}">
<script>location.replace('{target}' + location.hash);</script>
</head>
<body>
<p>The {name} report is at <a href="{target}">reports/{target}</a>.</p>
</body>
</html>
'''


def gene_redirects(store, gpcr_ids):
    """{stub filename: target filename} for gene-symbol URLs such as ADRB2.html.

    Skips a symbol that is blank, not a plain file name, shared by two
    receptors, or the same file as an existing report.
    """
    seen = {}
    for gid in gpcr_ids:
        gene = (store.gpcr_info[gid].get('gene_name') or '').strip()
        if not gene or not all(c.isalnum() or c in '-_.' for c in gene):
            continue
        seen.setdefault(gene, []).append(gid)
    reports = {'%s.html' % g for g in gpcr_ids}
    out = {}
    for gene, gids in sorted(seen.items()):
        name = '%s.html' % gene
        if len(gids) == 1 and name not in reports:
            out[name] = '%s.html' % gids[0]
    return out


def write_gene_redirects(output_dir, store, gpcr_ids):
    reports_dir = output_dir / 'reports'
    reports_dir.mkdir(parents=True, exist_ok=True)
    stubs = gene_redirects(store, gpcr_ids)
    for name, target in stubs.items():
        gid = target[:-5]
        html = _STUB.format(name=escape(store.gpcr_info[gid]['uniprot_name']),
                            site=SITE_URL, target=escape(target))
        (reports_dir / name).write_text(html, encoding='utf-8')
    return stubs
