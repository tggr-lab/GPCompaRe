"""The GPCRome Atlas page: wired into the nav, the sitemap, the build and the stage check.

Source checks need no build. The built-page checks read SMOKE_BUILD_DIR, FREEZE_BUILD_DIR or
SEARCH_BUILD_DIR (as the other build tests), else output_v3_demo, and skip when atlas.html is absent.
"""
import importlib.util
import json
import os
import re
from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader

from GPCompaReports_v2.website import seo
from GPCompaReports_v2.website.page_generators import atlas_page

BASE = Path(__file__).resolve().parent.parent
ROOT = BASE.parent
TEMPLATES = BASE / 'templates'
STATIC = BASE / 'static'

_env = os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR') or os.environ.get('SEARCH_BUILD_DIR')
BUILD_DIR = Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR
needs_build = pytest.mark.skipif(not (BUILD_DIR / 'atlas.html').is_file(), reason='no atlas.html in %s' % BUILD_DIR)

_spec = importlib.util.spec_from_file_location('check_stage', ROOT / 'scripts' / 'check_stage.py')
check_stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_stage)

EM_DASH = '—'
FORBIDDEN_WORDS = re.compile(r'\b(paper|manuscript|supplement\w*|AlphaFold)\b', re.I)


def _render(total=283):
    return atlas_page.render_atlas(atlas_page._env(), total)


def _anchors(html, region_class):
    m = re.search(r'<(?:nav|header)[^>]*class="%s".*?</(?:nav|header)>' % region_class, html, re.S)
    return re.findall(r'<a href="([^"]*)"([^>]*)>([^<]*)</a>', m.group(0)) if m else []


# ---------------------------------------------------------------------------------- the nav

def test_the_atlas_link_is_in_both_navs_after_statistics():
    topbar = (TEMPLATES / '_partials' / 'topbar.html').read_text(encoding='utf-8')
    link = '<a href="{{ static_prefix }}atlas.html"{% if active_page == \'atlas\' %} aria-current="page"{% endif %}>Atlas</a>'
    assert topbar.count(link) == 2
    for nav in re.findall(r'<nav class="(?:topnav|mobile-drawer-nav)".*?</nav>', topbar, re.S):
        labels = re.findall(r'>([A-Za-z]+)</a>', nav)
        assert labels.index('Atlas') == labels.index('Statistics') + 1


def test_atlas_page_renders_with_its_nav_link_active_and_no_other():
    html = _render()
    for cls in ('topnav', 'mobile-drawer-nav'):
        links = _anchors(html, cls)
        assert [t for _, _, t in links][:4] == ['Home', 'Browse', 'Statistics', 'Atlas'], cls
        current = [t for _, attrs, t in links if 'aria-current="page"' in attrs]
        assert current == ['Atlas'], cls
        assert ('atlas.html' in [h for h, _, t in links if t == 'Atlas'])


def test_other_pages_link_the_atlas_with_their_own_prefix():
    env = Environment(loader=FileSystemLoader(str(TEMPLATES)))
    src = '{% include "_partials/topbar.html" %}'
    for prefix in ('', '../'):
        html = env.from_string(src).render(static_prefix=prefix, active_page='report', nav_home_url='x', nav_browse_url='x',
                                           nav_stats_url='x', nav_downloads_url='x', nav_contact_url='x')
        assert html.count('href="%satlas.html"' % prefix) == 2
        assert 'aria-current' not in html


def test_the_sitemap_lists_the_atlas():
    assert 'atlas.html' in seo.STATIC_PAGES
    assert seo.STATIC_PAGES.index('atlas.html') == seo.STATIC_PAGES.index('statistics.html') + 1


