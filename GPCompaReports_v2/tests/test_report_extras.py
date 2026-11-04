"""The opt-in report additions: the 3D view, the ClinVar section and the
residue drawer.

The freeze test (test_freeze.py) proves the PI-approved report sections did not
move. This file proves the other half of the rule: the new capability is
outside those sections, off until asked for, credited, and wired to files that
exist. The browser behaviour is in test_smoke_browser.py.

Build-level checks read FREEZE_BUILD_DIR (default output_v3_demo), like the
other tests, and skip when there is no build. The unit checks at the end run
on synthetic data and need none.
"""
import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys

import pytest

from .report_files import report_pages
from GPCompaReports_v2.website.page_generators import report_extras

BASE = pathlib.Path(__file__).resolve().parent.parent
ROOT = BASE.parent

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

needs_build = pytest.mark.skipif(not (BUILD_DIR / 'reports').is_dir(),
                                 reason='no build at %s' % BUILD_DIR)

SECTION_RE = re.compile(r'<section class="report-section"[^>]*>(.*?)</section>', re.S)
CONFIG_RE = re.compile(r'<script type="application/json" id="rx-config">(.*?)</script>', re.S)


def _reports():
    return report_pages(BUILD_DIR / 'reports')


def _config(html):
    m = CONFIG_RE.search(html)
    assert m, 'no rx-config block'
    return json.loads(m.group(1))


def _extra(html, section_id):
    m = re.search(r'<section class="report-extra" id="%s".*?</section>' % section_id, html, re.S)
    return m.group(0) if m else None


# --------------------------------------------------------------------------
# build-level checks
# --------------------------------------------------------------------------

@needs_build
def test_new_sections_are_present_and_outside_every_report_section():
    for path in _reports():
        html = path.read_text(encoding='utf-8')
        cfg = _config(html)
        if cfg['has3d']:
            assert _extra(html, 'sec-3d'), '%s: no 3D view section' % path.stem
            assert 'id="rx-3d-toggle"' in html
        assert 'id="rx-drawer"' in html
        for body in SECTION_RE.findall(html):
            for token in ('rx-', 'sec-3d', 'sec-clinvar', 'report-extra'):
                assert token not in body, (
                    '%s: %r inside a frozen report section' % (path.stem, token))
        # the new sections never carry data-section-title, so the approved
        # section-nav labels cannot change
        for sid in ('sec-3d', 'sec-clinvar'):
            block = _extra(html, sid)
            if block:
                assert 'data-section-title' not in block


@needs_build
def test_a_build_with_the_packs_and_models_has_both_sections_everywhere():
    if not (report_extras.pack_dir().is_dir() and report_extras.models_dir()):
        pytest.skip('this machine has no Studio packs or no models, so the build cannot have them')
    for path in _reports():
        html = path.read_text(encoding='utf-8')
        assert _extra(html, 'sec-3d'), '%s: no 3D view section' % path.stem
        assert _extra(html, 'sec-clinvar'), '%s: no ClinVar section' % path.stem


@needs_build
def test_the_new_features_are_off_by_default():
    for path in _reports():
        html = path.read_text(encoding='utf-8')
        three_d = _extra(html, 'sec-3d')
        if three_d:
            assert 'aria-expanded="false"' in three_d
            assert re.search(r'<div class="rx-3d-panel" id="rx-3d-panel" hidden>', three_d)
            assert re.search(r'<div class="rx-3d-pane"[^>]*></div>', three_d), 'the pane starts empty'
        clinvar = _extra(html, 'sec-clinvar')
        if clinvar:
            assert re.search(r'<details class="rx-details" id="rx-clinvar">', clinvar), (
                'the ClinVar section must start collapsed (no open attribute)')
        assert re.search(r'<aside class="rx-drawer" id="rx-drawer" hidden', html)
        # Nothing of the viewer is requested by the page itself: the embed and
        # the models appear only as data in the config block, never in a tag.
        outside = CONFIG_RE.sub('', html)
        assert 'pair-viewer' not in outside
        assert '.pdb.gz' not in outside
        assert not re.search(r'<(script|link|img|iframe)[^>]+(studio/embed|models/)', outside)


@needs_build
def test_the_3d_view_carries_its_attribution():
    for path in _reports():
        html = path.read_text(encoding='utf-8')
        block = _extra(html, 'sec-3d')
        if not block:
            continue
        text = re.sub(r'<[^>]+>', ' ', block)
        for needle in ('GPCRdb', '2024-05-15', 'CC BY 4.0', 'Heo L, Feig M',
                       'Proteins 90:1873-1885 (2022)', 'Mol*', 'MIT'):
            assert needle in text, '%s: attribution lacks %r' % (path.stem, needle)
        assert 'href="https://creativecommons.org/licenses/by/4.0/"' in block
        assert 'href="https://doi.org/10.1002/prot.26382"' in block
        assert 'models-and-viewer.txt' in block
        assert 'Open in Studio' in block
        assert 'href="../studio/?db=%s"' % path.stem in block


