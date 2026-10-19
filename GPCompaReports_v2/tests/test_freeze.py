"""The PI approved the v2 report pages. With every V3 toggle off, the content
inside the report sections must be what it was.

This used to compare a freshly built demo report against
GPCompaReports_v2/output/reports/par2_human.html directly. That directory is
gitignored: a routine `python3 generate_site.py` (no --output) overwrites it,
after which the test would compare the branch against itself and pass
forever, silently, on the one property this whole test exists to guard.

The baseline now lives in a git-tracked fixture,
tests/fixtures/freeze_manifest.json, generated deliberately by
scripts/build_freeze_manifest.py from a pristine pre-V3 build and reviewed
by hand before being committed. This test only ever reads that fixture; it
never regenerates it.

"Approved content" = the inner HTML of every <section class="report-section">
element, in document order, not including the opening tag. The V3 branch adds
id= and data-section-title= to that opening tag deliberately (sanctioned
wayfinding); everything inside the tag is the PI-approved content that must
not move. This regex and separator must be kept identical to the copy in
scripts/build_freeze_manifest.py, or the manifest and this test will
silently disagree about what "approved content" means.
"""
import hashlib
import json
import os
import re
from pathlib import Path

import pytest

BASE = Path(__file__).resolve().parent.parent
MANIFEST_PATH = BASE / 'tests' / 'fixtures' / 'freeze_manifest.json'

# Approved edits to report content live here, each expressed as the exact
# reversal that undoes it (one rule per approved edit, each with an id). The
# baseline manifest above is NOT regenerated: it stays the pre-V3 record.
# Sections are reversed back to that baseline before hashing, so the approved
# edits pass and anything else still fails.
DELTAS_PATH = BASE / 'tests' / 'fixtures' / 'freeze_approved_deltas.json'

# Overridable so the same test can be pointed at a full 283-receptor build
# instead of the five-receptor demo, e.g.:
#   FREEZE_BUILD_DIR=output_v3_alt python3 -m pytest tests/test_freeze.py
# A relative value is resolved against BASE (GPCompaReports_v2/), matching
# where output_v3_demo, output_v3_alt, etc. already live.
_env_build_dir = os.environ.get('FREEZE_BUILD_DIR')
if _env_build_dir:
    BUILD_DIR = Path(_env_build_dir).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / BUILD_DIR
else:
    BUILD_DIR = BASE / 'output_v3_demo'

FULL_SITE_THRESHOLD = 283

SECTION_RE = re.compile(
    r'<section class="report-section"[^>]*>(.*?)</section>', re.S)
SECTION_SEP = b'\x00SECTION\x00'
V3_TOKEN_RE = re.compile(r'v3-[a-z-]+')


def _load_deltas():
    if not DELTAS_PATH.exists():
        return []
    return json.loads(DELTAS_PATH.read_text(encoding='utf-8')).get('reversal', [])


_REVERSAL = _load_deltas()


def _reverse_approved_edits(body, gpcr_id=None):
    """Undo the approved edits so the section can be compared to the baseline.

    Deliberately narrow. A literal rule rewrites one exact string, and the
    delete rule matches one exact element with its own class. A
    literal_per_receptor rule is a literal rule whose exact strings differ by
    receptor: it rewrites only the strings recorded for this gpcr_id, and does
    nothing for a receptor it has no entry for (so that receptor fails). None
    of them can absorb an unrelated change.
    """
    for rule in _REVERSAL:
        if rule['kind'] == 'literal':
            body = body.replace(rule['after'], rule['before'])
        elif rule['kind'] == 'regex_delete':
            body = re.sub(rule['pattern'], '', body)
        elif rule['kind'] == 'literal_per_receptor':
            values = rule['values'].get(gpcr_id)
            if values is None:
                continue
            after, before = values
            for after_t, before_t in rule['templates']:
                body = body.replace(after_t.format(after=after),
                                    before_t.format(before=before))
        else:
            raise ValueError('unknown reversal kind %r' % rule['kind'])
    return body


def _approved_sections(html, gpcr_id=None):
    return [_reverse_approved_edits(b, gpcr_id) for b in SECTION_RE.findall(html)]


def _approved_content_hash(html, gpcr_id=None):
    sections = _approved_sections(html, gpcr_id)
    blob = SECTION_SEP.join(section.encode('utf-8') for section in sections)
    return hashlib.sha256(blob).hexdigest(), len(sections)


def _load_manifest():
    # This must fail, not skip, when the manifest is missing. A missing
    # baseline means the freeze safeguard itself is absent, which is exactly
    # the silent-pass failure mode this rewrite exists to close.
    assert MANIFEST_PATH.exists(), (
        'freeze manifest missing at %s. Without a baseline this test cannot '
        'vouch for the freeze, so it fails rather than skips. Regenerate it '
        'deliberately with scripts/build_freeze_manifest.py against a '
        'pristine pre-V3 build (normally GPCompaReports_v2/output/), review '
        'the result by hand, and commit it.' % MANIFEST_PATH)
    return json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))


def _build_reports():
    """gpcr_id -> Path for every report html present in BUILD_DIR."""
    reports_dir = BUILD_DIR / 'reports'
    if not reports_dir.is_dir():
        return {}
    return {path.stem: path for path in sorted(reports_dir.glob('*.html'))}


