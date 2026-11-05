#!/usr/bin/env python3
"""Generate the frozen-content manifest used by GPCompaReports_v2/tests/test_freeze.py.

This is a deliberate, human-run command. It is never invoked by
generate_site.py, build_demo.sh, or any test, and it never runs as a build
step. Its output is a git-tracked fixture
(GPCompaReports_v2/tests/fixtures/freeze_manifest.json) that pins the
PI-approved content of every report page, so that a routine full site
rebuild into the gitignored output/ directory can never silently become the
new baseline.

Usage:
    python3 scripts/build_freeze_manifest.py <source_dir> [--force]

<source_dir> must be a pristine, pre-V3 build (normally
GPCompaReports_v2/output/, the directory this project treats as the source
of truth for the frozen content). There is no default: the human running
this must name the directory, so that pointing it at the wrong build is a
deliberate choice, not an accident of a default flag.

The script refuses to run against anything that looks like a V3 build (see
V3_MARKERS below), and refuses to overwrite an existing manifest unless
given --force. Its output is a proposal, not a trusted artifact: review the
printed summary before `git add`-ing and committing the result.

Deliberate data refresh (a second, narrower mode):

    python3 scripts/build_freeze_manifest.py --refresh OLD_BUILD NEW_BUILD \
        --allow sec-variants --allow sec-changes=gpr3_human,gpr4_human \
        --keep-old freeze_manifest.pre_<what>_<date>.json --reason "..."

OLD_BUILD must pass the current manifest (every receptor's approved content,
after the approved-edit reversals of tests/fixtures/freeze_approved_deltas.json,
hashes to the recorded value). The two builds are compared section by section
(by the section's id= attribute); every section that differs must be named by
an --allow (SECTION or SECTION=gid,gid,...), or nothing is written. Only the
receptors whose sections changed get a new hash; every receptor also gets its
per-section hashes recorded, so the next refresh and the test can say which
section moved. The previous manifest is kept beside it under --keep-old, and
the refresh is appended to the manifest's `refreshes` list.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = (
    REPO_ROOT / 'GPCompaReports_v2' / 'tests' / 'fixtures' / 'freeze_manifest.json')

SCHEMA_VERSION = 1
BRANCH_BASE_COMMIT = '3a10a53'
GH_PAGES_DEPLOY = 'b892874'
BUILD_DATE = '2026-05-07'

# Any of these appearing anywhere under source_dir means it is a V3 build, or
# at least carries V3 markup, and must never be used to generate the freeze
# manifest. This is the guard against accidentally approving the very
# changes the freeze test exists to detect.
V3_MARKERS = (
    'v3-secnav',
    'v3-nav.js',
    'v3-deeplink',
    'v3.css',
    'sec-snake',
    'GPCompaRe database',
)

# "Approved content" = the inner HTML of every <section class="report-section">
# element, in document order, not including the opening tag. The V3 branch
# adds id= and data-section-title= to that opening tag deliberately (sanctioned
# wayfinding); everything inside the tag is the PI-approved content that must
# not move. This regex and SECTION_SEP must be kept identical to the copy in
# GPCompaReports_v2/tests/test_freeze.py, or the manifest and the test that
# reads it will silently disagree about what "approved content" means.
SECTION_RE = re.compile(
    r'<section class="report-section"[^>]*>(.*?)</section>', re.S)
SECTION_SEP = b'\x00SECTION\x00'

# Stylesheets whose pre-V3 fingerprint is recorded for provenance only. No
# test asserts on these; styling is explicitly out of scope for the freeze
# (see GPCompaReports_v2/tests/fixtures/README.md). Paths are relative to
# static/css/ in both source_dir and the current source tree.
STYLESHEETS = (
    'landing.css',
    'site.css',
    'primer/primitives.css',
    'primer/primitives-dark.css',
)


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scan_for_v3_markers(source_dir):
    """Return {marker: [relative file paths]} for markers found under source_dir."""
    hits = {}
    for path in sorted(source_dir.rglob('*')):
        if not path.is_file():
            continue
        if path.suffix.lower() not in ('.html', '.css', '.js'):
            continue
        try:
            text = path.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        for marker in V3_MARKERS:
            if marker in text:
                hits.setdefault(marker, []).append(str(path.relative_to(source_dir)))
    return hits


def approved_content_hash(html):
    sections = SECTION_RE.findall(html)
    blob = SECTION_SEP.join(section.encode('utf-8') for section in sections)
    return hashlib.sha256(blob).hexdigest(), len(sections)


def git_head():
    try:
        result = subprocess.run(
            ['git', 'rev-parse', 'HEAD'], cwd=str(REPO_ROOT),
            capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except Exception:
        return None


def build_manifest(source_dir):
    reports_dir = source_dir / 'reports'
    report_files = sorted(reports_dir.glob('*.html'))
    if not report_files:
        print('ERROR: no *.html files found under %s' % reports_dir, file=sys.stderr)
        sys.exit(1)

    receptors = {}
    for path in report_files:
        gpcr_id = path.stem
        html = path.read_text(encoding='utf-8')
        digest, count = approved_content_hash(html)
        if count == 0:
            print('ERROR: %s has zero <section class="report-section"> elements, '
                  'refusing to record a hash for it' % gpcr_id, file=sys.stderr)
            sys.exit(1)
        receptors[gpcr_id] = {'sha256': digest, 'section_count': count}

    src_css_dir = REPO_ROOT / 'GPCompaReports_v2' / 'static' / 'css'
    pre_css_dir = source_dir / 'static' / 'css'
    stylesheets = {}
    for rel in STYLESHEETS:
        pre_path = pre_css_dir / rel
        cur_path = src_css_dir / rel
        pre_hash = sha256_file(pre_path) if pre_path.exists() else None
        cur_hash = sha256_file(cur_path) if cur_path.exists() else None
        stylesheets[rel] = {
            'pre_v3_sha256': pre_hash,
            'current_source_sha256': cur_hash,
            'current_source_path': 'GPCompaReports_v2/static/css/%s' % rel,
            'changed': pre_hash != cur_hash,
        }
    # v3.css is new: it did not exist before the branch, so there is no
    # pre-V3 fingerprint to compare it against.
    v3css_cur = src_css_dir / 'v3.css'
    if v3css_cur.exists():
        stylesheets['v3.css'] = {
            'pre_v3_sha256': None,
            'current_source_sha256': sha256_file(v3css_cur),
            'current_source_path': 'GPCompaReports_v2/static/css/v3.css',
            'changed': True,
            'note': 'did not exist in the pre-V3 build',
        }

    return {
        'schema_version': SCHEMA_VERSION,
        # The definition of "approved content" is recorded here so the test can
        # assert its own copy matches. Without this, the generator and the test
        # each hold their own regex and separator, and a change to one would
        # silently redefine what is being frozen: the exact silent-failure mode
        # this manifest replaced.
        'content_definition': {
            'section_regex': SECTION_RE.pattern,
            'separator_hex': SECTION_SEP.hex(),
            'hash_algorithm': 'sha256',
            'scope': 'inner HTML of each <section class="report-section">, '
                     'in document order, excluding the opening tag',
        },
        'provenance': {
            'source_dir': str(source_dir),
            'branch_base_commit': BRANCH_BASE_COMMIT,
            'gh_pages_deploy': GH_PAGES_DEPLOY,
            'build_date': BUILD_DATE,
            'generated_by_commit': git_head(),
            'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        },
        'receptors': receptors,
        'stylesheet_provenance': {
            '_note': ('Informational only. No test asserts on these hashes; '
                      'styling is explicitly out of scope for the freeze, see '
                      'GPCompaReports_v2/tests/fixtures/README.md.'),
            'files': stylesheets,
        },
    }


# ------------------------------------------------------------------------------------ refresh mode

SECTION_ID_RE = re.compile(
    r'<section class="report-section"([^>]*)>(.*?)</section>', re.S)
_ID_ATTR = re.compile(r'\bid="([^"]+)"')


def _freeze_test_module():
    sys.path.insert(0, str(REPO_ROOT))
    from GPCompaReports_v2.tests import test_freeze as tf  # the reversal rules the test applies
    from GPCompaReports_v2.tests.report_files import report_pages
    assert tf.SECTION_RE.pattern == SECTION_RE.pattern and tf.SECTION_SEP == SECTION_SEP
    return tf, report_pages


def sections_by_id(html, gid, tf):
    """[(section id, approved content after the approved-edit reversals)] in document order."""
    heads = SECTION_ID_RE.findall(html)
    bodies = tf._approved_sections(html, gid)
    assert len(heads) == len(bodies)
    out = []
    for i, ((attrs, _raw), body) in enumerate(zip(heads, bodies)):
        m = _ID_ATTR.search(attrs)
        out.append((m.group(1) if m else '#%d' % i, body))
    return out


def _digest(bodies):
    return hashlib.sha256(SECTION_SEP.join(b.encode('utf-8') for b in bodies)).hexdigest()


def _section_hash(body):
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


def parse_allow(values):
    """{section id: None (every receptor) or set of gids}."""
    allow = {}
    for v in values or []:
        sec, _, gids = v.partition('=')
        if not gids:
            allow[sec] = None
        elif allow.get(sec, set()) is not None:
            allow.setdefault(sec, set()).update(g.strip() for g in gids.split(',') if g.strip())
    return allow


def refresh(old_dir, new_dir, allow, keep_old, reason):
    tf, report_pages = _freeze_test_module()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    old_pages = {p.stem: p for p in report_pages(old_dir / 'reports')}
    new_pages = {p.stem: p for p in report_pages(new_dir / 'reports')}
    errors, changed, entries = [], {}, {}
    for gid, base in sorted(manifest['receptors'].items()):
        if gid not in old_pages or gid not in new_pages:
            errors.append('%s: missing from %s' % (gid, 'the old build' if gid not in old_pages else 'the new build'))
            continue
        old = sections_by_id(old_pages[gid].read_text(encoding='utf-8'), gid, tf)
        new = sections_by_id(new_pages[gid].read_text(encoding='utf-8'), gid, tf)
        if _digest([b for _, b in old]) != base['sha256'] or len(old) != base['section_count']:
            errors.append('%s: the old build does not match the current manifest' % gid)
            continue
        old_h = {i: _section_hash(b) for i, b in old}
        new_h = {i: _section_hash(b) for i, b in new}
        diff = sorted(i for i in set(old_h) | set(new_h) if old_h.get(i) != new_h.get(i))
        if [i for i, _ in old if i not in diff] != [i for i, _ in new if i not in diff]:
            errors.append('%s: unchanged sections moved' % gid)
        for i in diff:
            if i not in allow or (allow[i] is not None and gid not in allow[i]):
                errors.append('%s: section %s changed and is not allowed (%s)' % (
                    gid, i, 'added' if i not in old_h else 'removed' if i not in new_h else 'content'))
        entry = {'sha256': _digest([b for _, b in new]), 'section_count': len(new),
                 'sections': [{'id': i, 'sha256': _section_hash(b)} for i, b in new]}
        if diff:
            changed[gid] = diff
        else:
            assert entry['sha256'] == base['sha256']
        entries[gid] = entry
    extra = sorted(set(new_pages) - set(manifest['receptors']))
    if extra:
        errors.append('receptors in the new build but not in the manifest: %s' % extra)
    if errors:
        print('ERROR: refusing to refresh the manifest:', file=sys.stderr)
        for e in errors[:60]:
            print('  ' + e, file=sys.stderr)
        if len(errors) > 60:
            print('  ... %d more' % (len(errors) - 60), file=sys.stderr)
        sys.exit(1)

    keep = MANIFEST_PATH.parent / keep_old
    if keep.exists():
        print('ERROR: %s exists; choose another --keep-old name' % keep, file=sys.stderr)
        sys.exit(1)
    keep.write_text(MANIFEST_PATH.read_text(encoding='utf-8'), encoding='utf-8')
    per_section = {}
    for gid, ids in changed.items():
        for i in ids:
            per_section.setdefault(i, []).append(gid)
    manifest['receptors'] = entries
    manifest.setdefault('refreshes', []).append({
        'date': datetime.now(timezone.utc).date().isoformat(),
        'reason': reason,
        'old_build': str(old_dir),
        'new_build': str(new_dir),
        'allowed': {k: (sorted(v) if v is not None else 'every receptor') for k, v in sorted(allow.items())},
        'changed_receptors': len(changed),
        'changed_sections': {k: len(v) for k, v in sorted(per_section.items())},
        'previous_manifest': keep.name,
        'generated_by_commit': git_head(),
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    })
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print('==> Wrote %s (previous kept as %s)' % (MANIFEST_PATH, keep.name))
    print('    receptors with a new hash: %d of %d' % (len(changed), len(entries)))
    for sec, gids in sorted(per_section.items()):
        print('    %-16s %3d receptors%s' % (sec, len(gids), (': ' + ', '.join(gids)) if len(gids) <= 8 else ''))
    return changed


def main():
    if '--refresh' in sys.argv:
        parser = argparse.ArgumentParser(description='Refresh the freeze manifest for a deliberate data change.')
        parser.add_argument('--refresh', nargs=2, metavar=('OLD_BUILD', 'NEW_BUILD'), required=True)
        parser.add_argument('--allow', action='append', default=[],
                            help='SECTION_ID or SECTION_ID=gid,gid: a section allowed to change')
        parser.add_argument('--keep-old', required=True, help='file name for the previous manifest (fixtures/)')
        parser.add_argument('--reason', required=True)
        args = parser.parse_args()
        old_dir, new_dir = (Path(x).resolve() for x in args.refresh)
        refresh(old_dir, new_dir, parse_allow(args.allow), args.keep_old, args.reason)
        return
    parser = argparse.ArgumentParser(
        description='Generate the report-content freeze manifest. A deliberate, '
                     'human-run command; never invoked by a build or a test.')
    parser.add_argument(
        'source_dir', type=str,
        help='Pristine pre-V3 build directory to hash, e.g. GPCompaReports_v2/output '
             '(no default: you must name it)')
    parser.add_argument('--force', action='store_true',
                        help='Overwrite an existing manifest file')
    args = parser.parse_args()

    source_dir = Path(args.source_dir).resolve()
    if not source_dir.is_dir():
        print('ERROR: not a directory: %s' % source_dir, file=sys.stderr)
        sys.exit(1)

    print('==> Scanning %s for V3 markers...' % source_dir)
    hits = scan_for_v3_markers(source_dir)
    if hits:
        print('ERROR: refusing to generate a manifest from what looks like a '
              'V3 build.', file=sys.stderr)
        print('       Found markers:', file=sys.stderr)
        for marker, files in sorted(hits.items()):
            sample = ', '.join(files[:3])
            more = '' if len(files) <= 3 else ' (+%d more)' % (len(files) - 3)
            print('         %-20s in %s%s' % (marker, sample, more), file=sys.stderr)
        print('       The manifest must come from a pristine pre-V3 build, e.g. '
              'GPCompaReports_v2/output/. Do not point this at output_v3_demo/, '
              'output_v3_alt/, or any build you just made.', file=sys.stderr)
        sys.exit(1)
    print('    no V3 markers found')

    if MANIFEST_PATH.exists() and not args.force:
        print('ERROR: manifest already exists at %s' % MANIFEST_PATH, file=sys.stderr)
        print('       Pass --force to overwrite it.', file=sys.stderr)
        sys.exit(1)

    manifest = build_manifest(source_dir)

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + '\n', encoding='utf-8')

    receptors = manifest['receptors']
    total_sections = sum(entry['section_count'] for entry in receptors.values())
    print('')
    print('==> Wrote %s' % MANIFEST_PATH)
    print('    receptors:      %d' % len(receptors))
    print('    total sections: %d' % total_sections)
    print('    first fingerprints:')
    for gpcr_id in sorted(receptors)[:5]:
        entry = receptors[gpcr_id]
        print('      %-16s sections=%d sha256=%s...'
              % (gpcr_id, entry['section_count'], entry['sha256'][:16]))
    print('')
    print('REMINDER: this file is a proposed baseline, not yet a trusted one.')
    print('          Review it by hand (diff against the previous manifest if')
    print('          there was one, sanity-check the receptor count and a few')
    print('          hashes) before `git add`-ing and committing it.')


if __name__ == '__main__':
    main()
