"""The version registry (data_versions.json) is the one place a data release is spelled.

Checks that search and the report labels read it, that it agrees with the provenance the Studio packs carry,
and that the freeze reversal for the report's gnomAD label tracks it. Build checks read FREEZE_BUILD_DIR
(default output_v3_demo) and skip without a build.
"""
import json
import os
import re
from pathlib import Path

import pytest

from GPCompaReports_v2.analysis import pack_layer
from GPCompaReports_v2.website import data_versions as dv
from GPCompaReports_v2.website.page_generators import search_index_v2 as v2

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
BUILD_DIR = (Path(_env).expanduser() if Path(_env).expanduser().is_absolute() else BASE / _env) if _env \
    else BASE / 'output_v3_demo'

REQUIRED = ('rrcs_batch', 'gpcrdb_models', 'gpcrdb_numbering', 'gnomad', 'gnomad_batch', 'clinvar',
            'alphamissense', 'conservation', 'uniprot', 'ensembl', 'hgnc')


def test_registry_names_every_source():
    reg = dv.load()
    assert reg['database']['build_date'] and re.match(r'^\d{4}-\d{2}-\d{2}$', reg['database']['build_date'])
    for key in REQUIRED:
        assert reg['sources'][key]['label'], key
    for layer, keys in reg['layers'].items():
        for key in keys:
            assert key in reg['sources'], (layer, key)
    assert reg['sources']['rrcs_batch']['run_id'] == 'batch_analysis_20260202_151051'
    assert '—' not in json.dumps(reg, ensure_ascii=False)


def test_search_releases_come_from_the_registry():
    assert v2.RELEASES == dv.search_releases()
    for key in ('gnomad', 'clinvar', 'ensembl', 'refseq', 'hgnc', 'uniprot', 'alphamissense'):
        assert v2.RELEASES[key]['label'] == dv.label(key)
    assert v2.RELEASES['database']['label'] == dv.label('rrcs_batch')
    assert v2.RELEASES['reportTable']['label'] == dv.label('gnomad')


def test_report_template_spells_no_gnomad_release():
    html = (BASE / 'templates' / 'gpcr_report.html').read_text(encoding='utf-8')
    assert not re.search(r'gnomAD v\d', html), 'report labels must come from data_versions (variant_release)'
    assert 'variant_release.long_label' in html


def test_freeze_reversal_tracks_the_registry_label():
    """The report's gnomAD label is reversed to the approved one before the freeze hash. A registry change
    must come with a new approved rule, so this fails until someone writes it."""
    deltas = json.loads((BASE / 'tests' / 'fixtures' / 'freeze_approved_deltas.json').read_text(encoding='utf-8'))
    rules = {r['id']: r for r in deltas['reversal']}
    assert rules['gnomad-release-2026-11-05']['after'] == dv.long_label('gnomad')
    assert rules['gnomad-release-2026-11-05']['before'] == dv.long_label('gnomad_batch') == rules['gnomad-release']['after']
    ids = [r['id'] for r in deltas['reversal']]
    assert ids.index('gnomad-release-2026-11-05') < ids.index('gnomad-release')


def test_registry_matches_the_pack_provenance():
    folder = pack_layer.pack_dir()
    index = pack_layer.pack_index(folder)
    if index is None:
        pytest.skip('no Studio packs at %s' % folder)
    gn, cv = dv.source('gnomad'), dv.source('clinvar')
    seen = set()
    for r in index['receptors']:
        prov = pack_layer.load_pack(r['gid'], folder)['provenance']
        g = prov.get('gnomad')
        if g:  # npy6r, taar3: pseudogenes, no gnomAD source
            assert (g['dataset'], g['release'], g['fetched'][:10]) == (gn['dataset'], gn['release'], gn['fetched']), r['gid']
        c = prov['clinvar']
        assert (c['release'], c['dbBuild'], c['fetched'][:10]) == (cv['release'], cv['build'], cv['fetched']), r['gid']
        am = prov.get('alphamissense')
        if am:
            seen.add((am['record'], am['md5']))
    assert seen == {(dv.source('alphamissense')['record'], dv.source('alphamissense')['md5'])}


@pytest.mark.skipif(not (BUILD_DIR / 'index.html').exists(), reason='no build at %s' % BUILD_DIR)
def test_build_ships_the_registry():
    shipped = BUILD_DIR / 'data_versions.json'
    assert shipped.exists()
    assert json.loads(shipped.read_text(encoding='utf-8')) == dv.load()
    meta = BUILD_DIR / 'search2' / 'meta.json'
    if meta.exists():
        assert json.loads(meta.read_text(encoding='utf-8'))['releases'] == dv.search_releases()