@needs_build
def test_the_clinvar_section_is_release_labelled_and_has_a_plain_note_when_empty():
    seen_records = seen_empty = False
    for path in _reports():
        html = path.read_text(encoding='utf-8')
        block = _extra(html, 'sec-clinvar')
        if not block:
            continue
        assert re.search(r'<summary>ClinVar \d{4}-\d{2}-\d{2}: ', block), path.stem
        assert 'release ' in block and 'NCBI ClinVar' in block
        cfg = _config(html)
        if cfg['clinvar']:
            seen_records = True
            assert block.count('<tr>') == len(cfg['clinvar']) + 1  # header row too
            assert 'https://www.ncbi.nlm.nih.gov/clinvar/variation/' in block
            for record in cfg['clinvar']:
                assert record['vcv'] in block
        else:
            seen_empty = True
            assert 'No germline pathogenic or likely pathogenic missense records' in block
    if not (seen_records and seen_empty):
        pytest.skip('this build does not hold both a receptor with ClinVar records and one without')


@needs_build
def test_model_urls_in_each_report_resolve_in_a_stage():
    if not (BUILD_DIR / 'models').is_dir():
        pytest.skip('%s is a plain build, not a stage with models/' % BUILD_DIR)
    for path in _reports():
        html = path.read_text(encoding='utf-8')
        cfg = _config(html)
        if not cfg['has3d']:
            continue
        for state in ('active', 'inactive'):
            url = cfg['models'][state]
            # relative to reports/<gid>.html
            target = (BUILD_DIR / 'reports' / url).resolve()
            assert target.is_file(), '%s: %s does not resolve to %s' % (path.stem, url, target)
            assert target.name == '%s_%s.pdb.gz' % (path.stem, state)
        embed = (BUILD_DIR / 'reports' / cfg['embed']).resolve()
        assert embed.is_file(), '%s: the embed does not resolve' % path.stem


@needs_build
def test_the_privacy_page_describes_the_3d_view_accurately():
    privacy = (BUILD_DIR / 'privacy.html').read_text(encoding='utf-8')
    assert '3D view on reports' in privacy
    assert 'No third party is contacted' in privacy
    assert 'all from this site' in privacy


def test_new_copy_has_no_em_dash():
    sources = [BASE / 'templates' / 'gpcr_report.html', BASE / 'templates' / 'privacy.html',
               BASE / 'static' / 'notices' / 'models-and-viewer.txt',
               BASE / 'static' / 'js' / 'residue-drawer.js', BASE / 'static' / 'js' / 'viewer3d.js',
               BASE / 'static' / 'css' / 'report-extras.css']
    for src in sources:
        text = src.read_text(encoding='utf-8')
        if src.name == 'gpcr_report.html':
            # only the part this feature added
            text = '\n'.join(re.findall(r'(?s)(\{# -+ (?:3D view|ClinVar|Residue drawer).*?)(?=\{# -+ )', text))
            assert text, 'could not find the new template blocks'
        assert '—' not in text, '%s contains an em dash' % src.name


def test_the_new_scripts_contact_no_third_party():
    for name in ('viewer3d.js', 'residue-drawer.js'):
        text = (BASE / 'static' / 'js' / name).read_text(encoding='utf-8')
        urls = re.findall(r'https?://[^\s\'")]+', text)
        allowed = ('https://www.ncbi.nlm.nih.gov/clinvar/variation/',)
        for url in urls:
            assert url.startswith(allowed), '%s names %s' % (name, url)
    assert 'https://' not in (BASE / 'static' / 'js' / 'viewer3d.js').read_text(encoding='utf-8')


# --------------------------------------------------------------------------
# unit checks on synthetic data
# --------------------------------------------------------------------------

def _record(pos, ref, alt, vid=1, stars=2, conflict=False, conditions=('Condition',)):
    return [pos, ref, alt, 'p.%s%d%s' % (report_extras._ONE_TO_THREE[ref], pos, report_extras._ONE_TO_THREE[alt]),
            '%s%d%s' % (ref, pos, alt), vid, 'VCV%09d.1' % vid, 'Likely pathogenic', 'LP', stars,
            'criteria provided, single submitter', 1, list(conditions), 'NM_1.1', 'NP_1.1', None,
            conflict, None, '2024-01-01']


def _pack():
    return {
        'residues': [[10, 'M', 'TM1', '1.30x30', 'g'], [11, 'A', 'TM1', '1.31x31', 'g'],
                     [20, 'L', 'ICL1', '', 'g'], [30, 'K', 'TM2', '2.40x40', 'g']],
        'clinvar': [_record(30, 'K', 'E', 5), _record(10, 'M', 'I', 3), _record(11, 'G', 'D', 4)],
        'provenance': {'clinvar': {'release': '2026-10-11', 'scope': 'germline P/LP missense'}},
    }


