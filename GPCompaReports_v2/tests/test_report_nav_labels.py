"""The report section-nav labels are pinned here, not by the freeze test.

`data-section-title` sits on the opening tag of each report section, and the
freeze manifest's scope is the inner HTML *excluding* that tag. So the content
hash is blind to these labels: it would not have caught the approved change
from "Complete RRCS" to "RRCS results", and it would not catch an unapproved
one either.

The approved correction covers exactly one label. Everything else is pinned to
the order and wording it already had.
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
NAV = DELTAS['section_nav_labels']
EXPECTED = NAV['expected_order']
OPTIONAL = set(NAV['optional'])

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

REPORTS = BUILD_DIR / 'reports'
LABEL_RE = re.compile(r'data-section-title="([^"]*)"')

needs_build = pytest.mark.skipif(
    not REPORTS.is_dir(), reason='no built reports at %s' % REPORTS)


def _labels(path):
    return LABEL_RE.findall(path.read_text(encoding='utf-8'))


@needs_build
def test_every_report_uses_the_approved_labels_in_the_approved_order():
    for path in report_pages(REPORTS):
        labels = _labels(path)
        assert labels, '%s has no section nav labels' % path.stem
        assert len(labels) == len(set(labels)), (
            '%s repeats a nav label: %s' % (path.stem, labels))

        unexpected = [l for l in labels if l not in EXPECTED]
        assert not unexpected, (
            '%s carries nav label(s) not in the approved set: %s'
            % (path.stem, unexpected))

        absent = [l for l in EXPECTED if l not in labels]
        assert all(l in OPTIONAL for l in absent), (
            '%s is missing required nav label(s): %s'
            % (path.stem, [l for l in absent if l not in OPTIONAL]))

        assert labels == [l for l in EXPECTED if l in labels], (
            '%s has its nav labels out of the approved order: %s'
            % (path.stem, labels))


@needs_build
def test_the_superseded_label_is_gone_everywhere():
    before = NAV['changed_by_this_approval']['before']
    offenders = [p.stem for p in report_pages(REPORTS)
                 if before in p.read_text(encoding='utf-8')]
    assert not offenders, (
        'reports still carry the superseded nav label %r: %s'
        % (before, offenders[:10]))


@needs_build
def test_the_approved_label_is_present_everywhere():
    after = NAV['changed_by_this_approval']['after']
    missing = [p.stem for p in report_pages(REPORTS)
               if after not in _labels(p)]
    assert not missing, (
        'reports missing the approved nav label %r: %s' % (after, missing[:10]))
