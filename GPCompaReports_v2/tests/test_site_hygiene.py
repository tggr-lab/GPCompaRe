"""Additions outside the report sections: glossary, privacy, robots, sitemap,
gene-symbol redirects, per-page metadata and the pre-binned statistics histogram."""
import json
import os
import pathlib
import re
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from .report_files import report_pages, stub_target
from GPCompaReports_v2.analysis.cross_gpcr_analysis import plotly_autobins, prebinned_histogram
from GPCompaReports_v2.website.glossary import GLOSSARY, glossary_js
from GPCompaReports_v2.website.seo import SITE_URL

BASE = pathlib.Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

needs_build = pytest.mark.skipif(not (BUILD_DIR / 'glossary.html').exists(),
                                 reason='no build with the glossary at %s' % BUILD_DIR)


def test_glossary_terms_are_unique_plain_and_compile():
    ids = [t['id'] for t in GLOSSARY]
    assert len(ids) == len(set(ids))
    for t in GLOSSARY:
        assert t['definition'].strip() and '—' not in t['definition'] + t['term'], t['id']
    for needed in ('rrcs', 'delta', 'threshold', 'cfr', 'am', 'gnomad', 'af', 'conservation',
                   'gn', 'tm', 'loops', 'h8', 'termini', 'snake', 'models', 'kw'):
        assert needed in ids, needed
    data = json.loads(glossary_js().split('= ', 1)[1].rstrip(';\n'))
    assert all(r['match'] for r in data)


def test_autobins_match_plotly_on_known_cases():
    # Values Plotly bins as start -41, size 1 for nbinsx=100 (checked in the browser).
    rng = np.random.default_rng(0)
    vals = np.concatenate([rng.normal(0, 2, 5000), [-40.2, 33.7]])
    assert plotly_autobins(vals, 100) == (-41.0, 34.0, 1.0)
    centers, counts, _ = prebinned_histogram(vals, 100)
    assert counts.sum() == len(vals) and len(centers) == 75


@needs_build
def test_robots_and_sitemap():
    robots = (BUILD_DIR / 'robots.txt').read_text()
    assert 'Sitemap: %ssitemap.xml' % SITE_URL in robots
    root = ET.parse(BUILD_DIR / 'sitemap.xml').getroot()
    ns = '{http://www.sitemaps.org/schemas/sitemap/0.9}'
    locs = [e.text for e in root.iter(ns + 'loc')]
    assert len(locs) == len(set(locs))
    assert all(loc.startswith(SITE_URL) for loc in locs)
    for loc in locs:
        rel = loc[len(SITE_URL):] or 'index.html'
        assert (BUILD_DIR / rel).is_file(), loc
    reports = report_pages(BUILD_DIR / 'reports')
    assert {'%sreports/%s' % (SITE_URL, p.name) for p in reports} <= set(locs)


@needs_build
def test_gene_redirects_point_at_real_reports():
    reports_dir = BUILD_DIR / 'reports'
    stubs = [p for p in sorted(reports_dir.glob('*.html')) if stub_target(p)]
    assert stubs, 'no gene-symbol redirects written'
    real = {p.name for p in report_pages(reports_dir)}
    assert len(stubs) <= len(real)
    for p in stubs:
        target = stub_target(p)
        assert target in real, (p.name, target)
        assert '<link rel="canonical" href="%sreports/%s">' % (SITE_URL, target) in p.read_text()


@needs_build
def test_report_meta_description_and_canonical():
    for p in report_pages(BUILD_DIR / 'reports'):
        html = p.read_text(encoding='utf-8')
        m = re.search(r'<meta name="description" content="([^"]*)">', html)
        assert m and 'contact pairs; receptor threshold' in m.group(1), p.name
        assert '<link rel="canonical" href="%sreports/%s">' % (SITE_URL, p.name) in html
        assert 'property="og:title"' in html


@needs_build
def test_landing_dataset_jsonld():
    html = (BUILD_DIR / 'index.html').read_text(encoding='utf-8')
    m = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
    data = json.loads(m.group(1))
    assert data['@type'] == 'Dataset' and data['name'] == 'GPCompaRe database'
    assert data['url'] == SITE_URL
    assert 'license' not in data and 'distribution' not in data


@needs_build
def test_no_google_fonts_and_privacy_lists_the_third_parties():
    for page in ['index.html', 'statistics.html', 'glossary.html', 'privacy.html']:
        assert 'fonts.googleapis.com' not in (BUILD_DIR / page).read_text(encoding='utf-8')
    privacy = (BUILD_DIR / 'privacy.html').read_text(encoding='utf-8')
    for name in ('GitHub Pages', 'GoatCounter', 'Plotly CDN', 'Formspree'):
        assert name in privacy
    assert (BUILD_DIR / 'static' / 'fonts' / 'OFL.txt').is_file()


@needs_build
def test_statistics_histogram_ships_bins_not_raw_values():
    html = (BUILD_DIR / 'statistics.html').read_text(encoding='utf-8')
    line = next(l for l in html.split('\n')
                if l.startswith("window.CHART_DATA['chart-histogram'] = "))
    trace = json.loads(line.split(' = ', 1)[1].rstrip(';'))['data'][0]
    assert trace['histfunc'] == 'sum' and len(trace['x']) < 500
    assert len(line) < 20000
