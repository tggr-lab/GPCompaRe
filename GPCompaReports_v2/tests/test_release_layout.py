"""The release layout: database at the site root, Studio under studio/."""
import pathlib
import re
import subprocess

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
    for path in ('/data/', '/poster/', '/dossier/'):
        assert "--exclude='%s'" % path in BUILD, path


def test_build_refuses_to_run_without_snake_plots():
    assert '_OUROBOROS_OK' in BUILD and '_BUILDER_OK' in BUILD
