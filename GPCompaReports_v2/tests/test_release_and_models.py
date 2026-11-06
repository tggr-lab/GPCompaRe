"""One database release and an accurate model label (owner decisions 2026-11-06).

1. Every release or version a built page shows or embeds (landing fold, landing JSON-LD version and
   dateModified, footer, Downloads) equals data_versions.json database.release / build_date. No DOI
   placeholder anywhere until a DOI exists.
2. The GPCRdb models are AlphaFold-Multistate, with plain AlphaFold2 for some states
   (data/model_methods.json: 165 inactive and 26 active models of the 283 receptors). No page says
   every model is AlphaFold-Multistate, and each report's 3D attribution names its own two methods.

Build: FREEZE_BUILD_DIR, SMOKE_BUILD_DIR or SEARCH_BUILD_DIR (default output_v3_demo); the build checks
skip without one.
"""
import json
import os
import re
from pathlib import Path

import pytest

from GPCompaReports_v2.website import data_versions as dv
from GPCompaReports_v2.website import model_methods as mm

from .report_files import report_pages

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('SEARCH_BUILD_DIR')
BUILD_DIR = (Path(_env).expanduser() if _env else BASE / 'output_v3_demo')
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR
needs_build = pytest.mark.skipif(not (BUILD_DIR / 'index.html').is_file(), reason='no build at %s' % BUILD_DIR)

DB = dv.load()['database']
MODELS = dv.source('gpcrdb_models')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
# a database release as a page states it: "GPCompaRe database release <x>" or "release 2026.08"-style
RELEASE_TEXT = re.compile(r'GPCompaRe database release ([0-9][0-9A-Za-z.\-]*[0-9A-Za-z])')
# claims that every model is AlphaFold-Multistate
ALL_MULTISTATE = [
    re.compile(r'two AlphaFold[- ][Mm]ultistate models'),
    re.compile(r'GPCRdb AlphaFold[- ][Mm]ultistate models'),
    re.compile(r'(?:the|each|both) AlphaFold[- ][Mm]ultistate models?'),
    re.compile(r'AlphaFold[- ][Mm]ultistate models (?:for|of) \d'),
    re.compile(r'inactive AlphaFold[- ][Mm]ultistate models'),
]
# on built pages also the GPCRdb file-name tag ("AFMS 2024-05-15" read as the method of every model)
ALL_MULTISTATE_PAGES = ALL_MULTISTATE + [re.compile(r'\bAFMS\b')]
TAGS = re.compile(r'<[^>]+>')


def _text(html):
    html = re.sub(r'<script\b(?![^>]*application/ld\+json)[^>]*>.*?</script>', ' ', html, flags=re.S)
    html = re.sub(r'<style\b[^>]*>.*?</style>', ' ', html, flags=re.S)
    return re.sub(r'\s+', ' ', TAGS.sub(' ', html))


def _pages():
    return sorted(p for p in BUILD_DIR.rglob('*.html') if '/studio/' not in p.as_posix())


# ---- the registry ----

def test_registry_names_one_release():
    assert DATE.match(DB['release']) and DATE.match(DB['build_date'])
    assert DB['label'] == 'GPCompaRe database release %s' % DB['release']


def test_model_label_is_accurate_and_matches_the_counts():
    c = mm.counts()
    assert MODELS['label'] == 'GPCRdb models (%s build): %s' % (MODELS['build'], MODELS['methods'])
    assert 'plain AlphaFold2' in MODELS['methods'] and 'AlphaFold-Multistate' in MODELS['methods']
    assert ('plain AlphaFold2 for %d inactive and %d active models' % (c['inactive'][mm.AF2], c['active'][mm.AF2])
            in MODELS['long_label'])
    assert MODELS['methods_file'] == 'data/model_methods.json'


def test_model_methods_counts():
    data = mm.load()
    recs = data['receptors']
    assert len(recs) == data['counts']['receptors'] == 283
    for state in mm.STATES:
        tally = {}
        for r in recs.values():
            k = (r.get(state) or {}).get('method') or 'unknown'
            tally[k] = tally.get(k, 0) + 1
        assert tally == data['counts'][state], state
    assert data['counts']['inactive'] == {'AlphaFold2': 165, 'AlphaFold2-Multistate': 117, 'unknown': 1}
    assert data['counts']['active'] == {'AlphaFold2': 26, 'AlphaFold2-Multistate': 256, 'unknown': 1}
    unknown = sorted(g for g, r in recs.items() if not (r['active'] and r['inactive']))
    assert unknown == ['mchr1_human']
    assert not [g for g, r in recs.items() if r['active'] and r['inactive']
                and r['active']['method'] == r['inactive']['method'] == 'AlphaFold2']


def test_model_methods_cover_the_batch_receptors():
    batch = os.environ.get('GPCOMPARE_BATCH_DIR')
    cands = [Path(batch)] if batch else []
    cands.append(BASE.parent / 'The_batch_RRCS_analyzer' / 'batch_analysis_full' / 'batch_analysis_20260202_151051')
    for c in cands:
        if (c / 'csv_data').is_dir():
            gids = {f.name[:-len('_rrcs_delta.csv')] for f in (c / 'csv_data').glob('*_rrcs_delta.csv')}
            assert gids == set(mm.load()['receptors'])
            return
    pytest.skip('no batch directory (set GPCOMPARE_BATCH_DIR)')


