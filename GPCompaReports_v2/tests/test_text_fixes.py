"""The 2026-10-19 text fixes inside report sections.

Each fix is one approved reversal rule in tests/fixtures/freeze_approved_deltas.json.
test_freeze.py proves the rules undo the fixes exactly; this file proves each
rule is documented, still fires (its corrected text is on the page) and that the
wrong text it replaced is gone. A rule whose corrected text never appears would
be dead weight that could later mask an unapproved edit.
"""
import json
import os
import pathlib
import re

import pytest

BASE = pathlib.Path(__file__).resolve().parent.parent
DELTAS = json.loads(
    (BASE / 'tests' / 'fixtures' / 'freeze_approved_deltas.json')
    .read_text(encoding='utf-8'))
RULES = [r for r in DELTAS['reversal'] if r.get('approved_on') == '2026-10-19']

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

REPORTS = BUILD_DIR / 'reports'
SECTION_RE = re.compile(r'<section class="report-section"[^>]*>(.*?)</section>', re.S)

#: Wrong text that must not survive anywhere in an approved section.
GONE = [
    'del Alamo et al., 2022',
    'homozygote counts are uniformly zero',
    'located at contact-forming residues',
]
#: A gnomAD release named without its point release and dataset.
BARE_GNOMAD = re.compile(r'gnomAD v4(?!\.1 \(dataset gnomad_r4, accessed 2 February 2026\))')


def test_every_text_fix_is_its_own_documented_rule():
    ids = [r['id'] for r in RULES]
    assert len(ids) == 9 and len(set(ids)) == len(ids), ids
    for r in RULES:
        for key in ('section', 'what', 'why', 'approved_by'):
            assert r.get(key), '%s has no %s' % (r['id'], key)


def test_threshold_rule_covers_every_manifest_receptor():
    manifest = json.loads((BASE / 'tests' / 'fixtures' / 'freeze_manifest.json')
                          .read_text(encoding='utf-8'))
    rule = next(r for r in RULES if r['kind'] == 'literal_per_receptor')
    assert set(rule['values']) == set(manifest['receptors'])
    for gid, (after, before) in rule['values'].items():
        assert re.fullmatch(r'\d+\.\d\d', after), (gid, after)
        assert re.fullmatch(r'\d+\.\d', before), (gid, before)
        assert abs(float(after) - float(before)) <= 0.06, gid


def _sections(path):
    return '\n'.join(SECTION_RE.findall(path.read_text(encoding='utf-8')))


@pytest.mark.skipif(not REPORTS.is_dir(), reason='no built reports at %s' % REPORTS)
@pytest.mark.parametrize('gpcr_id', ['adrb2_human', 'par2_human'])
def test_each_fix_appears_and_the_wrong_text_is_gone(gpcr_id):
    path = REPORTS / ('%s.html' % gpcr_id)
    if not path.exists():
        pytest.skip('%s not in this build' % gpcr_id)
    body = _sections(path)
    for r in RULES:
        if r['kind'] == 'literal':
            assert r['after'] in body, '%s: corrected text missing' % r['id']
        else:
            after, _ = r['values'][gpcr_id]
            for after_t, _b in r['templates']:
                assert after_t.format(after=after) in body, r['id']
    for wrong in GONE:
        assert wrong not in body, 'still on %s: %r' % (gpcr_id, wrong)
    assert not BARE_GNOMAD.search(body), 'bare gnomAD v4 on %s' % gpcr_id


@pytest.mark.skipif(not REPORTS.is_dir(), reason='no built reports at %s' % REPORTS)
def test_adrb2_threshold_label_reads_1_97():
    body = _sections(REPORTS / 'adrb2_human.html')
    assert 'Medium (1.97 ≤ |Δ| &lt; 5.0)' in body
    assert 'Low (|Δ| &lt; 1.97)' in body