def test_manifest_and_test_agree_on_what_is_frozen():
    """Guard against silent drift between the two copies of the extraction rule.

    The generator and this test each hold a section regex and a separator. If
    one changes and the other does not, they quietly disagree about what
    "approved content" means, and the freeze stops measuring what it claims to.
    The manifest records the definition it was built with; this asserts ours
    still matches it.
    """
    manifest = _load_manifest()
    definition = manifest.get('content_definition')
    assert definition, (
        'manifest records no content_definition, so this test cannot confirm '
        'it still extracts approved content the same way the manifest did. '
        'Regenerate the manifest with scripts/build_freeze_manifest.py.')
    assert definition['section_regex'] == SECTION_RE.pattern, (
        'the section regex in this test no longer matches the one the manifest '
        'was built with:\n  manifest: %s\n  test:     %s'
        % (definition['section_regex'], SECTION_RE.pattern))
    assert definition['separator_hex'] == SECTION_SEP.hex(), (
        'the section separator no longer matches the one the manifest was '
        'built with')


def test_freeze_manifest_exists():
    """Standalone and unconditional: this must fail whenever the manifest is
    missing, regardless of whether any build is present to compare against.
    """
    manifest = _load_manifest()
    assert manifest.get('receptors'), 'manifest has no receptors recorded'


@pytest.mark.skipif(not (BUILD_DIR / 'reports').is_dir(),
                    reason='no build at %s, run scripts/build_demo.sh or set '
                           'FREEZE_BUILD_DIR' % BUILD_DIR)
class TestBuildAgainstManifest:
    """Everything below needs an actual build on disk to compare. With no
    build there is nothing to check, which is a different condition from a
    missing manifest (that always fails, see test_freeze_manifest_exists).
    """

    def test_no_unexpected_receptor_in_the_build(self):
        """A receptor in the build that the manifest has never seen is either
        a new addition never approved by the PI, or a sign this build was not
        generated the way the manifest assumes. Either way it must fail.
        """
        manifest = _load_manifest()
        known = set(manifest['receptors'])
        build = _build_reports()
        unexpected = sorted(set(build) - known)
        assert not unexpected, (
            'receptor(s) present in the build are absent from the freeze '
            'manifest (unexpected addition): %s' % unexpected)

    def test_approved_section_content_is_unchanged(self):
        manifest = _load_manifest()
        build = _build_reports()
        checked = 0
        for gpcr_id, path in sorted(build.items()):
            baseline = manifest['receptors'].get(gpcr_id)
            if baseline is None:
                continue  # already reported by test_no_unexpected_receptor_in_the_build
            html = path.read_text(encoding='utf-8')
            digest, count = _approved_content_hash(html, gpcr_id)
            assert count == baseline['section_count'], (
                '%s: approved section count changed (manifest=%d, build=%d). '
                'A report-section was added or removed inside the frozen '
                'part of the page.' % (gpcr_id, baseline['section_count'], count))
            assert digest == baseline['sha256'], (
                '%s: approved content hash changed. The PI-approved '
                'report-section content for this receptor no longer matches '
                'the frozen baseline in %s.' % (gpcr_id, MANIFEST_PATH.name))
            checked += 1
        assert checked > 0, (
            'no receptor in the build at %s matched the manifest; nothing '
            'was actually checked' % BUILD_DIR)

    def test_full_build_covers_every_manifest_receptor(self):
        """Only a hard requirement once the build is plausibly the full site.
        The five-receptor demo build was never supposed to have the other
        278 pages, so it cannot fail this on incompleteness; a build that
        claims to be complete (>= 283 reports) can.
        """
        manifest = _load_manifest()
        build = _build_reports()
        total = len(manifest['receptors'])
        covered = sorted(set(manifest['receptors']) & set(build))
        print('freeze coverage: %d/%d manifest receptors present in %s'
              % (len(covered), total, BUILD_DIR))
        if len(build) < FULL_SITE_THRESHOLD:
            pytest.skip(
                'build at %s has %d report(s), below the %d-receptor full-site '
                'threshold; %d/%d manifest receptors covered so far, full '
                'coverage not asserted' % (
                    BUILD_DIR, len(build), FULL_SITE_THRESHOLD, len(covered), total))
        missing = sorted(set(manifest['receptors']) - set(build))
        assert not missing, (
            'full build at %s (%d reports) is missing %d of %d manifest '
            'receptors: %s' % (
                BUILD_DIR, len(build), len(missing), total, missing[:10]))

    def test_no_v3_markup_inside_approved_sections(self):
        """Structural half of the freeze rule.

        The content-hash comparison above catches added or changed words.
        This catches added markup that carries no text yet, which is how a
        V3 feature would most likely leak in: an empty mount point or a
        hidden span inside approved content.
        """
        for gpcr_id, path in sorted(_build_reports().items()):
            html = path.read_text(encoding='utf-8')
            for i, body in enumerate(_approved_sections(html, gpcr_id)):
                found = V3_TOKEN_RE.findall(body)
                assert not found, (
                    '%s section %d contains V3 markup: %s'
                    % (gpcr_id, i, sorted(set(found))))