def test_clinvar_records_are_sorted_labelled_and_flag_a_differing_model_residue():
    pack = _pack()
    annotation = report_extras.residue_annotation(pack, {})
    block = report_extras.clinvar_block(pack, annotation, {10: 'M', 11: 'A', 30: 'K'})
    assert block['release'] == '2026-10-11'
    assert [r['pos'] for r in block['records']] == [10, 11, 30]
    assert block['records'][0]['gn'] == '1.30x30' and block['records'][0]['seg'] == 'TM1'
    flags = {r['pos']: r['differs'] for r in block['records']}
    assert flags == {10: False, 11: True, 30: False}  # position 11: ClinVar says G, the model has A
    assert report_extras.clinvar_label(block) == 'ClinVar 2026-10-11'
    assert report_extras.clinvar_label(None) == 'ClinVar'


def test_no_pack_means_no_clinvar_section_rather_than_a_false_none():
    assert report_extras.clinvar_block(None, {}, {}) is None
    assert report_extras.clinvar_block({'clinvar': []}, {}, {}) is None  # no provenance: not a ClinVar-aware pack


def test_segments_come_from_the_pack_and_fall_back_to_the_page_annotation():
    pack = _pack()
    ann = report_extras.residue_annotation(pack, {99: {'protein_segment': 'TM9', 'display_number': '9.9'}})
    assert report_extras.segment_ranges(ann) == {'TM1': [10, 11], 'ICL1': [20, 20], 'TM2': [30, 30]}
    page_only = report_extras.residue_annotation(None, {5: {'protein_segment': 'TM1', 'display_number': '1.5x5'},
                                                         6: {'protein_segment': 'TM1', 'generic_number': '1.6'}})
    assert page_only == {'5': ['TM1', '1.5x5'], '6': ['TM1', '1.6']}


def test_json_for_script_cannot_close_the_script_element():
    out = report_extras._json_for_script({'condition': '</script><b>&'})
    assert '</' not in out and '<' not in out and '&' not in out
    assert json.loads(out)['condition'] == '</script><b>&'


def test_a_hashed_pack_name_is_found_through_the_index(tmp_path, monkeypatch):
    (tmp_path / 'index.json').write_text(json.dumps({'release': {'files': {'x_human.json': 'x_human.abc.json'}}}))
    (tmp_path / 'x_human.abc.json').write_text('{"gid": "x_human"}')
    monkeypatch.setenv('STUDIO_PACK_DIR', str(tmp_path))
    assert report_extras.load_pack('x_human') == {'gid': 'x_human'}


def test_the_model_pair_needs_both_states(tmp_path):
    for state in ('active', 'inactive'):
        (tmp_path / state).mkdir()
    (tmp_path / 'active' / 'a_human_active.pdb').write_text('ATOM')
    assert not report_extras.has_model_pair('a_human', tmp_path)
    (tmp_path / 'inactive' / 'a_human_inactive.pdb').write_text('ATOM')
    assert report_extras.has_model_pair('a_human', tmp_path)
    assert not report_extras.has_model_pair('a_human', None)


# --------------------------------------------------------------------------
# the release scripts, on a synthetic stage
# --------------------------------------------------------------------------

def _load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / ('%s.py' % name))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PDB = {'active': b'ATOM      1  CA  MET A   1       0.000   0.000   0.000\n' * 400,
       'inactive': b'ATOM      1  CA  ALA A   1       1.000   0.000   0.000\n' * 400}
STUB = ('<!doctype html><meta http-equiv="refresh" content="0; url=a_human.html">'
        '<link rel="canonical" href="https://x/reports/a_human.html">')


def _make_models_and_reports(tmp_path):
    src = tmp_path / 'src'
    for state, data in PDB.items():
        (src / state).mkdir(parents=True)
        (src / state / ('a_human_%s.pdb' % state)).write_bytes(data)
    reports = tmp_path / 'stage' / 'reports'
    reports.mkdir(parents=True)
    (reports / 'a_human.html').write_text('<section class="report-section">x</section> id="sec-3d" id="sec-clinvar"')
    (reports / 'A.html').write_text(STUB)  # a gene-symbol redirect stub is not a report
    index = {'receptors': [{'gid': 'a_human', 'modelSha256': {
        s: hashlib.sha256(d).hexdigest() for s, d in PDB.items()}}]}
    (tmp_path / 'index.json').write_text(json.dumps(index))
    return src, reports, tmp_path / 'index.json'


