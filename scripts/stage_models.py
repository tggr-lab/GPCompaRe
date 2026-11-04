#!/usr/bin/env python3
"""Copy the database's GPCRdb model pairs into a stage, gzipped, bytes unmodified.

    python3 scripts/stage_models.py --src MODELS_DIR --reports REPORTS_DIR --out STAGE/models \
        [--index STUDIO_PACK_INDEX_JSON]

For every receptor report in REPORTS_DIR that has both models, writes
OUT/active/<gid>_active.pdb.gz and OUT/inactive/<gid>_inactive.pdb.gz (the
Studio and the report's 3D view expect exactly these names). The gzip stream
is deterministic (no timestamp, no file name). When --index is given, the
sha256 of each source file must equal the Studio pack's modelSha256, so the
Studio recognises the hosted models as the database's own. Any mismatch, or a
report without a model pair, stops the run.
"""
import argparse
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import sys

STATES = ('active', 'inactive')
REFRESH = re.compile(r'<meta http-equiv="refresh"')


def report_ids(reports):
    """Receptor ids of the report pages (gene-symbol redirect stubs excluded)."""
    ids = []
    for path in sorted(reports.glob('*.html')):
        head = path.read_text(encoding='utf-8')[:2048]
        if REFRESH.search(head) and 'report-section' not in head:
            continue
        ids.append(path.stem)
    return ids


def gzip_bytes(data):
    # compresslevel 9 and mtime 0: the same input always gives the same file
    return gzip.compress(data, compresslevel=9, mtime=0)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', required=True, type=pathlib.Path)
    ap.add_argument('--reports', required=True, type=pathlib.Path)
    ap.add_argument('--out', required=True, type=pathlib.Path)
    ap.add_argument('--index', type=pathlib.Path)
    args = ap.parse_args(argv)

    expected = {}
    if args.index:
        index = json.loads(args.index.read_text(encoding='utf-8'))
        expected = {r['gid']: r.get('modelSha256') for r in index['receptors']}

    gids = report_ids(args.reports)
    if not gids:
        sys.exit('no report pages in %s' % args.reports)
    problems, written, raw_total, gz_total = [], 0, 0, 0
    if args.out.exists():
        shutil.rmtree(args.out)
    for state in STATES:
        (args.out / state).mkdir(parents=True)
    for gid in gids:
        pair = {s: args.src / s / ('%s_%s.pdb' % (gid, s)) for s in STATES}
        missing = [str(p) for p in pair.values() if not p.is_file()]
        if missing:
            problems.append('%s: missing %s' % (gid, ', '.join(missing)))
            continue
        for state, path in pair.items():
            data = path.read_bytes()
            if expected:
                want = (expected.get(gid) or {}).get(state)
                got = hashlib.sha256(data).hexdigest()
                if want is None:
                    problems.append('%s %s: not in the Studio pack index' % (gid, state))
                    continue
                if got != want.lower():
                    problems.append('%s %s: sha256 differs from the Studio pack (%s)' % (gid, state, got[:12]))
                    continue
            blob = gzip_bytes(data)
            (args.out / state / ('%s_%s.pdb.gz' % (gid, state))).write_bytes(blob)
            written += 1
            raw_total += len(data)
            gz_total += len(blob)
    for line in problems:
        print('FAIL: ' + line)
    print('models: %d files for %d receptors, %.1f MiB raw, %.1f MiB gzipped'
          % (written, len(gids), raw_total / 2**20, gz_total / 2**20))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