def test_line_per_receptor():
    assert mm.line('adrb2_human') == 'Inactive model: AlphaFold2; active model: AlphaFold-Multistate'
    assert mm.line('5ht1a_human') == 'Both models: AlphaFold-Multistate'
    assert mm.line('mchr1_human') == ''


def test_notices_state_the_counts():
    c = mm.counts()
    txt = re.sub(r'\s+', ' ', (BASE / 'static' / 'notices' / 'models-and-viewer.txt').read_text(encoding='utf-8'))
    assert 'plain AlphaFold2 for some states (%d inactive and %d active models' % (
        c['inactive'][mm.AF2], c['active'][mm.AF2]) in txt
    assert 'doi.org/10.1038/s41586-021-03819-2' in txt


def test_no_source_claims_every_model_is_multistate():
    files = [*(BASE / 'templates').rglob('*.html'), *(BASE / 'website').rglob('*.py'),
             *(BASE / 'static' / 'js').rglob('*.js'), BASE / 'static' / 'notices' / 'models-and-viewer.txt']
    bad = []
    for f in files:
        if f.name.endswith('.min.js') or 'vendor' in f.parts:
            continue
        code = f.read_text(encoding='utf-8')
        bad += ['%s: %s' % (f.name, m.group(0)) for rx in ALL_MULTISTATE for m in rx.finditer(code)]
    assert not bad, bad


def test_no_source_spells_a_database_release_or_doi_placeholder():
    for f in [*(BASE / 'templates').rglob('*.html'), *(BASE / 'website').rglob('*.py')]:
        code = f.read_text(encoding='utf-8')
        assert not RELEASE_TEXT.search(code), '%s spells a database release' % f.name
        assert 'DOI pending' not in code, f.name
        assert "'version': '" not in code, '%s spells a JSON-LD version' % f.name


# ---- the build ----

@needs_build
def test_every_release_on_the_built_pages_is_the_registry_release():
    seen = 0
    for p in _pages():
        t = _text(p.read_text(encoding='utf-8'))
        assert 'DOI pending' not in t, p.name
        for m in RELEASE_TEXT.finditer(t):
            assert m.group(1) == DB['release'], '%s: %s' % (p.relative_to(BUILD_DIR), m.group(0))
            seen += 1
    assert seen


@needs_build
def test_landing_fold_footer_and_jsonld_use_the_registry():
    html = (BUILD_DIR / 'index.html').read_text(encoding='utf-8')
    m = re.search(r'<details id="release-info">(.*?)</details>', html, re.S)
    assert m, 'landing release fold missing'
    fold = m.group(1)
    assert '<dd data-release>%s</dd>' % DB['label'] in fold
    assert 'DOI' not in fold
    foot = re.search(r'<aside class="fine-print fine-print--versions"[^>]*>(.*?)</aside>', html, re.S)
    assert foot and DB['label'] in foot.group(1)
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    ds = [d for d in (json.loads(b.replace('<\\/', '</')) for b in blocks) if d.get('@type') == 'Dataset']
    assert len(ds) == 1
    assert ds[0]['version'] == DB['release']
    assert ds[0]['dateModified'] == DB['build_date']
    assert 'identifier' not in ds[0] and 'doi' not in json.dumps(ds[0]).lower()
    assert MODELS['methods'] in ds[0]['description']


@needs_build
def test_downloads_names_no_release_of_its_own_and_the_site_copy_is_the_registry():
    # Downloads states no release (tests/test_public_page_copy.py); the footer line it shares is the registry's
    html = (BUILD_DIR / 'downloads.html').read_text(encoding='utf-8')
    body = re.sub(r'<footer\b.*?</footer>', ' ', html, flags=re.S)
    assert not RELEASE_TEXT.search(_text(body)) and 'DOI' not in body
    assert DB['label'] in html
    assert json.loads((BUILD_DIR / 'data_versions.json').read_text(encoding='utf-8')) == dv.load()


@needs_build
def test_no_built_page_claims_every_model_is_multistate():
    bad = []
    for p in _pages():
        t = _text(p.read_text(encoding='utf-8'))
        bad += ['%s: %s' % (p.name, m.group(0)) for rx in ALL_MULTISTATE_PAGES for m in rx.finditer(t)]
    assert not bad, bad[:10]


@needs_build
def test_each_report_names_its_model_methods():
    reports = {p.stem: p for p in report_pages(BUILD_DIR / 'reports')}
    assert reports
    checked = 0
    for gid, p in sorted(reports.items()):
        html = p.read_text(encoding='utf-8')
        m = re.search(r'<aside class="fine-print rx-attr">(.*?)</aside>', html, re.S)
        if not m:
            continue
        attr = re.sub(r'\s+', ' ', m.group(1))
        line = mm.line(gid)
        methods = set(mm.for_receptor(gid).values())
        if line:
            assert 'data-model-methods="known">%s.</span>' % line in attr, gid
        else:
            assert 'data-model-methods="unknown">%s;' % MODELS['methods'] in attr, gid
        assert ('Heo L, Feig M.' in attr) == (not line or mm.AFMS in methods), gid
        assert ('Jumper J et al.' in attr) == (not line or mm.AF2 in methods), gid
        assert "GPCRdb</a> %s build" % MODELS['build'] in attr, gid
        checked += 1
    assert checked
