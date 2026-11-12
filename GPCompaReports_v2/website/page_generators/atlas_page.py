"""Generate the GPCRome Atlas page (atlas.html).

The page is a canvas over all receptors; its data (atlas/index.json and atlas/r/<gid>.json) is
written by analysis/gpcrome_atlas.py. This module renders only the HTML shell.

    python -m GPCompaReports_v2.website.page_generators.atlas_page --stage DIR

renders atlas.html into an existing built site (DIR) and copies static/css/atlas.css and
static/js/atlas/* into it. Every file is deleted and then written, never edited in place, so a
stage that is hard-linked to another copy stays safe.
"""

import argparse
import json
from pathlib import Path

_NAV = dict(
    static_prefix='',
    nav_home_url='index.html',
    nav_browse_url='browse/index.html',
    nav_stats_url='statistics.html',
    nav_downloads_url='downloads.html',
    nav_contact_url='contact.html',
)

BASE_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = BASE_DIR / 'static'
TEMPLATE_DIR = BASE_DIR / 'templates'


def render_atlas(env, total_gpcrs):
    return env.get_template('atlas.html').render(
        active_page='atlas',
        page_title='GPCRome Atlas · GPCompaRe',
        page_description='An interactive map of all %d human Class A GPCRs: how residue contacts change '
                         'between the inactive and active model of each receptor, by helix and by '
                         'generic position.' % total_gpcrs,
        page_path='atlas.html',
        total_gpcrs=total_gpcrs,
        extra_css=['static/css/atlas.css'],
        **_NAV,
    )


def _replace(dst, data):
    """Delete, then write: never modify a (possibly hard-linked) file in place."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    if isinstance(data, bytes):
        dst.write_bytes(data)
    else:
        dst.write_text(data, encoding='utf-8')


def generate_atlas_page(env, store, output_dir):
    output_dir = Path(output_dir)
    html = render_atlas(env, len(store.gpcr_ids))
    _replace(output_dir / 'atlas.html', html)
    print("  Generated: atlas.html")


def copy_static(output_dir):
    """static/css/atlas.css and static/js/atlas/* into output_dir/static (delete-then-write)."""
    output_dir = Path(output_dir)
    copied = []
    css = STATIC_DIR / 'css' / 'atlas.css'
    _replace(output_dir / 'static' / 'css' / 'atlas.css', css.read_bytes())
    copied.append('static/css/atlas.css')
    for src in sorted((STATIC_DIR / 'js' / 'atlas').glob('*')):
        if src.is_file():
            _replace(output_dir / 'static' / 'js' / 'atlas' / src.name, src.read_bytes())
            copied.append('static/js/atlas/' + src.name)
    return copied


def _env():
    from jinja2 import Environment, FileSystemLoader
    from .. import data_versions, model_methods
    from ..seo import SITE_URL
    env = Environment(loader=FileSystemLoader(str(TEMPLATE_DIR)))
    env.globals['site_url'] = SITE_URL
    data_versions.install(env)
    model_methods.install(env)
    return env


def main(argv=None):
    ap = argparse.ArgumentParser(description='Render atlas.html into an existing built site.')
    ap.add_argument('--stage', required=True, help='a built site directory (holds atlas/index.json)')
    a = ap.parse_args(argv)
    stage = Path(a.stage).expanduser().resolve()
    total = 283
    idx = stage / 'atlas' / 'index.json'
    if idx.exists():
        total = int(json.loads(idx.read_text(encoding='utf-8')).get('n_receptors', total))
    _replace(stage / 'atlas.html', render_atlas(_env(), total))
    copied = copy_static(stage)
    print('atlas.html (%d receptors) + %s -> %s' % (total, ', '.join(copied), stage))


if __name__ == '__main__':
    main()
