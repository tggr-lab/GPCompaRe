"""The RRCS table is capped at 1,000 rows, and the page has to say so.

The freeze test reverses the approved edit before hashing, and its delete rule
matches the note whatever numbers it carries. That is correct for a baseline
guard but means the freeze cannot catch a wrong total. This file does.

Approved change: the heading "Complete RRCS results" became "RRCS results",
and reports whose table is truncated carry one line under it giving the real
total. Everything else in the section is unchanged.
"""
import json
import os
import pathlib
import re

import pytest

from .report_files import report_pages

BASE = pathlib.Path(__file__).resolve().parent.parent
DELTAS = json.loads(
    (BASE / 'tests' / 'fixtures' / 'freeze_approved_deltas.json')
    .read_text(encoding='utf-8'))
TRUNCATED = DELTAS['truncated_receptors']
ROW_CAP = DELTAS['row_cap']

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

REPORTS = BUILD_DIR / 'reports'
NOTE_RE = re.compile(
    r'<p class="section-sub rrcs-truncation-note">'
    r'Showing ([\d,]+) of ([\d,]+) contact pairs\.</p>')

needs_build = pytest.mark.skipif(
    not REPORTS.is_dir(),
    reason='no built reports at %s' % REPORTS)


def _built():
    return {p.stem: p for p in report_pages(REPORTS)}


@needs_build
def test_the_old_heading_is_gone_everywhere():
    offenders = [g for g, p in _built().items()
                 if 'Complete RRCS results' in p.read_text(encoding='utf-8')]
    assert not offenders, (
        'reports still carry the superseded heading "Complete RRCS results": %s'
        % offenders[:10])


@needs_build
def test_every_report_carries_the_approved_heading():
    missing = [g for g, p in _built().items()
               if '<h2>RRCS results</h2>' not in p.read_text(encoding='utf-8')]
    assert not missing, 'reports missing the approved heading: %s' % missing[:10]


@needs_build
def test_untruncated_reports_carry_no_note():
    """A note on a report that shows every pair would be false."""
    offenders = []
    for gid, path in _built().items():
        if gid in TRUNCATED:
            continue
        if NOTE_RE.search(path.read_text(encoding='utf-8')):
            offenders.append(gid)
    assert not offenders, (
        'reports whose table is not truncated carry a truncation note: %s'
        % offenders)


@needs_build
def test_truncated_reports_state_the_real_total():
    present = _built()
    checked = []
    for gid, expected_total in sorted(TRUNCATED.items()):
        if gid not in present:
            continue
        html = present[gid].read_text(encoding='utf-8')
        m = NOTE_RE.search(html)
        assert m, '%s is truncated but carries no truncation note' % gid
        shown, total = m.group(1), m.group(2)
        assert shown == '{:,}'.format(ROW_CAP), (
            '%s says it shows %s rows, expected %s'
            % (gid, shown, '{:,}'.format(ROW_CAP)))
        assert total == '{:,}'.format(expected_total), (
            '%s states %s contact pairs, but it has %s'
            % (gid, total, '{:,}'.format(expected_total)))
        checked.append(gid)
    if not checked:
        pytest.skip('none of the %d truncated receptors is in this build '
                    '(the demo builds five untruncated ones)' % len(TRUNCATED))


@needs_build
def test_a_full_build_covers_every_truncated_receptor():
    present = _built()
    if len(present) < 283:
        pytest.skip('build has %d reports, below the full site' % len(present))
    missing = sorted(set(TRUNCATED) - set(present))
    assert not missing, 'full build is missing truncated receptors: %s' % missing
    for gid in TRUNCATED:
        assert NOTE_RE.search(present[gid].read_text(encoding='utf-8')), (
            '%s has no truncation note in the full build' % gid)