def test_the_generator_and_release_script_build_the_atlas():
    gen = (BASE / 'website' / 'site_generator.py').read_text(encoding='utf-8')
    assert 'generate_atlas_page(env, self.store, self.output_dir)' in gen
    sh = (ROOT / 'scripts' / 'build_release.sh').read_text(encoding='utf-8')
    assert 'GPCompaReports_v2.analysis.gpcrome_atlas' in sh
    # after the site (search2 and data/stats exist), before the stage is assembled and checked
    assert sh.index('generate_site.py') < sh.index('analysis.gpcrome_atlas') < sh.index('rsync -a --delete')
    assert '--models "$MODELS_DIR"' in sh and '--batch "$BATCH"' in sh
    # atlas/ is not under /data/, so the data exclusions do not touch it
    assert 'atlas' not in sh.split("--exclude='/data/*'")[0].split('rsync -a --delete')[-1]


# ---------------------------------------------------------------------------- the page itself

def test_the_page_uses_local_assets_only():
    html = _render()
    # the only absolute URLs are the ones every page already carries (site_url, the base template's hosts)
    base_env = Environment(loader=FileSystemLoader(str(TEMPLATES)))
    base_env.globals['site_url'] = seo.SITE_URL
    chrome = (TEMPLATES / 'base.html').read_text(encoding='utf-8') + (TEMPLATES / '_partials' / 'footer.html').read_text(encoding='utf-8')
    ref = re.findall(r'https?://[^\s"\'<>)]+', chrome)
    allowed_hosts = {re.match(r'https?://([^/]+)', u).group(1) for u in ref} | {re.match(r'https?://([^/]+)', seo.SITE_URL).group(1)}
    for url in re.findall(r'https?://[^\s"\'<>)]+', html):
        assert re.match(r'https?://([^/]+)', url).group(1) in allowed_hosts, url
    scripts = re.findall(r'<script[^>]*\ssrc="([^"]+)"', html)
    sheets = re.findall(r'<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"', html)
    assert 'static/css/atlas.css' in sheets
    for ref_ in scripts + sheets:
        if ref_.startswith(('http', '//')):
            continue                       # the base template's own hosts (checked above and below)
        assert ref_.startswith('static/'), ref_
        if ref_ != 'static/js/glossary-data.js':        # written by the build (info_pages.py)
            assert (STATIC / ref_[len('static/'):]).is_file(), ref_
    for ref_ in (r for r in scripts + sheets if r.startswith('//')):
        assert ref_ in chrome, ref_        # only what base.html already loads


def test_atlas_sources_load_nothing_from_other_hosts():
    files = [STATIC / 'css' / 'atlas.css'] + sorted((STATIC / 'js' / 'atlas').glob('*.js')) + [TEMPLATES / 'atlas.html']
    for p in files:
        text = p.read_text(encoding='utf-8')
        # comments may name a URL; a fetch, import, script, link or url() may not
        for pat in (r'fetch\(\s*[\'"]https?:', r'import\s*\(?\s*[\'"]https?:', r'(?:src|href)=["\']https?://(?!tggr-lab)',
                    r'url\(\s*[\'"]?https?:', r'XMLHttpRequest', r'new\s+WebSocket', r'sendBeacon'):
            assert not re.search(pat, text), '%s: %s' % (p.name, pat)


def test_atlas_copy_follows_the_site_rules():
    texts = {'atlas.html': TEMPLATES.joinpath('atlas.html').read_text(encoding='utf-8')}
    texts['atlas.css'] = STATIC.joinpath('css', 'atlas.css').read_text(encoding='utf-8')
    for p in sorted((STATIC / 'js' / 'atlas').glob('*.js')):
        texts[p.name] = p.read_text(encoding='utf-8')
    texts['atlas_page.py'] = (BASE / 'website' / 'page_generators' / 'atlas_page.py').read_text(encoding='utf-8')
    for name, text in texts.items():
        assert EM_DASH not in text, name
    visible = re.sub(r'<script\b.*?</script>|<style\b.*?</style>|<!--.*?-->', ' ', texts['atlas.html'], flags=re.S)
    visible = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', visible))
    assert not FORBIDDEN_WORDS.search(visible), FORBIDDEN_WORDS.search(visible).group(0)
    assert not re.search(r'M159I|Met159Ile', ' '.join(texts.values()))


# --------------------------------------------------------------------------- built page / stage