def test_stage_models_hosts_the_exact_bytes_gzipped(tmp_path):
    stage_models = _load_script('stage_models')
    src, reports, index = _make_models_and_reports(tmp_path)
    out = tmp_path / 'stage' / 'models'
    code = stage_models.main(['--src', str(src), '--reports', str(reports), '--out', str(out),
                              '--index', str(index)])
    assert code == 0
    for state, data in PDB.items():
        staged = out / state / ('a_human_%s.pdb.gz' % state)
        assert gzip.decompress(staged.read_bytes()) == data
    assert sorted(p.name for p in (out / 'active').iterdir()) == ['a_human_active.pdb.gz']  # no stub entry


def test_stage_models_refuses_models_that_are_not_the_studios(tmp_path):
    stage_models = _load_script('stage_models')
    src, reports, index = _make_models_and_reports(tmp_path)
    (src / 'active' / 'a_human_active.pdb').write_bytes(PDB['active'] + b'REMARK changed\n')
    code = stage_models.main(['--src', str(src), '--reports', str(reports),
                              '--out', str(tmp_path / 'stage' / 'models'), '--index', str(index)])
    assert code == 1


def test_stage_models_refuses_a_report_without_a_model_pair(tmp_path):
    stage_models = _load_script('stage_models')
    src, reports, index = _make_models_and_reports(tmp_path)
    (src / 'inactive' / 'a_human_inactive.pdb').unlink()
    assert stage_models.main(['--src', str(src), '--reports', str(reports),
                              '--out', str(tmp_path / 'stage' / 'models'), '--index', str(index)]) == 1


def _stage_for_check(tmp_path):
    stage_models = _load_script('stage_models')
    src, reports, index = _make_models_and_reports(tmp_path)
    stage = tmp_path / 'stage'
    (stage / 'studio' / 'pack').mkdir(parents=True)
    (stage / 'studio' / 'pack' / 'index.json').write_text(index.read_text())
    (stage / 'studio' / 'embed' / 'chunks').mkdir(parents=True)
    (stage / 'studio' / 'embed' / 'pair-viewer.js').write_text('import("./chunks/viewer-abc.js")')
    for name in ('chunks/viewer-abc.js', 'NOTICE.txt', 'THIRD_PARTY_NOTICES.txt'):
        (stage / 'studio' / 'embed' / name).write_text('x')
    (stage / 'static' / 'notices').mkdir(parents=True)
    (stage / 'static' / 'notices' / 'models-and-viewer.txt').write_text('x')
    assert stage_models.main(['--src', str(src), '--reports', str(reports), '--out', str(stage / 'models'),
                              '--index', str(index)]) == 0
    (stage / 'models' / 'NOTICE.txt').write_text('x')
    return stage


def test_check_stage_accepts_a_complete_model_stage_and_catches_each_fault(tmp_path):
    check_stage = _load_script('check_stage')
    # a tiny model compresses below the real files; the bounds are for real models
    check_stage.MODEL_MIN = 10
    stage = _stage_for_check(tmp_path)
    reports = sorted((stage / 'reports').glob('a_human.html'))

    fails = []
    check_stage.check_models(stage, reports, fails)
    assert fails == []

    active = stage / 'models' / 'active' / 'a_human_active.pdb.gz'
    saved = active.read_bytes()

    active.write_bytes(gzip.compress(PDB['active'] + b'X'))  # right shape, changed bytes
    fails = []
    check_stage.check_models(stage, reports, fails)
    assert any('differ from the Studio pack' in f for f in fails), fails

    active.write_bytes(b'not gzip' * 10)
    fails = []
    check_stage.check_models(stage, reports, fails)
    assert any('not a gzip file' in f for f in fails), fails

    active.write_bytes(saved)
    active.unlink()
    fails = []
    check_stage.check_models(stage, reports, fails)
    assert any('missing model' in f for f in fails), fails

    active.write_bytes(saved)
    (stage / 'models' / 'active' / 'ghost_human_active.pdb.gz').write_bytes(saved)
    fails = []
    check_stage.check_models(stage, reports, fails)
    assert any('without a report' in f for f in fails), fails


def test_check_stage_still_excludes_data_poster_and_dossier():
    check_stage = _load_script('check_stage')
    assert check_stage.EXCLUDED_DIRS == ('data', 'poster', 'dossier')


def test_the_release_script_hosts_models_and_keeps_the_exclusions():
    build = (ROOT / 'scripts' / 'build_release.sh').read_text(encoding='utf-8')
    assert 'stage_models.py' in build
    assert build.index('rsync -a --delete "${STUDIO_DIST%/}/"') < build.index('stage_models.py')
    assert build.index('stage_models.py') < build.index('check_stage.py')
    for path in ('/data/', '/poster/', '/dossier/'):
        assert "--exclude='%s'" % path in build


def test_stage_models_cli_runs():
    out = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'stage_models.py'), '--help'],
                         capture_output=True, text=True)
    assert out.returncode == 0 and '--index' in out.stdout
