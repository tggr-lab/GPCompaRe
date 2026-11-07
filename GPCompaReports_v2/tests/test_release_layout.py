"""The release layout: database at the site root, Studio under studio/."""
import json
import pathlib

BASE = pathlib.Path(__file__).resolve().parent.parent
ROOT = BASE.parent
DEPLOY = (ROOT / 'scripts' / 'deploy_pages.sh').read_text(encoding='utf-8')
BUILD = (ROOT / 'scripts' / 'build_release.sh').read_text(encoding='utf-8')
TOPBAR = (BASE / 'templates' / '_partials' / 'topbar.html').read_text(encoding='utf-8')


def test_studio_is_in_both_navs():
    assert TOPBAR.count('href="{{ static_prefix }}studio/"') == 2


def test_deploy_publishes_only_a_stage_that_carries_studio():
    assert 'studio/index.html' in DEPLOY and 'studio/sw.js' in DEPLOY
    assert 'generate_site.py' not in DEPLOY, 'deploy must not build a database-only site'


def test_deploy_runs_the_stage_check_before_syncing():
    assert DEPLOY.index('check_stage.py') < DEPLOY.index('rsync -a --delete')


def test_publication_exclusions_are_kept():
    for path in ('/poster/', '/dossier/'):
        assert "--exclude='%s'" % path in BUILD, path
    # the data caches stay out; the Statistics page's payloads under /data/stats/ are the one exception
    assert "--exclude='/data/*'" in BUILD and "--include='/data/stats/***'" in BUILD
    assert BUILD.index("--include='/data/stats/***'") < BUILD.index("--exclude='/data/*'")
    check = (ROOT / 'scripts' / 'check_stage.py').read_text(encoding='utf-8')
    assert "DATA_PUBLISHED = 'stats'" in check and "'data'" not in check.split('EXCLUDED_DIRS = ')[1].split('\n')[0]


def test_build_refuses_to_run_without_snake_plots():
    assert '_OUROBOROS_OK' in BUILD and '_BUILDER_OK' in BUILD


def test_snake_plots_are_drawn_from_the_published_residue_tables():
    helpers = (BASE / 'website' / 'page_generators' / 'gpcr_report_helpers.py').read_text(encoding='utf-8')
    assert 'fetch_protein_data' not in helpers, 'a live GPCRdb fetch would move the frozen plots'
    tables = json.loads((BASE / 'data' / 'snake_residues.json').read_text(encoding='utf-8'))['receptors']
    frozen = json.loads((BASE / 'tests' / 'fixtures' / 'freeze_manifest.json').read_text(encoding='utf-8'))['receptors']
    assert set(tables) == set(frozen)