@needs_build
def test_built_atlas_page_has_the_nav_and_sits_in_the_sitemap():
    html = (BUILD_DIR / 'atlas.html').read_text(encoding='utf-8')
    assert 'aria-current="page"' in html and re.search(r'aria-current="page">Atlas</a>', html)
    sitemap = BUILD_DIR / 'sitemap.xml'
    if sitemap.is_file():
        assert '<loc>%satlas.html</loc>' % seo.SITE_URL in sitemap.read_text(encoding='utf-8')


# stage check, positive and negative, on a synthetic stage

def _stage(tmp_path, n=283, schema='gpcompare-atlas/1', skip=None, extra=None):
    gids = ['g%03d_human' % i for i in range(n)]
    (tmp_path / 'atlas' / 'r').mkdir(parents=True)
    (tmp_path / 'atlas' / 'index.json').write_text(json.dumps(
        {'schema': schema, 'n_receptors': n, 'receptors': [{'gid': g} for g in gids]}), encoding='utf-8')
    for g in gids:
        if g != skip:
            (tmp_path / 'atlas' / 'r' / ('%s.json' % g)).write_text('{}', encoding='utf-8')
    if extra:
        (tmp_path / 'atlas' / extra).write_text('{}', encoding='utf-8')
    js = tmp_path / 'static' / 'js' / 'atlas'
    js.mkdir(parents=True)
    for name in ('atlas-core.js', 'atlas-render.js', 'atlas-3d.js', 'atlas.js'):
        (js / name).write_text('', encoding='utf-8')
    (tmp_path / 'static' / 'css').mkdir(parents=True)
    (tmp_path / 'static' / 'css' / 'atlas.css').write_text('', encoding='utf-8')
    (tmp_path / 'atlas.html').write_text(
        '<link rel="stylesheet" href="static/css/atlas.css"><script src="static/js/atlas/atlas.js"></script>', encoding='utf-8')
    return tmp_path


def test_stage_check_accepts_a_complete_atlas(tmp_path):
    fails = []
    assert check_stage.check_atlas(_stage(tmp_path), [], fails) == 283
    assert fails == []


@pytest.mark.parametrize('kwargs,needle', [
    ({'schema': 'gpcompare-atlas/2'}, 'schema'),
    ({'n': 282}, 'expected 283'),
    ({'skip': 'g005_human'}, 'missing: atlas/r/g005_human.json'),
    ({'extra': 'stray.json'}, 'unexpected files under atlas/'),
])
def test_stage_check_rejects_a_broken_atlas(tmp_path, kwargs, needle):
    fails = []
    check_stage.check_atlas(_stage(tmp_path, **kwargs), [], fails)
    assert any(needle in f for f in fails), fails


def test_stage_check_rejects_a_missing_index_or_page(tmp_path):
    fails = []
    check_stage.check_atlas(tmp_path, [], fails)
    assert fails == ['missing: atlas/index.json']
    stage = _stage(tmp_path / 's')
    (stage / 'atlas.html').unlink()
    (stage / 'static' / 'js' / 'atlas' / 'atlas-3d.js').unlink()
    fails = []
    check_stage.check_atlas(stage, [], fails)
    assert 'missing: atlas.html' in fails and 'missing: static/js/atlas/atlas-3d.js' in fails


def test_the_atlas_files_pass_the_stage_file_rules():
    assert {'.html', '.json', '.js', '.css'} <= check_stage.ALLOWED
    assert not check_stage.SECRET_NAME.search('atlas.html') and not check_stage.SECRET_NAME.search('index.json')


def test_deploy_syncs_atlas_and_does_not_exclude_it():
    deploy = (ROOT / 'scripts' / 'deploy_pages.sh').read_text(encoding='utf-8')
    excludes = re.findall(r"--(?:exclude|include)='([^']+)'", deploy)
    assert not any('atlas' in e or e in ('/*', '*.json', '*.html') for e in excludes)
    assert 'rsync -a --delete' in deploy and '"$STAGE/" "$WORKTREE/"' in deploy
